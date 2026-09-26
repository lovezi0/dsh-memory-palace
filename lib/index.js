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
// 6. 记忆写入（v1.8.0 起恒定「混合模式」）：由记忆子代理每轮自动维护今日日志（章节化、标删去重），
//    长期记忆 MEMORY.md 由 agent 主动写入（章节化写入 / 整章节替换 / 门禁内全量重整）。
//    v1.8.0 破坏性变更：`plugin`（记忆公民指令 + 轮次轻量兜底 + 错误捕获）与 `smart`
//    （LLM 自动会话摘要）两模式连同 `memoryMode` 配置一并移除——它们的能力已被混合模式覆盖
//    （主动记忆由 agent 按 HYBRID_PROACTIVE 承担，摘要由子代理写入日志承担），且格式化质量更高。
//    配置项一律「直接从 schema 摘除」，绝不收窄 union：宿主装载期校验走 standard-schema 入口
//    （cordis resolveConfig → Config["~standard"].validate），收窄枚举会让存量 profile 装载期抛
//    ValidationError；摘除字段则未知键原样透传、老配置值静默失效（见 DSH-CONTRACT-TRACKING.md）。
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
import { createPaths } from "./common/paths.mjs";
import { planModeOf } from "./common/planmode.mjs";
import { createRecords } from "./common/records.mjs";
import { createDistill } from "./distill.mjs";
import { registerTools } from "./tools.mjs";
import { registerApi } from "./api.mjs";
import { registerHybrid, HYBRID_PROACTIVE } from "./hybrid/index.mjs";
import { registerProjection } from "./projection.mjs";

export const name = "memory-palace";
// v1.6.0-rc1：settingsNamespace() 已删除，namespace 直接用字符串（宿主侧做类型级校验）。
const MEMORY_PALACE_SETTINGS_NAMESPACE = "memory-palace";

