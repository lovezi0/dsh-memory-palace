// memory-palace v1.6.0 hybrid 模式：MEMORY.md 主动维护工具集（仅 hybrid 模式注册）。
// 三个工具（操作规范全部承载在 description——定案 #11，不做 skill）：
// - memory_write        章节追加/新增（项目级多目录同步；用户级单文件）
// - memory_update_section 整章节精确替换 / 单条标记删除（stale 防护：oldText 归一化精确匹配）
// - memory_reorganize   项目级全量重整（双门禁机器校验 + 原子替换 + 时间戳注释）
// 定案约束：用户级禁止重整；重整时间戳由机器读写（HTML 注释落文件尾，agent 不可改）；
// hybrid 下不做三级去重管线（重复治理归子 agent），仅保留同 normLine 精确去重防手滑重复。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { expandHome, toHomeShort, readMdSync, nowStamp, normLine } from "../common/text.mjs";
import { appendToSectionText, upsertSectionText, replaceSectionText, markEntryDeletedText, locateSection } from "../common/sections.mjs";

const REORG_MARK = "memory-palace:last-reorg:";
const REORG_MARK_RE = new RegExp(`\\n?<!--\\s*${REORG_MARK}[^>]*-->\\s*$`);

// 本地 ISO 时间戳（YYYY-MM-DDTHH:mm:ss，冒号保留——落文件内容无文件名限制）。
// 沿 text.mjs nowStamp 的教训：禁 toISOString（UTC 差 8 小时）。
const localIsoStamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// 读重整时间戳：文件尾 HTML 注释；无/损坏 → 0（视为从未重整，冷却已过）。
export function readLastReorg(md) {
  const m = new RegExp(`<!--\\s*${REORG_MARK}([^>]+)-->`).exec(md || "");
  if (!m) return 0;
  const t = new Date(m[1].trim()).getTime();
  return Number.isFinite(t) ? t : 0;
}

// 计算 memory_reorganize 双门禁状态（供 pre-execute 弹窗与 execute 复核共用）。
export function checkReorgGate(memFile, cfg) {
  const md = readMdSync(memFile);
  const size = md.length;
  const overBudget = size > (cfg.workspaceBudgetChars || 3000);
  const last = readLastReorg(md);
  const cooldownMs = (cfg.reorgCooldownDays ?? 7) * 86400000;
  const cooled = Date.now() - last >= cooldownMs;
  return {
    ok: overBudget && cooled,
    size,
    overBudget,
    last,
    cooled,
    reason: overBudget
      ? cooled
        ? "ok"
        : `重整冷却期内（上次重整 ${new Date(last).toLocaleString()}，冷却 ${cfg.reorgCooldownDays ?? 7} 天），请用 memory_update_section 做章节级修正。`
      : `MEMORY.md 当前 ${size} 字符未超出注入预算（${cfg.workspaceBudgetChars || 3000}），无需重整；请用 memory_write / memory_update_section 维护。`,
  };
}

// 同 normLine 精确去重：目标章节内已存在同归一化条目 → skip（不算去重管线，仅防手滑重复）。
function sectionHasEntry(md, section, entry) {
  const loc = locateSection(md, section);
  if (!loc) return false;
  const want = normLine(entry);
  for (let i = loc.start + 1; i < loc.end; i++) {
    if (normLine(loc.lines[i]) === want) return true;
  }
  return false;
}

/**
 * 注册 hybrid 工具 + pre-execute 闸门。仅在 memoryMode === "hybrid" 时由 index.mjs 调用
 * （memoryMode 切换需重启 dsh——注册时机安全，不存在运行中换挡错配）。
 * @param {{ ctx: object, getConfig: () => object, paths: object, records: object, state: object }} deps
 */
