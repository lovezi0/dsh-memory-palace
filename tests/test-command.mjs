// memory-palace v1.8.1 会话命令 /memory_reorganize 测试。
// 覆盖：① 门禁不过（未超预算）→ error 且不 steer；
//       ② 门禁通过 → steer 内置提示（路径/预算/补充）+ 置位重整掩码（deny memory_read）+ 首步跳过项目级投影；
//       ③ 停用 / 静默预设 / plan 模式 → error 且不产生消息；
//       ④ commands 服务缺席 → 插件照常装载、不注册命令（可选依赖，绝不 pending）。
// 运行：npm run build 后 `/usr/bin/env -u NODE_OPTIONS node test-command.mjs`（import 自 lib/）。
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { name, apply, Config, inject } from "../lib/index.js";
import { REORG_MESSAGE_PREFIX } from "../lib/common/prompts.mjs";

let passed = 0;
function ok(n) { passed++; console.log(`  ✓ ${n}`); }
function section(t) { console.log(`\n${t}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = {
  enabled: true,
  bridgeBuddyMemory: false,
  workspaceMemoryDir: ".deepseek-harness/memory",
  workspaceBudgetChars: 3000,
  reorgCooldownDays: 7,
  summaryModel: "",
  distillDebugLog: false,
};

async function loadPlugin(overrides = {}, { withCommands = true } = {}) {
  const ctx = new Context();
  const captured = { commands: [], listeners: {} };
  ctx.provide("systemPrompt", { section: () => () => {} });
  ctx.provide("tools", { register: () => {} });
  ctx.provide("webServer", { register: () => {} });
  ctx.provide("webRuntime", { trustedHosts: [] });
  ctx.provide("llm", { stream() { throw new Error("not used"); }, listProviders: () => [], listModels: async () => [] });
  if (withCommands) {
    ctx.provide("commands", { register: (def) => { captured.commands.push(def); return () => {}; } });
  }
  const origOn = ctx.on.bind(ctx);
  ctx.on = (ev, cb) => { (captured.listeners[ev] ||= []).push(cb); return origOn(ev, cb); };
  ctx.logger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
  const cfg = { ...BASE, ...overrides };
  const r = ctx.plugin({ name, apply, Config, inject }, cfg);
  if (r && typeof r.then === "function") await r;
  await sleep(30);
  return { ctx, captured };
}

function fakeAgent(ws, id = "s-cmd") {
  const masks = [];
  const session = { id, header: { cwd: ws }, firstLiveSeq: 0, push() {} };
  return {
    session,
    steered: [],
    steer(msg) { this.steered.push(msg); },
    masks,
    // 掩码经 agent.ctx.tools.restrict 戴上——这里换成记录器，供断言 deny 集合。
    ctx: { tools: { restrict: (spec) => { masks.push(spec); return () => {}; } } },
  };
}

const BIG = `## 大章节\n${Array.from({ length: 300 }, (_, i) => `- 条目${i} ${"y".repeat(40)}`).join("\n")}\n`;
function workspace(tag, memoryBody) {
  const ws = mkdtempSync(join(tmpdir(), tag));
  mkdirSync(join(ws, ".deepseek-harness"), { recursive: true });
  writeFileSync(join(ws, ".deepseek-harness", "MEMORY.md"), memoryBody, "utf8");
  return ws;
}

// ---------- ①/② 门禁 ----------
section("① 门禁不过（未超预算）→ error，不产生消息");
{
  const ws = workspace("mp-cmd-small-", "## 小\n- a\n");
  const { captured } = await loadPlugin();
  const def = captured.commands[0];
  assert.ok(def && def.name === "memory_reorganize", "应注册 memory_reorganize 命令");
  assert.equal(typeof def.description, "string", "命令应有 description");
  assert.ok(def.description.includes("重整项目记忆"), "中文文案应写在 description（宿主命令无 i18n）");
  const agent = fakeAgent(ws);
  const res = await def.handler({ agent, rawInput: "" });
  assert.equal(res.kind, "error", "门禁不过应返回 error");
  assert.ok(/未超出注入预算/.test(res.text), "应回显门禁原因");
  assert.equal(agent.steered.length, 0, "不得产生用户消息");
  assert.equal(agent.masks.length, 0, "不得置位重整掩码");
  ok("门禁不过 → error，不 steer、不戴掩码");
}

section("② 门禁通过 → steer 内置提示 + deny memory_read + 首步跳过项目级投影");
{
  const ws = workspace("mp-cmd-big-", BIG);
  const { captured } = await loadPlugin();
  const def = captured.commands[0];
  const agent = fakeAgent(ws, "s-big");
  const res = await def.handler({ agent, rawInput: "补充说明" });
  assert.equal(res.kind, "success", "门禁通过应返回 success");
  assert.equal(agent.steered.length, 1, "应 steer 一条用户消息");
  const msg = agent.steered[0];
  assert.equal(msg.source.kind, "user", "命令消息 source.kind 应为 user");
  const text = msg.content[0].text;
  assert.ok(text.startsWith(REORG_MESSAGE_PREFIX), "内置提示应以命令前缀开头（供区分用户后续消息）");
  assert.ok(text.includes(join(ws, ".deepseek-harness", "MEMORY.md")), "应给出项目 MEMORY.md 绝对路径");
  assert.ok(text.includes("3000"), "应含目标预算字符数");
  assert.ok(text.includes("memory_reorganize"), "应强制要求用 memory_reorganize 工具写入（唯一带备份路径）");
  assert.ok(/memory_read 本次已被禁用/.test(text), "应明示 memory_read 本次禁用");
  assert.ok(text.includes("补充说明"), "应附用户补充");
  // v1.8.1-alpha.2：任务定义正名「两删一提一重构」+ 预算降为参考线 + 落盘一次 + 失败出口
  assert.ok(
    /两删一提一重构/.test(text) && /删过时/.test(text) && /删重复/.test(text) && /冗余提炼/.test(text) && /重构文件结构/.test(text),
    "内置提示应含「两删一提一重构」任务定义",
  );
  assert.ok(/健康参考线/.test(text), "内置提示应声明预算为健康参考线（非硬指标）");
  assert.ok(/只允许落盘一次/.test(text), "内置提示应声明只允许落盘一次");
  assert.ok(/绝不.*继续删改凑数/.test(text), "内置提示应含禁止绕道的失败出口");
  assert.ok(!/全文小于/.test(text), "旧措辞「全文小于 N」应已移除（它是过拟合源头）");
  ok("门禁通过 → steer 内置提示（前缀/路径/预算/补充/任务定义/落盘纪律）");

  assert.equal(agent.masks.length, 1, "应戴上一次工具掩码");
  assert.deepEqual(agent.masks[0].deny, ["memory_read"], "掩码只 deny memory_read");

  // 首步跳过项目级 MEMORY.md / 今日日志投影（用户级照常）→ 第二步恢复
  const preStep = (captured.listeners["agent/pre-step"] || [])[0];
  assert.ok(typeof preStep === "function", "应注册 agent/pre-step 投影钩子");
  const callPre = () => preStep({ agent, messages: [], step: 1 }, async () => ({ kind: "enter", messages: [] }));
  const first = await callPre();
  const firstText = first.messages.map((m) => m.content[0].text).join("\n");
  assert.ok(!firstText.includes("项目级记忆"), "首步不得投影项目级记忆");
  const second = await callPre();
  const secondText = second.messages.map((m) => m.content[0].text).join("\n");
  assert.ok(secondText.includes("项目级记忆"), "第二步应恢复项目级记忆投影（仅跳首步）");
  ok("首步跳过项目级投影 → 第二步恢复");
}

// ---------- ③ 停用 / 静默 / plan ----------
section("③ 停用 / 静默预设 / plan 模式 → error，不产生消息");
{
  const ws = workspace("mp-cmd-off-", BIG);
  {
    const { captured } = await loadPlugin({ enabled: false });
    const agent = fakeAgent(ws, "s-off");
    const res = await captured.commands[0].handler({ agent, rawInput: "" });
    assert.equal(res.kind, "error", "enabled=false 应 error");
    assert.equal(agent.steered.length, 0);
  }
  {
    const { captured } = await loadPlugin();
    const agent = fakeAgent(ws, "s-silent");
    agent.session.header.agentPreset = "minimal";
    const res = await captured.commands[0].handler({ agent, rawInput: "" });
    assert.equal(res.kind, "error", "静默预设应 error");
    assert.equal(agent.steered.length, 0);
  }
  {
    const { captured } = await loadPlugin();
    const agent = fakeAgent(ws, "s-plan");
    (captured.listeners["session/event"] || [])[0](agent.session, { type: "plan/mode", data: { active: true } });
    const res = await captured.commands[0].handler({ agent, rawInput: "" });
    assert.equal(res.kind, "error", "plan 模式应 error");
    assert.equal(agent.steered.length, 0);
  }
  ok("停用 / 静默 / plan → error 且不 steer");
}

// ---------- ④ 可选依赖 ----------
section("④ commands 服务缺席 → 插件照常装载，不注册命令");
{
  const { captured } = await loadPlugin({}, { withCommands: false });
  assert.equal(captured.commands.length, 0, "无 commands 服务时不注册命令");
  ok("commands 缺席 → 不注册、不抛错（绝不 pending）");
}

console.log(`\n==== test-command：${passed} 项全部通过 ====`);
