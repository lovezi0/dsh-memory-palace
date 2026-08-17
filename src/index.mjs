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
  workspaceMemoryDir: Schema.string().default(".deepseek-harness/memory").description("无 buddy 目录时使用的项目级记忆目录。"),
  dailyLogRetentionDays: Schema.number().default(30).description("每日日志保留天数，过期日志会被蒸馏进 MEMORY.md。"),
  userBudgetChars: Schema.number().default(4000).description("注入系统提示词的用户级记忆长度上限（字符）。"),
  workspaceBudgetChars: Schema.number().default(3000).description("注入系统提示词的工作区级记忆长度上限（字符）。"),
  // 桥接 WorkBuddy / CodeBuddy 项目记忆：项目已存在这些目录时直接读写，不再单独建 .deepseek-harness/memory/。
  bridgeBuddyMemory: Schema.boolean().default(true).description("检测并直接读写 WorkBuddy / CodeBuddy 项目记忆目录。"),
  buddyWorkspaceMemoryDirs: Schema.array(Schema.string()).default([".workbuddy/memory", ".codebuddy/memory"]).description("要桥接的 buddy 项目记忆目录列表（按优先级，全部已存在目录会同步写入）。"),
});

export const inject = ["systemPrompt", "tools"];

const todayISO = () => new Date().toISOString().slice(0, 10);

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
  // 最近一次对话文本缓存（直接用我们监听到的事件数据，不依赖 session 未文档化字段）。
  let lastUserText = "";
  let lastAssistantText = "";

  function extractText(event) {
    try {
      const d = event?.data ?? {};
      const c = d.message?.content ?? d.content ?? d.text;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("");
      if (c && typeof c === "object") return JSON.stringify(c);
      return "";
    } catch {
      return "";
    }
  }

  ctx.on("session/event", (session, event) => {
    if (session?.header?.cwd) activeCwd = session.header.cwd;
    const type = event?.type;
    if (type === "user/message") lastUserText = extractText(event);
    else if (type === "assistant/message") lastAssistantText = extractText(event);
    else if (type === "turn/end") void onTurnEnd();
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
    return d && existsSync(d) ? [d] : [];
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
        const w = readMdSync(join(dir, "MEMORY.md"));
        if (w) blocks.push(`# 工作区记忆 (${dirShort})\n${w}`);
        const t = readMdSync(join(dir, `${todayISO()}.md`));
        if (t) blocks.push(`# 今日工作日志 (${todayISO()} @ ${dirShort})\n${t}`);
      }
      if (!blocks.length) return "";
      const bridged = buddyDirs().length > 0;
      const antiMangle =
        "提及记忆文件路径时一律用 ~ 简写（如 ~/.deepseek-harness/MEMORY.md），不要逐字拼写绝对路径——你转述绝对路径容易漏掉目录分隔符。";
      const intro = bridged
        ? "你拥有持久化、人类可直接编辑的 Markdown 记忆文件。当前项目已存在 WorkBuddy/CodeBuddy 项目记忆目录，本插件直接读写这些目录（不再单独创建 .deepseek-harness/memory/）。" +
          "写入记忆：项目级约定用 memory_note 工具，跨项目个人偏好用 memory_note_user 工具；读取全部记忆用 memory_read 工具（不要手动 glob/read 记忆文件）。用它保持跨 session 一致性；看不到的内容不要编造。" +
          antiMangle
        : "你拥有持久化、人类可直接编辑的 Markdown 记忆文件（位于 ~/.deepseek-harness/MEMORY.md 与各项目的 .deepseek-harness/memory/）。" +
          "写入记忆：项目级约定用 memory_note 工具，跨项目个人偏好用 memory_note_user 工具；读取全部记忆用 memory_read 工具（不要手动 glob/read 记忆文件）。用它保持跨 session 一致性；看不到的内容不要编造。" +
          antiMangle;
      return [intro, ...blocks].join("\n\n");
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

  async function onTurnEnd() {
    const dirs = writeDirs();
    if (!dirs.length) return;
    const summary = (lastUserText || lastAssistantText || "(no message captured)").slice(0, 400);
    const entry = `\n## ${new Date().toISOString()}\n${summary}\n`;
    for (const dir of dirs) {
      try {
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
      } catch (e) {
        ctx.logger?.warn?.(`memory-palace write failed (${dir}): ${e}`);
      }
    }
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
    const mem = join(dir, "MEMORY.md");
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
        "Save a durable PROJECT-LEVEL convention or fact to the active workspace's MEMORY.md " +
        "(the project's .workbuddy/memory, .codebuddy/memory, or .deepseek-harness/memory). " +
        "Use it when the user states a lasting preference, convention, or fact about the CURRENT project. " +
        "For cross-project user-level memory, use memory_note_user instead.",
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
        if (!source().enabled) return { ok: false, message: "memory-palace is currently disabled in settings." };
        const dirs = writeDirs();
        if (!dirs.length) return { ok: false, message: "No active workspace." };
        try {
          const line = `- ${args.content}`;
          let wrote = 0;
          let skipped = 0;
          for (const dir of dirs) {
            const mem = join(dir, "MEMORY.md");
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
        "Use it when the user states a personal preference or fact that applies across ALL projects. " +
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
        "Use this instead of manually globbing/reading memory files — it aggregates everything.",
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
            const w = readMdSync(join(dir, "MEMORY.md"));
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
