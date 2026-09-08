// memory-palace v1.6.0 hybrid 模式：Markdown 章节纯函数（无 IO、无副作用）。
// 服务三类调用方：记忆子 agent 的日志 ops（追加/新增/标删）、agent 的 memory_write /
// memory_update_section 工具、memory_reorganize 的门禁计算。
// 设计约束（v1.6.0 定案）：
// - 全部返回 { ok, reason, ... }，永不抛错——LLM 产出的 ops 不可信，机器侧兜底；
// - 只拆两级标题（`## `），`#` 文件标题与前言归 head，`###` 及更深归当前章节内容；
// - 不改动 text.mjs 既有函数（normLine/budgetClip 有 v1.4.1 测试锚定），本文件自持归一化。

// 章节标题归一化：剥 `#` 前缀、合空白、转小写。标题匹配全部走它，"带不带 ## 前缀"都鲁棒。
const normTitle = (s) =>
  (s || "").trim().replace(/^#+\s*/, "").replace(/\s+/g, " ").toLowerCase();

// 章节块归一化：逐行 trim + 合空白、丢空行、转小写。整章节 stale 比对（防并发/重试错位）用。
const normBlock = (t) =>
  (t || "")
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l)
    .join("\n")
    .toLowerCase();

const SECTION_RE = /^##\s+(.+?)\s*$/;

// v1.7.0 特性4：确保每日日志有规范文件头 `# YYYY-MM-DD`。
// 现状有三种形态（实测）：①正常 `# 2026-09-08`；②首行空；③直接以 `## 章节` 开头（无文件头）。
// 本函数幂等：已有当日标题则原样返回；否则在文件头补一行标题 + 空行。
// 只在【写入时】调用（不回填历史文件），故存量日志可能新旧混存——可接受。
export function ensureLogHeader(md, date) {
  const title = `# ${date}`;
  const text = md || "";
  const lines = text.split("\n");
  // 已存在同日标题（不限首行，容忍前置空行）→ 不动
  if (lines.some((l) => l.trim() === title)) return text;
  const body = text.replace(/^\s+/, "");
  return body ? `${title}\n\n${body}` : `${title}\n`;
}

// 解析 `## ` 章节。返回 { head: string[], sections: [{ title, lines }] }；
// lines 含标题行本体；`#` 文件标题、前言与 `<!--` 注释归 head；`###` 及更深归当前章节。
export function parseSections(md) {
  const lines = (md || "").split("\n");
  const head = [];
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m) {
      cur = { title: m[1].trim(), lines: [line] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
    else head.push(line);
  }
  return { head, sections };
}

// 在 md 中定位章节，返回 { start, end, lines }（end 为下一章节起点或文件尾，不含）。
// 未命中返回 null。供内部函数与 hybrid/tools.mjs（memory_update_section 的 stale 校验）共用。
export function locateSection(md, section) {
  const lines = (md || "").split("\n");
  const want = normTitle(section);
  if (!want) return null;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_RE.exec(lines[i]);
    if (m && normTitle(m[1]) === want) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (SECTION_RE.test(lines[j])) {
      end = j;
      break;
    }
  }
  return { start, end, lines };
}

// 章节内追加条目。章节存在 → 内容最后一个非空行后插入 `- entry`（全空行则插在标题行后）；
// 章节不存在 → { ok:false, reason:"section-miss" }（调用方决定是否走新增）。
// entry 写入前剥除行首列表符（`- `/`* `/`-`/`*`，含缩进）——LLM 常按描述示例自带 `- ` 前缀，
// 不剥会导致 `- - xxx` 双列表符脏数据（v1.6.0 实装踩坑）。
export function appendToSectionText(md, section, entry) {
  const clean = String(entry ?? "").trim().replace(/^[-*]\s+/, "").trim();
  const entryLine = `- ${clean}`;
  if (!entryLine.slice(2).trim()) return { ok: false, reason: "empty-entry" };
  const loc = locateSection(md, section);
  if (!loc) return { ok: false, reason: "section-miss" };
  const { start, end, lines } = loc;
  let insertAt = end;
  while (insertAt > start + 1 && !lines[insertAt - 1].trim()) insertAt--;
  lines.splice(insertAt, 0, entryLine);
  return { ok: true, reason: "appended", text: lines.join("\n") };
}