export function registerHybridTools({ ctx, getConfig, paths, records, state }) {
  const cfg = () => getConfig();

  // 目标文件解析：project = 主目标（dirs[0]，多 buddy 目录时与蒸馏按钮同语义只动主目标，
  // 章节级 stale 校验天然防止错位覆写）；user = 用户级 MEMORY.md。
  function memFileOf(scope) {
    if (scope === "user") return { file: expandHome(cfg().userMemoryPath), dirs: [] };
    const dirs = paths.writeDirs();
    if (!dirs.length) return null;
    return { file: paths.memoryFileOf(dirs[0]), dirs };
  }

  // ---------- memory_write：章节追加/新增（章节化格式规范承载于 description——定案 #11） ----------
  ctx.tools.register(
    defineTool({
      name: "memory_write",
      description:
        "Append a durable memory entry to MEMORY.md in the required chaptered format. " +
        "Format is STRICT: entries live under `## 章节` headings as `- 条目` lines (one-line conclusion first, " +
        "then key details: commands/paths/numbers; objective third-person; no dialogue, no questions, no tags). " +
        "If the section exists the entry is appended under it; if not, the section is created automatically " +
        "(do NOT force-match a semantically wrong section — pick a new section name instead). " +
        "An exact-duplicate entry (same normalized text) in the same section is skipped. " +
        "scope='project' writes the active workspace MEMORY.md; scope='user' writes the cross-project user MEMORY.md. " +
        "NEVER write memory files with the raw write/edit tools — always use this tool. " +
        "For rewriting a whole section use memory_update_section; full-file reorganization is memory_reorganize (gated).",
      parameters: {
        scope: {
          type: "string",
          required: true,
          description: "'project' (active workspace MEMORY.md) or 'user' (cross-project user MEMORY.md).",
        },
        section: { type: "string", required: true, description: "章节标题（不含 `## ` 前缀），如：环境必知。" },
        entry: { type: "string", required: true, description: "条目文本（一行，结论先行 + 关键细节，不带 `- ` 前缀）。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean", required: true }, message: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value?.message ?? "Saved." }],
      },
      async execute(args) {
        state.recentAgentWrote = true;
        const c = cfg();
        if (!c.enabled) return { ok: false, message: "memory-palace is currently disabled in settings." };
        const section = String(args.section ?? "").trim();
        const entry = String(args.entry ?? "").trim();
        if (!section || !entry) return { ok: false, message: "section 与 entry 均不能为空。" };
        const target = memFileOf(args.scope === "user" ? "user" : "project");
        if (!target) return { ok: false, message: "No active workspace." };
        try {
          let wrote = 0;
          let skipped = 0;
          const files = target.dirs.length ? target.dirs.map((d) => paths.memoryFileOf(d)) : [target.file];
          for (const file of files) {
            const md = readMdSync(file);
            if (sectionHasEntry(md, section, entry)) {
              skipped++;
              continue;
            }
            const r = upsertSectionText(md, section, entry);
            if (!r.ok) {
              skipped++;
              continue;
            }
            await writeFile(file, r.text, "utf8");
            wrote++;
          }
          return {
            ok: wrote > 0,
            message: wrote > 0
              ? `Saved to ${wrote} MEMORY.md file(s) under 「${section}」${skipped ? ` (${skipped} duplicate skipped)` : ""}.`
              : `Duplicate entry under 「${section}」; nothing written.`,
          };
        } catch (e) {
          return { ok: false, message: `Failed: ${e}` };
        }
      },
    }),
  );

  // ---------- memory_update_section：整章节精确替换 / 单条标记删除（stale 防护） ----------
  ctx.tools.register(
    defineTool({
      name: "memory_update_section",
      description:
        "Update ONE section of MEMORY.md with stale-protection. Two modes:\n" +
        "1) Replace: pass oldText = the FULL current section text including its `## heading` line " +
        "(read it first via memory_read) and newText = the complete replacement section. The oldText is " +
        "matched by normalized exact comparison against the section on disk — on any mismatch the tool REJECTS " +
        "and returns the actual current content, so re-read and retry.\n" +
        "2) Mark-delete a single entry: pass markDelete:true and oldText = the exact entry line text; the entry " +
        "becomes a strikethrough tombstone (~~text~~) — never physically deleted, recoverable by hand.\n" +
        "NEVER edit memory files with raw write/edit tools. Deleting whole information is only allowed as " +
        "strikethrough; section replacement must not drop still-valid entries. " +
        "scope='project' (active workspace MEMORY.md, primary target) or 'user' (user MEMORY.md; NO full reorganize).",
      parameters: {
        scope: {
          type: "string",
          required: true,
          description: "'project' (active workspace MEMORY.md primary target) or 'user'.",
        },
        section: { type: "string", required: true, description: "章节标题（不含 `## ` 前缀）。" },
        oldText: {
          type: "string",
          required: true,
          description: "replace 模式 = 含 `## 标题` 行的整章节当前全文；markDelete 模式 = 目标条目原文（可含 `- ` 前缀）。",
        },
        newText: { type: "string", description: "replace 模式必填：替换后的整章节全文（含 `## 标题` 行，需保留删除线墓碑）。" },
        markDelete: { type: "boolean", description: "true = 仅把 oldText 匹配的单条条目标记为删除线；省略 = 整章节替换。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            message: { type: "string", required: true },
            actual: { type: "string", required: true },
          },
        },
        render: (_args, value) =>
          [{ type: "text", text: value?.actual ? `${value.message}\n\n当前实际内容：\n${value.actual}` : value?.message ?? "Done." }],
      },
      async execute(args) {
        state.recentAgentWrote = true;
        const c = cfg();
        if (!c.enabled) return { ok: false, message: "memory-palace is currently disabled in settings.", actual: "" };
        const section = String(args.section ?? "").trim();
        const oldText = String(args.oldText ?? "");
        if (!section || !oldText.trim()) return { ok: false, message: "section 与 oldText 均不能为空。", actual: "" };
        const target = memFileOf(args.scope === "user" ? "user" : "project");
        if (!target) return { ok: false, message: "No active workspace.", actual: "" };
        try {
          const file = target.file;
          const md = readMdSync(file);
          const r = args.markDelete === true
            ? markEntryDeletedText(md, section, oldText)
            : replaceSectionText(md, section, oldText, args.newText);
          if (!r.ok) {
            return { ok: false, message: `更新被拒绝（${r.reason}）：请先 memory_read 重读后再试。`, actual: r.actual ?? "" };
          }
          await writeFile(file, r.text, "utf8");
          return { ok: true, message: `Updated 「${section}」 in ${toHomeShort(file)} (${r.reason}).`, actual: "" };
        } catch (e) {
          return { ok: false, message: `Failed: ${e}`, actual: "" };
        }
      },
    }),
  );

  // ---------- memory_reorganize：项目级全量重整（双门禁机器校验 + 原子替换 + 时间戳） ----------
  ctx.tools.register(
    defineTool({
      name: "memory_reorganize",
      description:
        "FULLY reorganize the PROJECT-LEVEL MEMORY.md by replacing the whole file with newContent. " +
        "HARD GATES (machine-checked, both required): (1) the file exceeds the injection budget " +
        "(workspaceBudgetChars); (2) at least reorgCooldownDays (default 7) since the last reorganize. " +
        "If either gate fails the call is REJECTED — use memory_update_section instead. " +
        "Requirements for newContent: keep the full `## 章节` + `- 条目` format; NEVER lose still-valid key " +
        "information — read the daily logs (memory_read) and current MEMORY.md for cross-checking first; " +
        "merge duplicates, drop only strikethrough/obsolete content; keep user-level MEMORY.md untouched " +
        "(user-level reorganization is FORBIDDEN). A last-reorg timestamp comment is appended automatically. " +
        "A user confirmation dialog is shown before execution.",
      parameters: {
        newContent: {
          type: "string",
          required: true,
          description: "重整后的项目级 MEMORY.md 完整全文（`## 章节` + `- 条目` 格式；不含重整时间戳注释——机器自动追加）。",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean", required: true }, message: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value?.message ?? "Done." }],
      },
      async execute(args) {
        state.recentAgentWrote = true;
        const c = cfg();
        if (!c.enabled) return { ok: false, message: "memory-palace is currently disabled in settings." };
        const dirs = paths.writeDirs();
        if (!dirs.length) return { ok: false, message: "No active workspace." };
        const file = paths.memoryFileOf(dirs[0]);
        // 复核双门禁（pre-execute 已拦一道；这里防绕过）
        const gate = checkReorgGate(file, c);
        if (!gate.ok) return { ok: false, message: `重整被门禁拒绝：${gate.reason}` };
        const newContent = String(args.newContent ?? "").replace(REORG_MARK_RE, "").replace(/\s+$/, "");
        if (!newContent.trim()) return { ok: false, message: "newContent 不能为空。" };
        const stamped = `${newContent}\n\n<!-- ${REORG_MARK}${localIsoStamp()} -->\n`;
        try {
          // 原子替换（沿 distillProjectMemory 模式）：cover 同目录写入 → 完整性校验 → 备份 → rename → 失败回滚
          const coverFile = join(dirname(file), "memory-cover.md");
          await writeFile(coverFile, stamped, "utf8");
          if (!readMdSync(coverFile)) {
            await import("node:fs/promises").then((m) => m.unlink(coverFile)).catch(() => {});
            return { ok: false, message: "memory-cover.md 未完整写入，本次重整失败（原记忆未动）。" };
          }
          const backup = `${file}.${nowStamp()}`;
          const fsp = await import("node:fs/promises");
          await fsp.rename(file, backup).catch(async () => {
            await fsp.rename(coverFile, file); // 原文件不存在（首次创建）时直接落位
            return true;
          });
          try {
            await fsp.rename(coverFile, file);
          } catch (e) {
            await fsp.rename(backup, file).catch(() => {});
            throw e;
          }
          return {
            ok: true,
            message: `重整完成：${toHomeShort(file)}（原 ${gate.size} → ${stamped.length} 字符），备份 ${toHomeShort(backup)}，时间戳已更新。`,
          };
        } catch (e) {
          return { ok: false, message: `重整失败（原记忆未动或已回滚）：${e?.message || String(e)}` };
        }
      },
    }),
  );
}

