// v0.7.0 后端 cordis 单测：覆盖 加载 / 摘要 / 错误捕获 / 防闲聊闸门（A+D 合并 + 可选 LLM 判定）/
// 桥接 / 去重 / 用户级 / 聚合读取。
// 运行（Windows 静默环境）：/usr/bin/env -u NODE_OPTIONS node test-load.mjs
import { Context } from "@deepseek-ai/cordis";
import { name, apply, Config, inject } from "./lib/index.js";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = {
  enabled: true,
  userMemoryPath: "~/.deepseek-harness/MEMORY.md",
  workspaceMemoryDir: ".deepseek-harness/memory",
  dailyLogRetentionDays: 30,
  userBudgetChars: 4000,
  workspaceBudgetChars: 3000,
  summarize: true,
  summaryModel: "",
  autoCaptureErrors: true,
  enableLlmJudgement: false,
};

let pass = 0;
let fail = 0;
function assert(cond, label) {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

function makeMockLlm() {
  return {
    calls: [],
    async stream(opts) {
      this.calls.push(opts);
      async function* gen() {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "[SUMMARY]" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "[SUMMARY]" } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
      return gen();
    },
  };
}

function msgsText(opts) {
  const m = opts && opts.messages;
  if (!m) return "";
  if (typeof m === "string") return m;
  if (Array.isArray(m))
    return m
      .map((x) => {
        if (typeof x === "string") return x;
        if (x && Array.isArray(x.content)) return x.content.map((c) => c?.text ?? "").join("");
        if (x && typeof x.content === "string") return x.content;
        return JSON.stringify(x);
      })
      .join(" ");
  return JSON.stringify(m);
}

function fakeSession(cwd, provider = "deepseek", model = "deepseek-chat") {
  return {
    header: { cwd },
    requestHeader: () => ({ config: { provider, model } }),
  };
}

async function loadPlugin(overrides = {}) {
  const ctx = new Context();
  const captured = { sections: [], tools: [], listeners: {} };
  ctx.provide("systemPrompt", { section: (s) => { captured.sections.push(s); return () => {}; } });
  ctx.provide("tools", { register: (t) => { captured.tools.push(t); } });
  const mockLlm = makeMockLlm();
  ctx.provide("llm", mockLlm);
  const origOn = ctx.on.bind(ctx);
  ctx.on = (ev, cb) => {
    (captured.listeners[ev] ||= []).push(cb);
    return origOn(ev, cb);
  };
  ctx.logger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
  const cfg = { ...BASE, ...overrides };
  const r = ctx.plugin({ name, apply, Config, inject }, cfg);
  if (r && typeof r.then === "function") await r;
  await sleep(30);
  return { ctx, captured, mockLlm };
}

function fire(session, captured, type, data) {
  // 将简化的 tool/result mock 升级为真机事件结构，以真正覆盖 bug：
  // 真机 tool/result.message.content 是 ToolResultBlock[]，文本嵌套在 block.content 内（只取 .text 取不到）。
  // 测试若用 {content:"字符串"} 简化结构，extractText 旧逻辑能取到而真机取不到，会掩盖 bug，故此处对齐真机。
  let payload = data;
  if (type === "tool/result" && data && typeof data.content === "string") {
    payload = {
      message: {
        content: [{ type: "tool-result", toolCallId: "t1", content: [{ type: "text", text: data.content }] }],
      },
    };
  }
  for (const cb of captured.listeners["session/event"] || []) cb(session, { type, data: payload });
}

function localDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dailyFile(ws, dir = ".deepseek-harness/memory") {
  const today = localDate(new Date());
  return join(ws, dir, today + ".md");
}

// ---------- [1] 加载与导出 ----------
console.log("[1] LOAD");
const main = await loadPlugin();
assert(main.captured.sections.length === 1, "[1] 1 section registered");
assert(main.captured.tools.map((t) => t.name).join(",") === "memory_note,memory_note_user,memory_read,memory_delete", "[1] tools = memory_note,memory_note_user,memory_read,memory_delete");
assert((main.captured.listeners["session/event"] || []).length === 1, "[1] session/event listener registered");
assert(!inject.includes("llm"), "[1] inject no longer includes 'llm' (callLlm removed)");
const text = main.captured.sections[0].text();
assert(typeof text === "string", "[2] section.text() returns string");

// ---------- 场景 A：实质轮次（工具调用）→ 轻量条目写入日志（无 LLM） ----------
console.log("[A] SUBSTANTIVE TURN → LIGHT ENTRY");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-a-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "分析仓库结构" } });
  fire(s, captured, "tool/result", { content: "src/index.mjs, src/client.js" });
  fire(s, captured, "turn/end", {});
  await sleep(1800);
  const daily = dailyFile(ws);
  assert(existsSync(daily), "[A] daily log written");
  assert(readFileSync(daily, "utf8").includes("分析仓库结构"), "[A] daily contains raw user text (light entry)");
}

