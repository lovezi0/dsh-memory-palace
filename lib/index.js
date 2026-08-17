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
// 6. 记忆写入（v0.7.1 起）：主路径 = 记忆公民 prompt 主动记忆（注入「记忆公民指令」让 agent 主动调
//    memory_note/memory_note_user，零额外 LLM 调用、模型上下文完整）；turn/end 仅做轻量兜底——
//    基础闸门（工具/错误/关键词/已主动记）命中则写原始文本截断的轻量条目（不调 LLM）；
//    错误捕获只记「错误现象」（根因/方案由 agent 主动记）。已废弃插件侧 callLlm 自动摘要
//    （ctx.llm.stream 契约复杂、requestHeader 时机不稳，见 plans/v0.7.0.md 方案修订）。

import { readFileSync, existsSync } from "node:fs";
import { mkdir, readdir, unlink, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import Schema from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "memory-palace";
const MEMORY_PALACE_SETTINGS_NAMESPACE = settingsNamespace("memory-palace");

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
});

export const inject = ["systemPrompt", "tools"];

// 本地日期（YYYY-MM-DD）。绝不能再用 toISOString()——它返回 UTC 日期，本地 0-8 点会
// 把记忆写到"昨天"的日志（真机实测：本地 2026-08-18 00:26 的条目写进了 2026-08-17.md）。
const todayISO = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};

// 自己展开 ~，避免依赖 dsh-home-paths 的解析负担（homedir 即可）。
function expandHome(p) {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(1));
  }
  return p;
}

// 反向简写：home 下的绝对路径 → ~ 简写（统一正斜杠）。AI 转述绝对路径极易拼错
// （实测出现过 lovezi0.deepseek-harness 缺分隔符），一律喂给它 ~ 简写。
function toHomeShort(p) {
  if (!p) return p;
  const h = homedir();
  if (p === h) return "~";
  if (p.startsWith(h + "\\") || p.startsWith(h + "/")) {
    return "~" + p.slice(h.length).replace(/\\/g, "/");
  }
  return p;
}

