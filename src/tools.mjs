// memory-palace 记忆工具：memory_note / memory_note_user / memory_read / memory_delete
// + 删除硬确认闸门（tools/pre-execute → harness 原生确认弹窗）。
// 经 registerTools 注入 ctx/config/paths/运行时状态；在 index.mjs 装配时调用一次。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { join } from "node:path";
import { todayISO, isoDaysAgo, expandHome, toHomeShort, readMdSync, budgetClip, stripDeletedLines } from "./common/text.mjs";
import { appendLineDedup, findMatches, removeLineByMatch, recentLogDates } from "./common/records.mjs";
import { planModeOf } from "./common/planmode.mjs";

/**
 * @param {{ ctx: object, getConfig: () => object, paths: object, state: object }} deps
 */
export function registerTools({ ctx, getConfig, paths, state }) {
  const cfg = () => getConfig();
  // 从宿主 execute 第二参（ToolRunContext，defineTool 原样转发）/ pre-execute 事件载荷取
  // 发起会话 cwd——多会话并发时 activeCwd 可能是别的工作区，串台会读写错项目。
  // 缺省（undefined）回落 paths 工厂默认 = activeCwd（勿 `?? null`，null 会绕过默认参数）。
  const sessionCwd = (exec) => exec?.agent?.session?.header?.cwd;

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
  async function deleteCandidates(level, cwd) {
    const c = cfg();
    const files = [];
    if (level === "user") {
      const file = expandHome(c.userMemoryPath);
      files.push({ file, tier: "用户级", path: toHomeShort(file) });
      return files;
    }
    const dirs = paths.writeDirs(cwd);
    for (const dir of dirs) {
      const dirShort = toHomeShort(dir);
      if (level === "project") {
        const mem = paths.memoryFileOf(dir, cwd);
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
      async execute(args, exec) {
        if (!cfg().enabled) return { ok: false, message: "memory-palace is currently disabled in settings." };
        const cwd = sessionCwd(exec);
        const dirs = paths.writeDirs(cwd);
        if (!dirs.length) return { ok: false, message: "No active workspace." };
        try {
          const line = `- ${args.content}`;
          let wrote = 0;
          let skipped = 0;
          for (const dir of dirs) {
            const mem = paths.memoryFileOf(dir, cwd);
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
        `(default ${toHomeShort(expandHome(cfg().userMemoryPath))}). ` +
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
        const c = cfg();
        if (!c.enabled) return { ok: false, message: "memory-palace is currently disabled in settings." };
        try {
          const file = expandHome(c.userMemoryPath);
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

  // ---------- 可选工具：读取记忆（scope 控制范围，默认只读 durable 长期记忆） ----------
  // AI 说"读取项目记忆/看看记忆"时直接调用，返回聚合内容，避免 AI 自己翻文件、只找 MEMORY.md 而漏掉项目级记忆。
  // v1.7.1：加 scope（memory 默认 / project / today / yesterday / daily / all）—— 当日日志实测
  // 可达 1.7 万字符，默认值刻意不含它；确实需要日志时必须显式传 scope。
  // project 原名 node —— 为与 memory_write / memory_update_section 的 scope='project' 统一而更名，消除读写两侧命名歧义。
  ctx.tools.register(
    defineTool({
      name: "memory_read",
      description:
        "Read persistent memory. scope defaults to 'memory' and decides what comes back: " +
        "'memory' (default) = user-level MEMORY.md (cross-project preferences) + this project's workspace MEMORY.md; " +
        "'project' = this project's workspace MEMORY.md only (same naming as the write-side scope of memory_write / memory_update_section); " +
        "'today' / 'yesterday' = that single day's daily log; " +
        "'daily' = the last three days of logs (today + yesterday + the day before); " +
        "'all' = memory + daily (large — only when the logs are genuinely needed). " +
        "Start from the default scope and widen it only when the question is really about logs. " +
        "Use this instead of manually globbing/reading memory files. " +
        "Call it as tools.memory_read({}) or tools.memory_read({ scope: 'daily' }) — the runtime rejects undefined arguments.",
      parameters: {
        scope: {
          type: "string",
          enum: ["memory", "project", "today", "yesterday", "daily", "all"],
          description:
            "What to read. 'memory' (default) = user-level + workspace MEMORY.md (durable long-term memory; usually all you need). " +
            "'project' = workspace MEMORY.md only (same value as the write-side scope of memory_write). 'today' / 'yesterday' = that single day's log. " +
            "'daily' = last three days of logs. 'all' = memory + daily.",
        },
      },
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
      async execute(args = {}, exec) {
        const c = cfg();
        if (!c.enabled) return { ok: false, message: "memory-palace is currently disabled in settings.", memory: "" };
        const cwd = sessionCwd(exec);
        // v1.7.1：默认 scope='memory'（长期记忆）。刻意不设 'all' —— 默认全量会让 agent
        // 不加思考地把日志（实测单日可达 1.7 万字符）一起吞下，白白吃掉上下文。
        const scope = args?.scope ?? "memory";
        const wantUser = scope === "memory" || scope === "all";
        const wantProject = scope === "memory" || scope === "project" || scope === "all";
        // 日志按**日期**取（而非"最近 N 份文件"——跨日跳空会取偏）：today / yesterday / daily(近三天) / all
        const logDays =
          scope === "today" ? [0]
            : scope === "yesterday" ? [1]
              : scope === "daily" || scope === "all" ? [0, 1, 2]
                : [];
        try {
          const blocks = [];
          if (wantUser) {
            const userFile = expandHome(c.userMemoryPath);
            const u = readMdSync(userFile);
            if (u) blocks.push(`# 用户级记忆 (${toHomeShort(userFile)})\n${u}`);
          }
          for (const dir of paths.readDirs(cwd)) {
            const dirShort = toHomeShort(dir);
            if (wantProject) {
              // 标题必须用实际读到的 MEMORY.md 路径，而非日志目录 —— dsh 布局下 MEMORY.md 位于
              // 日志目录的上一级，旧实现拿 dir（.../memory）当标题会误导真实路径（buddy 布局
              // MEMORY.md 恰在 memory/ 内所以未暴露）。与 E 投影的 per-file 粒度对齐。
              for (const f of paths.memoryReadCandidates(dir, cwd)) {
                const t = readMdSync(f);
                if (t) blocks.push(`# 工作区记忆 (${toHomeShort(f)})\n${t}`);
              }
            }
            for (const n of logDays) {
              const day = isoDaysAgo(n);
              const t = readMdSync(join(dir, `${day}.md`));
              if (!t) continue;
              const label = n === 0 ? "今日" : n === 1 ? "昨日" : "前日";
              // v1.8.0-alpha.1 修复（D2）：日志 scope 先剥删除线墓碑再裁剪——墓碑对日志阅读是
              // 纯噪声（实测 79 有效+42 墓碑 → 返回 51+14，28 条有效被墓碑挤掉）。注意
              // memory/project scope 刻意**保留**墓碑不过滤：memory_update_section 的 replace
              // 模式要求 oldText 与磁盘含墓碑逐字一致，过滤会让 stale 校验永远失败。
              blocks.push(`# ${label}工作日志 (${day} @ ${dirShort})\n${budgetClip(stripDeletedLines(t), c.workspaceBudgetChars)}`);
            }
          }
          if (!blocks.length) {
            return { ok: true, message: `No memory files found (scope=${scope}).`, memory: "" };
          }
          return { ok: true, message: `Memory loaded (scope=${scope}).`, memory: blocks.join("\n\n") };
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
      async execute(args, exec) {
        const c = cfg();
        if (!c.enabled) {
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

        const candidates = await deleteCandidates(level, sessionCwd(exec));
        if (!candidates.length && level !== "user") {
          return { ok: false, preview: false, level, removed: 0, matches: [], details: [], message: "当前没有活动工作区，无法定位项目/每日记忆文件。", confirmPrompt: "" };
        }

        // 收集所有候选文件中的匹配条目（不修改任何文件）
        const matches = [];
        for (const cand of candidates) {
          const found = findMatches(cand.file, match, cand.tier, cand.path);
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
        for (const cand of candidates) {
          const r = await removeLineByMatch(cand.file, match);
          total += r.removed;
          for (const line of r.lines) details.push({ tier: cand.tier, path: cand.path, content: line });
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
  // 计划模式禁写（硬编码默认，无开关）：三个写工具统一 deny（连预览/确认都拦），仅禁写不禁读。
  const WRITE_TOOLS = new Set(["memory_note", "memory_note_user", "memory_delete"]);
  ctx.on("tools/pre-execute", async (exec, next) => {
    const name = exec?.name;
    // plan 模式禁写：三个写工具一律 deny，连预览/确认都拦。
    // 按**会话**判定（plan 模式是会话级状态，见 common/planmode.mjs）——别的会话进 plan 不该 deny 本会话。
    if (planModeOf(state, exec?.agent?.session) && WRITE_TOOLS.has(name)) {
      return { kind: "deny", reason: "plan 模式下禁止写入记忆" };
    }
    if (name !== "memory_delete") return next();
    const a = (exec.arguments && typeof exec.arguments === "object") ? exec.arguments : {};
    const confirm = a.confirm === true;
    if (!confirm) return next(); // 预览阶段：只查不删，无需弹窗
    const level = (a.level || "user").toLowerCase();
    if (!["user", "project", "daily"].includes(level)) return next();
    const match = (a.match || "").trim();
    if (!match) return next();
    try {
      const candidates = await deleteCandidates(level, sessionCwd(exec));
      const matches = [];
      for (const cand of candidates) {
        const found = findMatches(cand.file, match, cand.tier, cand.path);
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