// v1.7.2-alpha.2：适配 dsh 0.1.7-alpha.1 契约破坏（DSH-CONTRACT-TRACKING.md §1.6）。
// - 契约5：MessageSourceMap 删除通用 'plugin' kind → 投影/子代理消息 source 改用宿主
//   v3→v4 迁移约定 `plugin:dsh-memory-palace`（去重判据向后兼容旧形态，防升级前已 resume 的会话重复注入）。
// - 契约10：SettingsProvider.installSection 整包删除 → ctx.settings 改挂 SettingsForms
//   （describe/replace，写 profile patch）。配置项全部标 `.volatile()`：0.1.7 中「无 volatile 字段的
//   条目不进设置表单、replace 直接抛错」。volatile HMR 把新值原地提交进同一 Volatile 引用，故
//   source() 每次解包读 config 即得最新值，不再需要旧版 setSource 覆盖层切换。
// - settings.yaml 已被宿主移除（导入 profile patch 一次）→ distillLogLevel 说明改口。
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description("启用 memory-palace：记忆注入、记忆工具与每日日志写入的总开关（v1.8.0 起为**唯一**写入开关——不再有独立的「记忆写入总开关」，插件装好并启用即视为写入启用）。").volatile(),
  // ---- v1.7.2：预设级静默（官方 minimal「裸测环境」口径）----
  // 宿主把「模式」实现为 agent 平面的 preset：minimal 预设用 persona complete:true 独占 system prompt。
  // 但本插件注册在 host 平面（profile bundle 的 insert），各通道对**每个 agent** 都生效，preset 并不会
  // 把它摘掉——故须自行按会话判据静默，否则记忆正文仍会经 E 投影进历史（实测症状）。
  silentPresets: Schema.array(Schema.string()).default(["minimal"]).description("在这些 agent 预设下本插件整体静默（等价 enabled=false）：不注入系统提示词与投影、记忆工具对模型隐身、不写日志、不跑记忆子代理。默认 [\"minimal\"]（官方极简模式）；置空数组 = 关闭该机制。判据取会话创建头 agentPreset 与 agent-preset/selected 事件（宿主公开事实）。").volatile(),
  userMemoryPath: Schema.string().default("~/.deepseek-harness/MEMORY.md").description("用户级记忆文件路径（支持 ~ 展开）。").volatile(),
  workspaceMemoryDir: Schema.string().default(".deepseek-harness/memory").description("无 buddy 目录时使用的项目级每日日志目录；项目级 MEMORY.md 位于其同级（.deepseek-harness/MEMORY.md）。").volatile(),
    // v1.8.0：默认值由 4000/3000 调大为 8000/6000 —— 实测项目级 MEMORY.md 8507 字符、
    // 单日日志峰值 26776 字符，旧值把它们砍掉 6 成以上。
    // ⚠️ 语义（定案：保持「每文件上限」而非改成总量封顶）：
  //   预算对**每个文件**各生效一次，不是所有记忆文件合计的总量。注入份数 = 用户级 1
  //   + 项目级 MEMORY.md（dsh 原生 + dsh 旧嵌套 + 每个已存在 buddy 目录各 1，最多 4）
  //   + 今日日志（dsh + 每个 buddy 目录各 1，最多 3）→ 实测最坏 8 条消息 ≈ 5 万字符 = 7.1 倍。
  //   故文档/文案必须写明「每个文件各自的上限」，不得写成「总量」。
  // ⚠️ workspaceBudgetChars 一身三职（E 投影截断 / memory_read 每块截断 / **memory_reorganize 双门禁阈值**）：
  //   调它会同时移动「重整触发线」，二者保持一致（超出注入预算 = 该重整了）是刻意设计。
  userBudgetChars: Schema.number().default(8000).description("用户级 MEMORY.md 经「E 投影」注入时的长度上限（字符）。⚠️ 是「每个文件各自」的上限，不是所有记忆文件合计的总量上限。").volatile(),
  workspaceBudgetChars: Schema.number().default(6000).description("工作区侧注入上限（字符），一身三职：① 项目级 MEMORY.md 的 E 投影上限；② 今日工作日志的 E 投影上限——①②各自独立截断、互不挤占；③ 项目记忆重整门禁阈值（超出即允许重整）+ memory_read 读日志的每块截断预算。⚠️ 同样是「每个文件各自」的上限，不是总量：dsh 目录与每个已存在的 buddy 目录会各注一份。").volatile(),
  // 桥接 WorkBuddy / CodeBuddy 项目记忆：项目已存在这些目录时直接读写，不再单独建 .deepseek-harness/memory/。
  bridgeBuddyMemory: Schema.boolean().default(true).description("检测并直接读写 WorkBuddy / CodeBuddy 项目记忆目录。").volatile(),
  buddyWorkspaceMemoryDirs: Schema.array(Schema.string()).default([".workbuddy/memory", ".codebuddy/memory"]).description("要桥接的 buddy 项目记忆目录列表（按优先级，全部已存在目录会同步写入）。").volatile(),
  // ---- v1.8.0：memoryMode / autoCaptureErrors / summarize / dailyLogRetentionDays 已移除 ----
  // 旧 profile 若仍写着这些键，作为未知键原样透传、静默失效；用户下次在设置页保存时自动从 profile patch 消失。
  // 「记忆写入总开关」也一并删除（v1.8.0）：写入是否发生改由 `enabled`（profile config 级停用）与
  // `silentPresets`（会话预设级静默）决定，不再有独立的写入闸门。
  summaryModel: Schema.string().default("").description("记忆插件当前使用的模型（手动「蒸馏会话」/「蒸馏项目记忆」与记忆子代理共用）。留空=复用当前会话 provider/model；也可填 provider/model（如 deepseek/deepseek-chat）固定廉价模型省 token。").volatile(),
  summaryTimeoutMs: Schema.number().default(60000).description("蒸馏 LLM 调用的超时（毫秒），超时视为失败并降级；覆盖手动「蒸馏会话」/「蒸馏项目记忆」与记忆子代理三条链路；默认 60000（60s）。").volatile(),
  distillDebugLog: Schema.boolean().default(false).description("调试开关：向 dsh 服务端 stderr 输出蒸馏 LLM 调用诊断。distillLogLevel=info 时仅输出元数据（模型解析/请求参数/流进度/错误详情，不含文本）；distillLogLevel=debug 会额外打印 LLM 原始响应文本（分隔符包裹），仅限受信本地排障开启。").volatile(),
  // ---- v1.4.1：蒸馏 stderr 日志级别（平铺键，不进 UI；默认 info；distillDebugLog=true 时生效） ----
  distillLogLevel: Schema.string().default("info").description("蒸馏 stderr 日志级别：info=仅元数据诊断（默认，不打印 LLM 原始响应）；debug=额外打印 LLM 原始响应文本（分隔符包裹），仅限受信本地排障开启。无需 UI 配置，经 profile 的 cordis.patch.yml 在 memory-palace 条目 config 下设置 distillLogLevel 键（dsh 0.1.7 起 settings.yaml 已被宿主移除、导入 profile patch）。").volatile(),
  // ---- v1.4.0：手动「蒸馏会话」最终输出软预算（v1.4.1 起语义变更：prompt 软约束，思考不受限；实际硬上限由模型自身 maxTokens 决定） ----
  summaryMaxTokens: Schema.number().default(2000).description("手动「蒸馏会话」LLM 的最终输出软预算（prompt 约束，思考不受限；实际硬上限由模型自身 maxTokens 决定）。默认 2000；可调大以容纳更多 durable 事实。").volatile(),
  projectMaxTokens: Schema.number().default(8000).description("手动「蒸馏项目记忆」LLM 的最终输出软预算（prompt 约束，思考不受限；实际硬上限由模型自身 maxTokens 决定）。默认 8000。").volatile(),
  // ---- v1.4.0：蒸馏时回喂存量记忆（特性3，默认关；开启后手动蒸馏按钮回喂，delete 仅手动放开） ----
  feedbackEnabled: Schema.boolean().default(false).description("每次蒸馏时把项目级 + 用户级 MEMORY.md 全文（逐行编号、无截断）回喂给 LLM，使其能基于既有记忆做增量维护（delete 手动蒸馏按钮开放）。自动路径走记忆子代理、自带日志回喂，不受此项影响。默认关。").volatile(),
  // ---- v1.6.0：记忆子代理配置 ----
  reorgCooldownDays: Schema.number().default(7).description("项目级 MEMORY.md 全量重整的冷却天数（距上次重整）。与「超出注入预算」（`workspaceBudgetChars`，即项目级 MEMORY.md 大于该值）双条件同时满足才允许 memory_reorganize；时间戳以 HTML 注释落在 MEMORY.md 文件尾。").volatile(),
  subagentLogBudget: Schema.number().default(20000).description("记忆子代理回喂今日工作日志的字符上限。超出时仅回喂章节目录，子代理用 log_read_section 按需读取章节。").volatile(),
  // ---- v1.7.1（特性3）：自定义指令（用户自写，经 system prompt 注入到「记忆分工 prompt」之后） ----
  // 放 system 而非 E 投影：用户配置一次即恒定 → 零缓存成本（见下方 section 的分流原则）。
  customInstructions: Schema.string().default("").description("自定义指令：非空时追加到系统提示词「记忆分工说明」之后，用于承载不适合写进用户记忆的特殊指令。对全部会话生效；留空则不注入。").volatile(),
});

