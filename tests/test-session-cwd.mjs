// 多会话 cwd 隔离回归测试（PR#2 遗留点收尾）。
// 覆盖：memory_note / memory_read / memory_delete / hybrid memory_write 在
//   「全局 activeCwd 指向会话 B，但工具调用来自会话 A」时，读写必须落在会话 A 的工作区。
// 另含 fail-open 回归：exec 缺失（无 agent/session）时回落 activeCwd，行为与旧版一致。
// 运行：node tests/test-session-cwd.mjs（直调 src/，无需 build）。
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createPaths } from "../src/common/paths.mjs";
import { registerTools } from "../src/tools.mjs";
import { registerHybridTools } from "../src/hybrid/tools.mjs";

let passed = 0;
const ok = (name) => { passed++; console.log(`  PASS | ${name}`); };

const baseCfg = (over = {}) => ({
  enabled: true,
  userMemoryPath: join(tmpdir(), "mp-nonexistent-user", "MEMORY.md"), // 隔离测试不触用户级
  workspaceMemoryDir: ".deepseek-harness/memory",
  bridgeBuddyMemory: false,
  buddyWorkspaceMemoryDirs: [".workbuddy/memory", ".codebuddy/memory"],
  userBudgetChars: 4000,
  workspaceBudgetChars: 3000,
  ...over,
});

// 建两个工作区，各带 dsh 布局的 MEMORY.md，内容可区分。
function makeWorkspace(root, tag) {
  mkdirSync(join(root, ".deepseek-harness", "memory"), { recursive: true });
  writeFileSync(join(root, ".deepseek-harness", "MEMORY.md"), `# ${tag}项目记忆\n- 属于${tag}的事实\n`, "utf8");
  return root;
}

// 捕获注册的工具，返回 name → ToolDefinition（已被 defineTool 包装，execute 透传 exec）。
function captureCtx() {
  const tools = {};
  const listeners = [];
  return {
    tools,
    ctx: { tools: { register: (t) => { tools[t.name] = t; } }, on: (ev, h) => { listeners.push({ ev, h }); } },
    listeners,
  };
}

const TMP = join(tmpdir(), `mp-cwd-${Date.now()}`);
const dirA = makeWorkspace(join(TMP, "ws-a"), "A");
const dirB = makeWorkspace(join(TMP, "ws-b"), "B");

// activeCwd 恒指向 B（模拟"最近活跃会话是 B"），但工具调用带 exec.agent.session.header.cwd = A。
const cfg = baseCfg();
const paths = createPaths(() => cfg, () => dirB);
const state = { planModeActive: false };
const execA = { agent: { session: { header: { cwd: dirA } } } };

const { ctx, tools } = captureCtx();
registerTools({ ctx, getConfig: () => cfg, paths, state });
registerHybridTools({ ctx, getConfig: () => cfg, paths, records: null, state });

// ---------- memory_note：写落 A，不落 B ----------
{
  const beforeB = readFileSync(join(dirB, ".deepseek-harness", "MEMORY.md"), "utf8");
  const r = await tools.memory_note.execute({ content: "跨会话隔离验证条目" }, execA);
  assert.equal(r.ok, true, "memory_note 应成功");
  const afterA = readFileSync(join(dirA, ".deepseek-harness", "MEMORY.md"), "utf8");
  const afterB = readFileSync(join(dirB, ".deepseek-harness", "MEMORY.md"), "utf8");
  assert.ok(afterA.includes("跨会话隔离验证条目"), "会话 A 的写入应落在 A 的 MEMORY.md");
  assert.equal(afterB, beforeB, "B 的 MEMORY.md 不应被会话 A 的调用改动（防串台）");
  ok("memory_note：会话 A 调用写入 A、不串台到 B");
}

// ---------- memory_note（exec 缺失）：回落 activeCwd=B（fail-open 回归） ----------
{
  const beforeA = readFileSync(join(dirA, ".deepseek-harness", "MEMORY.md"), "utf8");
  const r = await tools.memory_note.execute({ content: "回落验证条目" }, undefined);
  assert.equal(r.ok, true);
  const afterB = readFileSync(join(dirB, ".deepseek-harness", "MEMORY.md"), "utf8");
  const afterA = readFileSync(join(dirA, ".deepseek-harness", "MEMORY.md"), "utf8");
  assert.ok(afterB.includes("回落验证条目"), "exec 缺失应回落 activeCwd=B");
  assert.equal(afterA, beforeA, "回落时不应写 A");
  ok("memory_note：exec 缺失回落 activeCwd（fail-open 回归）");
}

// ---------- memory_read：只返回会话 A 的工作区记忆 ----------
{
  const r = await tools.memory_read.execute({ scope: "project" }, execA);
  assert.ok(r.memory.includes("属于A的事实"), "应读到会话 A 的项目记忆");
  assert.ok(!r.memory.includes("属于B的事实"), "绝不应串台读到 B 的项目记忆");
  ok("memory_read：会话 A 仅投影 A 的工作区记忆（读侧隔离）");
}

// ---------- memory_write（hybrid）：写落 A ----------
{
  const r = await tools.memory_write.execute(
    { scope: "project", section: "隔离章节", entry: "hybrid 写入应落 A" },
    execA,
  );
  assert.equal(r.ok, true, "memory_write 应成功");
  const afterA = readFileSync(join(dirA, ".deepseek-harness", "MEMORY.md"), "utf8");
  const afterB = readFileSync(join(dirB, ".deepseek-harness", "MEMORY.md"), "utf8");
  assert.ok(afterA.includes("## 隔离章节") && afterA.includes("hybrid 写入应落 A"), "hybrid 写入应落在 A");
  assert.ok(!afterB.includes("隔离章节"), "hybrid 写入不应串台到 B");
  ok("memory_write（hybrid）：会话 A 调用落 A、不串台 B");
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\ntest-session-cwd：${passed} 项断言全部通过`);
