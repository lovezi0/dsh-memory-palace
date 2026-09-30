// memory-palace v1.8.0-alpha.4 测试：诊断日志落盘（common/logger.mjs）。
// 覆盖：① 门控（distillDebugLog=false = 零输出，连目录都不建）；② 落点
// （<profileContext.dir>/.memory-palace/logs/<session-id>/{info,debug}.log）+ 按行级别分流；
// ③ raw 文本只进 debug.log（隐私红线：info.log 恒不含 LLM 原始响应）；
// ④ profileContext 缺失（非 dsh 启动 / 测试 mock）→ 静默放弃、不抛错；
// ⑤ 写入失败（路径被文件占位）→ 吞异常；⑥ 多会话目录隔离；⑦ 无会话 id → __nosession__/；
// ⑧ 单文件 1 MB 上限。
// 运行：npm run build 后 `/usr/bin/env -u NODE_OPTIONS node test-subagent-log.mjs`（import 自 lib/）。
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createLogger } from "../lib/common/logger.mjs";
import { runMemorySubagent } from "../lib/hybrid/subagent.mjs";
import { createDistill } from "../lib/distill.mjs";
import { createPaths } from "../lib/common/paths.mjs";

let passed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }
function section(title) { console.log(`\n${title}`); }

const ctxWith = (dir) => ({ get: (name) => (name === "profileContext" ? { dir } : undefined) });
const ctxWithout = () => ({ get: () => undefined });
const cfgOf = (over = {}) => () => ({ enabled: true, distillDebugLog: false, distillLogLevel: "info", ...over });
const logsDir = (base, sid = "s1") => join(base, ".memory-palace", "logs", sid);
const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
const mkBase = (tag) => mkdtempSync(join(tmpdir(), `mp-log-${tag}-`));

const root = mkdtempSync(join(tmpdir(), "mp-log-root-"));

section("① 门控：distillDebugLog=false → 零输出（不建目录、不写文件）");
{
  const base = mkBase("off");
  const logger = createLogger({ ctx: ctxWith(base), getConfig: cfgOf({ distillDebugLog: false }) });
  const l = logger.for("s1", "subagent");
  l.dbgFail("should not appear");
  l.dbg("should not appear either");
  l.info("ledger should not appear");
  l.raw("raw should not appear");
  await logger.flush();
  assert.equal(read(join(logsDir(base), "info.log")), null, "关闭时不得创建 info.log");
  assert.equal(read(join(logsDir(base), "debug.log")), null, "关闭时不得创建 debug.log");
  assert.equal(existsSync(join(base, ".memory-palace")), false, "关闭时不得创建 .memory-palace 目录");
  ok("关闭 = 零输出");
}

section("② 落点 + 分级：<profileContext.dir>/.memory-palace/logs/<sid>/{info,debug}.log");
{
  const base = mkBase("on");
  const logger = createLogger({ ctx: ctxWith(base), getConfig: cfgOf({ distillDebugLog: true }) });
  const l = logger.for("sess-abc", "subagent");
  l.dbgFail("no write applied", { round: 2 });
  l.info("done ok=true mode=written", { appliedWrites: 2 });
  l.dbg("tool-calls round", { round: 0 });
  await logger.flush();
  const info = read(join(logsDir(base, "sess-abc"), "info.log"));
  const dbg = read(join(logsDir(base, "sess-abc"), "debug.log"));
  assert.ok(info, "info.log 应存在");
  assert.ok(dbg, "debug.log 应存在");
  assert.ok(info.includes("[warn] subagent · no write applied"), "warn 级（失败留痕）进 info.log");
  assert.ok(info.includes("[info] subagent · done ok=true"), "info 级（终态台账）进 info.log");
  assert.ok(!info.includes("tool-calls round"), "debug 行进不得进 info.log");
  assert.ok(dbg.includes("[debug] subagent · tool-calls round"), "debug 级（详单）进 debug.log");
  assert.ok(info.includes('"appliedWrites":2'), "额外字段应 JSON 化落盘");
  ok("落点正确 + 按行级别分流");
}

