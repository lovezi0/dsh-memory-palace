import { Context } from "@deepseek-ai/cordis";
import { name, apply, Config, inject } from "./lib/index.js";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ws = mkdtempSync(join(tmpdir(), "memtest-"));
const ctx = new Context();
const captured = { sections: [], tools: [], listeners: {} };
const sysPromptImpl = { section: (s) => { captured.sections.push(s); return () => {}; } };
const toolsImpl = { register: (t) => { captured.tools.push(t); } };
ctx.provide("systemPrompt", sysPromptImpl);
ctx.provide("tools", toolsImpl);

const origOn = ctx.on.bind(ctx);
ctx.on = (ev, cb) => { (captured.listeners[ev] ||= []).push(cb); return origOn(ev, cb); };
ctx.logger = { warn: (...a) => console.log("[warn]", ...a), error: (...a) => console.error("[error]", ...a), info: (...a) => console.log("[info]", ...a), debug: (...a) => console.log("[debug]", ...a) };

const cfg = {
  enabled: true,
  userMemoryPath: "~/.deepseek-harness/MEMORY.md",
  workspaceMemoryDir: ".deepseek-harness/memory",
  dailyLogRetentionDays: 30,
  userBudgetChars: 4000,
  workspaceBudgetChars: 3000,
};

try {
  const r = ctx.plugin({ name, apply, Config, inject }, cfg);
  if (r && typeof r.then === "function") await r;
} catch (e) {
  console.error("PLUGIN_LOAD_ERR", e.message, e.stack);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 200));
console.log("[1] LOADED sections=", captured.sections.length,
  "tools=", captured.tools.map((t) => t.name),
  "listeners=", Object.keys(captured.listeners));

const text = captured.sections[0] ? captured.sections[0].text() : "<no section>";
console.log("[2] SECTION_TEXT_IS_STRING=", typeof text === "string");

// simulate a session turn
const fakeSession = { header: { cwd: ws } };
for (const cb of captured.listeners["session/event"] || [])
  cb(fakeSession, { type: "user/message", data: { message: { content: "remember: use tabs" } } });
for (const cb of captured.listeners["session/event"] || [])
  cb(fakeSession, { type: "turn/end", data: {} });

await new Promise((r) => setTimeout(r, 300));

const today = new Date().toISOString().slice(0, 10);
const daily = join(ws, ".deepseek-harness/memory", today + ".md");
console.log("[3] DAILY_EXISTS=", existsSync(daily));
if (existsSync(daily)) console.log("[3] DAILY_CONTENT=", JSON.stringify(readFileSync(daily, "utf8")));

const tool = captured.tools.find((t) => t.name === "memory_note");
if (tool) {
  const res = await tool.execute({ content: "always use tabs for indentation" });
  console.log("[4] NOTE_RES=", JSON.stringify(res));
  const memFile = join(ws, ".deepseek-harness/memory/MEMORY.md");
  console.log("[4] MEM_EXISTS=", existsSync(memFile),
    existsSync(memFile) ? JSON.stringify(readFileSync(memFile, "utf8")) : "");
} else {
  console.log("[4] NO memory_note TOOL");
}

console.log("DONE ws=", ws);

// ---------- 场景 2：桥接已存在的 WorkBuddy 项目记忆 ----------
// 预建 .workbuddy/memory/，验证写入落到 buddy 目录、不单独建 .deepseek-harness/memory/。
const ws2 = mkdtempSync(join(tmpdir(), "memtest-buddy-"));
mkdirSync(join(ws2, ".workbuddy", "memory"), { recursive: true });

const fakeSession2 = { header: { cwd: ws2 } };
for (const cb of captured.listeners["session/event"] || [])
  cb(fakeSession2, { type: "user/message", data: { message: { content: "remember: use spaces" } } });
for (const cb of captured.listeners["session/event"] || [])
  cb(fakeSession2, { type: "turn/end", data: {} });

await new Promise((r) => setTimeout(r, 300));

const today2 = new Date().toISOString().slice(0, 10);
const buddyDaily = join(ws2, ".workbuddy", "memory", today2 + ".md");
const dshDaily2 = join(ws2, ".deepseek-harness", "memory", today2 + ".md");
console.log("[5] BUDDY_DAILY_EXISTS=", existsSync(buddyDaily),
  existsSync(buddyDaily) ? JSON.stringify(readFileSync(buddyDaily, "utf8")) : "");
console.log("[5] DSH_DIR_NOT_CREATED=", !existsSync(join(ws2, ".deepseek-harness")));

const tool2 = captured.tools.find((t) => t.name === "memory_note");
if (tool2) {
  const res = await tool2.execute({ content: "prefer spaces over tabs" });
  console.log("[6] NOTE_RES=", JSON.stringify(res));
  const buddyMem = join(ws2, ".workbuddy", "memory", "MEMORY.md");
  console.log("[6] BUDDY_MEM_EXISTS=", existsSync(buddyMem),
    existsSync(buddyMem) ? JSON.stringify(readFileSync(buddyMem, "utf8")) : "");
  console.log("[6] DSH_MEM_NOT_CREATED=", !existsSync(join(ws2, ".deepseek-harness", "memory", "MEMORY.md")));
} else {
  console.log("[6] NO memory_note TOOL");
}

console.log("DONE ws2=", ws2);