// 章节追加（upsert 语义）：存在则追加，不存在则文件尾新增章节。日志 ops 的 "append" 与
// memory_write 工具共用——"不要强行匹配现有章节，不符合章节标题就走新增"。
export function upsertSectionText(md, section, entry) {
  const r = appendToSectionText(md, section, entry);
  if (r.ok) return r;
  if (r.reason === "empty-entry") return r;
  const title = `## ${String(section ?? "").trim()}`;
  const base = (md || "").replace(/\s+$/, "");
  const entryLine = `- ${String(entry ?? "").trim().replace(/^[-*]\s+/, "").trim()}`;
  const text = base ? `${base}\n\n${title}\n${entryLine}\n` : `${title}\n${entryLine}\n`;
  return { ok: true, reason: "section-created", text };
}

// 显式新建章节（与 upsert 的区别：章节已存在时拒绝而非追加）——子 agent 日志 ops 的
// "new_section" 专用，防止模型把该走 append 的操作误标为 new_section 造成静默混写。
export function createSectionText(md, section, entry) {
  if (locateSection(md, section)) return { ok: false, reason: "section-exists" };
  return upsertSectionText(md, section, entry);
}

// 整章节精确替换（stale 防护）：oldSectionText 与当前章节全文（含标题行，归一化后）必须完全
// 一致才执行替换，否则拒绝并回显当前实际内容（供 agent 重读后再试）。newSectionText 原样落盘
// （模型负责含 `## 标题` 与删除线标记）；匹配/拒绝的归一化对首尾空行不敏感。
export function replaceSectionText(md, section, oldSectionText, newSectionText) {
  const newText = String(newSectionText ?? "").trim();
  if (!newText) return { ok: false, reason: "empty-replacement" };
  const loc = locateSection(md, section);
  if (!loc) return { ok: false, reason: "section-miss" };
  const { start, end, lines } = loc;
  const current = lines.slice(start, end).join("\n").trim();
  if (normBlock(current) !== normBlock(String(oldSectionText ?? ""))) {
    return { ok: false, reason: "conflict", actual: current };
  }
  // 保留章节末尾的分隔空行（章节与下一章节之间通常有空行，整块替换时不能吞掉，
  // 否则下一章节标题会紧贴上一章节最后一条目）。
  const hasTrailingBlank = end > start && !lines[end - 1].trim();
  const spliceEnd = hasTrailingBlank ? end - 1 : end;
  lines.splice(start, spliceEnd - start, ...newText.split("\n"));
  return { ok: true, reason: "replaced", text: lines.join("\n") };
}

// 章节内标记删除（墓碑，不物理删除）：命中行改写为删除线格式；已删除线 → already；
// 结构行（# / <!--）与已删除线条目永不被改写；章节未命中 / 行未命中分别上报。
// 删除线格式：保留原列表符（`- text` → `- ~~text~~`；无列表符 → `~~text~~`）。
export function markEntryDeletedText(md, section, entryOldText) {
  const want = normLineLoose(entryOldText);
  if (!want) return { ok: false, reason: "empty-entry" };
  const loc = locateSection(md, section);
  if (!loc) return { ok: false, reason: "section-miss" };
  const { start, end, lines } = loc;
  for (let i = start + 1; i < end; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || isStructuralLine(trimmed)) continue;
    if (/^(-\s+)?~~[\s\S]+~~$/.test(trimmed)) {
      if (normLineLoose(trimmed) === want) return { ok: true, reason: "already", text: md };
      continue;
    }
    if (normLineLoose(trimmed) !== want) continue;
    const struck = /^-\s+/.test(trimmed)
      ? trimmed.replace(/^(-\s+)([\s\S]+)$/, "$1~~$2~~")
      : `~~${trimmed}~~`;
    lines[i] = raw.replace(trimmed, struck);
    return { ok: true, reason: "marked", text: lines.join("\n") };
  }
  return { ok: false, reason: "entry-miss" };
}

// 宽松行归一化：剥列表符与删除线包裹、合空白、转小写。标删比对专用（与 text.mjs normLine
// 语义相近但多剥一层 ~~，避免"已标删行"永远无法二次匹配）。
function normLineLoose(s) {
  return (s || "")
    .trim()
    .replace(/^-\s+/, "")
    .replace(/^~~([\s\S]+)~~$/, "$1")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isStructuralLine(t) {
  return t.startsWith("#") || t.startsWith("<!--");
}