// ---------- 场景 B：错误轮次 → 落 MEMORY「错误+方案」 ----------
console.log("[B] ERROR TURN → MEMORY ERROR ENTRY");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-b-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "tool/result", { content: "boom" });
  fire(s, captured, "turn/end", { reason: { kind: "error", message: "boom: something failed" } });
  await sleep(1800);
  const mem = join(ws, ".deepseek-harness/MEMORY.md");
  assert(existsSync(mem), "[B] MEMORY.md created");
  const memText = readFileSync(mem, "utf8");
  assert(memText.includes("in-session 错误") && memText.includes("boom"), "[B] MEMORY has error entry (no LLM)");
}

// ---------- 场景 C：autoCaptureErrors=false → 不落 MEMORY 错误 ----------
console.log("[C] autoCaptureErrors=false → NO MEMORY ERROR");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-c-"));
  const { captured } = await loadPlugin({ autoCaptureErrors: false });
  const s = fakeSession(ws);
  fire(s, captured, "tool/result", { content: "boom" });
  fire(s, captured, "turn/end", { reason: { kind: "error", message: "boom: hidden" } });
  await sleep(1800);
  const mem = join(ws, ".deepseek-harness/MEMORY.md");
  const memText = existsSync(mem) ? readFileSync(mem, "utf8") : "";
  assert(!memText.includes("boom: hidden"), "[C] error NOT written to MEMORY when switch off");
  const daily = dailyFile(ws);
  assert(existsSync(daily), "[C] daily still written (summary gate open via error)");
}

// ---------- 场景 D：summarize=false → 完全关闭自动记录（agent 主动记 memory_note 仍可用） ----------
console.log("[D] summarize=false → NO RECORDING");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-d-"));
  const { captured } = await loadPlugin({ summarize: false });
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "分析仓库结构" } });
  fire(s, captured, "tool/result", { content: "src/..." });
  fire(s, captured, "turn/end", {});
  await sleep(1800);
  const daily = dailyFile(ws);
  assert(!existsSync(daily), "[D] no daily written when summarize off");
}

// ---------- 场景 F：防闲聊闸门（A+D 合并） ----------
console.log("[F] CHITCHAT GATE (A+D): trivial rounds not written");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-f-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  const greetings = ["hello", "你好", "hi", "阿八八八", "？", "   "];
  for (const g of greetings) {
    fire(s, captured, "user/message", { message: { content: g } });
    fire(s, captured, "turn/end", {});
    await sleep(120);
    const daily = dailyFile(ws);
    assert(!existsSync(daily), `[F] "${g}" → no daily log`);
  }
}

// ---------- 场景 F2：剥离 system-reminder + 摘要仍可写 ----------
console.log("[F2] STRIP system-reminder + summarize");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-f2-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "assistant/message", { message: { content: "<system-reminder>可用 skills 列表…</system-reminder> hi" } });
  fire(s, captured, "user/message", { message: { content: "分析仓库" } });
  fire(s, captured, "tool/result", { content: "src/..." });
  fire(s, captured, "turn/end", {});
  await sleep(1800);
  const daily = dailyFile(ws);
  assert(existsSync(daily), "[F2] daily written despite reminder noise");
}