// ---------- 场景 3：memory_note 去重（同一内容只写一次） ----------
const tool3 = captured.tools.find((t) => t.name === "memory_note");
if (tool3) {
  const ws3 = mkdtempSync(join(tmpdir(), "memtest-dedup-"));
  const fakeSession3 = { header: { cwd: ws3 } };
  for (const cb of captured.listeners["session/event"] || [])
    cb(fakeSession3, { type: "user/message", data: { message: { content: "setup" } } });
  // 首次写入
  const r1 = await tool3.execute({ content: "use tabs for indentation" });
  const mem3 = join(ws3, ".deepseek-harness/memory/MEMORY.md");
  const after1 = existsSync(mem3) ? readFileSync(mem3, "utf8") : "";
  // 重复调用同一内容
  const r2 = await tool3.execute({ content: "use tabs for indentation" });
  const r3 = await tool3.execute({ content: "use tabs for indentation" });
  const after2 = readFileSync(mem3, "utf8");
  const count = (after2.match(/- use tabs for indentation/g) || []).length;
  console.log("[7] DEDUP_RES1=", JSON.stringify(r1));
  console.log("[7] DEDUP_RES2=", JSON.stringify(r2));
  console.log("[7] DEDUP_RES3=", JSON.stringify(r3));
  console.log("[7] DEDUP_OCCURRENCES=", count);
  console.log("[7] DEDUP_AFTER=", JSON.stringify(after2));
} else {
  console.log("[7] NO memory_note TOOL");
}

// ---------- 场景 4：memory_note_user 写用户级记忆 + 去重 ----------
// 用独立 Context 加载第二个插件实例，userMemoryPath 指向临时目录，避免写真实 HOME。
const userHome = mkdtempSync(join(tmpdir(), "memtest-user-"));
const ctxU = new Context();
const capturedU = { sections: [], tools: [] };
ctxU.provide("systemPrompt", { section: (s) => { capturedU.sections.push(s); return () => {}; } });
ctxU.provide("tools", { register: (t) => { capturedU.tools.push(t); } });
const origOnU = ctxU.on.bind(ctxU);
ctxU.on = (ev, cb) => { origOnU(ev, cb); return () => {}; };
ctxU.logger = { warn: (...a) => console.log("[warn]", ...a) };
const cfgU = {
  enabled: true,
  userMemoryPath: join(userHome, "MEMORY.md"),
  workspaceMemoryDir: ".deepseek-harness/memory",
  dailyLogRetentionDays: 30,
  userBudgetChars: 4000,
  workspaceBudgetChars: 3000,
};
try {
  const r = ctxU.plugin({ name, apply, Config, inject }, cfgU);
  if (r && typeof r.then === "function") await r;
} catch (e) {
  console.error("PLUGIN_LOAD_ERR_U", e.message);
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 100));
const userTool = capturedU.tools.find((t) => t.name === "memory_note_user");
if (userTool) {
  const r1 = await userTool.execute({ content: "prefer spaces over tabs (global)" });
  const r2 = await userTool.execute({ content: "prefer spaces over tabs (global)" });
  const userMem = join(userHome, "MEMORY.md");
  const after = existsSync(userMem) ? readFileSync(userMem, "utf8") : "";
  const count = (after.match(/- prefer spaces over tabs \(global\)/g) || []).length;
  console.log("[8] USER_RES1=", JSON.stringify(r1));
  console.log("[8] USER_RES2=", JSON.stringify(r2));
  console.log("[8] USER_MEM_EXISTS=", existsSync(userMem));
  console.log("[8] USER_DEDUP_OCCURRENCES=", count);
  console.log("[8] USER_AFTER=", JSON.stringify(after));
} else {
  console.log("[8] NO memory_note_user TOOL");
}

// ---------- 场景 5：memory_read 在"只有每日日志、无 MEMORY.md"的项目里返回日志 ----------
// 复现真实故障：数据分析 项目 .workbuddy/memory/ 只有 YYYY-MM-DD.md，没有 MEMORY.md，
// AI 手动翻文件只找 MEMORY.md 而失败；memory_read 必须能聚合返回日志。
const readTool = captured.tools.find((t) => t.name === "memory_read");
if (readTool) {
  const ws5 = mkdtempSync(join(tmpdir(), "memtest-read-"));
  const memDir5 = join(ws5, ".workbuddy", "memory");
  mkdirSync(memDir5, { recursive: true });
  // 预建一份"昨日"日志（无 MEMORY.md）
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const fakeSession5 = { header: { cwd: ws5 } };
  for (const cb of captured.listeners["session/event"] || [])
    cb(fakeSession5, { type: "user/message", data: { message: { content: "setup" } } });
  // 用 run 写日志不方便，直接预写一份昨日日志文件
  const fs = await import("node:fs/promises");
  await fs.writeFile(join(memDir5, `${yesterday}.md`), `## 2026-08-15T00:00:00.000Z\n昨天定的约定: 用 spaces\n`, "utf8");
  const res5 = await readTool.execute({});
  console.log("[9] READ_RES_OK=", res5.ok);
  console.log("[9] READ_HAS_YESTERDAY_LOG=", res5.memory.includes(yesterday));
  console.log("[9] READ_HAS_LOG_CONTENT=", res5.memory.includes("昨天定的约定"));
  console.log("[9] READ_PREVIEW=", JSON.stringify((res5.memory || "").slice(0, 400)));
} else {
  console.log("[9] NO memory_read TOOL");
}