// 读取 Markdown 文件（同步，systemPrompt section 要求同步）。
function readMdSync(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

// 场景关键词（增强原方案 D）：命中即视为"用户告知偏好 / 做出技术决策"，纯文本轮次也写。
const SCENE_KEYWORDS = ["记住", "记一下", "remind", "偏好", "决定", "以后都", "约定", "采用", "根因", "修复"];

export function apply(ctx, config) {
  // 设置集成：在 DSH 设置页暴露 memory-palace 配置面板；运行时优先读用户设置覆盖层，
  // 未挂载 settings 服务时回退到 cordis 组合里的 config。
  let source = () => config;
  const baseEntry = { ...config };
  installSettingsSection(ctx, MEMORY_PALACE_SETTINGS_NAMESPACE, Config, baseEntry, {
    setSource: (next) => {
      source = next;
    },
    onChange: () => {},
  });

  // 跟踪当前 session 的 cwd（每次 session/event 都会带上 session 引用）。
  let activeCwd = null;
  let activeSession = null;
  // 每轮缓冲：存 {role,text}，role ∈ user/assistant/tool。
  // 关键：一次用户请求在 dsh agent 循环里会被拆成多个 turn（每个工具调用一轮），
  // 故 buffer 必须跨 turn 累积整个 request，不能在单个 turn/end 清空——否则最终 turn/end
  // 触发时 buffer 只剩残缺片段（无 user 请求、无 tool/result），防闲聊闸门误判为非实质轮次、不写记忆。
  // 结算策略：debounce（安静期后只结算一次）+ 新 user/message 时立即结算上一个 request。
  let turnBuffer = [];
  const TURN_BUFFER_MAX = 30;
  const TURN_BUFFER_CHAR_CAP = 6000;
  // agent 主动调 memory_note / memory_note_user 标志（本轮已主动记）。
  let recentAgentWrote = false;
  // 跨 turn 累积的 request 级错误信号（任何 turn/end 的 reason.kind==='error' 都标记，结算时统一判定）。
  let sawErrorTurn = false;
  let lastErrorMsg = "";
  // debounce 计时器：request 安静 SETTLE_DELAY 毫秒后触发一次结算。
  let settleTimer = null;
  const SETTLE_DELAY = 1500;

  // 从单个 content block 抽取文本。兼容两类：
  // - text block：顶层 {type:"text", text:"..."}（user/assistant 消息）
  // - tool-result block：{type:"tool-result", content: ContentBlock[]}，文本嵌套在 content 内（真机 tool/result 即如此，
  //   若只取 .text 会取空——这是此前「工具任务轮次不落记忆」的根因）
  function blockText(x) {
    if (typeof x === "string") return x;
    if (!x || typeof x !== "object") return "";
    if (typeof x.text === "string") {
      // 丢弃 harness 注入的运行时上下文快照块（真机 assistant/message 常以一个
      // "Current runtime context. This snapshot supersedes…" 开头的独立 text block 出现），
      // 避免把 DSH file policy 等系统噪声记进记忆。
      if (/^Current runtime context\./i.test(x.text)) return "";
      return x.text;
    }
    if (Array.isArray(x.content)) return x.content.map(blockText).join("");
    return "";
  }

  function extractText(event) {
    try {
      const d = event?.data ?? {};
      // user/message 的 event.data 直接是 UserMessage（无外层包装）→ 走 d.content；
      // assistant/message、tool/result 的 event.data 带 {message: ...} → 走 d.message.content。
      const c = d.message?.content ?? d.content ?? d.text;
      let text;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.map(blockText).join("");
      else if (c && typeof c === "object") text = JSON.stringify(c);
      else text = "";
      // 剥离 harness 注入的 <system-reminder>…</system-reminder> 系统块（实测 hello 轮次会抓到可用 skills 列表），
      // 避免把系统噪声记进记忆 / 误命中关键词。runtime-context 快照块在 blockText 层按块丢弃。
      return text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, "").trim();
    } catch {
      return "";
    }
  }

  // 从工具执行结果中识别错误。in-session 错误未必以 turn/end 的 reason.kind==='error' 暴露——
  // 代码运行报错、工具执行失败常以 tool/result 形式呈现，agent 看到错误后正常收尾（reason.kind 为 completed），
  // 故需单独扫描工具结果文本。命中即视为错误信号（受 autoCaptureErrors 门控）。
  function extractToolErrorText(turn) {
    for (const b of turn) {
      if (b.role !== "tool") continue;
      if (/code run failed|exception[:\s]|referenceerror|typeerror|syntaxerror|error:\s|traceback|执行失败|运行出错|运行报错/i.test(b.text)) {
        return b.text.slice(0, 300);
      }
    }
    return null;
  }

  ctx.on("session/event", (session, event) => {
    if (session) activeSession = session;
    if (session?.header?.cwd) activeCwd = session.header.cwd;
    const type = event?.type;
    if (type === "user/message" || type === "assistant/message" || type === "tool/result") {
      const text = extractText(event);
      if (text) {
        const role = type === "tool/result" ? "tool" : type === "user/message" ? "user" : "assistant";
        // 新用户请求到来：先结算并清空上一个 request（若存在），避免与本请求混淆。
        if (type === "user/message" && turnBuffer.length) _flushTurn();
        turnBuffer.push({ role, text });
        if (turnBuffer.length > TURN_BUFFER_MAX) turnBuffer = turnBuffer.slice(-TURN_BUFFER_MAX);
        const total = turnBuffer.reduce((n, b) => n + b.text.length, 0);
        if (total > TURN_BUFFER_CHAR_CAP) turnBuffer = [{ role: "user", text: "(buffer overflowed, summary only)" }];
      }
    } else if (type === "turn/end") {
      // 累积 request 级错误信号（跨 turn 合并），供结算时统一判定。
      const reason = event?.data?.reason;
      if (reason?.kind === "error") {
        sawErrorTurn = true;
        lastErrorMsg = (reason?.message || reason?.error?.message || "")?.toString() || "";
      }
      // 不清空 buffer；用 debounce 在整段请求安静后结算一次。
      _scheduleSettle();
    }
  });

  // 磁盘上【已存在】的 buddy 项目记忆目录（按配置顺序）。绝不主动新建 buddy 目录。
  function buddyDirs() {
    const cfg = source();
    if (!cfg.enabled || !cfg.bridgeBuddyMemory || !activeCwd) return [];
    return cfg.buddyWorkspaceMemoryDirs
      .map((rel) => join(activeCwd, rel))
      .filter((d) => existsSync(d));
  }
  // 读取源：存在 buddy 目录则用它们；否则仅当 legacy dsh 目录已存在才读（不创建）。
  function readDirs() {
    const cfg = source();
    if (!cfg.enabled) return [];
    const b = buddyDirs();
    if (b.length) return b;
    const d = activeCwd ? join(activeCwd, cfg.workspaceMemoryDir) : null;
    // 不设 existsSync 门槛：即便每日日志目录尚未创建，也要能读到同级的 .deepseek-harness/MEMORY.md
    return d ? [d] : [];
  }
  // 写入目标：存在 buddy 目录则全部同步写入；否则回退 dsh 目录（按需创建）。
  function writeDirs() {
    const cfg = source();
    if (!cfg.enabled) return [];
    const b = buddyDirs();
    if (b.length) return b;
    const d = activeCwd ? join(activeCwd, cfg.workspaceMemoryDir) : null;
    return d ? [d] : [];
  }

  // 项目级 MEMORY.md 路径解析：
  // - dsh 原生目录（workspaceMemoryDir，默认 .deepseek-harness/memory）：MEMORY.md 与 memory/ 同级
  //   = join(activeCwd, dirname(workspaceMemoryDir), "MEMORY.md")，即 .deepseek-harness/MEMORY.md
  //   （读取兼容：旧嵌套位置 .deepseek-harness/memory/MEMORY.md 仍存在时不丢数据）
  // - buddy 目录（.workbuddy/memory 等）：保持嵌套 memory/MEMORY.md（与 WB/CB 原生格式兼容）
  function dshDailyDir() {
    const cfg = source();
    return activeCwd ? join(activeCwd, cfg.workspaceMemoryDir) : null;
  }
  function dshMemoryFile() {
    const cfg = source();
    return activeCwd ? join(activeCwd, dirname(cfg.workspaceMemoryDir), "MEMORY.md") : null;
  }
  function isDshDir(dir) {
    const d = dshDailyDir();
    return !!(d && dir && dir === d);
  }
  // 写入用：返回该目录对应的 MEMORY.md 绝对路径（dsh 原生→同级；buddy→嵌套；已是文件则原样返回）
  function memoryFileOf(dir) {
    if (!dir) return dir;
    if (dir.endsWith("MEMORY.md")) return dir; // 用户级路径本身即文件
    return isDshDir(dir) ? dshMemoryFile() : join(dir, "MEMORY.md");
  }
  // 读取用：dsh 原生返回 [同级, 旧嵌套] 两个候选；buddy 仅嵌套；已是文件则原样返回
  function memoryReadCandidates(dir) {
    if (!dir) return [];
    if (dir.endsWith("MEMORY.md")) return [dir];
    if (isDshDir(dir)) {
      const f = dshMemoryFile();
      return f ? [f, join(dir, "MEMORY.md")] : [join(dir, "MEMORY.md")];
    }
    return [join(dir, "MEMORY.md")];
  }

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
      const u = readMdSync(userFileResolved);
      if (u) blocks.push(`# 用户级记忆 (${userFileShort})\n${u}`);
      for (const dir of readDirs()) {
        const dirShort = toHomeShort(dir);
        const w = memoryReadCandidates(dir).map(readMdSync).filter(Boolean).join("\n\n");
        if (w) blocks.push(`# 工作区记忆 (${dirShort})\n${w}`);
        const t = readMdSync(join(dir, `${todayISO()}.md`));
        if (t) blocks.push(`# 今日工作日志 (${todayISO()} @ ${dirShort})\n${t}`);
      }
      // 记忆正文可能为空（冷启动 / 全新环境尚无任何记忆）。
      // 注意：intro（含记忆公民指令）必须【始终】注入——若因记忆为空而整体返回空串，
      // agent 将不知道记忆系统存在、不会主动记，形成「无记忆 → 无指令 → 永不记」的死循环。
      const bridged = buddyDirs().length > 0;
      const antiMangle =
        "提及记忆文件路径时一律用 ~ 简写（如 ~/.deepseek-harness/MEMORY.md），不要逐字拼写绝对路径——你转述绝对路径容易漏掉目录分隔符。";
      const proactive =
        "\n\n[记忆公民指令] 你拥有跨 session 的 Markdown 记忆。以下场景【必须】主动调用 memory_note（项目级约定）或 memory_note_user（跨项目个人偏好）落档，不要依赖轮次结束的自动兜底——它只做原始文本截断，无法代替你的高质量总结：\n" +
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
      return blocks.length ? [intro, ...blocks].join("\n\n") : intro;
    },
  });

  // ---------- 写入：轮次结束 → 追加每日日志（写入全部目标目录） ----------
  // 追加一行记忆，若目标文件已包含相同内容则跳过（去重），返回是否实际写入。
  async function appendLineDedup(file, line) {
    await mkdir(dirname(file), { recursive: true });
    let cur = "";
    try {
      cur = readFileSync(file, "utf8");
    } catch {
      /* 文件尚不存在 */
    }
    if (cur.includes(line)) return false;
    await writeFile(file, `${cur}\n${line}\n`, "utf8");
    return true;
  }

  // 行归一化：去掉 `- `/`* ` 前缀、合并空白、转小写，使"带不带前缀"的子串匹配都鲁棒。
  const normLine = (s) => s.replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim().toLowerCase();
  // 结构行（标题 / 蒸馏注释）受保护，永不被删除。
  const isStructural = (t) => t.startsWith("#") || t.startsWith("<!--");

  // 在文件中按内容匹配查找记忆条目行（不修改文件）。返回每条匹配：{tier,path,content}。
  function findMatches(file, match, tier, pathShort) {
    const m = (match || "").trim();
    if (!m) return [];
    let cur = "";
    try {
      cur = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const nm = normLine(m);
    const out = [];
    for (const raw of cur.split("\n")) {
      const t = raw.trim();
      if (!t || isStructural(t)) continue;
      if (normLine(t).includes(nm)) out.push({ tier, path: pathShort, content: t });
    }
    return out;
  }

  // 按内容匹配删除 MEMORY.md / 每日日志中的条目行；保护结构行；返回删除条数与被删内容明细。
  async function removeLineByMatch(file, match) {
    const m = (match || "").trim();
    if (!m) return { removed: 0, ok: false, reason: "empty-match", lines: [] };
    let cur = "";
    try {
      cur = readFileSync(file, "utf8");
    } catch {
      return { removed: 0, ok: true, reason: "no-file", lines: [] };
    }
    const nm = normLine(m);
    const lines = cur.split("\n");
    const kept = [];
    let removed = 0;
    const removedLines = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) {
        kept.push(line);
        continue;
      }
      if (isStructural(t)) {
        kept.push(line);
        continue;
      }
      if (normLine(t).includes(nm)) {
        removed++;
        removedLines.push(t);
        continue;
      }
      kept.push(line);
    }
    if (removed > 0) await writeFile(file, kept.join("\n"), "utf8");
    return { removed, ok: true, reason: "done", lines: removedLines };
  }

  // 读取目录下最近的非今日每日日志日期（最多 limit 份，降序）。供删除范围圈定。
  async function recentLogDates(dir, limit = 3) {
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const today = todayISO();
    return files
      .map((f) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f))
      .filter((mm) => mm && mm[1] < today)
      .map((mm) => mm[1])
      .sort()
      .reverse()
      .slice(0, limit);
  }

  // 删除作用域的中文标签。
  function levelLabel(level) {
    if (level === "user") return "用户级";
    if (level === "project") return "项目级与每日级";
    if (level === "daily") return "每日级";
    return level;
  }

  // 根据 level 圈定待查/待删的候选文件，每个文件带层级标签与短路径。
  // - user：用户级 MEMORY.md（~/.deepseek-harness/MEMORY.md）
  // - project：项目级 MEMORY.md（与 memory/ 同级）+ 今日每日日志
  // - daily：今日每日日志 + 最近 3 份历史每日日志（同工作区）
  async function deleteCandidates(level) {
    const cfg = source();
    const files = [];
    if (level === "user") {
      const file = expandHome(cfg.userMemoryPath);
      files.push({ file, tier: "用户级", path: toHomeShort(file) });
      return files;
    }
    const dirs = writeDirs();
    for (const dir of dirs) {
      const dirShort = toHomeShort(dir);
      if (level === "project") {
        const mem = memoryFileOf(dir);
        files.push({ file: mem, tier: "项目级", path: toHomeShort(mem) });
      }
      // 每日级：今日日志必查；daily 作用域额外纳入最近 3 份历史日志
      const todayFile = join(dir, `${todayISO()}.md`);
      files.push({ file: todayFile, tier: "每日级", path: `${dirShort}/${todayISO()}.md` });
      if (level === "daily") {
        const dates = await recentLogDates(dir, 3);
        for (const d of dates) files.push({ file: join(dir, `${d}.md`), tier: "每日级", path: `${dirShort}/${d}.md` });
      }
    }
    return files;
  }

  // 生成面向用户的删除确认文案：列出每条匹配的位置 + 实际内容 + 序号（多匹配即对应选项）。
  function buildConfirmPrompt(level, match, matches) {
    const lines = matches.map((mm, i) => `[${i + 1}] [${mm.tier}] ${mm.path}\n      "${mm.content}"`);
    return (
      `⚠️ 删除记忆确认（不可逆操作）\n` +
      `匹配文本："${match}"（作用域：${levelLabel(level)}）\n` +
      `共匹配到 ${matches.length} 条记忆：\n${lines.join("\n")}\n\n` +
      `请确认是否全部删除？若只想删除其中部分条目，请提供更精确的 match 重新预览后再确认。`
    );
  }

  async function appendDaily(dir, entry) {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${todayISO()}.md`);
    let existing = "";
    try {
      existing = readFileSync(file, "utf8");
    } catch {
      /* 文件尚不存在 */
    }
    await writeFile(file, existing + entry, "utf8");
    await prune(dir);
  }

  // 轻量结构化条目（无 LLM）：截断原始文本，错误带 [ERROR] 标记。
  async function writeLightEntry(dirs, turn, isError) {
    const userText = turn.find((b) => b.role === "user")?.text ?? "";
    const asstText = turn.filter((b) => b.role === "assistant").map((b) => b.text).join(" ");
    const summary = (userText || asstText || "(no message captured)").slice(0, 200);
    const tag = isError ? " [ERROR]" : "";
    const entry = `\n## ${new Date().toISOString()}${tag}\n${summary}\n`;
    for (const dir of dirs) await appendDaily(dir, entry);
  }

  // 错误捕获（目标2）：按 scope 落对应 MEMORY.md，条目含「错误现象 + 解决方案」。
  // 错误捕获：按 scope 落对应 MEMORY.md，条目仅含「错误现象」。
  // （v0.7.1 起不再调 LLM 生成方案——「根因/绕过手法」由 agent 按记忆公民指令场景①主动调 memory_note 记。）
  async function captureError(turn, reason) {
    const cfg = source();
    const dirs = writeDirs();
    if (!dirs.length && !expandHome(cfg.userMemoryPath)) return;
    const scope = dirs.length ? "project" : "user";
    const errText = (reason?.message || reason?.error?.message || "(in-session error, no message)")
      .toString()
      .slice(0, 300);
    const line = `- [${new Date().toISOString().slice(0, 10)}] in-session 错误（${scope}）：${errText}`;
    const targets = dirs.length ? dirs : [expandHome(cfg.userMemoryPath)];
    for (const dir of targets) {
      const mem = memoryFileOf(dir);
      await appendLineDedup(mem, line).catch(() => {});
    }
  }

  // 结算一个完整 request：基于累积缓冲做「错误捕获 + 轻量兜底记录（闸门）」，不调 LLM。
  // 主路径是 agent 按记忆公民指令主动调 memory_note；此处只兜底保证"实质轮次不丢"。
  async function _settle(capturedTurn, isError, errMsg) {
    const cfg = source();
    if (!cfg.enabled) return;
    const dirs = writeDirs();
    if (!dirs.length) return;

    // 基础闸门（A+D 合并）：结构信号（工具/错误/主动记）或 场景关键词 → 开。
    const userText = capturedTurn.find((b) => b.role === "user")?.text ?? "";
    const hitKeyword = SCENE_KEYWORDS.some((k) => userText.includes(k));
    const hasTool = capturedTurn.some((b) => b.role === "tool");
    const agentWrote = recentAgentWrote;

    // 错误信号：request 级终态错误（任一 turn/end reason.kind==='error'）或 工具/代码执行期错误。
    const toolErr = extractToolErrorText(capturedTurn);
    const effectiveIsError = isError || !!toolErr;

    const baseGateOpen = effectiveIsError || hasTool || agentWrote || hitKeyword;

    // 错误捕获（受 autoCaptureErrors 门控，与记录闸门独立）。
    if (cfg.autoCaptureErrors && effectiveIsError) {
      const finalErrMsg = errMsg || toolErr || "(in-session error, no message)";
      void captureError(capturedTurn, { kind: "error", message: finalErrMsg }).catch(() => {});
    }

    // 轻量兜底记录（受 summarize 总开关 + 写门控）：命中闸门才写每日日志。
    if (!cfg.summarize || !baseGateOpen) return;
    void writeLightEntry(dirs, capturedTurn, effectiveIsError).catch(() => {});
  }

  // 立即结算并清空当前缓冲（供 debounce 到点、或收到新 user/message 时调用）。
  function _flushTurn() {
    const capturedTurn = turnBuffer;
    const wasErrorTurn = sawErrorTurn;
    const errMsg = lastErrorMsg;
    turnBuffer = [];
    sawErrorTurn = false;
    lastErrorMsg = "";
    recentAgentWrote = false;
    if (!capturedTurn.length) return;
    void _settle(capturedTurn, wasErrorTurn, errMsg).catch(() => {});
  }

  // debounce：每次 turn/end 重置计时器；SETTLE_DELAY 内无新 turn/end（即整段请求安静）才结算一次。
  function _scheduleSettle() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      _flushTurn();
    }, SETTLE_DELAY);
  }

  async function prune(dir) {
    const cfg = source();
    const cutoff = Date.now() - cfg.dailyLogRetentionDays * 86400000;
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      return;
    }
    const mem = memoryFileOf(dir);
    for (const f of files) {
      const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f);
      if (!m) continue;
      if (new Date(m[1]).getTime() < cutoff) {
        const old = join(dir, f);
        const text = await readFile(old, "utf8").catch(() => "");
        if (text) {
          let cur = "";
          try {
            cur = readFileSync(mem, "utf8");
          } catch {
            /* 尚无 MEMORY.md */
          }
          await mkdir(dirname(mem), { recursive: true });
          await writeFile(mem, `${cur}\n<!-- distilled from ${f} -->\n${text}`, "utf8");
        }
        await unlink(old).catch(() => {});
      }
    }
  }

  // ---------- 可选工具：用户声明项目级约定/偏好时写入工作区 MEMORY.md ----------
  ctx.tools.register(
    defineTool({
      name: "memory_note",
      description:
        "Save a durable PROJECT-LEVEL memory entry to the active workspace's MEMORY.md " +
        "(the project's .workbuddy/memory, .codebuddy/memory, or .deepseek-harness/MEMORY.md). " +
        "Call it proactively after completing tasks for the CURRENT project (record what was done + key result / paths / numbers), " +
        "and when the user states a lasting preference, convention, or fact, or a key decision / root-cause fix is established. " +
        "Format: one-line conclusion first, then key details. For cross-project user-level memory, use memory_note_user instead.",
      parameters: {
        content: {
          type: "string",
          required: true,
          description: "The convention / preference / fact to remember, in one concise line.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            message: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value?.message ?? "Saved." }],
      },
      async execute(args) {
        recentAgentWrote = true;
        if (!source().enabled) return { ok: false, message: "memory-palace is currently disabled in settings." };
        const dirs = writeDirs();
        if (!dirs.length) return { ok: false, message: "No active workspace." };
        try {
          const line = `- ${args.content}`;
          let wrote = 0;
          let skipped = 0;
          for (const dir of dirs) {
            const mem = memoryFileOf(dir);
            if (await appendLineDedup(mem, line)) wrote++;
            else skipped++;
          }
          const dup = skipped > 0 ? ` (${skipped} already had it)` : "";
          return { ok: true, message: `Saved to ${wrote} workspace MEMORY.md file(s)${dup}.` };
        } catch (e) {
          return { ok: false, message: `Failed: ${e}` };
        }
      },
    }),
  );

  // ---------- 可选工具：用户声明跨项目个人偏好时写入用户级 MEMORY.md ----------
  ctx.tools.register(
    defineTool({
      name: "memory_note_user",
      description:
        "Save a durable USER-LEVEL (cross-project) preference or fact to the user-level MEMORY.md " +
        `(default ${toHomeShort(expandHome(config.userMemoryPath))}). ` +
        "Call it proactively when the user states a personal preference / constraint that applies across ALL projects, " +
        "or a reusable fact / decision worth keeping for future sessions. Format: one-line conclusion first, then key details. " +
        "For current-project conventions, use memory_note instead.",
      parameters: {
        content: {
          type: "string",
          required: true,
          description: "The user-level preference / fact to remember, in one concise line.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            message: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value?.message ?? "Saved." }],
      },
      async execute(args) {
        recentAgentWrote = true;
        const cfg = source();
        if (!cfg.enabled) return { ok: false, message: "memory-palace is currently disabled in settings." };
        try {
          const file = expandHome(cfg.userMemoryPath);
          const fileShort = toHomeShort(file);
          const line = `- ${args.content}`;
          const wrote = await appendLineDedup(file, line);
          return {
            ok: true,
            message: wrote
              ? `Saved to user-level memory (${fileShort}).`
              : `Already present in user-level memory (${fileShort}); skipped.`,
          };
        } catch (e) {
          return { ok: false, message: `Failed: ${e}` };
        }
      },
    }),
  );

  // ---------- 可选工具：读取全部记忆（用户级 + 项目级 MEMORY.md 与每日日志） ----------
  // AI 说"读取项目记忆/看看记忆"时直接调用，返回聚合内容，避免 AI 自己翻文件、只找 MEMORY.md 而漏掉每日日志。
  ctx.tools.register(
    defineTool({
      name: "memory_read",
      description:
        "Read all persistent memory: user-level MEMORY.md (cross-project preferences), " +
        "and for the current project the workspace MEMORY.md plus recent daily logs " +
        "(YYYY-MM-DD.md) from .workbuddy/memory, .codebuddy/memory, or .deepseek-harness/memory. " +
        "Use this instead of manually globbing/reading memory files — it aggregates everything. " +
        "This tool takes no parameters; call it with an empty object, e.g. tools.memory_read({}) — the runtime rejects undefined arguments.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            message: { type: "string", required: true },
            memory: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value?.memory ?? value?.message ?? "No memory." }],
      },
      async execute() {
        const cfg = source();
        if (!cfg.enabled) return { ok: false, message: "memory-palace is currently disabled in settings.", memory: "" };
        try {
          const blocks = [];
          const userFile = expandHome(cfg.userMemoryPath);
          const userFileShort = toHomeShort(userFile);
          const u = readMdSync(userFile);
          if (u) blocks.push(`# 用户级记忆 (${userFileShort})\n${u}`);
          for (const dir of readDirs()) {
            const dirShort = toHomeShort(dir);
            const w = memoryReadCandidates(dir).map(readMdSync).filter(Boolean).join("\n\n");
            if (w) blocks.push(`# 工作区记忆 (${dirShort})\n${w}`);
            const t = readMdSync(join(dir, `${todayISO()}.md`));
            if (t) blocks.push(`# 今日工作日志 (${todayISO()} @ ${dirShort})\n${t}`);
            const recent = await recentLogs(dir, cfg);
            if (recent) blocks.push(recent);
          }
          if (!blocks.length) {
            return { ok: true, message: "No memory files found yet.", memory: "" };
          }
          return { ok: true, message: "Memory loaded.", memory: blocks.join("\n\n") };
        } catch (e) {
          return { ok: false, message: `Failed: ${e}`, memory: "" };
        }
      },
    }),
  );

  // ---------- 可选工具：按内容删除某条记忆（用户级 / 项目级 / 每日级），需用户显式确认 ----------
  // 两阶段安全设计：默认（confirm 省略/非 true）只做预览——查找匹配条目并原样返回其位置与内容，
  // 绝不删除；仅当 AI 把候选展示给用户、用户明确同意后再以相同 match/level 调用并置 confirm:true 才真正删除。
  // 预览结果含每条匹配的位置（用户级/项目级/每日级）、文件短路径与真实内容；多条匹配自动编号成选项。
  ctx.tools.register(
    defineTool({
      name: "memory_delete",
      description:
        "Delete a memory entry by matching its text. DESTRUCTIVE — requires explicit user confirmation. " +
        "This tool NEVER deletes unless you pass confirm:true. " +
        "Step 1 (preview, default): call with confirm omitted/false — it only finds matching entries and returns them " +
        "(each with its location tier: 用户级/项目级/每日级, the short file path, and the exact line content) so you can show the user and ask for confirmation. " +
        "Step 2 (delete): after the user explicitly agrees, call again with the SAME match and level and confirm:true to actually remove them. " +
        "Use it when the user asks to forget / remove / delete a particular remembered fact or preference. " +
        "The 'match' is a case-insensitive substring of the entry (leading '- ' is ignored); " +
        "structural lines (headers, comments) are never deleted. " +
        "The 'level' selects the scope: 'user' (default, cross-project ~/.deepseek-harness/MEMORY.md), " +
        "'project' (active workspace MEMORY.md + today's daily log), or 'daily' (today + recent 3 daily logs of the workspace). " +
        "Prefer calling memory_read first to copy the exact entry text.",
      parameters: {
        match: {
          type: "string",
          required: true,
          description: "Substring of the memory entry to delete (e.g. the exact line text). Non-empty.",
        },
        level: {
          type: "string",
          required: true,
          description: "Scope to search/delete: 'user' (default, cross-project), 'project' (workspace MEMORY.md + today's daily log), or 'daily' (workspace daily logs).",
        },
        confirm: {
          type: "boolean",
          description: "Safety gate. Omit or pass false to preview (find & show matches without deleting). Pass true ONLY after the user explicitly confirms, to actually delete.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            preview: { type: "boolean", required: true },
            level: { type: "string", required: true },
            removed: { type: "number", required: true },
            matches: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  tier: { type: "string", required: true },
                  path: { type: "string", required: true },
                  content: { type: "string", required: true },
                },
              },
            },
            details: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  tier: { type: "string", required: true },
                  path: { type: "string", required: true },
                  content: { type: "string", required: true },
                },
              },
            },
            message: { type: "string", required: true },
            confirmPrompt: { type: "string", required: true },
          },
        },
        render: (_args, value) =>
          [{ type: "text", text: value?.confirmPrompt || value?.message || (value?.preview ? "Preview only — no deletion performed." : "Deleted.") }],
      },
      async execute(args) {
        recentAgentWrote = true;
        const cfg = source();
        if (!cfg.enabled) {
          return { ok: false, preview: false, level: args.level || "user", removed: 0, matches: [], details: [], message: "memory-palace is currently disabled in settings.", confirmPrompt: "" };
        }
        const level = (args.level || "user").toLowerCase();
        if (!["user", "project", "daily"].includes(level)) {
          return { ok: false, preview: false, level, removed: 0, matches: [], details: [], message: `Unknown level: ${level} (use 'user' | 'project' | 'daily').`, confirmPrompt: "" };
        }
        const match = (args.match || "").trim();
        if (!match) {
          return { ok: false, preview: false, level, removed: 0, matches: [], details: [], message: "match 不能为空：请提供要删除的记忆文本（子串）。", confirmPrompt: "" };
        }

        const candidates = await deleteCandidates(level);
        if (!candidates.length && level !== "user") {
          return { ok: false, preview: false, level, removed: 0, matches: [], details: [], message: "当前没有活动工作区，无法定位项目/每日记忆文件。", confirmPrompt: "" };
        }

        // 收集所有候选文件中的匹配条目（不修改任何文件）
        const matches = [];
        for (const c of candidates) {
          const found = findMatches(c.file, match, c.tier, c.path);
          for (const f of found) matches.push(f);
        }

        const confirm = args.confirm === true;

        // 预览阶段：只查不删，返回带位置与真实内容的候选供 AI 转述给用户确认
        if (!confirm) {
          if (!matches.length) {
            return {
              ok: true, preview: true, level, removed: 0, matches: [], details: [],
              message: `在「${levelLabel(level)}」未找到匹配"${match}"的记忆条目，无需删除。如需删除其他层级，请调整 level（user/project/daily）。`,
              confirmPrompt: "",
            };
          }
          const confirmPrompt = buildConfirmPrompt(level, match, matches);
          return {
            ok: true, preview: true, level, removed: 0, matches, details: [],
            message: `已找到 ${matches.length} 条匹配"${match}"的记忆条目（位于${levelLabel(level)}）。删除为不可逆操作，请先向用户展示下列候选并征得其明确确认；确认后再以相同 match 与 level 调用本工具并置 confirm:true 执行删除。`,
            confirmPrompt,
          };
        }

        // 已获确认：执行删除，并回传被删条目的位置与内容明细（透明化）
        const details = [];
        let total = 0;
        for (const c of candidates) {
          const r = await removeLineByMatch(c.file, match);
          total += r.removed;
          for (const line of r.lines) details.push({ tier: c.tier, path: c.path, content: line });
        }
        return {
          ok: true, preview: false, level, removed: total, matches: [], details,
          message: total > 0
            ? `已确认删除 ${total} 条匹配"${match}"的记忆（${levelLabel(level)}）。`
            : `确认执行，但「${levelLabel(level)}」下未找到匹配"${match}"的记忆，未删除任何内容。`,
          confirmPrompt: "",
        };
      },
    }),
  );

  // 删除记忆的硬确认闸门：把"实际删除（confirm:true）"路由到 harness 原生确认弹窗。
  // 这用到 dsh-tools 的 `tools/pre-execute` 事件瀑布 + dsh-user-approval 的 `approval.request` 弹窗
  // （即删除用户记忆时你看到的「沙箱授权弹窗」）——比两阶段的 AI 级 confirm:true 更可靠：
  // 即便模型误传 confirm:true，没有真人点击弹窗允许也绝不会真正删除。
  // 预览（confirm 省略或为 false）直接放行、不弹窗，由 execute 返回候选供 AI 转述、供用户选择删哪几条。
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec?.name !== "memory_delete") return next();
    const a = (exec.arguments && typeof exec.arguments === "object") ? exec.arguments : {};
    const confirm = a.confirm === true;
    if (!confirm) return next(); // 预览阶段：只查不删，无需弹窗
    const level = (a.level || "user").toLowerCase();
    if (!["user", "project", "daily"].includes(level)) return next();
    const match = (a.match || "").trim();
    if (!match) return next();
    try {
      const candidates = await deleteCandidates(level);
      const matches = [];
      for (const c of candidates) {
        const found = findMatches(c.file, match, c.tier, c.path);
        for (const f of found) matches.push(f);
      }
      // 没匹配到就不弹窗，放行后由 execute 回"未找到"
      if (matches.length === 0) return next();
      const reason = buildConfirmPrompt(level, match, matches);
      return { kind: "ask", reason };
    } catch (err) {
      // 预览失败按拒绝处理，宁可不让删也不误删
      return { kind: "deny", reason: `删除前预览失败，已阻止删除：${err?.message || String(err)}` };
    }
  });
}

// 读取目录里最近的（非今日）每日日志，拼成一段供 memory_read 展示（最多 3 份）。
async function recentLogs(dir, cfg) {
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return "";
  }
  const today = todayISO();
  const dated = files
    .map((f) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f))
    .filter((m) => m && m[1] < today)
    .map((m) => m[1])
    .sort()
    .reverse()
    .slice(0, 3);
  const parts = [];
  for (const date of dated) {
    const text = readMdSync(join(dir, `${date}.md`));
    if (text) parts.push(`# 日志 ${date} @ ${toHomeShort(dir)}\n${text.slice(0, cfg.workspaceBudgetChars)}`);
  }
  return parts.join("\n\n");
}
