// 临时定向验证：手动蒸馏 route（distill.session）在「会话 cwd ≠ 插件 activeCwd」时，
// durable [smart] 事实必须写到会话工作区的【同级】MEMORY.md，而非旧嵌套 memory/MEMORY.md。
// 运行：/usr/bin/env -u NODE_OPTIONS node verify-distill-route.mjs
import { Context } from "@deepseek-ai/cordis";
import { name, apply, Config, inject } from "./lib/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = {
  enabled: true,
  userMemoryPath: "~/.deepseek-harness/MEMORY.md",
  workspaceMemoryDir: ".deepseek-harness/memory",
  dailyLogRetentionDays: 30,
  userBudgetChars: 4000,
  workspaceBudgetChars: 3000,
  summarize: true,
  memoryMode: "plugin",
  summaryModel: "",
  autoCaptureErrors: true,
};

function makeMockLlm(text) {
  return {
    stream(o) {
      async function* gen() {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
      return gen();
    },
  };
}

function fakeSession(cwd, events) {
  const eventsArr = (events || []).map((e, i) => ({ seq: i, ...e }));
  return {
    id: "sess-" + Math.random().toString(36).slice(2, 8),
    header: { cwd },
    firstLiveSeq: 0,
    events: eventsArr,
    get seq() { return eventsArr.length; },
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    deriveEventMessage(e) {
      const d = e?.data;
      const c = d?.message?.content ?? d?.content;
      const text = Array.isArray(c) ? c.map((x) => x?.text ?? "").join("") : (typeof c === "string" ? c : "");
      if (!text.trim()) return null;
      const role = e?.type === "assistant/message" ? "assistant" : "user";
      return { role, content: [{ type: "text", text }], source: { kind: "plugin", plugin: "test" } };
    },
  };
}

let pass = 0, fail = 0;
const assert = (cond, label) => { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL"} ${label}`); };

const durableText = '{"summary":"distilled summary","durable":[{"scope":"project","fact":"ALWAYS use sibling MEMORY.md"}]}';
const wsA = mkdtempSync(join(tmpdir(), "mp-route-a-"));   // 被蒸馏会话的工作区
const wsB = mkdtempSync(join(tmpdir(), "mp-route-b-"));   // 插件 activeCwd 指向的工作区
mkdirSync(join(wsA, ".deepseek-harness", "memory"), { recursive: true });
mkdirSync(join(wsB, ".deepseek-harness", "memory"), { recursive: true });

const ctx = new Context();
const captured = { sections: [], tools: [], routes: [] };
ctx.provide("systemPrompt", { section: (s) => { captured.sections.push(s); return () => {}; } });
ctx.provide("tools", { register: (t) => { captured.tools.push(t); } });
ctx.provide("webServer", { register: (r) => { captured.routes.push(r); } });
ctx.provide("webRuntime", { trustedHosts: [] });
ctx.provide("llm", makeMockLlm(durableText));
const sessions = new Map();
ctx.provide("sessions", { get: (id) => sessions.get(id) ?? null });
const origOn = ctx.on.bind(ctx);
ctx.on = (ev, cb) => { (captured.listeners ||= {})[ev] ||= []; captured.listeners[ev].push(cb); return origOn(ev, cb); };
ctx.logger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
await ctx.plugin({ name, apply, Config, inject }, { ...BASE });

// 场景搭建：插件 activeCwd 指向 wsB（先让 wsB 的会话发事件），再蒸馏 wsA 的会话。
const sessB = fakeSession(wsB);
for (const cb of captured.listeners["session/event"]) cb(sessB, { type: "user/message", data: { message: { content: "warmup wsB" } } });

const sessA = fakeSession(wsA, [
  { type: "user/message", data: { message: { content: "分析 hello 项目结构" } } },
  { type: "tool/result", data: { message: { content: [{ type: "tool-result", toolCallId: "t1", content: [{ type: "text", text: "src files" }] }] } } },
]);
sessions.set(sessA.id, sessA);

// 找到 distill.session 路由 handler，直接调用（复刻按钮点击 → fetch route）
const route = captured.routes.find((r) => r.path === "/memory-palace/api");
const handler = route.handler;
const body = JSON.stringify({ sessionId: sessA.id });
const req = {
  method: "POST",
  url: "/memory-palace/api/distill.session",
  headers: { host: "localhost:8123", "sec-fetch-site": "same-origin", origin: "http://localhost:8123", "content-type": "application/json" },
  [Symbol.asyncIterator]: async function* () { yield Buffer.from(body, "utf8"); },
};
let status = 0, payload = "";
const res = {
  writeHead(s, h) { status = s; },
  end(p) { payload = p; },
};
await handler(req, res);

console.log("route status:", status, "payload:", payload.slice(0, 120));
assert(status === 200, "route returns 200");

const sibling = join(wsA, ".deepseek-harness", "MEMORY.md");
const nested = join(wsA, ".deepseek-harness", "memory", "MEMORY.md");
const siblingText = existsSync(sibling) ? readFileSync(sibling, "utf8") : "";
const nestedText = existsSync(nested) ? readFileSync(nested, "utf8") : "";
console.log("sibling MEMORY.md exists:", existsSync(sibling), "contains fact:", siblingText.includes("ALWAYS use sibling MEMORY.md"));
console.log("nested MEMORY.md exists:", existsSync(nested), "contains fact:", nestedText.includes("ALWAYS use sibling MEMORY.md"));
assert(existsSync(sibling) && siblingText.includes("ALWAYS use sibling MEMORY.md"), "durable 写到【同级】MEMORY.md（修复生效）");
assert(!nestedText.includes("ALWAYS use sibling MEMORY.md"), "durable 未落到旧嵌套 memory/MEMORY.md（bug 已修）");

console.log(`\n==== VERIFY: ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