export const inject = ["systemPrompt", "tools", "llm", "webServer", "webRuntime"];

/**
 * v1.7.2-alpha.2（dsh 0.1.7 适配）：解包 cordis 解析后的 cosmokit Volatile 引用。
 * 0.1.7 起 Config schema 字段标 `.volatile()`，loader 解析后该字段值不再是原始值，
 * 而是 `{ get(): snapshot, [writeSymbol]: fn }` 引用对象（热改时原地更新、不重载 fiber）。
 * 宿主自己的 consumer 一律 `.get()` 读；本插件全部配置经 source() 消费，故在此统一解包。
 * 判定用鸭子类型（cosmokit 跨包不共享私有 write Symbol，不能用它的 isVolatile 判外部对象；
 * 本项目配置字段里没有任何自带 `.get` 方法的值，误判面为零）。递归处理数组/对象。
 * @param {unknown} value 解析后的配置值
 * @returns {unknown} 纯数据快照（与旧宿主行为一致）
 */
function unwrapConfig(value) {
  if (value === null || typeof value !== "object") return value;
  if (typeof value.get === "function" && !Array.isArray(value)) return unwrapConfig(value.get());
  if (Array.isArray(value)) return value.map(unwrapConfig);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = unwrapConfig(v);
  return out;
}

