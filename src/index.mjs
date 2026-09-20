// dsh-memory-palace — 把 WorkBuddy 的文件式记忆移植进 DeepSeek Harness。
//
// 设计决策（已与用户确认 + 源码核实）：
// 1. 真源 = 人类可读 Markdown 文件，可被记事本直接编辑。这是核心价值，绝不妥协。
// 2. 读取：agent 每轮 assemble 时把记忆注入 system prompt。因 systemPrompt.section 的
//    text() 必须是【同步】函数（dsh-system-prompt 源码不 await），读盘用同步 node:fs。
// 3. 写入：监听 session/event 的 turn/end，用异步 node:fs 追加。异步不在同步热路径上，
//    且用户级记忆位于 ~/.deepseek-harness（harness 自身数据约定是 ~/.dsh；此处单独用
//    .deepseek-harness 表示本插件的记忆，与 WorkBuddy 的 .workbuddy 解耦），用 node:fs 才能稳定读写。
// 4. 不引入 dsh-storage：用户已确认 .md 必须保留，dsh-storage-json 落 JSON 与之冲突。
// 5. 依赖解析：本包作为标准 npm 包经 `dsh plugin --profile web add .` 装入 profile 后，
//    @deepseek-ai/* 由 profile 的 node_modules 提供（声明为 peerDependencies），运行时裸 import 即可。
// 6. 记忆写入双模式（v1.1.0 起）：[插件模式]（默认）= 记忆公民 prompt 主动记忆 + turn/end 轻量兜底 +
//    错误捕获（均不调 LLM，v0.7.1 定稿）；[智能模式] = LLM 智能会话摘要（turn/end 闸门命中后调
//    ctx.llm.stream，增量提炼 summary→每日日志 + durable→MEMORY.md，产物带 [smart] 标记，失败降级轻量）。
//    两种模式在设置页切换，互斥；切换需重启 dsh 生效。技术依据（v1.1.0 重新论证，见 ABANDONED-LLM-SUMMARY.md）：
//    session.events / deriveEventMessage / requestHeader()?.config 系统性解决 v0.7.1 废弃时踩的 4 个坑。
//
// 模块结构（v1.2.0 混合式重构）：
// - src/common/prompts.mjs / text.mjs / paths.mjs / records.mjs：纯函数与常量（可独立单测/复用）
// - src/distill.mjs / tools.mjs / api.mjs：蒸馏业务 / 记忆工具 / 自有 route（经工厂注入依赖）
// - src/index.mjs：最薄入口——apply() 装配 + 闭包运行时（session/event 跟踪、settle 时序、section 注入）
// - src/client/（00-head…90-tail）：浏览器 bundle 源码（build 时零依赖拼接为 lib/client.js 单文件，
//   硬约束——dsh 客户端模块系统不支持插件相对 require）
import Schema from "@deepseek-ai/schemastery";
// v1.6.0-rc1：适配 DSH 0.1.2-alpha.2——dsh-settings 不再导出自由函数 installSettingsSection /
// settingsNamespace，设置节注册改用 SettingsProvider 实例方法 installSection（经 ctx.inject(["settings"])）。
import { extractText, extractToolErrorText } from "./common/text.mjs";
import { SCENE_KEYWORDS } from "./common/prompts.mjs";
import { createPaths } from "./common/paths.mjs";
import { createRecords } from "./common/records.mjs";
import { eventsFrom } from "./common/session.mjs";
import { createDistill } from "./distill.mjs";
import { registerTools } from "./tools.mjs";
import { registerApi } from "./api.mjs";
import { registerHybrid, HYBRID_PROACTIVE } from "./hybrid/index.mjs";
import { registerProjection } from "./projection.mjs";