// ---------- 场景 F3：关键词命中 → 纯文本也写（D 信号） ----------
console.log("[F3] KEYWORD HIT → written (no tool)");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-f3-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "我决定以后都用 tabs 缩进" } });
  fire(s, captured, "turn/end", {});
  await sleep(1800);
  const daily = dailyFile(ws);
  assert(existsSync(daily), "[F3] daily written on keyword (决定)");
}

// ---------- 场景 G：buddy 桥接 ----------
console.log("[G] BUDDY BRIDGE");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-g-"));
  mkdirSync(join(ws, ".workbuddy", "memory"), { recursive: true });
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "分析" } });
  fire(s, captured, "tool/result", { content: "x" });
  fire(s, captured, "turn/end", {});
  await sleep(1800);
  const today = localDate(new Date());
  const buddyDaily = join(ws, ".workbuddy", "memory", today + ".md");
  const dshDaily = join(ws, ".deepseek-harness", "memory", today + ".md");
  assert(existsSync(buddyDaily), "[G] buddy daily written");
  assert(!existsSync(dshDaily), "[G] dsh daily NOT created");
  assert(!existsSync(join(ws, ".deepseek-harness", "MEMORY.md")), "[G] dsh MEMORY.md NOT created (buddy bridge active)");
}

// ---------- 场景 H：memory_note 去重 ----------
console.log("[H] memory_note DEDUP");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-h-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  const tool = captured.tools.find((t) => t.name === "memory_note");
  fire(s, captured, "user/message", { message: { content: "setup" } });
  const r1 = await tool.execute({ content: "use tabs for indentation" });
  const r2 = await tool.execute({ content: "use tabs for indentation" });
  const r3 = await tool.execute({ content: "use tabs for indentation" });
  const mem = join(ws, ".deepseek-harness/MEMORY.md");
  const after = existsSync(mem) ? readFileSync(mem, "utf8") : "";
  const count = (after.match(/- use tabs for indentation/g) || []).length;
  assert(r1.ok && r2.ok && r3.ok, "[H] all three ok");
  assert(count === 1, "[H] deduplicated to 1 occurrence");
}

// ---------- 场景 I：memory_note_user 用户级 + 去重 ----------
console.log("[I] memory_note_user");
{
  const home = mkdtempSync(join(tmpdir(), "mem-i-"));
  const { captured } = await loadPlugin({ userMemoryPath: join(home, "MEMORY.md") });
  const tool = captured.tools.find((t) => t.name === "memory_note_user");
  const r1 = await tool.execute({ content: "prefer spaces over tabs (global)" });
  const r2 = await tool.execute({ content: "prefer spaces over tabs (global)" });
  const mem = join(home, "MEMORY.md");
  const after = existsSync(mem) ? readFileSync(mem, "utf8") : "";
  const count = (after.match(/- prefer spaces over tabs \(global\)/g) || []).length;
  assert(r1.ok && r2.ok, "[I] both ok");
  assert(count === 1, "[I] user-level dedup = 1");
}

// ---------- 场景 J：memory_read 聚合（仅日志无 MEMORY.md） ----------
console.log("[J] memory_read AGGREGATE");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-j-"));
  const memDir = join(ws, ".workbuddy", "memory");
  mkdirSync(memDir, { recursive: true });
  const yesterday = localDate(new Date(Date.now() - 86400000));
  const fs = await import("node:fs/promises");
  await fs.writeFile(join(memDir, `${yesterday}.md`), `## 2026-08-15T00:00:00.000Z\n昨天定的约定: 用 spaces\n`, "utf8");
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "load memory please" } });
  const readTool = captured.tools.find((t) => t.name === "memory_read");
  const res = await readTool.execute({});
  assert(res.ok, "[J] read ok");
  assert(res.memory.includes(yesterday), "[J] yesterday log included");
  assert(res.memory.includes("昨天定的约定"), "[J] log content included");
}

