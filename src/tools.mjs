// memory-palace 记忆工具：memory_note / memory_note_user / memory_read / memory_delete
// + 删除硬确认闸门（tools/pre-execute → harness 原生确认弹窗）。
// 经 registerTools 注入 ctx/config/paths/records/运行时状态；在 index.mjs 装配时调用一次。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { join } from "node:path";
import { todayISO, expandHome, toHomeShort, readMdSync } from "./common/text.mjs";
import { appendLineDedup, findMatches, removeLineByMatch, recentLogDates } from "./common/records.mjs";

/**
 * @param {{ ctx: object, getConfig: () => object, paths: object, records: object, state: object }} deps
 */
export function registerTools({ ctx, getConfig, paths, records, state }) {
  const cfg = () => getConfig();

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
    const c = cfg();
    const files = [];
    if (level === "user") {
      const file = expandHome(c.userMemoryPath);
      files.push({ file, tier: "用户级", path: toHomeShort(file) });
      return files;
    }
    const dirs = paths.writeDirs();
    for (const dir of dirs) {
      const dirShort = toHomeShort(dir);
      if (level === "project") {
        const mem = paths.memoryFileOf(dir);
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
      async execute(args) {
        state.recentAgentWrote = true;
        if (!cfg().enabled) return { ok: false, message: "memory-palace is currently disabled in settings." };
        const dirs = paths.writeDirs();
        if (!dirs.length) return { ok: false, message: "No active workspace." };
        try {
          const line = `- ${args.content}`;
          let wrote = 0;
          let skipped = 0;
          for (const dir of dirs) {
            const mem = paths.memoryFileOf(dir);
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
        state.recentAgentWrote = true;
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
        const c = cfg();
        if (!c.enabled) return { ok: false, message: "memory-palace is currently disabled in settings.", memory: "" };
        try {
          const blocks = [];
          const userFile = expandHome(c.userMemoryPath);
          const userFileShort = toHomeShort(userFile);
          const u = readMdSync(userFile);
          if (u) blocks.push(`# 用户级记忆 (${userFileShort})\n${u}`);
          for (const dir of paths.readDirs()) {
            const dirShort = toHomeShort(dir);
            const w = paths.memoryReadCandidates(dir).map(readMdSync).filter(Boolean).join("\n\n");
            if (w) blocks.push(`# 工作区记忆 (${dirShort})\n${w}`);
            const t = readMdSync(join(dir, `${todayISO()}.md`));
            if (t) blocks.push(`# 今日工作日志 (${todayISO()} @ ${dirShort})\n${t}`);
            const recent = await records.recentLogs(dir);
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
        state.recentAgentWrote = true;
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

        const candidates = await deleteCandidates(level);
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
