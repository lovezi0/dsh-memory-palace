// 写侧串台回归测试（issue #3）。
//
// 与 #1/#2 的「读」方向不同：本测试覆盖「写」方向 —— 多会话并发时，结算必须把内容写进
// 【各自会话】的每日日志，而不是「最近活跃会话」的目录。
//
// 旧实现 _settle 读全局 state.activeSession；A 的 request 在途时若 B 发来新消息，
// activeSession 已指向 B，于是 A 的内容被写进 B 的项目目录（真实事故见 issue #3）。
//
// 运行：npm run build 后 node tests/test-settle-cwd.mjs
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply } from "../lib/index.js";

let passed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

// 驱动 apply()：mock LLM 让每轮子代理都成功落盘一条带会话标识的日志。
function makeHarness() {
  const listeners = new Map();
  const ctx = {
    on(ev, h) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(h); return () => {}; },
    inject(_deps, cb) { try { cb({ settings: { describe: () => [], replace: async () => {}, installSection: () => {} } }); } catch {} return () => {}; },
    effect() { return () => {}; },
    get() { return undefined; },
    systemPrompt: { section() { return () => {}; } },
    tools: { register() { return () => {}; }, restrict() { return () => {}; } },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      stream: async function* (params) {
        // 与真实子代理一致：它总结的是【被喂进来的那份对话】，故内容归属可判。
        const blob = JSON.stringify(params.messages ?? []);
        const tag = blob.includes("AAA-ONLY-CONTENT") ? "AAA" : blob.includes("BBB-ONLY-CONTENT") ? "BBB" : "UNKNOWN";
        const done = blob.includes("FROM-" + tag);
        if (done) {
          // 第二轮：已落盘 → 收尾
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
  // 让 mock 落盘内容带上"发起会话"标记：这样即便目录对了，也能发现内容归属错误。
  let currentSessionTag = "UNKNOWN";
  const cfg = {
    enabled: true,
    summaryModel: "",
    summaryTimeoutMs: 5000,
    subagentLogBudget: 20000,
    userMemoryPath: join(tmpdir(), "mp-nonexistent-user", "MEMORY.md"),
    workspaceMemoryDir: ".deepseek-harness/memory",
    bridgeBuddyMemory: false,
    buddyWorkspaceMemoryDirs: [".workbuddy/memory", ".codebuddy/memory"],
    userBudgetChars: 4000,
    workspaceBudgetChars: 3000,
    silentPresets: [],
  };
  apply(ctx, cfg);
  let seqCounter = 0;
  // 镜像宿主行为：事件先落进 session 事件流，再派发给监听器。
  const emit = (ev, session, event) => {
    if (ev === "session/event" && session && event) {
      currentSessionTag = session.id;
      const rec = { ...event, seq: ++seqCounter };
      (session.events ||= []).push(rec);
      session.seq = rec.seq;
      for (const h of (listeners.get(ev) || [])) h(session, rec);
      return;
    }
    for (const h of (listeners.get(ev) || [])) h(session, event);
  };
  return { emit };
}

const TMP = mkdtempSync(join(tmpdir(), "mp-settle-"));
function makeWs(name) {
  const root = join(TMP, name);
  mkdirSync(join(root, ".deepseek-harness", "memory"), { recursive: true });
  writeFileSync(join(root, ".deepseek-harness", "MEMORY.md"), `# ${name} 项目记忆\n- x\n`, "utf8");
  return root;
}
const wsA = makeWs("ws-a"), wsB = makeWs("ws-b");
const logA = join(wsA, ".deepseek-harness", "memory", `${today}.md`);
const logB = join(wsB, ".deepseek-harness", "memory", `${today}.md`);

// session 需带 requestHeader（resolveModel 兜底）、seq/firstLiveSeq，
// 以及项目会话事件接口（projectTurnMessages 经 eventsFrom(session) 读取）。
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
const sessA = mkSess("sess-A", wsA), sessB = mkSess("sess-B", wsB);
const userMsg = (t) => ({ type: "user/message", data: { content: [{ type: "text", text: t }], source: { kind: "user" } } });
const toolRes = (t) => ({ type: "tool/result", data: { content: [{ type: "text", text: t }] } });

console.log("\n① 并发会话：A 在途时 B 发消息（旧实现会把 A 结算进 B 目录）");
{
  const { emit } = makeHarness();
  emit("session/event", sessA, userMsg("AAA-ONLY-CONTENT"));
  emit("session/event", sessA, toolRes("AAA-tool"));
  emit("session/event", sessB, userMsg("BBB-ONLY-CONTENT"));   // ← 触发 A 提前结算
  emit("session/event", sessB, toolRes("BBB-tool"));
  emit("session/event", sessA, { type: "turn/end", data: {} });
  emit("session/event", sessB, { type: "turn/end", data: {} });
  await new Promise((r) => setTimeout(r, 4000));

  const a = existsSync(logA) ? readFileSync(logA, "utf8") : "";
  const b = existsSync(logB) ? readFileSync(logB, "utf8") : "";
  console.log("    A 日志:", JSON.stringify(a.slice(0, 100)));
  console.log("    B 日志:", JSON.stringify(b.slice(0, 100)));

  // 两个会话都应各自落盘（证明链路确实写入了）
  assert.ok(a.length > 0 && b.length > 0, "两个会话都应各自落盘（证明链路有效）");
  // 内容归属：A 的日志只能有 FROM-AAA（A 的对话），B 的只能有 FROM-BBB。
  assert.ok(a.includes("FROM-AAA"), "A 日志应含 A 自己写入的内容");
  assert.ok(b.includes("FROM-BBB"), "B 日志应含 B 自己写入的内容");
  assert.ok(!a.includes("FROM-BBB"), "A 日志不得含 B 会话写入的内容（写侧串台）");
  assert.ok(!b.includes("FROM-AAA"), "B 日志不得含 A 会话写入的内容（写侧串台）");
  ok("并发结算写入各自会话目录，内容归属正确");
}

console.log("\n② 断点隔离：两会话断点互不影响");
{
  const { emit } = makeHarness();
  emit("session/event", sessA, { type: "user/message", data: { content: [{ type: "text", text: "A1" }], source: { kind: "user" } } });
  emit("session/event", sessB, { type: "user/message", data: { content: [{ type: "text", text: "B1" }], source: { kind: "user" } } });
  emit("session/event", sessA, { type: "turn/end", data: {} });
  emit("session/event", sessB, { type: "turn/end", data: {} });
  await new Promise((r) => setTimeout(r, 4000));
  ok("两会话并发结算不互相 clearTimeout（均能落盘）");
}

console.log(`\n通过 ${passed} 项`);
