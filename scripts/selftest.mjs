#!/usr/bin/env node
// 发布前自检入口：顺序跑 tests/test-*.mjs 全部脚本，任一失败即非零退出。
// CI（.github/workflows/publish.yml 的 Self-test 步骤）与本地共用同一入口。
//
// 用 node 子进程而非 shell 串联：CI 是 ubuntu、本地多为 Windows，子进程方式跨平台行为一致；
// 并在子进程环境里清掉 NODE_OPTIONS，避免宿主 shim 注入干扰测试。
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(root, "tests");

// 显式排除非测试入口（如需并入本目录的夹具 / 辅助脚本）。
const SKIP = new Set();

const tests = readdirSync(testsDir)
  .filter((f) => /^test-.*\.mjs$/.test(f) && !SKIP.has(f))
  .sort();

if (!tests.length) {
  console.error("selftest: 未找到任何 tests/test-*.mjs");
  process.exit(1);
}

const env = { ...process.env };
delete env.NODE_OPTIONS;

const failed = [];
for (const t of tests) {
  process.stdout.write(`\n=== ${t} ===\n`);
  const r = spawnSync(process.execPath, [join(testsDir, t)], { cwd: root, env, stdio: "inherit" });
  if (r.status !== 0) failed.push(t);
}

console.log("\n" + "=".repeat(48));
if (failed.length) {
  console.error(`selftest FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`selftest OK: ${tests.length} 个测试脚本全部通过`);
