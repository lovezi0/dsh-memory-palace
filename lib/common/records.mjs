// memory-palace 记忆记录读写（去重追加 / 匹配删除 / 每日日志）。
// 纯函数直接导出；依赖配置/路径解析的写入类函数经 createRecords 工厂注入。
// v1.8.0：轻量条目（writeLightEntry）、错误捕获（captureError）与日志过期迁移（prune）
// 随 plugin 模式一并删除——日志由记忆子代理维护、永不过期不删，是证据层。
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { todayISO, normLine, isStructural, stripSmartTag } from "./text.mjs";

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
  }

  // v1.7.1：recentLogs 已删除 —— memory_read 的 scope='daily' 改为按日期（isoDaysAgo）直读，
  // 不再需要"最近 N 份文件"语义（跨日跳空会取偏）。
  // v1.8.0：prune / writeLightEntry / captureError 已删除（plugin 模式整体移除，日志永不过期）。
  return { appendDaily };
}
