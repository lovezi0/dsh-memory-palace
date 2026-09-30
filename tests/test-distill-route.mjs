// v1.8.1 定向回归：/memory-palace/api 的手动蒸馏 route。
// 覆盖：① 已下线的 distill.session 必须 404（v1.8.1 移除会话蒸馏）；
// ② distill.project.preview 返回当前 MEMORY.md 字符数；
// ③ distill.project 走完整链路（cover 写入 → 校验 → 备份 → rename 原子替换）。
// 运行（Windows 静默环境）：npm run build 后 `/usr/bin/env -u NODE_OPTIONS node test-distill-route.mjs`
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Context } from "@deepseek-ai/cordis";
import { name, apply, Config, inject } from "../lib/index.js";

let passed = 0;
function ok(label) { passed++; console.log(`  ✓ ${label}`); }

// 预置非空项目 MEMORY.md（项目蒸馏读盘阶段要求非空，否则提前 return）。
const ws = mkdtempSync(join(tmpdir(), "mp-route-"));
mkdirSync(join(ws, ".deepseek-harness"), { recursive: true });
const memFile = join(ws, ".deepseek-harness", "MEMORY.md");
writeFileSync(memFile, "# 项目记忆\n- 旧事实\n", "utf8");

const mockLlm = {
  stream() {
    const text = "## 蒸馏后\n- 事实 Z\n";
    return (async function* () {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "finish", reason: { kind: "stop" } };
    })();
  },
  listProviders: () => [],
  listModels: async () => [],
};

const captured = { routes: [] };
const ctx = new Context();
ctx.provide("systemPrompt", { section: () => () => {} });
ctx.provide("tools", { register: () => () => {} });
ctx.provide("webServer", { register: (r) => { captured.routes.push(r); return () => {}; } });
ctx.provide("webRuntime", { trustedHosts: [] });
ctx.provide("llm", mockLlm);
const session = {
  id: "s-route",
  header: { cwd: ws },
  requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
};
const sessions = new Map([[session.id, session]]);
ctx.provide("sessions", { get: (id) => sessions.get(id) ?? null });
ctx.logger = { warn() {}, error() {}, info() {}, debug() {} };

await ctx.plugin({ name, apply, Config, inject }, {
  enabled: true,
  summaryModel: "",
  userMemoryPath: "~/.deepseek-harness/MEMORY.md",
  workspaceMemoryDir: ".deepseek-harness/memory",
});

const route = captured.routes.find((r) => r.path === "/memory-palace/api");
assert.ok(route, "已注册 /memory-palace/api route");

const call = async (method, body) => {
  const payload = JSON.stringify(body || {});
  const req = {
    method: "POST",
    url: `/memory-palace/api/${method}`,
    headers: {
      host: "localhost:8123",
      "sec-fetch-site": "same-origin",
      origin: "http://localhost:8123",
      "content-type": "application/json",
    },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, "utf8"); },
  };
  let status = 0;
  let out = "";
  const res = { writeHead(s) { status = s; }, end(p) { out = p; } };
  await route.handler(req, res);
  return { status, body: out ? JSON.parse(out) : null };
};

console.log("\n① 已下线方法：distill.session 必须 404");
{
  const r = await call("distill.session", { sessionId: session.id });
  assert.equal(r.status, 404, "distill.session 应 404（会话蒸馏已移除）");
  assert.equal(r.body?.error?.code, "not-found", "错误码应为 not-found");
  ok("distill.session → 404（未掉进项目蒸馏分支）");
}

console.log("\n② distill.project.preview：返回当前 MEMORY.md 字符数");
{
  const r = await call("distill.project.preview", { sessionId: session.id });
  assert.equal(r.status, 200, "preview 应 200");
  assert.equal(typeof r.body?.value?.size, "number", "value.size 应为数字");
  // route 内用 readMdSync（内部 trim 掉首尾空白），故比对也按 trim 后长度。
  assert.equal(r.body.value.size, readFileSync(memFile, "utf8").trim().length, "size 应等于 MEMORY.md（trim 后）字符数");
  ok("distill.project.preview → 200 + size 正确");
}

console.log("\n③ distill.project：cover 校验 → 备份 → 原子替换");
{
  const before = readFileSync(memFile, "utf8");
  const r = await call("distill.project", { sessionId: session.id });
  assert.equal(r.status, 200, "project 应 200");
  assert.equal(r.body?.value?.ok, true, "value.ok 应为 true");
  const after = readFileSync(memFile, "utf8");
  assert.ok(after.includes("事实 Z"), "MEMORY.md 已被蒸馏结果覆盖");
  assert.ok(!after.includes("旧事实"), "旧内容已被替换");
  const backups = readdirSync(join(ws, ".deepseek-harness")).filter((f) => f.startsWith("MEMORY.md."));
  assert.equal(backups.length, 1, "应生成 1 份 .<本地时间戳> 备份");
  assert.equal(readFileSync(join(ws, ".deepseek-harness", backups[0]), "utf8"), before, "备份内容 = 替换前的原文");
  ok("distill.project → 覆盖 + 备份正确");
}

console.log(`\n==== test-distill-route：${passed} 项全部通过 ====`);