// hybrid 写工具闸门（pre-execute）：plan 模式 deny；memory_reorganize 门禁前置计算 + 原生确认弹窗。
// 沿 tools.mjs 的 memory_delete 闸门模式（tools/pre-execute → approval.request）。
export function attachHybridGuards(ctx, getConfig, paths, state) {
  const HYBRID_WRITE_TOOLS = new Set(["memory_write", "memory_update_section", "memory_reorganize"]);
  ctx.on("tools/pre-execute", async (exec, next) => {
    const name = exec?.name;
    if (!HYBRID_WRITE_TOOLS.has(name)) return next();
    if (state.planModeActive) {
      return { kind: "deny", reason: "plan 模式下禁止写入记忆" };
    }
    if (name !== "memory_reorganize") return next();
    const c = getConfig();
    const dirs = paths.writeDirs();
    if (!dirs.length) return { kind: "deny", reason: "无活动工作区，无法重整。" };
    const file = paths.memoryFileOf(dirs[0]);
    const gate = checkReorgGate(file, c);
    if (!gate.ok) return { kind: "deny", reason: gate.reason };
    const args = (exec.arguments && typeof exec.arguments === "object") ? exec.arguments : {};
    const size = String(args.newContent ?? "").length;
    return {
      kind: "ask",
      reason:
        `⚠️ 项目级 MEMORY.md 全量重整确认\n` +
        `当前 ${gate.size} 字符（已超预算 ${c.workspaceBudgetChars || 3000}），冷却已满足（上次重整 ${gate.last ? new Date(gate.last).toLocaleString() : "从未"}）。\n` +
        `即将用 ${size} 字符的新全文覆盖 ${file}（原文件会自动备份）。\n` +
        `请确认是否执行重整？`,
    };
  });
}