// ---------- 场景 K：工具/代码执行期报错（turn/end=completed，非 error）→ 仍捕获 (issue 1 修复) ----------
console.log("[K] TOOL-ERROR (turn completed) → still captured (issue 1 fix)");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-k-"));
  const { captured } = await loadPlugin({ autoCaptureErrors: true });
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "检查一下工作区的实际路径" } });
  fire(s, captured, "tool/result", { content: "Error: code run failed (exception): ReferenceError: require is not defined" });
  fire(s, captured, "turn/end", { reason: { kind: "completed" } });
  await sleep(1800);
  const mem = join(ws, ".deepseek-harness/MEMORY.md");
  assert(existsSync(mem), "[K] MEMORY.md created");
  const memText = readFileSync(mem, "utf8");
  assert(memText.includes("in-session 错误") && memText.includes("require is not defined"), "[K] error captured from tool result despite completed turn");
}
// ---------- 场景 K2：autoCaptureErrors=false → 即便工具报错也不落 MEMORY ----------
console.log("[K2] autoCaptureErrors=false → NO MEMORY error even on tool error");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-k2-"));
  const { captured } = await loadPlugin({ autoCaptureErrors: false });
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "检查路径" } });
  fire(s, captured, "tool/result", { content: "code run failed (exception): ReferenceError: require is not defined" });
  fire(s, captured, "turn/end", { reason: { kind: "completed" } });
  await sleep(1800);
  const mem = join(ws, ".deepseek-harness/MEMORY.md");
  const memText = existsSync(mem) ? readFileSync(mem, "utf8") : "";
  assert(!memText.includes("in-session 错误"), "[K2] error NOT captured to MEMORY when switch off");
}

