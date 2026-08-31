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
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
// v1.6.0-rc1：适配 DSH 0.1.2-alpha.2——dsh-settings 不再导出自由函数 installSettingsSection /
// settingsNamespace，设置节注册改用 SettingsProvider 实例方法 installSection（经 ctx.inject(["settings"])）。
import { todayISO, expandHome, toHomeShort, readMdSync, budgetClip, stripSmartTag, stripDeletedLines, extractText, extractToolErrorText } from "./common/text.mjs";
import { SCENE_KEYWORDS } from "./common/prompts.mjs";
import { createPaths } from "./common/paths.mjs";
import { createRecords } from "./common/records.mjs";
import { createDistill } from "./distill.mjs";
import { registerTools } from "./tools.mjs";
import { registerApi } from "./api.mjs";
import { registerHybrid, HYBRID_PROACTIVE } from "./hybrid/index.mjs";

export const name = "memory-palace";
// v1.6.0-rc1：settingsNamespace() 已删除，namespace 直接用字符串（宿主侧做类型级校验）。
const MEMORY_PALACE_SETTINGS_NAMESPACE = "memory-palace";

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description("启用 memory-palace 记忆注入与每日日志写入。"),
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
  summaryModel: Schema.string().default("").description("智能模式的摘要模型，留空=复用当前会话 provider/model；也可填 provider/model（如 deepseek/deepseek-chat）固定廉价模型省 token。"),
  summaryTimeoutMs: Schema.number().default(60000).description("蒸馏 LLM 调用的超时（毫秒），超时视为失败并降级；覆盖智能模式摘要与手动蒸馏两条链路；默认 60000（60s）。"),
  distillDebugLog: Schema.boolean().default(false).description("调试开关：向 dsh 服务端 stderr 输出蒸馏 LLM 调用诊断。distillLogLevel=info 时仅输出元数据（模型解析/请求参数/流进度/错误详情，不含文本）；distillLogLevel=debug 会额外打印 LLM 原始响应文本（分隔符包裹），仅限受信本地排障开启。"),
  // ---- v1.4.1：蒸馏 stderr 日志级别（平铺键，不进 UI；默认 info；distillDebugLog=true 时生效） ----
  distillLogLevel: Schema.string().default("info").description("蒸馏 stderr 日志级别：info=仅元数据诊断（默认，不打印 LLM 原始响应）；debug=额外打印 LLM 原始响应文本（分隔符包裹），仅限受信本地排障开启。无需 UI 配置，经 profile/settings.yaml 设置 distillLogLevel 键。"),
  // ---- v1.4.0：智能模式最终输出软预算（v1.4.1 起语义变更：prompt 软约束，思考不受限；实际硬上限由模型自身 maxTokens 决定） ----
  summaryMaxTokens: Schema.number().default(2000).description("智能模式会话摘要 LLM 的【最终输出软预算（prompt 约束，思考不受限）】。默认 2000。实际硬上限由模型自身 maxTokens 决定；可调大以容纳更多 durable 事实。"),
  projectMaxTokens: Schema.number().default(8000).description("手动「蒸馏项目记忆」LLM 的【最终输出软预算（prompt 约束，思考不受限）】。默认 8000。实际硬上限由模型自身 maxTokens 决定。"),
  // ---- v1.4.0：蒸馏时回喂存量记忆（特性3，默认关；开启后自动智能模式 turn/end 与手动蒸馏按钮均回喂，delete 仅手动放开） ----
  feedbackEnabled: Schema.boolean().default(false).description("蒸馏时把项目级 + 用户级 MEMORY.md 全文（逐行编号、无截断）回喂给 LLM，使其能基于既有记忆做 add/replace/delete 增量维护。默认关；开启后自动智能模式（turn/end）与手动蒸馏会话按钮均回喂存量记忆；delete 仍仅手动按钮开放，自动模式跳过（防误删）。hybrid 模式下此开关不参与（子代理自带日志回喂）。"),
  // ---- v1.6.0：hybrid 模式配置（仅 memoryMode=hybrid 时生效） ----
  reorgCooldownDays: Schema.number().default(7).description("hybrid 模式：项目级 MEMORY.md 全量重整的冷却天数（距上次重整）。与「超出注入预算」双条件同时满足才允许 memory_reorganize；时间戳以 HTML 注释落在 MEMORY.md 文件尾。"),
  subagentLogBudget: Schema.number().default(20000).description("hybrid 模式：记忆子代理回喂今日工作日志的字符上限。超出时仅回喂章节目录，子代理用 log_read_section 按需读取章节。"),
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
    // v1.4.1：已注入记忆的 session 集合——仅首次注入（DSH 会话自身继承历史轮次，逐轮注入
    // = 内容重复 + 过时断言每轮在场）；compaction 发生后清除对应 id，下次构建重注。
    injectedSessionIds: new Set(),
  };
  const TURN_BUFFER_MAX = 30;
  // v1.1.3：字符上限提升到 30k（长工具型 request 的工具结果动辄数千字符，6k 上限会触发
  // 溢出保护清空 tool 块 → 闸门误判 → 记忆整体丢失）。
  const TURN_BUFFER_CHAR_CAP = 30000;
  const SETTLE_DELAY = 1500;

  // ---- 装配：路径解析 / 记录读写 / 蒸馏 / 工具 / route ----
  const paths = createPaths(() => source(), () => state.activeCwd);
  const records = createRecords({ getConfig: () => source(), paths });
  const distill = createDistill({ ctx, getConfig: () => source(), paths, records, state });
  registerTools({ ctx, getConfig: () => source(), paths, records, state });
  registerApi({ ctx, paths, distill, state, getSettingsFace });
  // v1.6.0：hybrid 模式独立模块。必须【无条件注册】——apply() 同步段执行时 settings 服务
  // 尚未挂载（v1.6.0-rc1 起设置节经 SettingsProvider.installSection 在 ctx.inject(["settings"])
  // 回调里注册并同步 setSource），此刻 source() 读的是 cordis 组合配置（默认 plugin），
  // 条件注册会导致设置页切 hybrid 后工具/子代理从未注册（v1.6.0 实装踩坑：settings.yaml
  // memoryMode=hybrid 但 registerHybrid 未执行 → 子代理 TypeError 被吞、日志全空）。
  // 运行时分派靠 _settle / proactive 的热 source() 判断；工具注册无副作用（plugin/smart
  // 的 prompt 不引导使用，guards 白名单只拦 hybrid 工具）。
  const hybrid = registerHybrid({ ctx, getConfig: () => source(), paths, records, state });

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
    // 计划模式：禁写记忆（硬编码默认行为，无开关；不依赖 dsh-plan-mode 服务，未装则永不触发=安全降级=不拦截）
    if (type === "plan/mode") {
      state.planModeActive = !!(event?.data?.active);
      return;
    }
    if (type === "user/message" || type === "assistant/message" || type === "tool/result") {
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
      // v1.4.1：compaction 压缩上下文后，记忆块可能被压掉——清除已注入标记，
      // 下次 system prompt 构建时重注（压缩后上下文变薄，重注时机依然正确）。
      if (session?.id) state.injectedSessionIds.delete(session.id);
    }
  });

  // ---------- 读取：同步 section text（systemPrompt 要求同步） ----------
  ctx.systemPrompt.section({
    name: "memory-palace",
    order: 50,
    text: () => {
      const cfg = source();
      if (!cfg.enabled) return "";
      const userFileResolved = expandHome(cfg.userMemoryPath);
      const userFileShort = toHomeShort(userFileResolved);
      const blocks = [];
      // v1.2.0：注入按预算截断——用户级 ≤ userBudgetChars、工作区级（MEMORY.md 与今日日志）
      // 各自 ≤ workspaceBudgetChars。v1.4.1：budgetClip 改为"结构行 + 尾部最新条目"（修
      // LIFO/FIFO 错配——写入追加在尾部，旧实现只留头部导致最新结论永远进不了视野），
      // stripSmartTag 剥除行首 [smart] 标记（模型不可见该标签，存量自然消亡）。
      // v1.6.0：stripDeletedLines 剔除整行删除线墓碑（文件保留、注入不过）。
      const u = readMdSync(userFileResolved);
      if (u) blocks.push(`# 用户级记忆 (${userFileShort})\n${stripSmartTag(stripDeletedLines(budgetClip(u, cfg.userBudgetChars)))}`);
      for (const dir of paths.readDirs()) {
        const dirShort = toHomeShort(dir);
        const w = paths.memoryReadCandidates(dir).map(readMdSync).filter(Boolean).join("\n\n");
        if (w) blocks.push(`# 工作区记忆 (${dirShort})\n${stripSmartTag(stripDeletedLines(budgetClip(w, cfg.workspaceBudgetChars)))}`);
        const t = readMdSync(join(dir, `${todayISO()}.md`));
        if (t) blocks.push(`# 今日工作日志 (${todayISO()} @ ${dirShort})\n${stripSmartTag(stripDeletedLines(budgetClip(t, cfg.workspaceBudgetChars)))}`);
      }
      // v1.4.1：仅首次注入。DSH 会话自身引用历史轮次作为上下文，逐轮注入 = 内容重复 +
      // 过时断言每轮在场；记忆注入的价值大头在冷启动第一轮。已注入过的 session 返回
      // 空串；compaction 后经 session/event 清除标记实现重注。
      // intro 指令仍始终注入（无记忆时也不例外——否则 agent 不知道记忆系统存在，形成
      // 「无记忆→无指令→永不记」死循环）；被跳过的只是记忆正文块。
      const sessionId = state.activeSession?.id ?? null;
      const alreadyInjected = sessionId ? state.injectedSessionIds.has(sessionId) : false;
      if (sessionId && !alreadyInjected && blocks.length) state.injectedSessionIds.add(sessionId);
      if (alreadyInjected) blocks.length = 0;
      // 记忆正文可能为空（冷启动 / 全新环境尚无任何记忆）。
      // 注意：intro（含记忆公民指令）必须【始终】注入——若因记忆为空而整体返回空串，
      // agent 将不知道记忆系统存在、不会主动记，形成「无记忆 → 无指令 → 永不记」的死循环。
      const bridged = paths.buddyDirs().length > 0;
      const antiMangle =
        "提及记忆文件路径时一律用 ~ 简写（如 ~/.deepseek-harness/MEMORY.md），不要逐字拼写绝对路径——你转述绝对路径容易漏掉目录分隔符。";
      // v1.1.0：按记忆模式注入不同指令。插件模式=记忆公民指令（引导 agent 主动记）；
      // 智能模式=简短说明（记忆由 LLM 智能摘要自动维护，无需主动记，但仍可用 memory_read 读）。
      // v1.6.0：hybrid=记忆子代理自动维护日志 + agent 主动维护 MEMORY.md（见 HYBRID_PROACTIVE）。
      const proactive =
        source().memoryMode === "smart"
          ? "\n\n[记忆说明] 你的跨 session 记忆由 LLM 智能摘要自动维护（每轮结束自动提炼摘要并沉淀 durable 事实到 MEMORY.md），无需主动调用 memory_note / memory_note_user；读取全部记忆用 memory_read 工具（不要手动 glob/read 记忆文件）。"
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
          "写入记忆：项目级约定用 memory_note 工具，跨项目个人偏好用 memory_note_user 工具；读取全部记忆用 memory_read 工具（不要手动 glob/read 记忆文件）。用它保持跨 session 一致性；看不到的内容不要编造。" +
          antiMangle + proactive
        : "你拥有持久化、人类可直接编辑的 Markdown 记忆文件（位于 ~/.deepseek-harness/MEMORY.md，以及各项目的 .deepseek-harness/MEMORY.md（长期记忆）与 .deepseek-harness/memory/（每日日志））。" +
          "写入记忆：项目级约定用 memory_note 工具，跨项目个人偏好用 memory_note_user 工具；读取全部记忆用 memory_read 工具（不要手动 glob/read 记忆文件）。用它保持跨 session 一致性；看不到的内容不要编造。" +
          antiMangle + proactive;
      // 计划模式禁写提示（硬编码默认行为，无开关）：无论记忆模式都追加，让 agent 自觉不写（网关物理兜底仍生效）
      const planNote = state.planModeActive
        ? "\n\n[plan 模式] 当前处于 plan 模式，不要调用 memory_note / memory_note_user 写入记忆，也不要请求删除记忆（读取记忆用 memory_read，仍可用）。"
        : "";
      const introFull = intro + planNote;
      // v1.4.1：blocks 为空（已注入过）时只返回 intro 指令；返回值永非空串，
      // 避免 harness 对空 section 的处理歧义。
      return blocks.length ? [introFull, ...blocks].join("\n\n") : introFull;
    },
  });

  // ---------- 结算一个完整 request：基于累积缓冲做「错误捕获 + 轻量兜底记录（闸门）」，不调 LLM ----------
  // 主路径是 agent 按记忆公民指令主动调 memory_note；此处只兜底保证"实质轮次不丢"。
  async function _settle(capturedTurn, isError, errMsg) {
    // 计划模式禁写（硬编码默认，无开关）：自动写路径全拦截（智能模式/轻量兜底/错误捕获同源跳过）
    if (state.planModeActive) return;
    const cfg = source();
    if (!cfg.enabled) return;
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
      if (!baseGateOpen && state.activeSession && state.activeSession.events) {
        const SURFACE = new Set(["user/message", "assistant/message", "tool/result"]);
        const newEvents = state.activeSession.events.filter(
          (e) => e.seq >= state.lastSummarizedSeq && SURFACE.has(e.type),
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