section("③ raw：LLM 原始响应只进 debug.log（info.log 恒不含文本）");
{
  const base = mkBase("raw");
  const logger = createLogger({ ctx: ctxWith(base), getConfig: cfgOf({ distillDebugLog: true, distillLogLevel: "debug" }) });
  const l = logger.for("s-raw", "distill");
  l.dbgFail("session finish", { kind: "stop" });
  l.raw("SECRET-LLM-OUTPUT");
  await logger.flush();
  const info = read(join(logsDir(base, "s-raw"), "info.log"));
  const dbg = read(join(logsDir(base, "s-raw"), "debug.log"));
  assert.ok(dbg && dbg.includes("SECRET-LLM-OUTPUT"), "原始响应应落 debug.log");
  assert.ok(dbg.includes("llm raw text begin >>>") && dbg.includes("llm raw text end <<<"), "应有起止分隔标记");
  assert.ok(info && !info.includes("SECRET-LLM-OUTPUT"), "原始响应不得进 info.log");
  ok("raw 只进 debug.log");
}

section("④ profileContext 缺失 → 静默放弃（不落盘、不抛错）");
{
  const logger = createLogger({ ctx: ctxWithout(), getConfig: cfgOf({ distillDebugLog: true }) });
  const l = logger.for("s1", "plugin");
  await assert.doesNotReject(async () => {
    l.dbgFail("no path");
    l.dbg("no path");
    l.info("no path");
    l.raw("no path");
    await logger.flush();
  }, "无 profileContext 时不得抛错");
  ok("缺 profileContext 降级静默");
}

section("⑤ 写入失败（路径被文件占位）→ 吞异常");
{
  const base = mkBase("fail");
  writeFileSync(join(base, ".memory-palace"), "i am a file, not a directory");
  const logger = createLogger({ ctx: ctxWith(base), getConfig: cfgOf({ distillDebugLog: true }) });
  await assert.doesNotReject(async () => {
    logger.for("s1", "subagent").dbgFail("boom");
    await logger.flush();
  }, "目录创建失败必须被吞掉");
  ok("fs 失败吞异常");
}

section("⑥ 多会话隔离 → 各自 <sid>/ 目录互不串台");
{
  const base = mkBase("multi");
  const logger = createLogger({ ctx: ctxWith(base), getConfig: cfgOf({ distillDebugLog: true }) });
  logger.for("sA", "subagent").info("done A");
  logger.for("sB", "subagent").info("done B");
  await logger.flush();
  const a = read(join(logsDir(base, "sA"), "info.log"));
  const b = read(join(logsDir(base, "sB"), "info.log"));
  assert.ok(a && a.includes("done A") && !a.includes("done B"), "A 目录只含 A 的行");
  assert.ok(b && b.includes("done B") && !b.includes("done A"), "B 目录只含 B 的行");
  ok("会话目录隔离");
}

section("⑦ 无会话 id → __nosession__/");
{
  const base = mkBase("nosess");
  const logger = createLogger({ ctx: ctxWith(base), getConfig: cfgOf({ distillDebugLog: true }) });
  logger.for(undefined, "plugin").dbgFail("no session context");
  await logger.flush();
  const f = read(join(logsDir(base, "__nosession__"), "info.log"));
  assert.ok(f && f.includes("no session context"), "应落 __nosession__/info.log");
  ok("无会话 id 落 __nosession__/");
}