// ---------- 场景 L：memory_delete 按内容删除（用户级 + 项目级） ----------
console.log("[L] memory_delete");
{
  // 项目级：写入→删除→确认消失
  const ws = mkdtempSync(join(tmpdir(), "mem-l-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "x" } });
  const note = captured.tools.find((t) => t.name === "memory_note");
  await note.execute({ content: "use tabs for indentation" });
  const del = captured.tools.find((t) => t.name === "memory_delete");
  const mem = join(ws, ".deepseek-harness/MEMORY.md");
  // 预览（不删）
  const p = await del.execute({ match: "use tabs for indentation", level: "project" });
  const before = existsSync(mem) ? readFileSync(mem, "utf8") : "";
  assert(p.preview === true && p.removed === 0, "[L] preview does NOT delete");
  assert(before.includes("use tabs for indentation"), "[L] entry still present after preview");
  assert(Array.isArray(p.matches) && p.matches.length === 1, "[L] preview returns 1 match");
  assert(p.matches[0].tier === "项目级" && p.matches[0].content.includes("use tabs"), "[L] match carries tier + content");
  assert(typeof p.confirmPrompt === "string" && p.confirmPrompt.length > 0, "[L] confirmPrompt generated");
  // 确认删除
  const r1 = await del.execute({ match: "use tabs for indentation", level: "project", confirm: true });
  const after = existsSync(mem) ? readFileSync(mem, "utf8") : "";
  assert(r1.preview === false && r1.removed === 1, "[L] confirm deletes removed=1");
  assert(!after.includes("use tabs for indentation"), "[L] entry gone after confirm");
  assert(r1.details.length === 1 && r1.details[0].tier === "项目级", "[L] delete returns details with tier");
  // 子串匹配
  await note.execute({ content: "prefer const over var" });
  const p2 = await del.execute({ match: "const", level: "project" });
  assert(p2.preview && p2.matches.length === 1, "[L] substring preview");
  const r2 = await del.execute({ match: "const", level: "project", confirm: true });
  const after2 = existsSync(mem) ? readFileSync(mem, "utf8") : "";
  assert(r2.removed === 1 && !after2.includes("prefer const"), "[L] substring delete works");
  // 找不到 → 预览为空
  const r3 = await del.execute({ match: "nonexistent-xyz", level: "project" });
  assert(r3.preview && r3.matches.length === 0, "[L] no-match preview empty");
  // 用户级
  const home = mkdtempSync(join(tmpdir(), "mem-l-u-"));
  const up = join(home, "USERMEM.md");
  const { captured: cap2 } = await loadPlugin({ userMemoryPath: up });
  const s2 = fakeSession(mkdtempSync(join(tmpdir(), "mem-l-ws-")));
  const noteU = cap2.tools.find((t) => t.name === "memory_note_user");
  await noteU.execute({ content: "I drink coffee at 3pm" });
  const delU = cap2.tools.find((t) => t.name === "memory_delete");
  const pU = await delU.execute({ match: "coffee", level: "user" });
  assert(pU.preview && pU.matches.length === 1 && pU.matches[0].tier === "用户级", "[L] user preview tier=用户级");
  const r4 = await delU.execute({ match: "coffee", level: "user", confirm: true });
  const afterU = existsSync(up) ? readFileSync(up, "utf8") : "";
  assert(r4.removed === 1 && !afterU.includes("coffee"), "[L] user-level delete works");
}

// ---------- 场景 L2：多匹配给选项 + 每日级 ----------
console.log("[L2] memory_delete multi-match options + daily tier");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-l2-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: "x" });
  const note = captured.tools.find((t) => t.name === "memory_note");
  await note.execute({ content: "config: use tabs" });
  await note.execute({ content: "config: use spaces" });
  const del = captured.tools.find((t) => t.name === "memory_delete");

  const p = await del.execute({ match: "config", level: "project" });
  assert(p.preview && p.matches.length === 2, "[L2] two matches returned as options");
  const r = await del.execute({ match: "config", level: "project", confirm: true });
  assert(r.removed === 2, "[L2] confirm deletes both matches");

  // 每日级：写入今日日志再删
  const today = localDate(new Date());
  const daily = join(ws, ".deepseek-harness", "memory", today + ".md");
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(ws, ".deepseek-harness", "memory"), { recursive: true });
  await fs.writeFile(daily, `- daily note about tabs\n- daily note about coffee\n`, "utf8");
  const pD = await del.execute({ match: "coffee", level: "daily" });
  assert(pD.preview && pD.matches.some((m) => m.tier === "每日级"), "[L2] daily tier match surfaced");
  const rD = await del.execute({ match: "coffee", level: "daily", confirm: true });
  const afterD = existsSync(daily) ? readFileSync(daily, "utf8") : "";
  assert(rD.removed === 1 && !afterD.includes("coffee") && afterD.includes("tabs"), "[L2] daily delete removes only matched line");
}

// ---------- 场景 M：tools/pre-execute 原生确认弹窗（删除硬闸门） ----------
console.log("[M] pre-execute approval gate (native popup)");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-m-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: "x" });
  const note = captured.tools.find((t) => t.name === "memory_note");
  await note.execute({ content: "use tabs for indentation" });
  await note.execute({ content: "use spaces for indentation" });
  const preListeners = captured.listeners["tools/pre-execute"] || [];
  assert(preListeners.length === 1, "[M] one tools/pre-execute listener registered");
  const gate = preListeners[0];
  const next = async () => ({ kind: "allow" });

  // 预览（confirm 非 true）→ 放行，不弹窗
  const rPrev = await gate({ name: "memory_delete", arguments: { match: "indentation", level: "project" } }, next);
  assert(rPrev.kind === "allow", "[M] preview call passes through (no popup)");

  // 确认删除（confirm:true）→ 原生弹窗 ask，reason 含位置 + 实际内容 + 编号选项
  const rAsk = await gate({ name: "memory_delete", arguments: { match: "indentation", level: "project", confirm: true } }, next);
  assert(rAsk.kind === "ask", "[M] confirm:true triggers native approval popup (ask)");
  assert(typeof rAsk.reason === "string" && rAsk.reason.includes("use tabs for indentation") && rAsk.reason.includes("项目级"), "[M] ask reason cites location + actual content");
  assert(rAsk.reason.includes("[1]") && rAsk.reason.includes("[2]"), "[M] ask reason numbers multiple matches as options");

  // 确认删除但无匹配 → 不弹窗，放行（execute 回"未找到"）
  const rNone = await gate({ name: "memory_delete", arguments: { match: "zzz-no-such", level: "project", confirm: true } }, next);
  assert(rNone.kind === "allow", "[M] confirm with no match passes through (no popup)");

  // 非本工具 → 放行
  const rOther = await gate({ name: "memory_read", arguments: {} }, next);
  assert(rOther.kind === "allow", "[M] unrelated tool passes through");
}

