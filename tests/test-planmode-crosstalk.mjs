// plan 模式跨会话串台回归测试。
//
// 背景：宿主 plan 模式是**会话级**事实 —— `session.append('plan/mode', {active})`
// （packages/plan/plan-mode/src/index.ts:434/450），plan-mode 插件自身也按 session 存状态
// （`pendingIntents.set(session, …)` / `loggedActive(session)`）。
// 而本插件曾把该状态存成**进程级全局** `state.planModeActive`，导致 A 会话进 plan 会波及 B 会话：
//   ① `_settle` 闸门       → B 的记忆整段不落盘
//   ② system section 注入  → B 的 prompt 被塞「当前处于 plan 模式…」（内容级污染）
//   ③ pre-execute deny     → B 的 memory_note / memory_delete 被拒
//
// 本测试**双向**断言（防修过头）：
//   A 侧（3 条）：进了 plan 的会话，禁写仍然生效 —— 这 3 条在修复前后都必须 PASS。
//   B 侧（3 条）：没进 plan 的会话，不受任何影响 —— 这 3 条在修复前 FAIL、修复后 PASS。
//
// 运行：npm run build 后 node tests/test-planmode-crosstalk.mjs
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply } from "../lib/index.js";

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

function makeHarness() {
  const listeners = new Map();
  const captured = { section: null };
  const ctx = {
    on(ev, h) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(h); return () => {}; },
    inject(_deps, cb) { try { cb({ settings: { describe: () => [], replace: async () => {}, installSection: () => {} } }); } catch {} return () => {}; },
    effect() { return () => {}; },
    get() { return undefined; },
    systemPrompt: { section(cfg) { captured.section = cfg; return () => {}; } },
    tools: { register() { return () => {}; }, restrict() { return () => {}; } },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      stream: async function* (params) {
        const blob = JSON.stringify(params.messages ?? []);
        const tag = blob.includes("AAA-ONLY") ? "AAA" : blob.includes("BBB-ONLY") ? "BBB" : "UNKNOWN";
        if (blob.includes("FROM-" + tag)) {
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: "已写入。" };
          yield { type: "block-end", index: 0, block: { type: "text", text: "已写入。" } };
          yield { type: "finish", reason: { kind: "stop" } };
          return;
        }
        const args = `{"ops":[{"op":"append","section":"隔离验证","entry":"FROM-${tag}"}]}`;
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield { type: "tool-call-delta", index: 0, id: "c1", name: "log_write_ops", argumentsDelta: args };
        yield { type: "block-end", index: 0, block: { type: "tool-call", id: "c1", name: "log_write_ops", arguments: args } };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      },
    },
    webServer: { register() { return () => {}; } },
    webRuntime: {},
  };
  const cfg = {
    enabled: true,
    summaryModel: "", summaryTimeoutMs: 5000, subagentLogBudget: 20000,
    userMemoryPath: join(tmpdir(), "mp-nonexistent-user", "MEMORY.md"),
    workspaceMemoryDir: ".deepseek-harness/memory",
    bridgeBuddyMemory: false,
    buddyWorkspaceMemoryDirs: [".workbuddy/memory", ".codebuddy/memory"],
    userBudgetChars: 8000, workspaceBudgetChars: 6000,
    silentPresets: [],
  };
  apply(ctx, cfg);
  let seqCounter = 0;
  const emit = (ev, session, event) => {
    if (ev === "session/event" && session && event) {
      const rec = { ...event, seq: ++seqCounter };
      (session.events ||= []).push(rec);
      session.seq = rec.seq;
      for (const h of (listeners.get(ev) || [])) h(session, rec);
      return;
    }
    for (const h of (listeners.get(ev) || [])) h(session, event);
  };
  // tools/pre-execute 是瀑布式：返回 {kind:'deny'} 即拦截，否则继续 next()。
  const firePreExecute = async (exec) => {
    let result;
    const next = async () => { result = { kind: "next" }; return result; };
    for (const h of (listeners.get("tools/pre-execute") || [])) {
      const r = await h(exec, next);
      if (r && r.kind && r.kind !== "next") return r;
      result = r || result;
    }
    return result || { kind: "next" };
  };
  return { emit, firePreExecute, captured };
}