section("⑧ 单文件 1 MB 上限 → 达上限后停止追加");
{
  const base = mkBase("cap");
  const dir = logsDir(base, "s1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "info.log"), "x".repeat(1024 * 1024 + 1));
  const logger = createLogger({ ctx: ctxWith(base), getConfig: cfgOf({ distillDebugLog: true }) });
  logger.for("s1", "subagent").dbgFail("AFTER-CAP");
  await logger.flush();
  const text = read(join(dir, "info.log"));
  assert.ok(!text.includes("AFTER-CAP"), "超限后不得再追加");
  assert.equal(text.length, 1024 * 1024 + 1, "既有内容不得被改动或删除");
  ok("1 MB 上限生效");
}

// ============================================================================================
// 串台专项：以下四项用**真实调用链**验证多会话不串台，而不是只读代码断言。
// 背景：多会话隔离曾在"进程级全局承载每会话语义"上出过缺陷，故单列专测。
// ============================================================================================

const mkSession = (id, events) => ({
  id,
  seq: events.length,
  firstLiveSeq: 0,
  events,
  requestHeader: () => ({ config: { provider: "mock", model: "mock-model" } }),
  deriveEventMessage: (e) => ({
    id: `m${e.seq}`,
    role: e.type === "user/message" ? "user" : "assistant",
    content: [{ type: "text", text: String(e.data?.text || "") }],
    source: { kind: "user" },
  }),
});
const EVENTS = [
  { seq: 0, type: "user/message", data: { text: "查一下配置问题" } },
  { seq: 1, type: "assistant/message", data: { text: "已定位" } },
];
const subagentCtx = () => ({
  llm: {
    listProviders: () => [],
    listModels: async () => [],
    stream: async function* () {
      await new Promise((r) => setTimeout(r, 5)); // 制造真实交错窗口
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "无内容" } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  },
});

section("⑨ 真实链路：runMemorySubagent 双会话【并发】→ 日志各归各目录（串台专项）");
{
  const base = mkBase("conc-sub");
  const logger = createLogger({ ctx: ctxWith(base), getConfig: cfgOf({ distillDebugLog: true }) });
  const cfg = cfgOf({ distillDebugLog: true, summaryModel: "", summaryTimeoutMs: 5000, subagentLogBudget: 20000 });
  // A：正常会话（dirs 非空）→ 走完整循环 → debug 级 dbg("done")
  // B：dirs 为空 → 提前 return → warn 级 dbgFail("disabled or no session/dirs")
  const [ra, rb] = await Promise.all([
    runMemorySubagent({
      ctx: subagentCtx(), getConfig: cfg, paths: null, records: null,
      state: { lastSummarizedSeq: 0 }, session: mkSession("sessA", EVENTS), dirs: ["/tmp/a"], isError: false, logger,
    }),
    runMemorySubagent({
      ctx: subagentCtx(), getConfig: cfg, paths: null, records: null,
      state: { lastSummarizedSeq: 0 }, session: mkSession("sessB", EVENTS), dirs: [], isError: false, logger,
    }),
  ]);
  await logger.flush();
  const aDbg = read(join(logsDir(base, "sessA"), "debug.log"));
  const aInfo = read(join(logsDir(base, "sessA"), "info.log"));
  const bInfo = read(join(logsDir(base, "sessB"), "info.log"));
  assert.equal(ra.mode, "noop", "A 应走完整循环收尾");
  assert.equal(rb.mode, "disabled", "B 应因 dirs 为空提前返回");
  assert.ok(aDbg && aDbg.includes("[debug] subagent · done"), "A 的 done 应落 sessA/debug.log");
  // v1.8.0-alpha.4：子代理链路补齐 LLM 流统计（此前完全看不到 LLM 行为）
  assert.ok(aDbg.includes("stream turn"), "应记录 LLM 流统计行 stream turn");
  assert.ok(/"chunks":\d+/.test(aDbg), "流统计应含 chunks");
  assert.ok(/"firstChunkMs":/.test(aDbg) && /"elapsedMs":\d+/.test(aDbg), "流统计应含 firstChunkMs / elapsedMs");
  assert.ok(!(aInfo || "").includes("disabled or"), "A 的文件不得含 B 的留痕");
  assert.ok(bInfo && bInfo.includes("disabled or no session/dirs"), "B 的留痕应落 sessB/info.log");
  assert.equal(read(join(logsDir(base, "sessB"), "debug.log")), null, "B 不该产生 debug.log（它从未跑循环）");
  assert.ok(!(bInfo || "").includes("done"), "B 的文件不得含 A 的留痕");
  ok("子代理并发：日志各归各会话目录，无交叉");
}

section("⑩ 高并发交叉写：30 会话 × 5 行 → 零串台");
{
  const base = mkBase("cross");
  const logger = createLogger({ ctx: ctxWith(base), getConfig: cfgOf({ distillDebugLog: true }) });
  const N = 30, M = 5;
  const jobs = [];
  for (let i = 0; i < N; i++) {
    const l = logger.for(`sess-${i}`, "subagent");
    for (let j = 0; j < M; j++) jobs.push(Promise.resolve().then(() => l.info(`MARK-sess-${i}-${j}`)));
  }
  await Promise.all(jobs);
  await logger.flush();
  let crossTalk = 0;
  for (let i = 0; i < N; i++) {
    const text = read(join(logsDir(base, `sess-${i}`), "info.log")) || "";
    for (let j = 0; j < M; j++) {
      assert.ok(text.includes(`MARK-sess-${i}-${j}`), `sess-${i} 自己的第 ${j} 行应在文件里`);
    }
    for (let k = 0; k < N; k++) {
      if (k !== i && text.includes(`MARK-sess-${k}-`)) crossTalk++;
    }
  }
  assert.equal(crossTalk, 0, `并发交叉写出现 ${crossTalk} 处串台`);
  ok(`${N} 会话 × ${M} 行并发：零串台`);
}

section("⑪ 真实链路：distillProjectMemory 双会话【并发】→ 日志各归各目录（串台专项）");
{
  const base = mkBase("conc-distill");
  const logger = createLogger({ ctx: ctxWith(base), getConfig: cfgOf({ distillDebugLog: true }) });
  // 模型解析失败（summaryModel 为空 + requestHeader 无 provider/model）→ resolveModel 返回 null
  // → dbgFail("no model")。该 dbgFail 位于 resolveModel 内、用的是传入 session 的作用域日志器
  // ——正是要验的绑定点。
  // v1.8.1：载体由 distillSessionCore 换成 distillProjectMemory（前者已随会话蒸馏移除）；
  // 项目蒸馏读盘要求 MEMORY.md 非空、且 paths 需真实解析（workspaceMemoryDir 必填），故预置工作区。
  const cfg = cfgOf({ distillDebugLog: true, summaryModel: "", workspaceMemoryDir: ".deepseek-harness/memory" });
  const mkWs = (tag) => {
    const ws = mkdtempSync(join(tmpdir(), `mp-proj-${tag}-`));
    mkdirSync(join(ws, ".deepseek-harness"), { recursive: true });
    writeFileSync(join(ws, ".deepseek-harness", "MEMORY.md"), "# 项目记忆\n- 旧事实\n", "utf8");
    return ws;
  };
  const wsA = mkWs("a"), wsB = mkWs("b");
  const paths = createPaths(cfg, () => wsA);
  const distill = createDistill({
    ctx: { llm: { listProviders: () => [], listModels: async () => [] } },
    getConfig: cfg, paths, logger,
  });
  const bare = (id) => ({ id, requestHeader: () => ({}) });
  await Promise.all([
    distill.distillProjectMemory(wsA, bare("dA")),
    distill.distillProjectMemory(wsB, bare("dB")),
  ]);
  await logger.flush();
  const a = read(join(logsDir(base, "dA"), "info.log"));
  const b = read(join(logsDir(base, "dB"), "info.log"));
  assert.ok(a && a.includes("resolveModel: no model resolved"), "dA 应记录自身的 no model");
  assert.ok(b && b.includes("resolveModel: no model resolved"), "dB 应记录自身的 no model");
  assert.equal(read(join(logsDir(base, "__nosession__"), "info.log")), null, "两个会话都有身份，不得落 __nosession__/");
  ok("项目蒸馏并发：resolveModel 留痕各归各会话目录");
}

section("⑫ 无会话身份（session=undefined）→ 落 __nosession__/（而非误记到别的会话）");
{
  const base = mkBase("nosess2");
  const logger = createLogger({ ctx: ctxWith(base), getConfig: cfgOf({ distillDebugLog: true }) });
  const cfg = cfgOf({ distillDebugLog: true, summaryModel: "", workspaceMemoryDir: ".deepseek-harness/memory" });
  const ws = mkdtempSync(join(tmpdir(), "mp-proj-nosess-"));
  mkdirSync(join(ws, ".deepseek-harness"), { recursive: true });
  writeFileSync(join(ws, ".deepseek-harness", "MEMORY.md"), "# 项目记忆\n- 旧事实\n", "utf8");
  const paths = createPaths(cfg, () => ws);
  const distill = createDistill({
    ctx: { llm: { listProviders: () => [], listModels: async () => [] } },
    getConfig: cfg, paths, logger,
  });
  const r = await distill.distillProjectMemory(ws, undefined);
  await logger.flush();
  assert.equal(r.ok, false, "无模型可解析时应失败返回");
  const f = read(join(logsDir(base, "__nosession__"), "info.log"));
  assert.ok(f && f.includes("resolveModel: no model resolved"), "无身份时落 __nosession__/，不得挂到任何具体会话");
  ok("无会话身份 → __nosession__/ 隔离");
}

rmSync(root, { recursive: true, force: true });
console.log(`\n==== 汇总：${passed} 项全部通过 ====`);
