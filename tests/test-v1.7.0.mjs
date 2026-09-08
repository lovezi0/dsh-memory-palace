// v1.7.0 单测：四特性纯函数与钩子逻辑（不依赖真实 dsh 宿主）。
// 运行：/usr/bin/env -u NODE_OPTIONS node test-v1.7.0.mjs
// 覆盖：
//   特性1 E 投影（buildProjections 内容/预算/source 标注；registerProjection 折叠/去重/降级）
//   特性2 路径读取优先级（readDirs dsh 优先叠加 buddy；writeDirs buddy 优先不变）
//   特性3 子 agent 投影 source 过滤（projectTurnMessages）
//   特性4 ensureLogHeader（幂等/补齐/旧格式）+ SUBAGENT_SYSTEM 含格式规范段
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPaths } from "../src/common/paths.mjs";
import { ensureLogHeader, upsertSectionText } from "../src/common/sections.mjs";
import { buildProjections, registerProjection } from "../src/projection.mjs";
import { projectTurnMessages } from "../src/hybrid/subagent.mjs";
import { SUBAGENT_SYSTEM } from "../src/hybrid/prompts.mjs";

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS | ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL | ${label}\n         ${e?.message || e}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS | ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL | ${label}\n         ${e?.message || e}`);
  }
}

const TMP = join(process.cwd(), ".tmp-v170-test");
const resetTmp = () => rmSync(TMP, { recursive: true, force: true });
const mk = (rel) => mkdirSync(join(TMP, rel), { recursive: true });
const norm = (p) => p.replace(/\\/g, "/");
const baseCfg = (over = {}) => ({
  enabled: true,
  userMemoryPath: "~/.deepseek-harness/MEMORY.md",
  workspaceMemoryDir: ".deepseek-harness/memory",
  bridgeBuddyMemory: true,
  buddyWorkspaceMemoryDirs: [".workbuddy/memory", ".codebuddy/memory"],
  userBudgetChars: 4000,
  workspaceBudgetChars: 3000,
  ...over,
});

// ============ 特性 4：ensureLogHeader ============
console.log("\n[特性4] ensureLogHeader");
{
  const D = "2026-09-08";
  check("空文件 → 只写标题", () => assert.equal(ensureLogHeader("", D), "# 2026-09-08\n"));
  check("已有同日标题 → 原样返回（幂等）", () => {
    const t = "# 2026-09-08\n\n## 章节\n- 条目";
    assert.equal(ensureLogHeader(t, D), t);
    assert.equal(ensureLogHeader(ensureLogHeader(t, D), D), t);
  });
  check("首行空 → 补标题", () =>
    assert.equal(ensureLogHeader("\n## 章节\n- 条目", D), "# 2026-09-08\n\n## 章节\n- 条目"));
  check("直接以 ## 开头（无文件头）→ 补标题", () =>
    assert.equal(ensureLogHeader("## 章节\n- 条目", D), "# 2026-09-08\n\n## 章节\n- 条目"));
  check("旧格式带后缀 → 在其上方补规范标题（不删旧行）", () =>
    assert.equal(
      ensureLogHeader("# 2026-09-08 工作日志\n\n## 章节", D),
      "# 2026-09-08\n\n# 2026-09-08 工作日志\n\n## 章节",
    ));
  check("与 upsertSectionText 组合：空日志写入后文件头唯一", () => {
    const r = upsertSectionText("", "章节", "条目");
    const out = ensureLogHeader(r.text, D);
    assert.equal(out.split("# 2026-09-08").length - 1, 1);
    assert.ok(out.startsWith("# 2026-09-08\n\n## 章节\n- 条目"));
  });
}

// ============ 特性 4：SUBAGENT_SYSTEM 格式规范 ============
console.log("\n[特性4] SUBAGENT_SYSTEM 格式规范");
{
  const sys = SUBAGENT_SYSTEM();
  check("含【格式规范】段", () => assert.ok(sys.includes("【格式规范（必须遵守）】")));
  check("含 7 条正面规则（文件头/章节/缩进/加粗/行内分组/一句语境/代码块）", () => {
    for (const k of ["文件头由插件自动维护", "###", "两个空格缩进", "**加粗**", "**用户约定**", "只一句", "代码块"]) {
      assert.ok(sys.includes(k), `缺关键规则：${k}`);
    }
  });
  check("含 3 条反模式", () => {
    assert.ok(sys.includes("过程流水"));
    assert.ok(sys.includes("自我过程表述"));
    assert.ok(sys.includes("200 字长句"));
  });
  check("保留原有环境边界禁令", () => assert.ok(sys.includes("run_code 等工具均不存在")));
}

// ============ 特性 2：路径优先级 ============
console.log("\n[特性2] readDirs / writeDirs 优先级");
{
  const probe = (setup, cfgOver = {}) => {
    resetTmp();
    setup();
    const paths = createPaths(() => baseCfg(cfgOver), () => TMP);
    // 归一化为「相对 TMP 的 posix 路径」，跨平台可比。
    const rel = (p) => norm(p).replace(norm(TMP), "");
    return {
      read: paths.readDirs(TMP).map(rel),
      write: paths.writeDirs(TMP).map(rel),
    };
  };
  const dsh = "/.deepseek-harness/memory";
  const wb = "/.workbuddy/memory";
  const cb = "/.codebuddy/memory";

  check("无 buddy 目录 → 读/写均为 dsh", () => {
    const r = probe(() => {});
    assert.deepEqual(r.read, [dsh]);
    assert.deepEqual(r.write, [dsh]);
  });
  check("仅 .workbuddy → 读 [dsh, wb]；写 [wb]（读 dsh 优先，写 buddy 优先）", () => {
    const r = probe(() => mk(".workbuddy/memory"));
    assert.deepEqual(r.read, [dsh, wb]);
    assert.deepEqual(r.write, [wb]);
  });
  check("仅 .codebuddy → 读 [dsh, cb]；写 [cb]", () => {
    const r = probe(() => mk(".codebuddy/memory"));
    assert.deepEqual(r.read, [dsh, cb]);
    assert.deepEqual(r.write, [cb]);
  });
  check("buddy 双目录 → 读 [dsh, wb, cb]；写 [wb, cb]", () => {
    const r = probe(() => { mk(".workbuddy/memory"); mk(".codebuddy/memory"); });
    assert.deepEqual(r.read, [dsh, wb, cb]);
    assert.deepEqual(r.write, [wb, cb]);
  });
  check("bridgeBuddyMemory=false → 读/写只含 dsh", () => {
    const r = probe(() => mk(".workbuddy/memory"), { bridgeBuddyMemory: false });
    assert.deepEqual(r.read, [dsh]);
    assert.deepEqual(r.write, [dsh]);
  });
  check("enabled=false → 读/写均为空", () => {
    const r = probe(() => {}, { enabled: false });
    assert.deepEqual(r.read, []);
    assert.deepEqual(r.write, []);
  });
  check("旧版回归：buddy 存在时 dsh 仍可被读到（修目录级排他）", () => {
    const r = probe(() => mk(".workbuddy/memory"));
    assert.ok(r.read.includes(dsh), "dsh 目录必须仍在读取源中");
  });
}

// ============ 特性 3：子 agent 投影 source 过滤 ============
console.log("\n[特性3] projectTurnMessages source 过滤");
{
  const mkEvent = (type, source, text, seq) => ({
    type,
    seq,
    data: { id: `${type}-${seq}`, role: "user", content: [{ type: "text", text }], source },
  });
  const mkSession = (events) => ({
    _events: events,
    deriveEventMessage(e) {
      if (e.type === "user/message") return e.data;
      if (e.type === "assistant/message") {
        return { role: "assistant", content: e.data.content, source: { kind: "model", provider: "p", model: "m" } };
      }
      if (e.type === "tool/result") {
        return { role: "user", content: e.data.content, source: { kind: "tool", callId: "c1" } };
      }
      return null;
    },
    snapshotEvents(from) {
      return this._events.filter((e) => e.seq >= from);
    },
  });

  const events = [
    mkEvent("user/message", { kind: "agent-instructions", form: "instructions" }, "AGENTS.md baseline", 1),
    mkEvent("user/message", { kind: "plugin", plugin: "dsh-memory-palace", form: "instructions" }, "# 用户级记忆正文", 2),
    mkEvent("user/message", { kind: "skill-catalog", form: "catalog" }, "可用 skills", 3),
    mkEvent("user/message", { kind: "user" }, "用户的真实提问", 4),
    mkEvent("assistant/message", { kind: "model" }, "回答", 5),
    mkEvent("tool/result", { kind: "tool" }, "工具输出", 6),
  ];

  check("排除 agent-instructions / plugin / skill-catalog，只留真实用户消息", () => {
    const texts = projectTurnMessages(mkSession(events), 0).map((m) => m.content[0].text);
    assert.deepEqual(texts, ["用户的真实提问", "回答", "工具输出"]);
  });
  check("assistant/message 与 tool/result 原样保留", () => {
    const hist = projectTurnMessages(mkSession(events), 0);
    assert.equal(hist.length, 3);
    assert.equal(hist[1].role, "assistant");
    assert.equal(hist[2].source.kind, "tool");
  });
  check("fromSeq 断点仍生效", () => {
    const texts = projectTurnMessages(mkSession(events), 4).map((m) => m.content[0].text);
    assert.deepEqual(texts, ["用户的真实提问", "回答", "工具输出"]);
  });
  check("无 source 的 user/message 保留（fail-open：宁可多留，不误丢真实对话）", () => {
    const hist = projectTurnMessages(mkSession([mkEvent("user/message", undefined, "无 source", 7)]), 0);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].content[0].text, "无 source");
  });
  check("source 存在但非 user → 排除（黑名单口径）", () => {
    const hist = projectTurnMessages(
      mkSession([mkEvent("user/message", { kind: "plugin", plugin: "x" }, "插件注入", 8)]),
      0,
    );
    assert.equal(hist.length, 0);
  });
}

// ============ 特性 1：E 投影 ============
console.log("\n[特性1] buildProjections");
{
  const setup = () => {
    resetTmp();
    mk(".deepseek-harness/memory");
    mk(".workbuddy/memory");
    writeFileSync(join(TMP, ".deepseek-harness/MEMORY.md"), "# dsh 项目记忆\n- dsh 条目", "utf8");
    writeFileSync(join(TMP, ".workbuddy/memory/MEMORY.md"), "# buddy 项目记忆\n- buddy 条目", "utf8");
  };
  const build = (cfgOver = {}) => {
    const cfg = baseCfg(cfgOver);
    const paths = createPaths(() => cfg, () => TMP);
    return buildProjections({ getConfig: () => cfg, paths });
  };

  check("source 标注为 kind=plugin / plugin=dsh-memory-palace / form=instructions", () => {
    setup();
    const msgs = build(TMP);
    assert.ok(msgs.length > 0);
    for (const m of msgs) {
      assert.equal(m.role, "user");
      assert.equal(m.source.kind, "plugin");
      assert.equal(m.source.plugin, "dsh-memory-palace");
      assert.equal(m.source.form, "instructions");
    }
  });
  check("用户级与项目级拆成独立消息，且 dsh + buddy 项目记忆都注入（特性2 联动）", () => {
    setup();
    const heads = build().map((m) => norm(m.content[0].text.split("\n")[0]));
    assert.ok(heads.some((h) => h.includes("用户级记忆")), "缺用户级");
    assert.ok(heads.some((h) => h.includes(".deepseek-harness/MEMORY.md")), "缺 dsh 项目级");
    assert.ok(heads.some((h) => h.includes(".workbuddy/memory/MEMORY.md")), "缺 buddy 项目级");
  });
  check("enabled=false → 不产出任何投影", () => {
    setup();
    assert.equal(build({ enabled: false }).length, 0);
  });
  check("预算截断生效", () => {
    setup();
    const msgs = build({ userBudgetChars: 5, workspaceBudgetChars: 5 });
    for (const m of msgs) assert.ok(m.content[0].text.length < 200, "预算未截断");
  });
  check("无记忆文件 → 空数组（不报错）", () => {
    resetTmp();
    // 用户级指向不存在的路径，避免读到真实 ~/.deepseek-harness/MEMORY.md 污染断言。
    assert.deepEqual(build({ userMemoryPath: "~/.__no_such_dir__/MEMORY.md" }), []);
  });
}

console.log("\n[特性1] registerProjection 钩子");
{
  const setupOne = () => {
    resetTmp();
    mk(".deepseek-harness/memory");
    writeFileSync(join(TMP, ".deepseek-harness/MEMORY.md"), "# 项目记忆\n- 条目A", "utf8");
  };
  const cfg = baseCfg({ userMemoryPath: "~/.__nonexistent__/MEMORY.md", buddyWorkspaceMemoryDirs: [] });
  const paths = createPaths(() => cfg, () => TMP);
  const capture = (p = paths) => {
    let listener = null;
    registerProjection({ ctx: { on: (n, f) => { if (n === "agent/pre-step") listener = f; } }, getConfig: () => cfg, paths: p });
    return listener;
  };
  const mkSession = (nodes = [], eventAt = () => undefined) => ({ surface: { nodes }, eventAt });
  const run = (listener, agent, messages, decision) =>
    listener({ agent, messages, step: 1, signal: { throwIfAborted() {} } }, async () => decision);

  setupOne();
  const listener = capture();
  check("已注册 agent/pre-step 监听器", () => assert.equal(typeof listener, "function"));

  await checkAsync("折叠位置在 claimed 之后", async () => {
    const claimed = [{ content: [{ type: "text", text: "提问" }], source: { kind: "user" } }];
    const runtime = { content: [{ type: "text", text: "runtime" }], source: { kind: "plugin", plugin: "x" } };
    const out = await run(listener, { session: mkSession() }, claimed, { kind: "enter", messages: [...claimed, runtime] });
    const idx = out.messages.findIndex((m) => m.source?.plugin === "dsh-memory-palace");
    assert.equal(idx, 1, `期望 idx=1，实际 ${idx}`);
  });

  await checkAsync("decision 已含同 payload → 不重复注入", async () => {
    const first = await run(listener, { session: mkSession() }, [], { kind: "enter", messages: [] });
    const proj = first.messages.find((m) => m.source?.plugin === "dsh-memory-palace");
    const out = await run(listener, { session: mkSession() }, [], { kind: "enter", messages: [proj] });
    assert.equal(out.messages.length, 1);
  });

  await checkAsync("surface 已含同 payload → 不重复注入（compaction 移出后自动重注）", async () => {
    const first = await run(listener, { session: mkSession() }, [], { kind: "enter", messages: [] });
    const proj = first.messages.find((m) => m.source?.plugin === "dsh-memory-palace");
    const session = mkSession([10], () => ({ type: "user/message", data: proj }));
    const out = await run(listener, { session }, [], { kind: "enter", messages: [] });
    assert.equal(out.messages.length, 0);
  });

  await checkAsync("reject 决策原样返回", async () => {
    const out = await run(listener, { session: mkSession() }, [], { kind: "reject" });
    assert.equal(out.kind, "reject");
  });

  await checkAsync("next() 自身错误正常冒泡（不掩盖宿主错误）", async () => {
    await assert.rejects(
      () => listener({ agent: { session: mkSession() }, messages: [], step: 1, signal: { throwIfAborted() {} } },
        async () => { throw new Error("next boom"); }),
      /next boom/,
    );
  });

  await checkAsync("投影内部异常被吞掉并降级（关键：否则整个 turn 失败）", async () => {
    const badPaths = { readDirs: () => { throw new Error("boom"); }, memoryReadCandidates: () => [] };
    const badListener = capture(badPaths);
    const out = await badListener(
      { agent: { session: mkSession() }, messages: [], step: 1, signal: { throwIfAborted() {} } },
      async () => ({ kind: "enter", messages: [] }),
    );
    assert.equal(out.kind, "enter");
  });
}

resetTmp();
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
