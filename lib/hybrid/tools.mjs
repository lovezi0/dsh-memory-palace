// memory-palace hybrid 模式：MEMORY.md 主动维护工具集（仅 hybrid 模式注册）。
// 三个工具（操作规范全部承载在 description——定案 #11，不做 skill）：
// - memory_write 章节追加/新增（项目级多目录同步；用户级单文件）
// - memory_update_section 整章节精确替换 / 单条标记删除（stale 防护：oldText 归一化精确匹配）
// - memory_reorganize 项目级全量重整（双门禁机器校验 + 原子替换 + 时间戳注释）
// 定案约束：用户级禁止重整；重整时间戳由机器读写（HTML 注释落文件尾，agent 不可改）；
// hybrid 下不做三级去重管线（重复治理归子 agent），仅保留同 normLine 精确去重防手滑重复。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { expandHome, toHomeShort, readMdSync, nowStamp, normLine } from "../common/text.mjs";
import { appendToSectionText, upsertSectionText, replaceSectionText, markEntryDeletedText, locateSection } from "../common/sections.mjs";
import { planModeOf } from "../common/planmode.mjs";

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
  const overBudget = size > (cfg.workspaceBudgetChars || 6000);
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
        : `重整冷却期内（上次重整 ${new Date(last).toLocaleString()}，冷却 ${cfg.reorgCooldownDays ?? 7} 天）：本项目重整**仅允许落盘一次**——请**停止**并向用户如实报告最终结果，**不得**改用 memory_update_section 或其它工具继续删改凑数。`
      : `MEMORY.md 当前 ${size} 字符未超出注入预算（${cfg.workspaceBudgetChars || 6000}），无需重整；请用 memory_write / memory_update_section 维护。`,
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
 * 注册记忆工具（MEMORY.md 章节化写入 / 整章节替换 / 全量重整）+ pre-execute 闸门。
 * 由 index.mjs 无条件装配（原 hybrid 已成唯一写入路径）。
 * @param {{ ctx: object, getConfig: () => object, paths: object, state: object }} deps
 */