export const name = "memory-palace";
// v1.6.0-rc1：settingsNamespace() 已删除，namespace 直接用字符串（宿主侧做类型级校验）。
const MEMORY_PALACE_SETTINGS_NAMESPACE = "memory-palace";

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description("启用 memory-palace 记忆注入与每日日志写入。"),
  // ---- v1.7.2：预设级静默（官方 minimal「裸测环境」口径）----
  // 宿主把「模式」实现为 agent 平面的 preset：minimal 预设用 persona complete:true 独占 system prompt。
  // 但本插件注册在 host 平面（profile bundle 的 insert），各通道对**每个 agent** 都生效，preset 并不会
  // 把它摘掉——故须自行按会话判据静默，否则记忆正文仍会经 E 投影进历史（实测症状）。
  silentPresets: Schema.array(Schema.string()).default(["minimal"]).description("在这些 agent 预设下本插件整体静默（等价 enabled=false）：不注入系统提示词与投影、记忆工具对模型隐身、不写日志、不跑记忆子代理。默认 [\"minimal\"]（官方极简模式）；置空数组 = 关闭该机制。判据取会话创建头 agentPreset 与 agent-preset/selected 事件（宿主公开事实）。"),
  userMemoryPath: Schema.string().default("~/.deepseek-harness/MEMORY.md").description("用户级记忆文件路径（支持 ~ 展开）。"),
  workspaceMemoryDir: Schema.string().default(".deepseek-harness/memory").description("无 buddy 目录时使用的项目级每日日志目录；项目级 MEMORY.md 位于其同级（.deepseek-harness/MEMORY.md）。"),
  dailyLogRetentionDays: Schema.number().default(30).description("每日日志保留天数，过期日志会被蒸馏进 MEMORY.md。"),
  userBudgetChars: Schema.number().default(4000).description("注入系统提示词的用户级记忆长度上限（字符）。"),
  workspaceBudgetChars: Schema.number().default(3000).description("注入系统提示词的工作区级记忆长度上限（字符）。"),
  // 桥接 WorkBuddy / CodeBuddy 项目记忆：项目已存在这些目录时直接读写，不再单独建 .deepseek-harness/memory/。
  bridgeBuddyMemory: Schema.boolean().default(true).description("检测并直接读写 WorkBuddy / CodeBuddy 项目记忆目录。"),
  buddyWorkspaceMemoryDirs: Schema.array(Schema.string()).default([".workbuddy/memory", ".codebuddy/memory"]).description("要桥接的 buddy 项目记忆目录列表（按优先级，全部已存在目录会同步写入）。"),
  // ---- v0.7.1 调整：废弃插件侧 callLlm，主路径 = 记忆公民 prompt 主动记忆；turn/end 仅做轻量兜底 ----
  summarize: Schema.boolean().default(true).description("它是「agent 主动记忆」主路径失效时的安全网，保证实质工作不丢，代价是只留原始文本、不做总结。"),
  autoCaptureErrors: Schema.boolean().default(true).description("对话出错时（含代码运行报错、工具执行失败）自动把『错误现象』写入对应 MEMORY.md（『根因/方案』由 agent 按记忆公民指令场景①主动记；默认开，关闭无需重启）。"),
  // ---- v1.1.0：记忆模式（plugin=记忆公民指令+轮次轻量+错误捕获；smart=LLM 智能会话摘要）----
  // v1.6.0：+hybrid（子 agent 自动维护日志 + agent 主动维护 MEMORY.md），三档并存，切换需重启 dsh。
  memoryMode: Schema.union(["plugin", "smart", "hybrid"]).default("plugin").description("记忆模式：plugin=记忆公民指令+轮次轻量+错误捕获；smart=LLM 智能会话摘要（summary→每日日志 + durable→MEMORY.md）；hybrid=记忆子代理自动维护今日日志（标删去重）+ agent 主动维护 MEMORY.md（章节化写入/整章节替换/门禁内全量重整）。切换需重启 dsh 生效。"),
  summaryModel: Schema.string().default("").description("记忆插件当前使用的模型（智能模式会话摘要 / 手动蒸馏 / hybrid 记忆子代理共用）。留空=复用当前会话 provider/model；也可填 provider/model（如 deepseek/deepseek-chat）固定廉价模型省 token。"),
  summaryTimeoutMs: Schema.number().default(60000).description("蒸馏 LLM 调用的超时（毫秒），超时视为失败并降级；覆盖智能模式摘要与手动蒸馏两条链路；默认 60000（60s）。"),
  distillDebugLog: Schema.boolean().default(false).description("调试开关：向 dsh 服务端 stderr 输出蒸馏 LLM 调用诊断。distillLogLevel=info 时仅输出元数据（模型解析/请求参数/流进度/错误详情，不含文本）；distillLogLevel=debug 会额外打印 LLM 原始响应文本（分隔符包裹），仅限受信本地排障开启。"),
  // ---- v1.4.1：蒸馏 stderr 日志级别（平铺键，不进 UI；默认 info；distillDebugLog=true 时生效） ----
  distillLogLevel: Schema.string().default("info").description("蒸馏 stderr 日志级别：info=仅元数据诊断（默认，不打印 LLM 原始响应）；debug=额外打印 LLM 原始响应文本（分隔符包裹），仅限受信本地排障开启。无需 UI 配置，经 DSH home（$DSH_HOME）根目录的 settings.yaml 设置 distillLogLevel 键。"),
  // ---- v1.4.0：智能模式最终输出软预算（v1.4.1 起语义变更：prompt 软约束，思考不受限；实际硬上限由模型自身 maxTokens 决定） ----
  summaryMaxTokens: Schema.number().default(2000).description("会话摘要 LLM 的最终输出软预算（prompt 约束，思考不受限；实际硬上限由模型自身 maxTokens 决定）。默认 2000；可调大以容纳更多 durable 事实。"),
  projectMaxTokens: Schema.number().default(8000).description("手动「蒸馏项目记忆」LLM 的最终输出软预算（prompt 约束，思考不受限；实际硬上限由模型自身 maxTokens 决定）。默认 8000。"),
  // ---- v1.4.0：蒸馏时回喂存量记忆（特性3，默认关；开启后自动智能模式 turn/end 与手动蒸馏按钮均回喂，delete 仅手动放开） ----
  feedbackEnabled: Schema.boolean().default(false).description("每次蒸馏时把项目级 + 用户级 MEMORY.md 全文（逐行编号、无截断）回喂给 LLM，使其能基于既有记忆做增量维护。delete 仍仅手动蒸馏按钮开放，自动模式跳过（防误删）。hybrid 模式下仅手动触发蒸馏受影响（自动路径走记忆子代理，自带日志回喂）。默认关。"),
  // ---- v1.6.0：hybrid 模式配置（仅 memoryMode=hybrid 时生效） ----
  reorgCooldownDays: Schema.number().default(7).description("hybrid 模式：项目级 MEMORY.md 全量重整的冷却天数（距上次重整）。与「超出注入预算」双条件同时满足才允许 memory_reorganize；时间戳以 HTML 注释落在 MEMORY.md 文件尾。"),
  subagentLogBudget: Schema.number().default(20000).description("hybrid 模式：记忆子代理回喂今日工作日志的字符上限。超出时仅回喂章节目录，子代理用 log_read_section 按需读取章节。"),
  // ---- v1.7.1（特性3）：自定义指令（用户自写，经 system prompt 注入到「记忆分工 prompt」之后） ----
  // 放 system 而非 E 投影：用户配置一次即恒定 → 零缓存成本（见下方 section 的分流原则）。
  customInstructions: Schema.string().default("").description("自定义指令：非空时追加到系统提示词「记忆分工说明」之后，用于承载不适合写进用户记忆的特殊指令。对全部会话与三种记忆模式生效；留空则不注入。"),
});