// ---------- 场景 T：工具任务轮次（多 turn 拆开）必须落记忆 ----------
// 复现用户报告：让 dsh「写脚本统计文件数量」（含多次工具调用），此前因 tool/result 文本取不到 → hasTool 永远 false
// → 闸门误判非实质轮次 → 不写记忆。修复后 tool-result block 嵌套文本被正确提取，多 turn 累积后落盘。
console.log("[T] tool-task turn (multi-turn) writes memory");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-t-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "用 Python 写个脚本统计每个子目录的文件数" } });
  fire(s, captured, "tool/result", { content: "wrote count_files.py (1598 bytes)" });
  fire(s, captured, "turn/end", {}); // turn 1（含工具结果）
  fire(s, captured, "assistant/message", { message: { content: [{ type: "text", text: "再运行一下确认结果" }] } });
  fire(s, captured, "tool/result", { content: "ran: 3 files in 2 dirs" });
  fire(s, captured, "turn/end", {}); // turn 2（又含工具结果）
  fire(s, captured, "assistant/message", { message: { content: [{ type: "text", text: "已完成" }] } });
  fire(s, captured, "turn/end", {}); // turn 3（最终，无工具）
  await sleep(1800); // 等 debounce flush
  const daily = dailyFile(ws);
  const text = existsSync(daily) ? readFileSync(daily, "utf8") : "";
  assert(text.length > 0, "[T] 工具任务轮次已落记忆（多 turn 累积后写入）");
}

// ---------- 场景 V：冷启动（记忆全空）时主动记忆指令仍注入 ----------
console.log("[V] section 空记忆仍注入记忆公民指令");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-v-"));
  const emptyUser = join(ws, "no-user-memory.md");
  const { captured } = await loadPlugin({ userMemoryPath: emptyUser });
  const text = captured.sections[0].text();
  assert(typeof text === "string" && text.length > 0, "[V] 空记忆时 section 非空");
  assert(text.includes("记忆公民指令"), "[V] 空记忆时仍注入主动记忆指令");
  assert(text.includes("memory_note"), "[V] 指令含记忆工具指引");
}

// ---------- 场景 W：本地日期写入 + runtime-context 噪声剥离 ----------
console.log("[W] local-date daily file + runtime-context noise stripped");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-w-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  // assistant 消息：真机形态下 runtime-context 是独立 text block，真实回复是另一个 block
  fire(s, captured, "assistant/message", {
    message: { content: [
      { type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: workspace-write." },
      { type: "text", text: "已完成统计" },
    ] },
  });
  fire(s, captured, "tool/result", { content: "done" });
  fire(s, captured, "turn/end", {});
  await sleep(1800);
  const daily = dailyFile(ws);
  assert(existsSync(daily), "[W] daily written to LOCAL-date file");
  const text = readFileSync(daily, "utf8");
  assert(!text.includes("Current runtime context"), "[W] runtime-context noise stripped");
  assert(text.includes("已完成统计"), "[W] real assistant text kept");
}

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