export function registerHybridTools({ ctx, getConfig, paths, state }) {
  const cfg = () => getConfig();
  // 从宿主 execute 第二参（ToolRunContext，defineTool 原样转发）取发起会话 cwd。
  // 用可选链自然得 undefined（勿 `?? null`——null 会绕过 paths 默认参数导致 dirs 恒空）。
  const sessionCwd = (exec) => exec?.agent?.session?.header?.cwd;

  // 目标文件解析：project = 主目标（dirs[0]，多 buddy 目录时与蒸馏按钮同语义只动主目标，
  // 章节级 stale 校验天然防止错位覆写）；user = 用户级 MEMORY.md。
  // cwd 由调用方从 exec.agent.session.header.cwd 透传（多会话并发时 activeCwd 可能是别的
  // 工作区，串台会写错项目）；缺省（undefined）回落 paths 工厂默认 = activeCwd，保持旧行为。
  function memFileOf(scope, cwd) {
    if (scope === "user") return { file: expandHome(cfg().userMemoryPath), dirs: [] };
    const dirs = paths.writeDirs(cwd);
    if (!dirs.length) return null;
    return { file: paths.memoryFileOf(dirs[0], cwd), dirs };
  }

  // 写入工具返回附一行体量回显（**仅回显、不拦截**），让 agent 具备体量感。
  // 预算按 scope 取：project → workspaceBudgetChars；user → userBudgetChars
  // （memory_write / memory_update_section 都有两个 scope，写用户级时用 workspace 会算错倍率）。
  function sizeLine(scope, file, c) {
    try {
      const size = readMdSync(file).length;
      const budget = scope === "user" ? (c.userBudgetChars || 8000) : (c.workspaceBudgetChars || 6000);
      const ratio = budget > 0 ? (size / budget).toFixed(2) : "0.00";
      return ` 当前 ${size}/${budget} 字符（${ratio}×）`;
    } catch {
      return "";
    }
  }

  // ---------- memory_write：章节追加/新增（章节化格式规范承载于 description——定案 #11） ----------
  ctx.tools.register(
    defineTool({
      name: "memory_write",
      description:
        "Append ONE durable memory entry to MEMORY.md in the required chaptered format. " +
        "Format is STRICT: entries live under `## 章节` headings as `- 条目` lines — ONE fact per entry, " +
        "conclusion first, objective third-person, no dialogue/questions/tags. Keep each entry concise; " +
        "split anything longer into a `- parent` line + an indented `  - child` line. " +
        "CONTENT RULES (a durable note for the NEXT session, NOT a work log): NEVER include source coordinates " +
        "(`file.go:123`), one-off material (full error dumps, command output, throwaway URLs), or step-by-step " +
        "process. Paths: reusable entry points only (dirs, config file names, commands) — never source coordinates. " +
        "URLs: only a base address you must reuse verbatim. " +
        "Good: `Run pending DB migrations before starting the service — avoid: running a new migration on an " +
        "older build (irreversible).` " +
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
      async execute(args, exec) {
        const c = cfg();
        if (!c.enabled) return { ok: false, message: "memory-palace is currently disabled in settings." };
        const section = String(args.section ?? "").trim();
        const entry = String(args.entry ?? "").trim();
        if (!section || !entry) return { ok: false, message: "section 与 entry 均不能为空。" };
        const cwd = sessionCwd(exec);
        const target = memFileOf(args.scope === "user" ? "user" : "project", cwd);
        if (!target) return { ok: false, message: "No active workspace." };
          try {
            let wrote = 0;
            let skipped = 0;
            let flattened = false;
            const files = target.dirs.length ? target.dirs.map((d) => paths.memoryFileOf(d, cwd)) : [target.file];
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
              flattened = flattened || r.flattened === true;
            }
            // 修复：entry 经 flattenEntry 扁平化为单行——含内嵌换行/标题行
            // 时不再原样落盘破坏结构，message 明示合并，不静默撒谎。
            const flatNote = flattened ? "（entry 含多行，已合并为单行）" : "";
          // 体量回显（仅提示，不拦截）——让 agent 具备体量感，超预算时自然倾向合并或重整。
          const scopeKey = args.scope === "user" ? "user" : "project";
          const sizeNote = wrote > 0 && files[0] ? sizeLine(scopeKey, files[0], c) : "";
          return {
            ok: wrote > 0,
            message: wrote > 0
              ? `Saved to ${wrote} MEMORY.md file(s) under 「${section}」${flatNote}${skipped ? ` (${skipped} duplicate skipped)` : ""}.${sizeNote}`
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
        "Same ENTRY SHAPE rules as memory_write: one fact per entry, conclusion first, objective third-person, " +
        "concise (split long ones into `- parent` + " +
        "indented `  - child`), no source coordinates (`file.go:123`), no one-off material (error dumps, " +
        "command output, throwaway URLs); paths = reusable entry points only; URLs = must-reuse base addresses only. " +
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
      async execute(args, exec) {
        const c = cfg();
        if (!c.enabled) return { ok: false, message: "memory-palace is currently disabled in settings.", actual: "" };
        const section = String(args.section ?? "").trim();
        const oldText = String(args.oldText ?? "");
        if (!section || !oldText.trim()) return { ok: false, message: "section 与 oldText 均不能为空。", actual: "" };
        const target = memFileOf(args.scope === "user" ? "user" : "project", sessionCwd(exec));
        if (!target) return { ok: false, message: "No active workspace.", actual: "" };
        try {
          const file = target.file;
          const md = readMdSync(file);
          const r = args.markDelete === true
            ? markEntryDeletedText(md, section, oldText)
            : replaceSectionText(md, section, oldText, args.newText);
          if (!r.ok) {
            const msg = r.reason === "heading-mismatch"
              ? `更新被拒绝（heading-mismatch）：newText 的标题行与 section 参数「${section}」不一致（或缺少 ## 标题行）。请保持两者一致后重试；确需重命名章节，请同步修改标题行与 section 参数。`
              : `更新被拒绝（${r.reason}）：请先 memory_read 重读后再试。`;
            return { ok: false, message: msg, actual: r.actual ?? "" };
          }
          await writeFile(file, r.text, "utf8");
          const scopeKey = args.scope === "user" ? "user" : "project";
          return {
            ok: true,
            message: `Updated 「${section}」 in ${toHomeShort(file)} (${r.reason}).${sizeLine(scopeKey, file, c)}`,
            actual: "",
          };
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
        "TASK (a pass over the CURRENT MEMORY.md + the dated daily logs): drop obsolete entries, drop " +
        "duplicates, condense redundancy WITHOUT losing precision, and restructure sections. The workspace budget " +
        "(workspaceBudgetChars) is a REFERENCE LINE, not a hard target — NEVER delete still-valid information " +
        "just to reach it. " +
        "HARD GATES (machine-checked, both required): (1) the file exceeds the injection budget; " +
        "(2) at least reorgCooldownDays (default 7) since the last reorganize. If either gate fails the call is " +
        "REJECTED — then STOP and report the result to the user; do NOT fall back to memory_update_section or any " +
        "other tool to keep trimming. ONLY ONE write is allowed per reorganization — write your best single pass " +
        "(drafts are NOT saved, so do not rewrite the whole draft over and over). " +
        "SOURCE: read the files directly with your own file-reading tools (workspace MEMORY.md + the memory/ " +
        "directory of `YYYY-MM-DD.md` logs, any dates you need). The memory_read tool is DISABLED during a " +
        "reorganization (its scope only reaches today/yesterday/the last three days) — do NOT call it. Do NOT " +
        "invent sections or conclusions absent from the original memory; logs are for cross-checking only — never " +
        "re-introduce outdated conclusions. " +
        "ENTRY SHAPE: one fact per entry, conclusion first, objective third-person, concise (split long ones into " +
        "a `- parent` + indented `  - child`); " +
        "no source coordinates (`file.go:123`), no one-off material (error dumps, command output, throwaway URLs); " +
        "paths = reusable entry points only; URLs = must-reuse base addresses only. " +
        "Keep user-level MEMORY.md untouched (user-level reorganization is FORBIDDEN). " +
        "A last-reorg timestamp comment is appended automatically. A user confirmation dialog is shown before execution.",
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
      async execute(args, exec) {
        const c = cfg();
        if (!c.enabled) return { ok: false, message: "memory-palace is currently disabled in settings." };
        const cwd = sessionCwd(exec);
        const dirs = paths.writeDirs(cwd);
        if (!dirs.length) return { ok: false, message: "No active workspace." };
        const file = paths.memoryFileOf(dirs[0], cwd);
        // 复核双门禁（pre-execute 已拦一道；这里防绕过）
        const gate = checkReorgGate(file, c);
        if (!gate.ok) return { ok: false, message: `重整被门禁拒绝：${gate.reason}` };
        const newContent = String(args.newContent ?? "").replace(REORG_MARK_RE, "").replace(/\s+$/, "");
        if (!newContent.trim()) return { ok: false, message: "newContent 不能为空。" };
        const stamped = `${newContent}\n\n<!-- ${REORG_MARK}${localIsoStamp()} -->\n`;
        try {
          // 原子替换：cover 同目录写入 → 完整性校验 → 备份 → rename → 失败回滚
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
          // 口径统一为「去掉时间戳注释后的正文字符数」+ 达标判定（失败出口：超预算则明确要求停止并报告）。
          const after = stamped.replace(REORG_MARK_RE, "").replace(/\s+$/, "").length;
          const budget = c.workspaceBudgetChars || 6000;
          const verdict = after > budget
            ? `；⚠️ 仍超出参考预算 ${budget} 字符——请【停止】，向用户如实报告最终结果与超出原因（建议提高 workspaceBudgetChars 或由用户指定删除哪些条目），不得改用其它工具继续删改凑数。`
            : `；已在参考预算以内。`;
          const ratio = budget > 0 ? (after / budget).toFixed(2) : "0.00";
          return {
            ok: true,
            message: `重整完成：${toHomeShort(file)}（原 ${gate.size} → 现 ${after}/${budget} 字符，${ratio}×）${verdict} 备份 ${toHomeShort(backup)}，时间戳已更新。`,
          };
        } catch (e) {
          return { ok: false, message: `重整失败（原记忆未动或已回滚）：${e?.message || String(e)}` };
        }
      },
    }),
  );
}

// hybrid 写工具闸门（pre-execute）：plan 模式 deny；memory_reorganize 门禁前置计算 + 进入重整流程
// （deny memory_read）+ 原生确认弹窗。沿 tools.mjs 的 memory_delete 闸门模式（tools/pre-execute → approval.request）。
export function attachHybridGuards(ctx, getConfig, paths, state) {
  const HYBRID_WRITE_TOOLS = new Set(["memory_write", "memory_update_section", "memory_reorganize"]);
  ctx.on("tools/pre-execute", async (exec, next) => {
    const name = exec?.name;
    if (!HYBRID_WRITE_TOOLS.has(name)) return next();
    // 按**会话**判定（plan 模式是会话级状态，见 common/planmode.mjs）——别的会话进 plan 不该 deny 本会话
    if (planModeOf(state, exec?.agent?.session)) {
      return { kind: "deny", reason: "plan 模式下禁止写入记忆" };
    }
    if (name !== "memory_reorganize") return next();
    const c = getConfig();
    const cwd = exec?.agent?.session?.header?.cwd;
    const dirs = paths.writeDirs(cwd);
    if (!dirs.length) return { kind: "deny", reason: "无活动工作区，无法重整。" };
    const file = paths.memoryFileOf(dirs[0], cwd);
    const gate = checkReorgGate(file, c);
    if (!gate.ok) return { kind: "deny", reason: gate.reason };
    // agent 自动调用本工具同样进入「重整流程」——给该会话 deny memory_read，
    // 逼其改用文件读取能力读 MEMORY.md 与历史日志（memory_read 只覆盖近三天）。
    // 标记的摘除在 index.mjs（用户下一条真实消息 / 会话销毁 / TTL），此处只负责置位。
    state.markReorg?.(exec?.agent?.session, { agent: exec?.agent });
    const args = (exec.arguments && typeof exec.arguments === "object") ? exec.arguments : {};
    const size = String(args.newContent ?? "").length;
    return {
      kind: "ask",
      reason:
        `⚠️ 项目级 MEMORY.md 全量重整确认\n` +
        `当前 ${gate.size} 字符（已超预算 ${c.workspaceBudgetChars || 6000}），冷却已满足（上次重整 ${gate.last ? new Date(gate.last).toLocaleString() : "从未"}）。\n` +
        `即将用 ${size} 字符的新全文覆盖 ${file}（原文件会自动备份）。\n` +
        `请确认是否执行重整？`,
    };
  });
}