export const inject = ["systemPrompt", "tools", "llm", "webServer", "webRuntime"];

export function apply(ctx, config) {
  // 设置集成：在 DSH 设置页暴露 memory-palace 配置面板；运行时优先读用户设置覆盖层，
  // 未挂载 settings 服务时回退到 cordis 组合里的 config。
  // v1.6.0-rc1：注册动作挪进下方 ctx.inject(["settings"]) 回调（installSection 是
  // SettingsProvider 实例方法，须等 settings 服务挂载；其内部同步 setSource，时序与旧版等价）。
  let source = () => config;
  const baseEntry = { ...config };

  // ---- v1.1.3：设置读写 route（真保存）----
  // client fetch 同源 /memory-palace/api/settings.get|update，绕过 settingsScope(persistence=memory no-op)
  // 与 apiproxy allowlist 两层限制；handler 内直接走服务端 settings → settings-file 持久化。
  // 写用 replace 语义（整节替换）：表单里留空的字段自动回退 base/schema 默认，与「保存=提交整个表单」一致。
  let settingsFace = null;
  ctx.inject(["settings"], (sctx) => {
    const ns = MEMORY_PALACE_SETTINGS_NAMESPACE;
    // v1.6.0-rc1：设置节注册挪到此处（settings 服务就绪后）。installSection 内部会同步
    // 执行 setSource(() => scope.get())，把 source 从 cordis config 切到用户设置覆盖层；
    // owner=ctx 使插件卸载时宿主自动回退 setSource(() => entry)。与旧版自由函数时序等价。
    sctx.settings.installSection(ctx, ns, Config, baseEntry, {
      setSource: (next) => {
        source = next;
      },
      onChange: () => {},
    });
    const viewOf = () => {
      const descriptor = sctx.settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ns);
      return descriptor === undefined
        ? { value: undefined, user: undefined, revision: undefined }
        : { value: descriptor.value, user: descriptor.user, revision: descriptor.revision };
    };
    settingsFace = {
      get: viewOf,
      replace: async (section, expectedRevision) => {
        await sctx.settings.replace(ns, section, expectedRevision);
        return viewOf();
      },
    };
  });
  const getSettingsFace = () => settingsFace;

  // ---- 运行时状态（跨模块共享的可变状态；distill/tools/api/records 经工厂注入读取） ----
  const state = {
    activeCwd: null,          // 最近活跃 session 的 cwd（session/event 更新）
    activeSession: null,      // 最近活跃 session 引用
    turnBuffer: [],           // 每轮缓冲 {role,text}，role ∈ user/assistant/tool
    recentAgentWrote: false,  // agent 主动调 memory_note / memory_note_user 标志
    sawErrorTurn: false,      // 跨 turn 累积的 request 级错误信号
    lastErrorMsg: "",
    settleTimer: null,        // debounce 计时器
    lastSummarizedSeq: -1,    // 智能模式增量摘要断点（session 事件 seq）
    summarySessionId: null,
    planModeActive: false,    // 计划模式：禁写记忆（硬编码默认，无开关；仅经 session/event 的 plan/mode 翻转；未装 dsh-plan-mode 永不触发=不拦截）
    // v1.7.2：会话 → agent 预设 id（仅"切换预设"事件写入；创建头另在 presetOfSession 里兜底读）。
    // 只增不减：会话结束后残留几条字符串，代价可忽略；切回同一 session 断言预设不变（宿主侧保证）。
    presetBySession: new Map(),
    // v1.7.0：injectedSessionIds 已删除——记忆正文改经 E 投影（src/projection.mjs）注入为
    // 常驻消息，compaction 后由投影自动重注，不再需要"仅首次注入"的会话级标记。
  };
  const TURN_BUFFER_MAX = 30;
  // v1.1.3：字符上限提升到 30k（长工具型 request 的工具结果动辄数千字符，6k 上限会触发
  // 溢出保护清空 tool 块 → 闸门误判 → 记忆整体丢失）。
  const TURN_BUFFER_CHAR_CAP = 30000;
  const SETTLE_DELAY = 1500;

  // ---------- v1.7.2：预设级静默判据（官方 minimal = 宿主给模型的"裸测环境"） ----------
  // 背景：宿主的「模式」= agent 平面的 preset（`packages/preset/agent-presets/presets/*/agent.cordis.yml`），
  // minimal 预设以 persona `complete: true` 独占 system prompt 并关掉 runtime context——那是官方跑分口径
  // 的刻意设计。而本插件是 host 平面插件（profile bundle insert），其 systemPrompt.section / agent/pre-step
  // 投影 / 工具注册对**每个 agent** 都生效，preset 不会把它摘掉；`complete` 又只吞 sections、不裁 tools。
  // 结果就是"指令没了、记忆正文照进、工具 schema 照发"的半残状态（实测：极简模式下投影仍在注入）。
  // 因此必须自行判定会话预设并整体静默。
  //
  // 判据取宿主公开事实，不引入额外服务依赖：
  //   ① session.header.agentPreset —— 创建头，由 session-controller 的 composeAgent 写入**解析后**的
  //      预设 id（未显式指定时即部署默认），故默认预设会话同样能识别；
  //   ② `agent-preset/selected` 事件 —— 仅"尚未产生任何消息"的空会话可切预设，切换时追加，
  //      由下方 session/event 监听捕获。
  // 二者合起来等价于宿主的 `agentPreset` 会话投影（init=header，apply=该事件），无需注入 sessionProjections。
  // fail-open：判据缺失（老宿主 / 非 preset 部署）一律视为"不静默"，绝不因判据缺失而丢掉记忆能力。
  function presetOfSession(session) {
    if (!session) return undefined;
    const switched = state.presetBySession.get(session.id);
    if (typeof switched === "string" && switched) return switched;
    const header = session.header?.agentPreset;
    return typeof header === "string" && header ? header : undefined;
  }

  /**
   * 该会话是否应整体静默：`enabled=false`（全局停用）或命中「静默预设」名单。
   * 命中后 section / E 投影 / turn-end 写入 / 记忆工具 / hybrid 子代理一并关闭——
   * 语义等价于该会话里没装本插件。
   * @param {object|undefined} session
   * @returns {boolean}
   */
  function isSessionSilent(session) {
    const cfg = source();
    if (!cfg.enabled) return true;
    const list = Array.isArray(cfg.silentPresets) ? cfg.silentPresets.filter((x) => typeof x === "string" && x) : [];
    if (!list.length) return false; // 名单空 = 关闭该机制（只受 enabled 管）
    const preset = presetOfSession(session);
    return preset !== undefined && list.includes(preset);
  }

  // ---- 装配：路径解析 / 记录读写 / 蒸馏 / 工具 / route ----
  const paths = createPaths(() => source(), () => state.activeCwd);
  const records = createRecords({ getConfig: () => source(), paths });
  const distill = createDistill({ ctx, getConfig: () => source(), paths, records, state });
  registerTools({ ctx, getConfig: () => source(), paths, state });
  registerApi({ ctx, paths, distill, state, getSettingsFace });
  // v1.6.0：hybrid 模式独立模块。必须【无条件注册】——apply() 同步段执行时 settings 服务
  // 尚未挂载（v1.6.0-rc1 起设置节经 SettingsProvider.installSection 在 ctx.inject(["settings"])
  // 回调里注册并同步 setSource），此刻 source() 读的是 cordis 组合配置（默认 plugin），
  // 条件注册会导致设置页切 hybrid 后工具/子代理从未注册（v1.6.0 实装踩坑：settings.yaml
  // memoryMode=hybrid 但 registerHybrid 未执行 → 子代理 TypeError 被吞、日志全空）。
  // 运行时分派靠 _settle / proactive 的热 source() 判断；工具注册无副作用（plugin/smart
  // 的 prompt 不引导使用，guards 白名单只拦 hybrid 工具）。
  const hybrid = registerHybrid({ ctx, getConfig: () => source(), paths, records, state });
  // v1.7.0 特性1：E 投影通道（记忆正文常驻注入）。与 hybrid 同理，无条件注册——
  // 其内部读热配置，无副作用（enabled=false 或命中静默预设时 buildProjections 返回空）。
  // v1.7.2：把 isSessionSilent 透传下去——投影按**会话**判定，故必须知道 agent 所属会话的预设。
  registerProjection({ ctx, getConfig: () => source(), paths, isSilent: isSessionSilent });

  // ---------- v1.7.2：静默会话（enabled=false 或命中静默预设）的工具 schema 隐身 ----------
  // 背景：`complete: true` 只收缩 sections、**不裁剪 tools**——记忆工具的 schema 仍会经 toolProvider
  // 进 assemble，在"裸测环境"里白吃 token 且可能被模型幻觉调用。故静默会话需显式隐身工具。
  // 机制约束：① enabled / silentPresets 都是热配置，apply() 同步段读不到 → 不能条件注册（否则切回后
  //   工具从未注册，同 v1.6.0 hybrid 踩坑）；② tools.restrict() 要求 agent 作用域 ctx、静态名单、
  //   dispose 才解除；③ 宿主无"当前是哪个 preset"的装配期 API，但 agent/created 时 session 创建头已带
  //   agentPreset（composeAgent 写入解析后的 id），故此处判定可靠。
  // 落法：挂 agent/created 建立掩码，并在**空会话切换预设**时同步（宿主允许"尚未产生任何消息"的会话
  //   改预设；此时模型还没看过任何东西，掩码必须跟着变，否则切到极简后工具仍暴露）。
  // 语义与 model selection 一致（能力集在 agent 装配前冻结）：运行中热切 enabled / silentPresets
  // 仅影响后续新建 agent，当前 agent 不变——可接受（execute 内已有 enabled 兜底，即便残留 schema 被调
  // 也返回 disabled）。
  // deny 名单含 4 基础工具 + 3 hybrid 工具；log_read_section / log_write_ops 是子 agent 内部工具
  // （经 ctx.llm.stream 的 tools 参数、不入全局层），列进 deny 会触发 unknown-tool 抛错，故不含。
  const MEMORY_TOOL_NAMES = [
    "memory_note",
    "memory_note_user",
    "memory_read",
    "memory_delete",
    "memory_write",
    "memory_update_section",
    "memory_reorganize",
  ];
  // sessionId → agent（仅用于切换预设时重新同步掩码；agent/disposed 时清理，避免长跑进程里越积越多）
  const agentBySession = new Map();
  // sessionId → restrict() 的解除函数（掩码是否已戴，靠它判断 + 反向解除）
  const toolMaskBySession = new Map();

  /** 按会话当前预设同步工具掩码：静默→戴上（deny 全部记忆工具），非静默→摘下。幂等。 */
  function syncToolMask(agent) {
    const sessionId = agent?.session?.id;
    if (!sessionId) return;
    const masked = toolMaskBySession.has(sessionId);
    const silent = isSessionSilent(agent?.session);
    if (silent === masked) return;
    try {
      if (silent) {
        const release = agent?.ctx?.tools?.restrict({ deny: MEMORY_TOOL_NAMES });
        if (typeof release === "function") toolMaskBySession.set(sessionId, release);
      } else {
        toolMaskBySession.get(sessionId)?.();
        toolMaskBySession.delete(sessionId);
      }
    } catch (error) {
      // 绝不冒泡：restrict 抛错（如某工具因异常未注册命中 unknown-tool）时降级为"不隐身"，
      // 由 execute 的 enabled 兜底保证功能仍停用，只是没省掉 schema token。
      console.error(`[memory-palace] tool-hide skipped: ${error?.message || String(error)}`);
    }
  }

  ctx.on("agent/created", ({ agent }) => {
    if (agent?.session?.id) agentBySession.set(agent.session.id, agent);
    syncToolMask(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    const sessionId = agent?.session?.id;
    if (!sessionId) return;
    try {
      toolMaskBySession.get(sessionId)?.();
    } catch {
      /* scope 已在卸载，忽略 */
    }
    toolMaskBySession.delete(sessionId);
    agentBySession.delete(sessionId);
  });

  // ---- session/event 跟踪：更新 activeCwd/activeSession/增量断点 + 累积 turnBuffer ----
  // 关键：一次用户请求在 dsh agent 循环里会被拆成多个 turn（每个工具调用一轮），
  // 故 buffer 必须跨 turn 累积整个 request，不能在单个 turn/end 清空——否则最终 turn/end
  // 触发时 buffer 只剩残缺片段（无 user 请求、无 tool/result），防闲聊闸门误判为非实质轮次、不写记忆。
  // 结算策略：debounce（安静期后只结算一次）+ 新 user/message 时立即结算上一个 request。
  ctx.on("session/event", (session, event) => {
    if (session) state.activeSession = session;
    if (session?.header?.cwd) state.activeCwd = session.header.cwd;
    // 切换 session 时重置智能模式增量断点（新会话从 firstLiveSeq 起算）。
    if (session && session.id !== state.summarySessionId) {
      state.summarySessionId = session.id;
      state.lastSummarizedSeq = session.firstLiveSeq;
    }
    const type = event?.type;
    // v1.7.2：预设切换（仅空会话可切；宿主在切换提交后追加该事件）。记进 Map 供 isSessionSilent 读取。
    if (type === "agent-preset/selected") {
      const id = event?.data?.agentPreset;
      if (session?.id && typeof id === "string" && id) state.presetBySession.set(session.id, id);
      // 掩码跟随：会话切进/切出静默预设时立即戴上或摘下（此时模型尚未看过任何内容，
      // 不做这一步会出现"切到极简、工具 schema 仍暴露"的漏网）。
      const owner = session?.id ? agentBySession.get(session.id) : undefined;
      if (owner) syncToolMask(owner);
      return;
    }
    // 计划模式：禁写记忆（硬编码默认行为，无开关；不依赖 dsh-plan-mode 服务，未装则永不触发=安全降级=不拦截）
    if (type === "plan/mode") {
      state.planModeActive = !!(event?.data?.active);
      return;
    }
    if (type === "user/message" || type === "assistant/message" || type === "tool/result") {
      // v1.7.0 特性1 连带修复：turnBuffer 只采集【真实用户消息】。
      // E 投影的 user/message（source.kind === 'plugin'）也在 SURFACE 里，若不过滤会被
      // 采集进 buffer，并触发下方 `type === "user/message" && state.turnBuffer.length` 的
      // _flushTurn() —— 打乱 request 边界、污染关键词闸门（结算时取第一条 user 文本）。
      // 判定用【黑名单】而非白名单（fail-open）：只在 source 明确存在且非 'user' 时排除。
      // 理由：source 缺失时若按"非 user"丢弃，真实用户消息会被漏掉 → 闸门关闭 → 记忆整体
      // 丢失（本项目历史上最严重的一类 bug）。注入类消息在 DSH 中必带 source，故放行风险极低。
      const srcKind = event?.data?.source?.kind;
      if (type === "user/message" && srcKind && srcKind !== "user") return;
      const text = extractText(event);
      if (text) {
        const role = type === "tool/result" ? "tool" : type === "user/message" ? "user" : "assistant";
        // 新用户请求到来：先结算并清空上一个 request（若存在），避免与本请求混淆。
        if (type === "user/message" && state.turnBuffer.length) _flushTurn();
        state.turnBuffer.push({ role, text });
        if (state.turnBuffer.length > TURN_BUFFER_MAX) state.turnBuffer = state.turnBuffer.slice(-TURN_BUFFER_MAX);
        const total = state.turnBuffer.reduce((n, b) => n + b.text.length, 0);
        if (total > TURN_BUFFER_CHAR_CAP) {
          // v1.1.3 修复：溢出时【保留尾部最近内容】而非替换成占位——占位会让 hasTool/关键词判定
          // 全部失效（长工具型 request 的 tool 块被清空 → 结算闸门误判关闭 → 记忆整体丢失）。
          state.turnBuffer = state.turnBuffer.slice(-8);
        }
      }
    } else if (type === "turn/end") {
      // 累积 request 级错误信号（跨 turn 合并），供结算时统一判定。
      const reason = event?.data?.reason;
      if (reason?.kind === "error") {
        state.sawErrorTurn = true;
        state.lastErrorMsg = (reason?.message || reason?.error?.message || "")?.toString() || "";
      }
      // 不清空 buffer；用 debounce 在整段请求安静后结算一次。
      _scheduleSettle();
    } else if (type === "compaction" || type?.startsWith?.("compaction/")) {
      // v1.7.0：无需再清"已注入标记"（该机制已删）——记忆正文改经 E 投影注入，
      // compaction 把投影消息移出 surface 后，后续 step 的去重扫描找不到它 → 自动重注。
    }
  });

  // ---------- 读取：同步 section text（systemPrompt 要求同步） ----------
  // v1.7.1：section **只保留恒定内容**（intro 指令 + 记忆分工说明 + planNote），
  // 今日工作日志已迁入 E 投影（src/projection.mjs）。
  // 分流依据是「内容是否恒定」：恒定 → 留 section（system prompt 在序列最前，内容恒定则
  // 前缀缓存永久有效）；易变 → 走 E 投影追加到历史尾部，且按文件身份只注一次。
  // ⚠️ 切勿把任何「每步可能变化」的内容放回本 section —— 变一次就会让其后整段前缀作废。
  //    实测代价：9 次全量重算、命中率从 99.26% 掉到 94.53%（见 testdata/session.v3.jsonl）。
  ctx.systemPrompt.section({
    name: "memory-palace",
    order: 50,
    // v1.7.2：text 接收宿主 AssembleContext（`{ agent, scope, signal }`，见 agent 包 assembleContextFor），
    // 故可按**会话**判定预设静默 —— 与投影/工具/写入同一判据，避免"half-injected"状态。
    text: (context) => {
      const cfg = source();
      if (!cfg.enabled) return "";
      // v1.7.2：极简（裸测）预设整体静默。注：minimal 预设的 complete:true 本来也会吞掉本节，
      // 这里显式返回空串是为了① 覆盖"自定义静默预设未用 complete"的情形；② 让本节的去留与其余
      // 通道严格一致，便于排障（不会出现"投影关了、section 还在"的错觉）。
      if (isSessionSilent(context?.agent?.session)) return "";
      // v1.7.0：alreadyInjected / injectedSessionIds 已整体删除（记忆正文改走 E 投影）。
      // intro（含记忆公民指令）仍【始终】注入——若因记忆为空而整体返回空串，agent 将不知道
      // 记忆系统存在、不会主动记，形成「无记忆 → 无指令 → 永不记」死循环。
      const bridged = paths.buddyDirs().length > 0;
      const antiMangle =
        "提及记忆文件路径时一律用 ~ 简写（如 ~/.deepseek-harness/MEMORY.md），不要逐字拼写绝对路径——你转述绝对路径容易漏掉目录分隔符。";
      // v1.1.0：按记忆模式注入不同指令。插件模式=记忆公民指令（引导 agent 主动记）；
      // 智能模式=简短说明（记忆由 LLM 智能摘要自动维护，无需主动记，但仍可用 memory_read 读）。
      // v1.6.0：hybrid=记忆子代理自动维护日志 + agent 主动维护 MEMORY.md（见 HYBRID_PROACTIVE）。
      const proactive =
        source().memoryMode === "smart"
          ? "\n\n[记忆说明] 你的跨 session 记忆由 LLM 智能摘要自动维护（每轮结束自动提炼摘要并沉淀 durable 事实到 MEMORY.md），无需主动调用 memory_note / memory_note_user；读取记忆用 memory_read 工具，scope 默认 'memory'，需要日志时显式传 scope（不要手动 glob/read 记忆文件）。"
          : source().memoryMode === "hybrid"
            ? HYBRID_PROACTIVE
            : "\n\n[记忆公民指令] 你拥有跨 session 的 Markdown 记忆。以下场景【必须】主动调用 memory_note（项目级约定）或 memory_note_user（跨项目个人偏好）落档，不要依赖轮次结束的自动兜底——它只做原始文本截断，无法代替你的高质量总结：\n" +
              "① 完成任务 / 工作并产出结果（写脚本、统计、分析、修复、交付）→ 记任务做了什么 + 关键结果（路径/命令/数字）\n" +
              "② 修复 bug / 定位根因（记现象 + 根因 + 绕过/修复手法，防复发）\n" +
              "③ 验证 build/test/CI 通过（记命令与结论）\n" +
              "④ 完成里程碑 / 关键决策 / 变更约定（记决策与理由）\n" +
              "⑤ 用户表达的偏好、约束、durable 事实（记原话要点）\n" +
              "判定标准：这条信息「下个 session 的我」还需要吗？不需要（闲聊、一次性操作、显而易见）就不记。格式：一句话结论开头 + 关键细节（命令/路径/数字），不写流水账。";
      const intro = bridged
        ? "你拥有持久化、人类可直接编辑的 Markdown 记忆文件。当前项目已存在 WorkBuddy/CodeBuddy 项目记忆目录，本插件直接读写这些目录（不再单独创建 .deepseek-harness/memory/）。" +
          "写入记忆：项目级约定用 memory_note 工具，跨项目个人偏好用 memory_note_user 工具；读取记忆用 memory_read 工具，scope 默认 'memory'（用户级 + 项目级 MEMORY.md），需要今日/历史日志时显式传 scope:'daily' 或 'all'（不要手动 glob/read 记忆文件）。用它保持跨 session 一致性；看不到的内容不要编造。" +
          "注意：上下文中的记忆是**会话起始快照**，不随记忆文件之后的更新自动刷新；需要以当前状态为依据时（改记忆前、或据记忆作答前）用 memory_read 重读。" +
          antiMangle + proactive
        : "你拥有持久化、人类可直接编辑的 Markdown 记忆文件（位于 ~/.deepseek-harness/MEMORY.md，以及各项目的 .deepseek-harness/MEMORY.md（长期记忆）与 .deepseek-harness/memory/（每日日志））。" +
          "写入记忆：项目级约定用 memory_note 工具，跨项目个人偏好用 memory_note_user 工具；读取记忆用 memory_read 工具，scope 默认 'memory'（用户级 + 项目级 MEMORY.md），需要今日/历史日志时显式传 scope:'daily' 或 'all'（不要手动 glob/read 记忆文件）。用它保持跨 session 一致性；看不到的内容不要编造。" +
          "注意：上下文中的记忆是**会话起始快照**，不随记忆文件之后的更新自动刷新；需要以当前状态为依据时（改记忆前、或据记忆作答前）用 memory_read 重读。" +
          antiMangle + proactive;
      // 计划模式禁写提示（硬编码默认行为，无开关）：无论记忆模式都追加，让 agent 自觉不写（网关物理兜底仍生效）
      const planNote = state.planModeActive
        ? "\n\n[plan 模式] 当前处于 plan 模式，不要调用 memory_note / memory_note_user 写入记忆，也不要请求删除记忆（读取记忆用 memory_read，仍可用）。"
        : "";
      const introFull = intro + planNote;
      // v1.7.1（特性3）：自定义指令追加在「记忆插件 prompt + 记忆分工 prompt」之后 ——
      // 拼接顺序即 system prompt 里的实际排布（同一 section 内完成，order 不变）。
      // 它由用户在设置页配置，内容恒定 → 放 system 零缓存成本，不违反本节的分流原则。
      const custom = typeof cfg.customInstructions === "string" ? cfg.customInstructions.trim() : "";
      // v1.7.1：本 section 已无任何动态块（日志迁出 E 投影），直接返回常量指令。
      // 返回值仍非空串（即便自定义指令为空也含 intro），避免 harness 对空 section 的处理歧义。
      return custom ? `${introFull}\n\n[用户自定义指令] ${custom}` : introFull;
    },
  });

  // ---------- 结算一个完整 request：基于累积缓冲做「错误捕获 + 轻量兜底记录（闸门）」，不调 LLM ----------
  // 主路径是 agent 按记忆公民指令主动调 memory_note；此处只兜底保证"实质轮次不丢"。
  async function _settle(capturedTurn, isError, errMsg) {
    // 计划模式禁写（硬编码默认，无开关）：自动写路径全拦截（智能模式/轻量兜底/错误捕获同源跳过）
    if (state.planModeActive) return;
    const cfg = source();
    if (!cfg.enabled) return;
    // v1.7.2：静默会话（极简等预设）不写任何记忆——错误捕获 / 轻量兜底 / smart 摘要 / hybrid 子代理
    // 全部在此一处提前返回（hybrid 分支在其下方，天然被拦）。
    if (isSessionSilent(state.activeSession)) return;
    const dirs = paths.writeDirs();
    if (!dirs.length) return;

    // 基础闸门（A+D 合并）：结构信号（工具/错误/主动记）或 场景关键词 → 开。
    const userText = capturedTurn.find((b) => b.role === "user")?.text ?? "";
    const hitKeyword = SCENE_KEYWORDS.some((k) => userText.includes(k));
    const hasTool = capturedTurn.some((b) => b.role === "tool");
    const agentWrote = state.recentAgentWrote;

    // 错误信号：request 级终态错误（任一 turn/end reason.kind==='error'）或 工具/代码执行期错误。
    const toolErr = extractToolErrorText(capturedTurn);
    const effectiveIsError = isError || !!toolErr;

    let baseGateOpen = effectiveIsError || hasTool || agentWrote || hitKeyword;

    // v1.1.0：按记忆模式分派。智能模式=LLM 智能会话摘要（错误由摘要提炼；失败/返回 false 均降级轻量兜底）。
    if (cfg.memoryMode === "smart") {
      // v1.1.3 修复：turnBuffer 字符上限（30k）仍可能截断超长工具型 request，导致 hasTool 误判为
      // false（tool 块被裁剪）→ 结算闸门误关 → 记忆整体丢失。智能模式闸门改用 session 事件增量
      // （真实完整信号，不依赖会被裁剪的 turnBuffer）。
      // v1.6.2-alpha.4：宿主 0.1.2-alpha.4 删除 Session.events getter，事件读取统一走
      // eventsFrom 兼容层（snapshotEvents 半开区间，旧宿主回退 events+filter）。
      if (!baseGateOpen && state.activeSession) {
        const SURFACE = new Set(["user/message", "assistant/message", "tool/result"]);
        const newEvents = eventsFrom(state.activeSession, state.lastSummarizedSeq).filter(
          (e) => SURFACE.has(e.type),
        );
        if (newEvents.some((e) => e.type === "tool/result")) baseGateOpen = true;
      }
    }

    // v1.6.0 hybrid：记忆子代理每轮必跑（定案——不走闸门；plan 模式在上方已拦）。
    // 失败不降级 writeLightEntry（v1.6.0 定案：无格式原文会破坏日志章节化结构）——
    // 断点不推进，下一次 turn/end 子代理自动补蒸。
    if (cfg.memoryMode === "hybrid") {
      if (!cfg.summarize) return; // 总闸门（dirs.length 已在上方保证非空）
      void hybrid
        .runMemorySubagent({ ctx, getConfig: () => source(), paths, records, state, session: state.activeSession, dirs, isError: effectiveIsError })
        .catch(() => {});
      return;
    }

    // 写门控：命中闸门才写（受 summarize 总开关，插件/smart 模式共用）。
    if (!cfg.summarize || !baseGateOpen) return;

    if (cfg.memoryMode === "smart") {
      void distill.summarizeTurn(capturedTurn, dirs, effectiveIsError)
        .then((ok) => {
          if (!ok) return records.writeLightEntry(dirs, capturedTurn, effectiveIsError);
        })
        .catch(() => records.writeLightEntry(dirs, capturedTurn, effectiveIsError))
        .catch(() => {});
      return;
    }

    // 插件模式：错误捕获（受 autoCaptureErrors 门控）+ 轻量兜底记录。
    if (cfg.autoCaptureErrors && effectiveIsError) {
      const finalErrMsg = errMsg || toolErr || "(in-session error, no message)";
      void records.captureError(capturedTurn, { kind: "error", message: finalErrMsg }).catch(() => {});
    }
    void records.writeLightEntry(dirs, capturedTurn, effectiveIsError).catch(() => {});
  }

  // 立即结算并清空当前缓冲（供 debounce 到点、或收到新 user/message 时调用）。
  function _flushTurn() {
    const capturedTurn = state.turnBuffer;
    const wasErrorTurn = state.sawErrorTurn;
    const errMsg = state.lastErrorMsg;
    state.turnBuffer = [];
    state.sawErrorTurn = false;
    state.lastErrorMsg = "";
    state.recentAgentWrote = false;
    if (!capturedTurn.length) return;
    void _settle(capturedTurn, wasErrorTurn, errMsg).catch(() => {});
  }

  // debounce：每次 turn/end 重置计时器；SETTLE_DELAY 内无新 turn/end（即整段请求安静）才结算一次。
  function _scheduleSettle() {
    if (state.settleTimer) clearTimeout(state.settleTimer);
    state.settleTimer = setTimeout(() => {
      state.settleTimer = null;
      _flushTurn();
    }, SETTLE_DELAY);
  }
}