const TMP = mkdtempSync(join(tmpdir(), "mp-planmode-"));
function makeWs(name) {
  const root = join(TMP, name);
  mkdirSync(join(root, ".deepseek-harness", "memory"), { recursive: true });
  writeFileSync(join(root, ".deepseek-harness", "MEMORY.md"), `# ${name} 项目记忆\n- x\n`, "utf8");
  return root;
}
const wsA = makeWs("ws-a"), wsB = makeWs("ws-b");
const logA = join(wsA, ".deepseek-harness", "memory", `${today}.md`);
const logB = join(wsB, ".deepseek-harness", "memory", `${today}.md`);

const mkSess = (id, cwd) => {
  const events = [];
  return {
    id, seq: 1, firstLiveSeq: 0,
    header: { cwd, agentPreset: "standard" },
    requestHeader: () => ({ config: { provider: "mock", model: "mock-model" } }),
    events,
    snapshotEvents: (from) => events.filter((e) => e.seq >= (from ?? 0)),
    deriveEventMessage: (e) => {
      const text = (e.data?.content || []).map((c) => c.text || "").join(" ");
      if (!text) return null;
      return { id: "m" + e.seq, role: e.type === "user/message" ? "user" : "assistant", content: [{ type: "text", text }], source: e.data?.source ?? { kind: "user" } };
    },
  };
};
const userMsg = (t) => ({ type: "user/message", data: { content: [{ type: "text", text: t }], source: { kind: "user" } } });

const { emit, firePreExecute, captured } = makeHarness();
const sessA = mkSess("sess-A", wsA), sessB = mkSess("sess-B", wsB);

// ---- 场景搭建：只有 A 进 plan 模式（B 全程没有收到任何 plan 事件）----
emit("session/event", sessA, { type: "plan/mode", data: { active: true } });
emit("session/event", sessA, userMsg("AAA-ONLY-CONTENT"));
emit("session/event", sessA, { type: "turn/end", data: {} });
emit("session/event", sessB, userMsg("BBB-ONLY-CONTENT"));
emit("session/event", sessB, { type: "turn/end", data: {} });
await new Promise((r) => setTimeout(r, 2500));

const a = existsSync(logA) ? readFileSync(logA, "utf8") : "";
const b = existsSync(logB) ? readFileSync(logB, "utf8") : "";

const results = [];
const check = (name, cond, detail) => { results.push([name, cond]); console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : detail ? `  ← ${detail}` : ""}`); };

console.log("\n[A 侧] 进了 plan 模式的会话：禁写必须仍然生效（修复前后都应 PASS）");
check("A 的日志未落盘（plan 模式禁写）", !a.includes("FROM-AAA"), `实际: ${JSON.stringify(a.slice(0, 60))}`);
const textA = captured.section?.text?.({ agent: { session: sessA } }) ?? "";
check("A 的 system prompt 含 [plan 模式] 提示", textA.includes("[plan 模式]"));
const ra = await firePreExecute({ name: "memory_note", arguments: { text: "x" }, agent: { session: sessA } });
check("A 的 memory_note 被 deny", ra?.kind === "deny", `实际 kind=${ra?.kind}`);

console.log("\n[B 侧] 没进 plan 模式的会话：不得受任何影响（修复前 FAIL、修复后 PASS）");
check("B 的日志能落盘", b.includes("FROM-BBB"), "B 日志为空 → 被 A 的 plan 状态拦掉");
check("B 的日志未被写入 A 的内容", !b.includes("FROM-AAA"));
const textB = captured.section?.text?.({ agent: { session: sessB } }) ?? "";
check("B 的 system prompt 无 plan 提示", !textB.includes("[plan 模式]"), "被注入 A 的 `[plan 模式]` 提示");
const rb = await firePreExecute({ name: "memory_note", arguments: { text: "x" }, agent: { session: sessB } });
check("B 的 memory_note 未被 deny", rb?.kind !== "deny", `reason: ${rb?.reason}`);

const failed = results.filter((x) => !x[1]);
console.log(`\n通过 ${results.length - failed.length}/${results.length} 项`);
for (const [name] of failed) console.log("   ✗", name);
process.exit(failed.length ? 1 : 0);