export function apply(ctx, config) {
  // 设置集成：在 DSH 设置页暴露 memory-palace 配置面板；运行时优先读用户设置覆盖层，
  // 未挂载 settings 服务时回退到 cordis 组合里的 config。
  // v1.6.0-rc1：注册动作挪进下方 ctx.inject(["settings"]) 回调（installSection 是
  // SettingsProvider 实例方法，须等 settings 服务挂载；其内部同步 setSource，时序与旧版等价）。
  // v1.7.2-alpha.2：配置真源统一 = cordis 注入的 config（0.1.7 起即 profile 条目 config、热改原地生效）。
  let source = () => unwrapConfig(config);
  const baseEntry = { ...config };

  // ---- v1.1.3：设置读写 route（真保存）/ v1.7.2-alpha.2：适配 dsh 0.1.7 SettingsForms ----
  // client fetch 同源 /memory-palace/api/settings.get|update，绕过 apiproxy allowlist；
  // handler 内直接走服务端 settings 面 → profile patch 持久化。
  // 写用 replace 语义（整节替换）：表单里留空的字段自动回退 base/schema 默认，与「保存=提交整个表单」一致。
  // v1.7.2-alpha.2 适配（dsh 0.1.7-alpha.1）：dsh-settings 整包重写为 SettingsForms——
  //   ① 不再有 installSection / setSource / onChange：配置的**唯一真源 = profile 条目 config**，
  //      应用值就是 cordis 注入的 config，且热改经 loader 原地生效（volatile 字段经引用更新、
  //      其余字段整 fiber 重载），故 source 恒为 () => config，无需 setSource 切换。
  //      ⚠️ cordis loader 解析后 volatile 字段是 cosmokit 引用对象 `{ get(), [write] }`
  //      （非原始值！schemastery resolve 对 meta.volatile 的字段 createVolatile 包装）——
  //      所有配置读取必须经下方 unwrapConfig() 解包，否则 cfg.enabled 拿到对象→真值判断全乱。
  //      鸭子判定 typeof value.get === 'function'（cosmokit 的 write Symbol 跨包不共享、
  //      不能用它的 isVolatile 判外部对象；本项目 config 值里没有自带 get() 的字段，零误判面）。
  //   ② describe({redactSecrets:true}) 返回 SettingsDescriptor[]（ns/schema/value/revision/user），
  //      replace/update/mutate 签名保持 (ns, section, expectedRevision)——本插件整节提交走 replace。
  //   ③ 前提：Config schema 须显式 .volatile()（0.1.7 只把 volatile 字段投影进表单；
  //      全无 volatile 的条目 describe 不列出、write 直接抛「no volatile fields」）。
  let settingsFace = null;
  ctx.inject(["settings"], (sctx) => {
    const ns = MEMORY_PALACE_SETTINGS_NAMESPACE;
    const viewOf = () => {
      const descriptor = sctx.settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ns);
      return descriptor === undefined
        ? { value: undefined, user: undefined, revision: undefined }
        : { value: descriptor.value, user: descriptor.user, revision: descriptor.revision };
    };
    // v1.7.2-alpha.2 双栈：旧宿主（0.1.6 线 SettingsProvider）有 installSection，须注册节并把 setSource
    // 切到解析层；新宿主（0.1.7 SettingsForms）无此方法——配置真源即 profile 条目 config，
    // 热改经 loader 生效，source 保持 () => config 即可。describe/replace 两栈签名兼容。
    if (typeof sctx.settings.installSection === "function") {
      sctx.settings.installSection(ctx, ns, Config, baseEntry, {
        setSource: (next) => {
          source = () => unwrapConfig(next());
        },
        onChange: () => {},
      });
    }
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
    // ---- 每会话状态分桶（修复：结算写入错项目）----
    // 下面三者的语义都是「当前请求所属会话」，原实现放在进程级全局上，而 session/event 是无条件
    // 覆盖的 → 多会话并发时必然互相污染：A 会话的内容被结算进 B 项目目录。按 sessionId 分桶后互不干扰。
    // 被取代并删除的全局单值字段（勿再引回）：`turnBuffer` / `sawErrorTurn` / `settleTimer`
    // 对应前三个 Map；`lastSummarizedSeq` / `breakpointSessionId` 对应 seqBySession。
    // 注：seqBySession 是记忆子代理的**增量断点**（session 事件 seq），不是已删的 smart 模式残留
    // ——`hybrid/subagent.mjs` 在调用方未注入 getSeq/setSeq 时仍会回落到全局 state.lastSummarizedSeq
    // （单测 tests/test-hybrid.mjs 就走该回退路径）。
    buffersBySession: new Map(), // sessionId -> { turnBuffer, sawErrorTurn, session }
    settleTimers: new Map(),     // sessionId -> debounce timer
    seqBySession: new Map(),     // sessionId -> 记忆子代理增量断点
    // plan 模式：禁写记忆（硬编码默认，无开关）。
    // 宿主是**会话级**状态（`session.append('plan/mode')`，见 common/planmode.mjs），故按会话记；
    // `planModeActive` 仅作「拿不到会话上下文」时的兜底值。未装 dsh-plan-mode 则永不触发 = 不拦截。
    planModeBySession: new Map(), // sessionId -> 该会话是否处于 plan 模式（判定优先看它）
    planModeActive: false,        // 兜底：最近一次 plan/mode 事件的值，供拿不到会话上下文的场合使用
    // v1.7.2：会话 → agent 预设 id（仅"切换预设"事件写入；创建头另在 presetOfSession 里兜底读）。
    // 只增不减：会话结束后残留几条字符串，代价可忽略；切回同一 session 断言预设不变（宿主侧保证）。
    presetBySession: new Map(),
    // v1.7.0：injectedSessionIds 已删除——记忆正文改经 E 投影（src/projection.mjs）注入为
    // 常驻消息，compaction 后由投影自动重注，不再需要"仅首次注入"的会话级标记。
    // v1.8.0：recentAgentWrote（原防闲聊闸门信号）与 summarySessionId（原 smart 模式会话标记）
    // 随 plugin / smart 两模式一并删除。
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
  const distill = createDistill({ ctx, getConfig: () => source(), paths, records });
  registerTools({ ctx, getConfig: () => source(), paths, state });
  registerApi({ ctx, paths, distill, getSettingsFace });
  // v1.8.0：记忆子代理模块（原 hybrid）。必须【无条件注册】——apply() 同步段执行时 settings 服务
  // 尚未挂载，此刻 source() 读的是 cordis 组合配置（未显式配置时即 schema 默认）；
  // 条件注册会在热配置变化后导致工具/子代理从未注册（v1.6.0 实装踩坑：配置写着启用但
  // registerHybrid 未执行 → 子代理 TypeError 被吞、日志全空）。
  // 运行时分派靠 _settle / proactive 的热 source() 判断；工具注册无副作用（enabled=false 或静默
  // 会话下 execute 内有兜底）。
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

  // ---- session/event 跟踪：更新 activeCwd/activeSession + 累积 turnBuffer ----
  // 关键：一次用户请求在 dsh agent 循环里会被拆成多个 turn（每个工具调用一轮），
  // 故 buffer 必须跨 turn 累积整个 request，不能在单个 turn/end 清空——否则最终 turn/end
  // 触发时 buffer 只剩残缺片段（无 user 请求、无 tool/result），工具期错误信号（extractToolErrorText）
  // 会取不到，传给记忆子代理的 isError 随之失准。
  // 结算策略：debounce（安静期后只结算一次）+ 新 user/message 时立即结算上一个 request。
  // 取/建某会话的状态桶（sessionId 缺失时归入同一个兜底桶，保持旧行为不失效）。
  function bucketOf(sessionId) {
    const id = sessionId || "__nosession__";
    let b = state.buffersBySession.get(id);
    if (!b) {
      b = { turnBuffer: [], sawErrorTurn: false, session: null };
      state.buffersBySession.set(id, b);
    }
    return b;
  }

  ctx.on("session/event", (session, event) => {
    if (session) state.activeSession = session;
    if (session?.header?.cwd) state.activeCwd = session.header.cwd;
    const sid = session?.id || "__nosession__";
    const bucket = bucketOf(sid);
    if (session) bucket.session = session;
    // 切换 session 时重置记忆子代理的增量断点（新会话从 firstLiveSeq 起算）。
    // 必须做：seq 按会话独立编号，沿用上一会话的断点会让 projectTurnMessages 取到空区间 →
    // 子代理静默 noop、日志永不落盘（v1.6.0 起沿用至今；v1.8.0 核查确认此处不是 smart 残留）。
    // 断点同样按会话分桶：全局单值会让并发会话互相重置。
    if (session && !state.seqBySession.has(sid)) {
      state.seqBySession.set(sid, session.firstLiveSeq);
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
      // plan 模式是**会话级**事实（宿主 `session.append('plan/mode')`）→ 必须按会话记：
      // 用全局单值会让 A 的 plan 状态波及 B —— B 记忆不落盘 / B 的 prompt 被注入 plan 提示 / B 写工具被拒。
      const on = !!(event?.data?.active);
      // 兜底值【始终】跟随最近一次事件：工具闸门等拿不到会话上下文的场合靠它判定
      // （若只在"无会话事件"时才写，兜底会恒为 false → 那些场合漏拦）。
      state.planModeActive = on;
      // 会话级精确记录：有会话身份时判定只看这张表（无记录 = 该会话未进 plan = false，不回落全局）。
      if (session?.id) state.planModeBySession.set(session.id, on);
      return;
    }
    if (type === "user/message" || type === "assistant/message" || type === "tool/result") {
      // v1.7.0 特性1 连带修复：turnBuffer 只采集【真实用户消息】。
      // E 投影的 user/message（source.kind === 'plugin:dsh-memory-palace'）也在 SURFACE 里，若不过滤
      // 会被采集进 buffer，并触发下方 `type === "user/message" && bucket.turnBuffer.length` 的
      // _flushTurn() —— 打乱 request 边界、污染回喂子代理的对话内容。
      // 判定用【黑名单】而非白名单（fail-open）：只在 source 明确存在且非 'user' 时排除。
      // 理由：source 缺失时若按"非 user"丢弃，真实用户消息会被漏掉 → request 边界与错误信号全错
      // （本项目历史上最严重的一类 bug）。注入类消息在 DSH 中必带 source，故放行风险极低。
      const srcKind = event?.data?.source?.kind;
      if (type === "user/message" && srcKind && srcKind !== "user") return;
      const text = extractText(event);
      if (text) {
        const role = type === "tool/result" ? "tool" : type === "user/message" ? "user" : "assistant";
        // 新用户请求到来：先结算并清空上一个 request（若存在），避免与本请求混淆。
        // 缓冲按会话分桶：否则 A 会话的消息会混进 B 会话的结算，连同内容一起写错项目。
        if (type === "user/message" && bucket.turnBuffer.length) _flushTurn(sid, bucket);
        bucket.turnBuffer.push({ role, text });
        if (bucket.turnBuffer.length > TURN_BUFFER_MAX) bucket.turnBuffer = bucket.turnBuffer.slice(-TURN_BUFFER_MAX);
        const total = bucket.turnBuffer.reduce((n, b) => n + b.text.length, 0);
        if (total > TURN_BUFFER_CHAR_CAP) {
          // v1.1.3 修复：溢出时【保留尾部最近内容】而非替换成占位——占位会让工具期错误检测
          // （extractToolErrorText）失效，传给记忆子代理的 isError 失准、错误现象漏记。
          bucket.turnBuffer = bucket.turnBuffer.slice(-8);
        }
      }
    } else if (type === "turn/end") {
      // 累积 request 级错误信号（跨 turn 合并），供结算时统一判定并传给记忆子代理。
      // 同样按会话分桶：全局标志会让 A 会话的错误把 B 会话的日志标成 isError。
      if (event?.data?.reason?.kind === "error") bucket.sawErrorTurn = true;
      // 不清空 buffer；用 debounce 在整段请求安静后结算一次（定时器按会话独立）。
      _scheduleSettle(sid);
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
      // intro【始终】注入——若因记忆为空而整体返回空串，agent 将不知道记忆系统存在、不会主动记，
      // 形成「无记忆 → 无指令 → 永不记」死循环。
      const bridged = paths.buddyDirs().length > 0;
      const antiMangle =
        "提及记忆文件路径时一律用 ~ 简写（如 ~/.deepseek-harness/MEMORY.md），不要逐字拼写绝对路径——你转述绝对路径容易漏掉目录分隔符。";
      // v1.8.0：记忆写入恒定混合模式——今日日志由记忆子代理自动维护，长期记忆 MEMORY.md 由 agent 主动维护。
      // 原 plugin（记忆公民指令）/ smart（智能摘要说明）两分支已随模式一并删除；
      // HYBRID_PROACTIVE 内含 agent 侧写入职责与场景，是唯一的分工指令来源。
      const proactive = HYBRID_PROACTIVE;
      const intro = bridged
        ? "你拥有持久化、人类可直接编辑的 Markdown 记忆文件。当前项目已存在 WorkBuddy/CodeBuddy 项目记忆目录，本插件直接读写这些目录（不再单独创建 .deepseek-harness/memory/）。" +
          "写入记忆：项目级约定用 memory_note 工具，跨项目个人偏好用 memory_note_user 工具；读取记忆用 memory_read 工具，scope 默认 'memory'（用户级 + 项目级 MEMORY.md），需要今日/历史日志时显式传 scope:'daily' 或 'all'（不要手动 glob/read 记忆文件）。用它保持跨 session 一致性；看不到的内容不要编造。" +
          "注意：上下文中的记忆是**会话起始快照**，不随记忆文件之后的更新自动刷新；需要以当前状态为依据时（改记忆前、或据记忆作答前）用 memory_read 重读。" +
          antiMangle + proactive
        : "你拥有持久化、人类可直接编辑的 Markdown 记忆文件（位于 ~/.deepseek-harness/MEMORY.md，以及各项目的 .deepseek-harness/MEMORY.md（长期记忆）与 .deepseek-harness/memory/（每日日志））。" +
          "写入记忆：项目级约定用 memory_note 工具，跨项目个人偏好用 memory_note_user 工具；读取记忆用 memory_read 工具，scope 默认 'memory'（用户级 + 项目级 MEMORY.md），需要今日/历史日志时显式传 scope:'daily' 或 'all'（不要手动 glob/read 记忆文件）。用它保持跨 session 一致性；看不到的内容不要编造。" +
          "注意：上下文中的记忆是**会话起始快照**，不随记忆文件之后的更新自动刷新；需要以当前状态为依据时（改记忆前、或据记忆作答前）用 memory_read 重读。" +
          antiMangle + proactive;
      // 计划模式禁写提示（硬编码默认行为，无开关）：让 agent 自觉不写（网关物理兜底仍生效）。
      // 按**会话**判定：plan 模式是会话级状态，别的会话进 plan 不该往本会话 prompt 里塞这条提示。
      const planNote = planModeOf(state, context?.agent?.session)
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

  // ---------- 结算一个完整 request：交给记忆子代理写今日日志（不在此处做任何直接写入） ----------
  // v1.8.0：原「防闲聊闸门 + 轻量兜底 + 错误捕获」（plugin）、「LLM 摘要分派」（smart）
  // 与「记忆写入总开关」(summarize) 均已删除，本函数收敛为单一路径：前置闸门 → 算错误信号 → 子代理。
  async function _settle(capturedTurn, isError, sid, boundSession) {
    // 会话身份由入参显式传入（原实现读全局 state.activeSession，多会话并发时会写到别的项目目录）。
    // boundSession 缺失时兜底用全局，保持旧行为不失效。
    const session = boundSession || state.activeSession;
    // 计划模式禁写（硬编码默认，无开关）：plan 模式是**会话级**状态 → 只拦该会话本身；写入路径在此一处拦截
    if (planModeOf(state, session)) return;
    const cfg = source();
    if (!cfg.enabled) return;
    // v1.7.2：静默会话（极简等预设）不写任何记忆——记忆子代理在此一处提前返回。
    if (isSessionSilent(session)) return;
    const cwd = session?.header?.cwd ?? null;
    const dirs = paths.writeDirs(cwd);
    if (!dirs.length) return;

    // 错误信号：request 级终态错误（任一 turn/end reason.kind==='error'）或 工具/代码执行期错误。
    // 只作布尔传给子代理（错误现象本身在对话里，子代理自己看得到）——原 plugin 模式据此写
    // MEMORY.md 的 `in-session 错误` 行，该链路已随 plugin 模式删除。
    const effectiveIsError = isError || !!extractToolErrorText(capturedTurn);

    // v1.8.0：原「记忆写入总开关」(summarize) 已删除——走到这里即写入。
    // 停写只剩两条路：`enabled=false`（profile config）与 `silentPresets` 命中（会话预设级静默），二者均在上方拦截。
    // v1.6.0 hybrid：记忆子代理每轮必跑（定案——不走内容闸门；plan 模式与静默会话在上方已拦）。
    // 失败【不】降级为任何轻量写入（v1.6.0 定案：无格式原文会破坏日志章节化结构）——
    // 子代理内部不推进断点，下一次 turn/end 自动补蒸。
    void hybrid
      .runMemorySubagent({
        ctx,
        getConfig: () => source(),
        paths,
        records,
        state,
        session,
        dirs,
        isError: effectiveIsError,
        // 断点按会话分桶：全局单值在并发会话下会被互相重置，导致子代理静默 noop、日志不落盘。
        getSeq: () => state.seqBySession.get(sid) ?? session?.firstLiveSeq ?? 0,
        setSeq: (v) => state.seqBySession.set(sid, v),
      })
      .catch(() => {});
  }

  // 立即结算并清空当前缓冲（供 debounce 到点、或收到新 user/message 时调用）。
  function _flushTurn(sid, bucket) {
    // 结算归属由入参会话决定（不再读全局 state.activeSession）。
    const bound = bucket || bucketOf(sid);
    const capturedTurn = bound.turnBuffer;
    const wasErrorTurn = bound.sawErrorTurn;
    bound.turnBuffer = [];
    bound.sawErrorTurn = false;
    if (!capturedTurn.length) return;
    void _settle(capturedTurn, wasErrorTurn, sid, bound.session).catch(() => {});
  }

  // debounce：每次 turn/end 重置计时器；SETTLE_DELAY 内无新 turn/end（即整段请求安静）才结算一次。
  function _scheduleSettle(sid) {
    // 每个会话独立计时：共用单一定时器时，B 的 turn/end 会把 A 的待结算 clearTimeout 掉 → A 整段丢失。
    const id = sid || "__nosession__";
    const prev = state.settleTimers.get(id);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      state.settleTimers.delete(id);
      const bound = state.buffersBySession.get(id);
      if (bound) _flushTurn(id, bound);
    }, SETTLE_DELAY);
    state.settleTimers.set(id, t);
  }
}
