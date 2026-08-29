// memory-palace 记忆记录读写（去重追加 / 匹配删除 / 每日日志 / 迁移 / 轻量条目 / 错误捕获）。
// 纯函数直接导出；依赖配置/路径解析的写入类函数经 createRecords 工厂注入。
import { mkdir, readdir, unlink, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { todayISO, expandHome, readMdSync, toHomeShort, normLine, isStructural, stripSmartTag } from "./text.mjs";

// 追加一行记忆，若目标文件已包含相同内容则跳过（去重），返回是否实际写入。
export async function appendLineDedup(file, line) {
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

// 在文件中按内容匹配查找记忆条目行（不修改文件）。返回每条匹配：{tier,path,content}。
export function findMatches(file, match, tier, pathShort) {
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
export async function removeLineByMatch(file, match) {
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

// 全文逐行编号读取（v1.4.0 特性3：回喂存量记忆）。返回 { lines:[{n,raw,structural}], text }。
// 行号 n 与文件实际行一一对应（1 起），供 LLM 通过 line 引用；text 为每行 `n|raw` 拼接，直接喂模型。
// 不截断、无字符预算（用户明确要求全量回喂，避免截断导致记忆错误）。
// v1.4.1：回喂行经 stripSmartTag 剥除行首 [smart] 标记——模型不可见该标签（写侧已停拼），
// 存量磁盘条目读时透明剥除。replace/delete 的 oldText 校验仍以磁盘原文（raw）为准，不受影响。
export function readNumberedMemory(file) {
  let cur = "";
  try {
    cur = readFileSync(file, "utf8");
  } catch {
    return { lines: [], text: "" };
  }
  if (!cur) return { lines: [], text: "" };
  const lines = cur.split("\n").map((raw, i) => {
    const t = raw.trim();
    return { n: i + 1, raw, structural: isStructural(t) };
  });
  const text = lines.map((l) => `${l.n}|${stripSmartTag(l.raw)}`).join("\n");
  return { lines, text };
}

// 基于编号现有记忆的增量维护操作（v1.4.0 特性3）。op 之一：
//   - add：追加一行（text/newText，去重）；scope 由 caller 决定目标文件。
//   - replace：替换第 line 行（写前重读 + normLine(oldText) 精确匹配校验，防 stale 行号误改）。
//   - delete：删除第 line 行（结构行 / 未匹配 oldText 均拒绝）。
// 写前重读（re-read before write）保证基于最新文件内容，避免并发/重试导致的 stale 行号错位。
// 返回 { ok, reason, changed, line?, removed?, actual? }
export async function applyMemoryOp(file, op) {
  const o = op || {};
  await mkdir(dirname(file), { recursive: true });
  let cur = "";
  try {
    cur = readFileSync(file, "utf8");
  } catch {
    /* 文件尚不存在 */
  }
  const lines = cur.split("\n");
  const normRaw = (s) => normLine((s || "").trim());

  if (o.op === "add") {
    const text = (o.text ?? o.newText ?? "").trim();
    if (!text) return { ok: false, reason: "empty-add" };
    if (cur && normRaw(cur).includes(normRaw(text))) return { ok: true, reason: "dup", changed: false };
    const base = cur && !cur.endsWith("\n") ? cur + "\n" : cur;
    await writeFile(file, `${base}${text}\n`, "utf8");
    return { ok: true, reason: "added", changed: true };
  }

  if (o.op !== "replace" && o.op !== "delete") {
    return { ok: false, reason: "unknown-op", op: o.op };
  }

  const n = o.line;
  if (!Number.isInteger(n) || n < 1 || n > lines.length) {
    return { ok: false, reason: "bad-line", line: n, totalLines: lines.length };
  }
  const idx = n - 1;
  const rawLine = lines[idx];
  const trimmed = rawLine.trim();
  if (isStructural(trimmed)) {
    return { ok: false, reason: "structural-protected", line: n };
  }
  // 写前重读后精确匹配：确保操作基于最新内容（防止 stale 行号导致误改/误删）。
  const oldNorm = normRaw(o.oldText);
  if (oldNorm && normRaw(rawLine) !== oldNorm) {
    return { ok: false, reason: "conflict", line: n, expected: o.oldText, actual: trimmed };
  }

  if (o.op === "delete") {
    const newLines = lines.slice(0, idx).concat(lines.slice(idx + 1));
    await writeFile(file, newLines.join("\n"), "utf8");
    return { ok: true, reason: "deleted", changed: true, line: n, removed: trimmed };
  }
  // replace
  const newText = (o.newText ?? "").trim();
  if (!newText) return { ok: false, reason: "empty-replace" };
  lines[idx] = newText;
  await writeFile(file, lines.join("\n"), "utf8");
  return { ok: true, reason: "replaced", changed: true, line: n };
}

// 读取目录下最近的非今日每日日志日期（最多 limit 份，降序）。供删除范围圈定。
export async function recentLogDates(dir, limit = 3) {
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

/**
 * 依赖配置/路径解析的记录写入类函数工厂。
 * @param {{ getConfig: () => object, paths: ReturnType<import("./paths.mjs").createPaths> }} deps
 */
export function createRecords({ getConfig, paths }) {
  const cfg = () => getConfig();

  async function appendDaily(dir, entry) {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${todayISO()}.md`);
    let existing = "";
    try {
      existing = readFileSync(file, "utf8");
    } catch {
      /* 文件尚不存在 */
    }
    // v1.1.0：每日日志按天分割，文件头写当天日期（# YYYY-MM-DD），条目不再每条带时间戳。
    // 新文件 → 标题+条目；旧文件（无当天一级标题，含历史 `## 时间戳` 条目）→ 补标题到文件头。
    const todayTitle = `# ${todayISO()}`;
    const trimmed = existing.trim();
    if (!trimmed) {
      await writeFile(file, `${todayTitle}\n\n${entry}`, "utf8");
    } else {
      const hasTitle = existing.split("\n").some((l) => l.trim() === todayTitle);
      await writeFile(file, (hasTitle ? "" : `${todayTitle}\n\n`) + existing + entry, "utf8");
    }
    await prune(dir);
  }

  async function prune(dir) {
    const c = cfg();
    const cutoff = Date.now() - c.dailyLogRetentionDays * 86400000;
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      return;
    }
    const mem = paths.memoryFileOf(dir);
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

  // 读取目录里最近的（非今日）每日日志，拼成一段供 memory_read 展示（最多 3 份）。
  async function recentLogs(dir) {
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
      if (text) parts.push(`# 日志 ${date} @ ${toHomeShort(dir)}\n${text.slice(0, cfg().workspaceBudgetChars)}`);
    }
    return parts.join("\n\n");
  }

  // 轻量结构化条目（无 LLM）：截断原始文本，错误带 [ERROR] 前缀。
  async function writeLightEntry(dirs, turn, isError) {
    const userText = turn.find((b) => b.role === "user")?.text ?? "";
    const asstText = turn.filter((b) => b.role === "assistant").map((b) => b.text).join(" ");
    const summary = (userText || asstText || "(no message captured)").slice(0, 200);
    const tag = isError ? "[ERROR] " : "";
    const entry = `\n${tag}${summary}\n\n`;
    for (const dir of dirs) await appendDaily(dir, entry);
  }

  // 错误捕获（目标2）：按 scope 落对应 MEMORY.md，条目仅含「错误现象」。
  // （v0.7.1 起不再调 LLM 生成方案——「根因/绕过手法」由 agent 按记忆公民指令场景①主动调 memory_note 记。）
  async function captureError(turn, reason) {
    const c = cfg();
    const dirs = paths.writeDirs();
    if (!dirs.length && !expandHome(c.userMemoryPath)) return;
    const scope = dirs.length ? "project" : "user";
    const errText = (reason?.message || reason?.error?.message || "(in-session error, no message)")
      .toString()
      .slice(0, 300);
    const line = `- [${new Date().toISOString().slice(0, 10)}] in-session 错误（${scope}）：${errText}`;
    const targets = dirs.length ? dirs : [expandHome(c.userMemoryPath)];
    for (const dir of targets) {
      const mem = paths.memoryFileOf(dir);
      await appendLineDedup(mem, line).catch(() => {});
    }
  }

  return { appendDaily, prune, recentLogs, writeLightEntry, captureError };
}
