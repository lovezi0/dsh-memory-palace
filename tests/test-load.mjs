// v0.7.0 后端 cordis 单测：覆盖 加载 / 摘要 / 错误捕获 / 防闲聊闸门（A+D 合并 + 可选 LLM 判定）/
// 桥接 / 去重 / 用户级 / 聚合读取。
// 运行（Windows 静默环境）：/usr/bin/env -u NODE_OPTIONS node test-load.mjs
import { Context } from "@deepseek-ai/cordis";
import { name, apply, Config, inject } from "../lib/index.js";
import { createPaths } from "../lib/common/paths.mjs";
import { createRecords, readNumberedMemory, applyMemoryOp } from "../lib/common/records.mjs";
import { createDistill } from "../lib/distill.mjs";
import { buildProjections } from "../lib/projection.mjs";
import { classifyFailure, backoffDelayMs, runWithRetry, RETRY_CONSTANTS } from "../lib/common/retry.mjs";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = {
  enabled: true,
  userMemoryPath: "~/.deepseek-harness/MEMORY.md",
  workspaceMemoryDir: ".deepseek-harness/memory",
  userBudgetChars: 4000,
  workspaceBudgetChars: 3000,
  summaryModel: "",
  distillDebugLog: false,
};

let pass = 0;
let fail = 0;
function assert(cond, label) {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

function makeMockLlm(opts = {}) {
  const text = opts.text !== undefined ? opts.text : '{"summary":"[SUMMARY]","durable":[]}';
  const fail = !!opts.fail;
  // v1.4.0：可重试失败模拟——前 failTimes 次返回 finish.kind='error'（带 failStatus），之后成功；
  // failForever + failStatus = 每次都返回该状态错误（用于验证重试耗尽 / 500 单独限次）。
  const failStatus = opts.failStatus;
  const failTimes = opts.failTimes || 0;
  const failForever = !!opts.failForever;
  // v1.2.3：注册表 mock——provider → model id 列表（供 resolveModel 反查裸 id 归属）。
  // 默认覆盖三个典型：带前缀 id（nvidia）、裸 id（xiaomi/zai）、双段自定义（openai）。
  const registry = opts.registry || {
    nvidia: ["nvidia/nemotron-3-ultra-550b-a55b", "z-ai/glm-5.2"],
    xiaomi: ["mimo-v2.5", "mimo-v2.5-pro"],
    zai: ["GLM-4.7-Flash", "GLM-4.6V-Flash"],
    openai: ["openai/gpt-4o"],
  };
  return {
    calls: [],
    // 注意：必须【同步】返回 async iterable（与真机 LlmRuntime.stream 契约一致，
    // 见 packages/llm/llm/src/index.ts:913）；若写成 async 方法会返回 Promise，插件的
    // `for await` 迭代 Promise 抛 TypeError → 摘要降级 → 测试掩盖真机行为。
    stream(o) {
      const idx = this.calls.length;
      this.calls.push(o);
      const isFailCall = failForever || (failStatus != null && idx < failTimes);
      async function* gen() {
        if (fail) throw new Error("mock llm failure");
        if (isFailCall) {
          yield { type: "block-start", index: 0, blockType: "text" };
          yield {
            type: "finish",
            reason: { kind: "error", failure: { status: failStatus, message: "mock " + failStatus } },
          };
          return;
        }
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield {
          type: "finish",
          reason: opts.finishKind ? { kind: opts.finishKind, failure: { message: "mock" } } : { kind: "stop" },
        };
      }
      return gen();
    },
    // v1.2.3：注册表枚举接口（resolveModel 反查依赖）。
    listProviders() {
      return Object.keys(registry).map((id) => ({ id, name: id }));
    },
    async listModels(provider) {
      return (registry[provider] || []).map((id) => ({ provider, id, name: id }));
    },
  };
}

function msgsText(opts) {
  const m = opts && opts.messages;
  if (!m) return "";
  if (typeof m === "string") return m;
  if (Array.isArray(m))
    return m
      .map((x) => {
        if (typeof x === "string") return x;
        if (x && Array.isArray(x.content)) return x.content.map((c) => c?.text ?? "").join("");
        if (x && typeof x.content === "string") return x.content;
        return JSON.stringify(x);
      })
      .join(" ");
  return JSON.stringify(m);
}

function fakeSession(cwd, provider = "deepseek", model = "deepseek-chat", events = []) {
  const eventsArr = events.map((e, i) => ({ seq: i, ...e }));
  const extract = (blocks) => {
    if (typeof blocks === "string") return blocks;
    if (!Array.isArray(blocks)) return "";
    return blocks
      .map((c) => {
        if (typeof c === "string") return c;
        if (typeof c?.text === "string") return c.text;
        if (Array.isArray(c?.content)) return extract(c.content);
        return "";
      })
      .join("");
  };
  return {
    id: "sess-" + Math.random().toString(36).slice(2, 8),
    header: { cwd },
    firstLiveSeq: 0,
    events: eventsArr,
    get seq() {
      return eventsArr.length;
    },
    push(e) {
      eventsArr.push({ seq: eventsArr.length, ...e });
    },
    requestHeader: () => ({ config: { provider, model } }),
    deriveEventMessage(e) {
      const d = e?.data;
      const content = d?.message?.content ?? d?.content;
      const text = extract(content).trim();
      if (!text) return null;
      const role = e?.type === "assistant/message" ? "assistant" : "user";
      return { role, content: [{ type: "text", text }], source: { kind: "plugin", plugin: "test" } };
    },
  };
}

async function loadPlugin(overrides = {}, llmOpts) {
  const ctx = new Context();
  const captured = { sections: [], tools: [], listeners: {} };
  ctx.provide("systemPrompt", { section: (s) => { captured.sections.push(s); return () => {}; } });
  ctx.provide("tools", { register: (t) => { captured.tools.push(t); } });
  // v1.1.3：设置读写 route 依赖 webServer/webRuntime（mock no-op；route 只在真实请求时执行）。
  ctx.provide("webServer", { register: () => {} });
  ctx.provide("webRuntime", { trustedHosts: [] });
  const mockLlm = makeMockLlm(llmOpts || {});
  ctx.provide("llm", mockLlm);
  const origOn = ctx.on.bind(ctx);
  ctx.on = (ev, cb) => {
    (captured.listeners[ev] ||= []).push(cb);
    return origOn(ev, cb);
  };
  ctx.logger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
  const cfg = { ...BASE, ...overrides };
  const r = ctx.plugin({ name, apply, Config, inject }, cfg);
  if (r && typeof r.then === "function") await r;
  await sleep(30);
  return { ctx, captured, mockLlm };
}

function fire(session, captured, type, data) {
  // 将简化的 tool/result mock 升级为真机事件结构，以真正覆盖 bug：
  // 真机 tool/result.message.content 是 ToolResultBlock[]，文本嵌套在 block.content 内（只取 .text 取不到）。
  // 测试若用 {content:"字符串"} 简化结构，extractText 旧逻辑能取到而真机取不到，会掩盖 bug，故此处对齐真机。
  let payload = data;
  if (type === "tool/result" && data && typeof data.content === "string") {
    payload = {
      message: {
        content: [{ type: "tool-result", toolCallId: "t1", content: [{ type: "text", text: data.content }] }],
      },
    };
  }
  // 同步追加到 fakeSession 的事件日志（模拟真实 session 仅追加），供智能模式增量摘要取数。
  if (session && typeof session.push === "function") session.push({ type, data: payload });
  for (const cb of captured.listeners["session/event"] || []) cb(session, { type, data: payload });
}

function localDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dailyFile(ws, dir = ".deepseek-harness/memory") {
  const today = localDate(new Date());
  return join(ws, dir, today + ".md");
}

// ---------- [1] 加载与导出 ----------
console.log("[1] LOAD");
const main = await loadPlugin();
assert(main.captured.sections.length === 1, "[1] 1 section registered");
assert(main.captured.tools.map((t) => t.name).join(",") === "memory_note,memory_note_user,memory_read,memory_delete,memory_write,memory_update_section,memory_reorganize", "[1] tools = 4 legacy + 3 hybrid (v1.6.0 unconditional registration)");
assert((main.captured.listeners["session/event"] || []).length === 1, "[1] session/event listener registered");
assert(inject.includes("llm"), "[1] inject includes 'llm' (memory sub-agent needs it)");
const text = main.captured.sections[0].text();
assert(typeof text === "string", "[2] section.text() returns string");

// ---------- [1c] v1.8.0：memoryMode / autoCaptureErrors / summarize / dailyLogRetentionDays 均已移除 ----------
console.log("[1c] REMOVED CONFIG FIELDS");
{
  const { default: Schema } = await import("@deepseek-ai/schemastery");
  const [resolved] = Schema.resolve({}, Config);
  assert(!("memoryMode" in resolved), "[1c] memoryMode 字段已从 schema 移除（v1.8.0 起恒定混合模式）");
  assert(!("autoCaptureErrors" in resolved), "[1c] autoCaptureErrors 字段已移除（plugin 模式专属）");
  assert(!("dailyLogRetentionDays" in resolved), "[1c] dailyLogRetentionDays 字段已移除（日志永不过期）");
  assert(!("summarize" in resolved), "[1c] summarize 字段已移除（写入恒定＝插件已装且启用）");
  // 保留字段仍在，且不再有独立的写入闸门
  assert("summaryModel" in resolved && "userBudgetChars" in resolved, "[1c] 其余配置字段未受影响");
  // 老 profile 里保留的废弃键必须原样透传、不抛错——宿主装载期校验走 standard-schema 入口，
  // 收窄 union 会让存量 profile 装载失败（DSH-CONTRACT-TRACKING §1.9 实测禁区）。
  const [value] = Schema.resolve({ memoryMode: "plugin", autoCaptureErrors: true, summarize: false }, Config);
  assert(value.memoryMode === "plugin", "[1c] 废弃键原样透传（老 profile 不会被装载期拦下）");
  assert(value.summarize === false, "[1c] 废弃的总开关键同样原样透传");

  // 端到端装载回归（本版唯一的「装不上」风险点）：老 profile 带着 plugin/smart 时代的
  // 废弃键经 cordis resolveConfig（= Config["~standard"].validate）必须装载成功。
  const legacyLoad = await loadPlugin({
    memoryMode: "plugin",
    autoCaptureErrors: true,
    summarize: false,
    dailyLogRetentionDays: 30,
  });
  assert(legacyLoad.captured.sections.length === 1,
    "[1c] 老 profile 带废弃键 → 插件仍正常装载（无 ValidationError）");
  // 写入不再受总开关约束：即便老 profile 写着 summarize:false，子代理仍应被调用。
  const wsC = mkdtempSync(join(tmpdir(), "mem-1c-"));
  const sC = fakeSession(wsC);
  fire(sC, legacyLoad.captured, "user/message", { message: { content: "分析仓库结构" } });
  fire(sC, legacyLoad.captured, "tool/result", { content: "src/x" });
  fire(sC, legacyLoad.captured, "turn/end", {});
  await sleep(1800);
  assert(legacyLoad.mockLlm.calls.length >= 1,
    "[1c] summarize:false 的旧配置不再阻断写入（总开关已废，装即写）");
}

// ---------- [1b] v1.7.1 特性3：自定义指令注入（section 内、位于记忆指令之后） ----------
console.log("[1b] CUSTOM INSTRUCTIONS → system prompt injection");
{
  const blank = await loadPlugin({ customInstructions: "   \n  " });
  const tb = blank.captured.sections[0].text();
  assert(tb.trim().length > 0, "[1b] blank-only custom → intro still returned (non-empty)");
  assert(tb === tb.trim(), "[1b] blank-only custom leaves no stray whitespace");

  const withCustom = await loadPlugin({ customInstructions: "回答一律用中文。\n代码注释用英文。" });
  const tc = withCustom.captured.sections[0].text();
  assert(tc.includes("回答一律用中文。"), "[1b] custom text injected into section");
  assert(tc.includes("[用户自定义指令] 回答一律用中文。"), "[1b] custom text prefixed with [用户自定义指令]");
  assert(tc.includes("代码注释用英文。"), "[1b] multi-line custom preserved");
  const atIntro = tc.indexOf("记忆");
  const atCustom = tc.indexOf("回答一律用中文。");
  assert(atIntro !== -1 && atIntro < atCustom, "[1b] custom appended AFTER memory instructions");
  // v1.7.1 特性1 回归保护：日志必须留在 E 投影，混进 section 会让 system 前缀每轮失效。
  assert(!tc.includes("# 今日工作日志"), "[1b] daily log must NOT leak into section");
}

// ---------- 场景 G：buddy 桥接（写入目标解析） ----------
// v1.8.0：原断言「buddy 每日日志已落盘」依赖已删除的轻量兜底路径；改为断言
// ① 写入目标解析到 buddy 目录 ② 子代理在该工作区被调用（写入路径活着）。
console.log("[G] BUDDY BRIDGE");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-g-"));
  mkdirSync(join(ws, ".workbuddy", "memory"), { recursive: true });
  const { captured, mockLlm } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "分析" } });
  fire(s, captured, "tool/result", { content: "x" });
  fire(s, captured, "turn/end", {});
  await sleep(1800);
  const cfgG = { ...BASE, bridgeBuddyMemory: true, buddyWorkspaceMemoryDirs: [".workbuddy/memory", ".codebuddy/memory"] };
  const pathsG = createPaths(() => cfgG, () => ws);
  const dirsG = pathsG.writeDirs(ws);
  assert(dirsG.length === 1 && dirsG[0].endsWith(join(".workbuddy", "memory")),
    "[G] write dir resolved to buddy memory dir");
  assert(!existsSync(join(ws, ".deepseek-harness", "memory")), "[G] dsh memory dir NOT created (buddy bridge active)");
  assert(!existsSync(join(ws, ".deepseek-harness", "MEMORY.md")), "[G] dsh MEMORY.md NOT created (buddy bridge active)");
  assert(mockLlm.calls.length >= 1, "[G] memory sub-agent invoked for the bridged workspace");
}

// ---------- 场景 H：memory_note 去重 ----------
console.log("[H] memory_note DEDUP");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-h-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  const tool = captured.tools.find((t) => t.name === "memory_note");
  fire(s, captured, "user/message", { message: { content: "setup" } });
  const r1 = await tool.execute({ content: "use tabs for indentation" });
  const r2 = await tool.execute({ content: "use tabs for indentation" });
  const r3 = await tool.execute({ content: "use tabs for indentation" });
  const mem = join(ws, ".deepseek-harness/MEMORY.md");
  const after = existsSync(mem) ? readFileSync(mem, "utf8") : "";
  const count = (after.match(/- use tabs for indentation/g) || []).length;
  assert(r1.ok && r2.ok && r3.ok, "[H] all three ok");
  assert(count === 1, "[H] deduplicated to 1 occurrence");
}

// ---------- 场景 I：memory_note_user 用户级 + 去重 ----------
console.log("[I] memory_note_user");
{
  const home = mkdtempSync(join(tmpdir(), "mem-i-"));
  const { captured } = await loadPlugin({ userMemoryPath: join(home, "MEMORY.md") });
  const tool = captured.tools.find((t) => t.name === "memory_note_user");
  const r1 = await tool.execute({ content: "prefer spaces over tabs (global)" });
  const r2 = await tool.execute({ content: "prefer spaces over tabs (global)" });
  const mem = join(home, "MEMORY.md");
  const after = existsSync(mem) ? readFileSync(mem, "utf8") : "";
  const count = (after.match(/- prefer spaces over tabs \(global\)/g) || []).length;
  assert(r1.ok && r2.ok, "[I] both ok");
  assert(count === 1, "[I] user-level dedup = 1");
}

// ---------- 场景 J：memory_read scope（v1.7.1：默认只读长期记忆，日志须显式请求） ----------
console.log("[J] memory_read SCOPE");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-j-"));
  const memDir = join(ws, ".workbuddy", "memory");
  mkdirSync(memDir, { recursive: true });
  const yesterday = localDate(new Date(Date.now() - 86400000));
  const fs = await import("node:fs/promises");
  await fs.writeFile(join(memDir, `${yesterday}.md`), `## 2026-08-15T00:00:00.000Z\n昨天定的约定: 用 spaces\n`, "utf8");
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "load memory please" } });
  const readTool = captured.tools.find((t) => t.name === "memory_read");

  // 默认 scope='memory'：本 fixture 只有日志、没有 MEMORY.md → 不应带出任何日志内容
  const def = await readTool.execute({});
  assert(def.ok, "[J] read ok");
  assert(!def.memory.includes("昨天定的约定"), "[J] default scope=memory excludes logs");
  assert(def.message.includes("scope=memory"), "[J] message echoes scope");

  // scope='project'（v1.7.1 更名，原 node；与 memory_write 的写侧 scope 同名）：本 fixture 无工作区 MEMORY.md → 不返回内容
  const projRes = await readTool.execute({ scope: "project" });
  assert(projRes.ok && projRes.message.includes("scope=project"), "[J] project scope accepted and echoed");
  assert(!projRes.memory.includes("昨天定的约定"), "[J] project excludes logs (no workspace MEMORY.md in fixture)");

  // v1.7.1 标题修正：project 应读到 buddy 布局的 MEMORY.md，且标题为实际文件路径（而非日志目录）
  await fs.writeFile(join(memDir, "MEMORY.md"), "# 项目约定\n工作区级内容\n", "utf8");
  const projRes2 = await readTool.execute({ scope: "project" });
  assert(projRes2.memory.includes("工作区级内容"), "[J] project reads workspace MEMORY.md");
  assert(projRes2.memory.includes("MEMORY.md"), "[J] block title uses the MEMORY.md path (not the log dir)");

  // scope='today'：不含昨日的日志
  const todayRes = await readTool.execute({ scope: "today" });
  assert(!todayRes.memory.includes("昨天定的约定"), "[J] today excludes yesterday's log");

  // scope='yesterday'：应带出昨日的日志
  const yRes = await readTool.execute({ scope: "yesterday" });
  assert(yRes.memory.includes("昨天定的约定"), "[J] yesterday includes yesterday's log");

  // scope='daily'（近三天）：同样带出昨日的日志
  const daily = await readTool.execute({ scope: "daily" });
  assert(daily.ok && daily.memory.includes(yesterday), "[J] daily: yesterday log included");
  assert(daily.memory.includes("昨天定的约定"), "[J] daily: log content included");

    // scope='all'：同样应带出日志
    const all = await readTool.execute({ scope: "all" });
    assert(all.ok && all.memory.includes("昨天定的约定"), "[J] all: log content included");

    // v1.8.0-alpha.1 修复（D2）：日志 scope 剥删除线墓碑（不再冒充有效条目/占预算）；
    // memory/project scope 保留墓碑 —— replace 模式的 stale 校验需要含墓碑的磁盘原文。
    const wsJ2 = mkdtempSync(join(tmpdir(), "mem-j2-"));
    const memDirJ2 = join(wsJ2, ".workbuddy", "memory");
    mkdirSync(memDirJ2, { recursive: true });
    const yJ2 = localDate(new Date(Date.now() - 86400000));
    const fsJ2 = await import("node:fs/promises");
    await fsJ2.writeFile(join(memDirJ2, `${yJ2}.md`), "## 环境必知\n- 有效条目\n- ~~已作废条目~~\n", "utf8");
    await fsJ2.writeFile(join(memDirJ2, "MEMORY.md"), "## 章节\n- 现行条目\n- ~~墓碑条目~~\n", "utf8");
    const capJ2 = await loadPlugin();
    const sJ2 = fakeSession(wsJ2);
    fire(sJ2, capJ2.captured, "user/message", { message: { content: "j2" } });
    const readJ2 = capJ2.captured.tools.find((t) => t.name === "memory_read");
    const logRead = await readJ2.execute({ scope: "yesterday" });
    assert(logRead.memory.includes("有效条目"), "[J2] valid log entry kept");
    assert(!logRead.memory.includes("已作废条目"), "[J2] tombstone stripped from log read");
    const memRead = await readJ2.execute({ scope: "project" });
    assert(memRead.memory.includes("现行条目"), "[J2] memory entry kept");
    assert(memRead.memory.includes("墓碑条目"), "[J2] MEMORY.md keeps tombstones (stale match needs raw)");
  }

// ---------- 场景 L：memory_delete 按内容删除（用户级 + 项目级） ----------
console.log("[L] memory_delete");
{
  // 项目级：写入→删除→确认消失
  const ws = mkdtempSync(join(tmpdir(), "mem-l-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "x" } });
  const note = captured.tools.find((t) => t.name === "memory_note");
  await note.execute({ content: "use tabs for indentation" });
  const del = captured.tools.find((t) => t.name === "memory_delete");
  const mem = join(ws, ".deepseek-harness/MEMORY.md");
  // 预览（不删）
  const p = await del.execute({ match: "use tabs for indentation", level: "project" });
  const before = existsSync(mem) ? readFileSync(mem, "utf8") : "";
  assert(p.preview === true && p.removed === 0, "[L] preview does NOT delete");
  assert(before.includes("use tabs for indentation"), "[L] entry still present after preview");
  assert(Array.isArray(p.matches) && p.matches.length === 1, "[L] preview returns 1 match");
  assert(p.matches[0].tier === "项目级" && p.matches[0].content.includes("use tabs"), "[L] match carries tier + content");
  assert(typeof p.confirmPrompt === "string" && p.confirmPrompt.length > 0, "[L] confirmPrompt generated");
  // 确认删除
  const r1 = await del.execute({ match: "use tabs for indentation", level: "project", confirm: true });
  const after = existsSync(mem) ? readFileSync(mem, "utf8") : "";
  assert(r1.preview === false && r1.removed === 1, "[L] confirm deletes removed=1");
  assert(!after.includes("use tabs for indentation"), "[L] entry gone after confirm");
  assert(r1.details.length === 1 && r1.details[0].tier === "项目级", "[L] delete returns details with tier");
  // 子串匹配
  await note.execute({ content: "prefer const over var" });
  const p2 = await del.execute({ match: "const", level: "project" });
  assert(p2.preview && p2.matches.length === 1, "[L] substring preview");
  const r2 = await del.execute({ match: "const", level: "project", confirm: true });
  const after2 = existsSync(mem) ? readFileSync(mem, "utf8") : "";
  assert(r2.removed === 1 && !after2.includes("prefer const"), "[L] substring delete works");
  // 找不到 → 预览为空
  const r3 = await del.execute({ match: "nonexistent-xyz", level: "project" });
  assert(r3.preview && r3.matches.length === 0, "[L] no-match preview empty");
  // 用户级
  const home = mkdtempSync(join(tmpdir(), "mem-l-u-"));
  const up = join(home, "USERMEM.md");
  const { captured: cap2 } = await loadPlugin({ userMemoryPath: up });
  const s2 = fakeSession(mkdtempSync(join(tmpdir(), "mem-l-ws-")));
  const noteU = cap2.tools.find((t) => t.name === "memory_note_user");
  await noteU.execute({ content: "I drink coffee at 3pm" });
  const delU = cap2.tools.find((t) => t.name === "memory_delete");
  const pU = await delU.execute({ match: "coffee", level: "user" });
  assert(pU.preview && pU.matches.length === 1 && pU.matches[0].tier === "用户级", "[L] user preview tier=用户级");
  const r4 = await delU.execute({ match: "coffee", level: "user", confirm: true });
  const afterU = existsSync(up) ? readFileSync(up, "utf8") : "";
  assert(r4.removed === 1 && !afterU.includes("coffee"), "[L] user-level delete works");
}

// ---------- 场景 L2：多匹配给选项 + 每日级 ----------
console.log("[L2] memory_delete multi-match options + daily tier");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-l2-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: "x" });
  const note = captured.tools.find((t) => t.name === "memory_note");
  await note.execute({ content: "config: use tabs" });
  await note.execute({ content: "config: use spaces" });
  const del = captured.tools.find((t) => t.name === "memory_delete");

  const p = await del.execute({ match: "config", level: "project" });
  assert(p.preview && p.matches.length === 2, "[L2] two matches returned as options");
  const r = await del.execute({ match: "config", level: "project", confirm: true });
  assert(r.removed === 2, "[L2] confirm deletes both matches");

  // 每日级：写入今日日志再删
  const today = localDate(new Date());
  const daily = join(ws, ".deepseek-harness", "memory", today + ".md");
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(ws, ".deepseek-harness", "memory"), { recursive: true });
  await fs.writeFile(daily, `- daily note about tabs\n- daily note about coffee\n`, "utf8");
  const pD = await del.execute({ match: "coffee", level: "daily" });
  assert(pD.preview && pD.matches.some((m) => m.tier === "每日级"), "[L2] daily tier match surfaced");
  const rD = await del.execute({ match: "coffee", level: "daily", confirm: true });
  const afterD = existsSync(daily) ? readFileSync(daily, "utf8") : "";
  assert(rD.removed === 1 && !afterD.includes("coffee") && afterD.includes("tabs"), "[L2] daily delete removes only matched line");
}

// ---------- 场景 M：tools/pre-execute 原生确认弹窗（删除硬闸门） ----------
console.log("[M] pre-execute approval gate (native popup)");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-m-"));
  const { captured } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: "x" });
  const note = captured.tools.find((t) => t.name === "memory_note");
  await note.execute({ content: "use tabs for indentation" });
  await note.execute({ content: "use spaces for indentation" });
  const preListeners = captured.listeners["tools/pre-execute"] || [];
  // v1.6.0：hybrid 无条件注册后 pre-execute 监听器为 2 个（legacy 删除闸门 + hybrid 写工具闸门）
  assert(preListeners.length === 2, "[M] two tools/pre-execute listeners registered (legacy + hybrid)");
  const gate = preListeners[0];
  const next = async () => ({ kind: "allow" });

  // 预览（confirm 非 true）→ 放行，不弹窗
  const rPrev = await gate({ name: "memory_delete", arguments: { match: "indentation", level: "project" } }, next);
  assert(rPrev.kind === "allow", "[M] preview call passes through (no popup)");

  // 确认删除（confirm:true）→ 原生弹窗 ask，reason 含位置 + 实际内容 + 编号选项
  const rAsk = await gate({ name: "memory_delete", arguments: { match: "indentation", level: "project", confirm: true } }, next);
  assert(rAsk.kind === "ask", "[M] confirm:true triggers native approval popup (ask)");
  assert(typeof rAsk.reason === "string" && rAsk.reason.includes("use tabs for indentation") && rAsk.reason.includes("项目级"), "[M] ask reason cites location + actual content");
  assert(rAsk.reason.includes("[1]") && rAsk.reason.includes("[2]"), "[M] ask reason numbers multiple matches as options");

  // 确认删除但无匹配 → 不弹窗，放行（execute 回"未找到"）
  const rNone = await gate({ name: "memory_delete", arguments: { match: "zzz-no-such", level: "project", confirm: true } }, next);
  assert(rNone.kind === "allow", "[M] confirm with no match passes through (no popup)");

  // 非本工具 → 放行
  const rOther = await gate({ name: "memory_read", arguments: {} }, next);
  assert(rOther.kind === "allow", "[M] unrelated tool passes through");
}

// ---------- 场景 V：冷启动（记忆全空）时写入分工指令仍注入 ----------
// v1.8.0：原断言针对 plugin 模式的「记忆公民指令」，该分支已删；改为断言 HYBRID_PROACTIVE 与工具指引。
console.log("[V] cold start → write-role instructions still injected");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-v-"));
  const emptyUser = join(ws, "no-user-memory.md");
  const { captured } = await loadPlugin({ userMemoryPath: emptyUser });
  const t = captured.sections[0].text();
  assert(typeof t === "string" && t.length > 0, "[V] 空记忆时 section 非空");
  assert(t.includes("记忆子代理"), "[V] 空记忆时仍注入记忆分工指令（HYBRID_PROACTIVE）");
  assert(t.includes("memory_write") && t.includes("memory_update_section"),
    "[V] 分工指令含 MEMORY.md 维护工具指引");
  assert(t.includes("memory_note") && t.includes("memory_read"),
    "[V] intro 含 memory_note / memory_read 工具指引");
}

// ---------- 场景 W：turn/end → 记忆子代理接线（v1.8.0 唯一写入路径）+ 口径保留 ----------
console.log("[W] turn/end wires to the memory sub-agent + text-extraction口径 kept");
{
  const ws = mkdtempSync(join(tmpdir(), "mem-w-"));
  const { captured, mockLlm } = await loadPlugin();
  const s = fakeSession(ws);
  fire(s, captured, "user/message", { message: { content: "分析仓库结构" } });
  fire(s, captured, "tool/result", { content: "src/x" });
  fire(s, captured, "turn/end", {});
  await sleep(1800);
  assert(mockLlm.calls.length >= 1, "[W] turn/end 触发记忆子代理（唯一写入路径，旧 plugin/smart 已删）");
  const call = mockLlm.calls[0] || {};
  assert(call.provider === "deepseek" && call.model === "deepseek-chat",
    "[W] 未配 summaryModel 时复用会话 provider/model");
  assert(String(call.system || "").includes("记忆子代理"), "[W] 子代理 system prompt 就位");

  // 口径保留：turnBuffer 的文本提取必须剥离 runtime-context 快照块（供工具期错误检测，防误命中）。
  const { extractText } = await import("../lib/common/text.mjs");
  const noisy = extractText({ data: { message: { content: [
    { type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." },
    { type: "text", text: "已完成统计" },
  ] } } });
  assert(!noisy.includes("Current runtime context"), "[W] runtime-context 快照块被剥离");
  assert(noisy.includes("已完成统计"), "[W] 真实助手文本保留");
}

// ---------- 场景 P：计划模式禁写记忆（硬默认，无开关） ----------
console.log("[P1-P7] PLAN MODE → writing blocked, read + manual distill exempt");
{
  // P1/P2：plan 下三个写工具经 pre-execute 网关 deny（连预览/确认都拦）
  const { captured } = await loadPlugin();
  const s = fakeSession(mkdtempSync(join(tmpdir(), "mem-p-")));
  fire(s, captured, "plan/mode", { active: true });
  const gate = captured.listeners["tools/pre-execute"][0];
  const next = async () => ({ kind: "allow" });
  assert((await gate({ name: "memory_note", arguments: { content: "x" } }, next)).kind === "deny", "[P1] plan: memory_note denied by gate");
  assert((await gate({ name: "memory_note_user", arguments: { content: "x" } }, next)).kind === "deny", "[P1] plan: memory_note_user denied by gate");
  assert((await gate({ name: "memory_delete", arguments: { match: "x", level: "project" } }, next)).kind === "deny", "[P2] plan: memory_delete preview denied");
  assert((await gate({ name: "memory_delete", arguments: { match: "x", level: "project", confirm: true } }, next)).kind === "deny", "[P2] plan: memory_delete confirm denied");

  // P3：plan 模式下 turn/end 不触发记忆子代理（_settle 顶部拦截）
  const ws3 = mkdtempSync(join(tmpdir(), "mem-p3-"));
  const { captured: cap3, mockLlm: ml3 } = await loadPlugin();
  const s3 = fakeSession(ws3);
  fire(s3, cap3, "plan/mode", { active: true });
  fire(s3, cap3, "user/message", { message: { content: "分析仓库结构" } });
  fire(s3, cap3, "tool/result", { content: "src/x" });
  fire(s3, cap3, "turn/end", {});
  await sleep(1800);
  assert(ml3.calls.length === 0, "[P3] plan: memory sub-agent not invoked (write blocked at _settle)");

  // P5：plan 关闭后写入路径恢复正常（回归）
  const ws5 = mkdtempSync(join(tmpdir(), "mem-p5-"));
  const { captured: cap5, mockLlm: ml5 } = await loadPlugin();
  const s5 = fakeSession(ws5);
  fire(s5, cap5, "plan/mode", { active: false });
  fire(s5, cap5, "user/message", { message: { content: "分析仓库结构" } });
  fire(s5, cap5, "tool/result", { content: "src/x" });
  fire(s5, cap5, "turn/end", {});
  await sleep(1800);
  assert(ml5.calls.length >= 1, "[P5] plan=false: memory sub-agent invoked again (no regression)");

  // P6：plan 下 memory_read 仍可用（仅禁写不禁读）
  const ws6 = mkdtempSync(join(tmpdir(), "mem-p6-"));
  const memDir6 = join(ws6, ".workbuddy", "memory");
  mkdirSync(memDir6, { recursive: true });
  const fs6 = await import("node:fs/promises");
  await fs6.writeFile(join(memDir6, `${localDate(new Date())}.md`), "# 今日\n- 约定A\n", "utf8");
  const { captured: cap6 } = await loadPlugin();
  const s6 = fakeSession(ws6);
  fire(s6, cap6, "plan/mode", { active: true });
  const readTool = cap6.tools.find((t) => t.name === "memory_read");
  const res6 = await readTool.execute({ scope: "daily" }); // 内容在日志里，须显式指定 scope（v1.7.1）
  assert(res6.ok && res6.memory.includes("约定A"), "[P6] plan: memory_read still works");

  // P7：plan 下手动蒸馏（distillProjectMemory）豁免，仍写盘（真人显式意图）
  const ws7 = mkdtempSync(join(tmpdir(), "mem-p7-"));
  const memFile7 = join(ws7, ".deepseek-harness", "MEMORY.md");
  const fs7 = await import("node:fs/promises");
  const path7 = await import("node:path");
  await fs7.mkdir(path7.dirname(memFile7), { recursive: true });
  await fs7.writeFile(memFile7, "# 项目记忆\n- 旧事实\n", "utf8");
  const mockLlm7 = makeMockLlm({ text: "## 蒸馏后\n- 事实 Z\n" });
  const ctx7 = new Context();
  ctx7.provide("llm", mockLlm7);
  const cfg7 = { ...BASE, distillDebugLog: false, enabled: true };
  const state7 = { activeCwd: ws7, planModeActive: true };
  const paths7 = createPaths(() => cfg7, () => ws7);
  const records7 = createRecords({ getConfig: () => cfg7, paths: paths7 });
  const distill7 = createDistill({ ctx: ctx7, getConfig: () => cfg7, paths: paths7, records: records7 });
  const s7 = fakeSession(ws7);
  const r7 = await distill7.distillProjectMemory(ws7, s7);
  assert(r7.ok, "[P7] plan: manual distill still writes (exempt)");
  const memText7 = readFileSync(memFile7, "utf8");
  assert(memText7.includes("事实 Z"), "[P7] plan: MEMORY.md updated by manual distill");
}

// ---------- 场景 R：蒸馏 LLM 失败重试（v1.4.0 特性2） ----------
console.log("[R] DISTILL RETRY (classify / backoff / runWithRetry)");
{
  // R-UNIT：classifyFailure 分类
  assert(classifyFailure({ status: 500 }).kind === "retryable", "[R] classify 500=retryable");
  assert(classifyFailure({ status: 503 }).kind === "retryable", "[R] classify 503=retryable");
  assert(classifyFailure({ status: 429 }).kind === "limited", "[R] classify 429=limited");
  assert(classifyFailure({ status: 401 }).kind === "fatal", "[R] classify 401=fatal");
  assert(classifyFailure({ status: 404 }).kind === "fatal", "[R] classify 404=fatal");
  assert(classifyFailure({ code: "ECONNRESET" }).kind === "retryable", "[R] classify ECONNRESET=retryable");
  assert(classifyFailure({ name: "AbortError" }).kind === "retryable", "[R] classify AbortError=retryable");
  assert(classifyFailure({ message: "request aborted by timeout" }).kind === "retryable", "[R] classify aborted msg=retryable");
  assert(classifyFailure({}).kind === "fatal", "[R] classify unknown=fatal (no blind retry)");
  assert(classifyFailure({ code: "ENOTFOUND" }).kind === "fatal", "[R] classify ENOTFOUND=fatal (DNS, no blind retry per plan)");

  // R-UNIT：backoff 单调不减且受 MAX_DELAY_MS 夹紧
  const b0 = backoffDelayMs(0), b1 = backoffDelayMs(1), b2 = backoffDelayMs(10);
  assert(b0 <= b1 && b1 <= b2, "[R] backoff non-decreasing");
  assert(b2 <= RETRY_CONSTANTS.MAX_DELAY_MS + Math.ceil(RETRY_CONSTANTS.MAX_DELAY_MS * 0.15), "[R] backoff capped by MAX_DELAY_MS+jitter");

  // 加速：把退避常数压到 ~ms 级，避免重试测试真实睡眠。
  const savedBase = RETRY_CONSTANTS.BASE_DELAY_MS, savedMax = RETRY_CONSTANTS.MAX_DELAY_MS;
  RETRY_CONSTANTS.BASE_DELAY_MS = 1;
  RETRY_CONSTANTS.MAX_DELAY_MS = 2;

  function buildDistill(overrides, llmOpts) {
    const cfg = { ...BASE, ...overrides };
    const ctx = new Context();
    const mockLlm = makeMockLlm(llmOpts || {});
    ctx.provide("llm", mockLlm);
    const getConfig = () => cfg;
    const paths = createPaths(getConfig, () => null);
    const records = createRecords({ getConfig, paths });
    const state = { activeCwd: null, activeSession: null, lastSummarizedSeq: -1, summarySessionId: null };
    const distill = createDistill({ ctx, getConfig, paths, records, state });
    return { cfg, mockLlm, paths, distill };
  }
  const capturedNoop = { listeners: { "session/event": [] } };

  // R1：503 前 2 次失败 → 重试后第 3 次成功（calls=3，结果 ok）
  {
    const ws = mkdtempSync(join(tmpdir(), "mem-r1-"));
    const { distill, mockLlm, paths } = buildDistill({ memoryMode: "smart" }, { failStatus: 503, failTimes: 2, text: '{"summary":"[OK]","durable":[]}' });
    const s = fakeSession(ws);
    fire(s, capturedNoop, "user/message", { message: { content: "分析仓库结构" } });
    fire(s, capturedNoop, "tool/result", { content: "src/x" });
    const dirs = paths.writeDirs(ws);
    const r = await distill.distillSessionCore(s, dirs, 0, { allowDelete: false });
    assert(mockLlm.calls.length === 3, "[R1] 503x2 then success => 3 calls");
    assert(r.ok === true, "[R1] retry success returns ok");
    assert(existsSync(dailyFile(ws)), "[R1] daily written after retry success");
  }

  // R2：fatal（legacy fail，无 status）→ 不重试（calls=1），结果 ok:false
  {
    const ws = mkdtempSync(join(tmpdir(), "mem-r2-"));
    const { distill, mockLlm, paths } = buildDistill({ memoryMode: "smart" }, { fail: true });
    const s = fakeSession(ws);
    fire(s, capturedNoop, "user/message", { message: { content: "分析" } });
    fire(s, capturedNoop, "tool/result", { content: "x" });
    const dirs = paths.writeDirs(ws);
    const r = await distill.distillSessionCore(s, dirs, 0, { allowDelete: false });
    assert(mockLlm.calls.length === 1, "[R2] fatal error => no retry (1 call)");
    assert(r.ok === false, "[R2] fatal returns ok:false");
  }

  // R3：503 永久失败 → 重试耗尽（maxRetries=3 → 4 次调用），结果 ok:false
  {
    const ws = mkdtempSync(join(tmpdir(), "mem-r3-"));
    const { distill, mockLlm, paths } = buildDistill({ memoryMode: "smart" }, { failStatus: 503, failForever: true });
    const s = fakeSession(ws);
    fire(s, capturedNoop, "user/message", { message: { content: "分析" } });
    fire(s, capturedNoop, "tool/result", { content: "x" });
    const dirs = paths.writeDirs(ws);
    const r = await distill.distillSessionCore(s, dirs, 0, { allowDelete: false });
    assert(mockLlm.calls.length === RETRY_CONSTANTS.MAX_RETRIES + 1, "[R3] 503 forever => MAX_RETRIES+1 calls");
    assert(r.ok === false, "[R3] exhausted returns ok:false");
  }

  // R4：500 永久失败 → 单独限到 HTTP500_MAX_RETRIES=1（2 次调用）
  {
    const ws = mkdtempSync(join(tmpdir(), "mem-r4-"));
    const { distill, mockLlm, paths } = buildDistill({ memoryMode: "smart" }, { failStatus: 500, failForever: true });
    const s = fakeSession(ws);
    fire(s, capturedNoop, "user/message", { message: { content: "分析" } });
    fire(s, capturedNoop, "tool/result", { content: "x" });
    const dirs = paths.writeDirs(ws);
    const r = await distill.distillSessionCore(s, dirs, 0, { allowDelete: false });
    assert(mockLlm.calls.length === RETRY_CONSTANTS.HTTP500_MAX_RETRIES + 1, "[R4] 500 forever => HTTP500_MAX_RETRIES+1 calls");
    assert(r.ok === false, "[R4] exhausted returns ok:false");
  }

  // R5：429 永久失败 → 可重试（limited，走通用 maxRetries → 4 次调用）
  {
    const ws = mkdtempSync(join(tmpdir(), "mem-r5-"));
    const { distill, mockLlm, paths } = buildDistill({ memoryMode: "smart" }, { failStatus: 429, failForever: true });
    const s = fakeSession(ws);
    fire(s, capturedNoop, "user/message", { message: { content: "分析" } });
    fire(s, capturedNoop, "tool/result", { content: "x" });
    const dirs = paths.writeDirs(ws);
    const r = await distill.distillSessionCore(s, dirs, 0, { allowDelete: false });
    assert(mockLlm.calls.length === RETRY_CONSTANTS.MAX_RETRIES + 1, "[R5] 429 forever => MAX_RETRIES+1 calls (limited retryable)");
    assert(r.ok === false, "[R5] exhausted returns ok:false");
  }

  // 还原退避常数
  RETRY_CONSTANTS.BASE_DELAY_MS = savedBase;
  RETRY_CONSTANTS.MAX_DELAY_MS = savedMax;
}

// ---------- 场景 R6：readNumberedMemory / applyMemoryOp（v1.4.0 特性3 基础） ----------
console.log("[R6] readNumberedMemory / applyMemoryOp unit");
{
  const fsP = await import("node:fs/promises");
  const pathP = await import("node:path");
  const ws = mkdtempSync(join(tmpdir(), "mem-r6-"));
  const file = join(ws, "MEMORY.md");
  await fsP.writeFile(file, "# 项目笔记\n- 旧事实一\n- 旧事实二", "utf8");

  const nm = readNumberedMemory(file);
  assert(nm.lines.length === 3, "[R6] readNumberedMemory counts 3 lines");
  assert(nm.lines[0].structural === true, "[R6] line1 (#) is structural");
  assert(nm.lines[1].structural === false, "[R6] line2 (bullet) not structural");
  assert(nm.text.includes("1|"), "[R6] numbered text has line numbers");

  // replace with correct oldText → changed
  const r1 = await applyMemoryOp(file, { op: "replace", line: 2, oldText: "- 旧事实一", newText: "- 更新事实一" });
  assert(r1.ok && r1.changed, "[R6] replace with matching oldText succeeds");
  assert(readFileSync(file, "utf8").includes("更新事实一"), "[R6] file reflects replace");

  // replace with WRONG oldText → conflict (no change)
  const r2 = await applyMemoryOp(file, { op: "replace", line: 2, oldText: "错的内容", newText: "- 不应发生" });
  assert(r2.ok === false && r2.reason === "conflict", "[R6] replace with stale oldText rejected (conflict)");
  assert(!readFileSync(file, "utf8").includes("不应发生"), "[R6] conflict did not mutate file");

  // delete a content line → removed
  const r3 = await applyMemoryOp(file, { op: "delete", line: 3, oldText: "- 旧事实二" });
  assert(r3.ok && r3.changed, "[R6] delete content line succeeds");
  assert(!readFileSync(file, "utf8").includes("旧事实二"), "[R6] deleted line gone");

  // delete a structural line → protected
  const r4 = await applyMemoryOp(file, { op: "delete", line: 1, oldText: "# 项目笔记" });
  assert(r4.ok === false && r4.reason === "structural-protected", "[R6] delete structural line rejected");

  // add dedup
  const r5 = await applyMemoryOp(file, { op: "add", text: "- 更新事实一" });
  assert(r5.ok && r5.changed === false && r5.reason === "dup", "[R6] add dedups existing line");
  const r6 = await applyMemoryOp(file, { op: "add", text: "- 全新事实" });
  assert(r6.ok && r6.changed, "[R6] add new line succeeds");
  assert(readFileSync(file, "utf8").includes("全新事实"), "[R6] new line appended");
}

// ---------- 场景 F：回喂存量记忆（v1.4.0 特性3 集成） ----------
console.log("[F] FEEDBACK existing memory into distill");
{
  const { createPaths: cp } = await import("../lib/common/paths.mjs");
  function buildDistill(overrides, llmOpts) {
    const cfg = { ...BASE, ...overrides };
    const ctx = new Context();
    const mockLlm = makeMockLlm(llmOpts || {});
    ctx.provide("llm", mockLlm);
    const getConfig = () => cfg;
    const paths = cp(getConfig, () => null);
    const records = createRecords({ getConfig, paths });
    const state = { activeCwd: null, activeSession: null, lastSummarizedSeq: -1, summarySessionId: null };
    const distill = createDistill({ ctx, getConfig, paths, records, state });
    return { cfg, mockLlm, paths, distill };
  }
  const capturedNoop = { listeners: { "session/event": [] } };

  // F1：feedbackEnabled + allowDelete → 存量记忆回喂，并执行 replace/delete
  {
    const ws = mkdtempSync(join(tmpdir(), "mem-f1-"));
    const memFile = join(ws, ".deepseek-harness", "MEMORY.md");
    const fsP = await import("node:fs/promises");
    await fsP.mkdir(join(ws, ".deepseek-harness"), { recursive: true });
    await fsP.writeFile(memFile, "# 项目笔记\n- 旧事实一\n- 旧事实二\n", "utf8");
    const fbText = JSON.stringify({
      summary: "x",
      durable: [],
      memoryOps: [
        { op: "replace", line: 2, oldText: "- 旧事实一", newText: "- 更新事实一" },
        { op: "delete", line: 3, oldText: "- 旧事实二" },
      ],
    });
    const { distill, mockLlm, paths } = buildDistill({ memoryMode: "smart", feedbackEnabled: true }, { text: fbText });
    const s = fakeSession(ws);
    fire(s, capturedNoop, "user/message", { message: { content: "分析仓库结构" } });
    fire(s, capturedNoop, "tool/result", { content: "src/x" });
    const dirs = paths.writeDirs(ws);
    const r = await distill.distillSessionCore(s, dirs, 0, { allowDelete: true });
    assert(r.ok === true, "[F1] feedback distill ok");
    // 存量记忆被回喂（首条消息含项目级记忆内容）
    const firstMsg = msgsText({ messages: mockLlm.calls[0].messages[0] });
    assert(firstMsg.includes("旧事实一") && firstMsg.includes("项目级记忆"), "[F1] existing memory fed as feedback");
    const after = readFileSync(memFile, "utf8");
    assert(after.includes("更新事实一"), "[F1] replace applied");
    assert(!after.includes("旧事实二"), "[F1] delete applied");
    assert(after.includes("# 项目笔记"), "[F1] structural line preserved");
  }

  // F2：auto 模式（allowDelete=false）→ 仍回喂存量记忆（智能模式级能力），
  //     但 delete op 被跳过（仅手动按钮允许 delete），replace 仍生效。
  {
    const ws = mkdtempSync(join(tmpdir(), "mem-f2-"));
    const memFile = join(ws, ".deepseek-harness", "MEMORY.md");
    const fsP = await import("node:fs/promises");
    await fsP.mkdir(join(ws, ".deepseek-harness"), { recursive: true });
    await fsP.writeFile(memFile, "# 项目笔记\n- 旧事实一\n- 旧事实二\n", "utf8");
    const fbText = JSON.stringify({
      summary: "x",
      durable: [],
      memoryOps: [
        { op: "replace", line: 2, oldText: "- 旧事实一", newText: "- 更新事实一" },
        { op: "delete", line: 3, oldText: "- 旧事实二" },
      ],
    });
    const { distill, mockLlm, paths } = buildDistill({ memoryMode: "smart", feedbackEnabled: true }, { text: fbText });
    const s = fakeSession(ws);
    fire(s, capturedNoop, "user/message", { message: { content: "分析" } });
    fire(s, capturedNoop, "tool/result", { content: "x" });
    const dirs = paths.writeDirs(ws);
    const r = await distill.distillSessionCore(s, dirs, 0, { allowDelete: false });
    assert(r.ok === true, "[F2] auto distill ok");
    const firstMsg = msgsText({ messages: mockLlm.calls[0].messages[0] });
    // 自动模式仍回喂存量记忆（智能模式级能力，非手动按钮专属）
    assert(firstMsg.includes("旧事实一") && firstMsg.includes("项目级记忆"), "[F2] feedback still fed in auto mode (smart-mode-level)");
    const after = readFileSync(memFile, "utf8");
    // delete 在自动模式被跳过 → 旧事实二仍在
    assert(after.includes("旧事实二"), "[F2] delete skipped in auto mode");
    // replace 在自动模式仍生效 → 旧事实一被更新
    assert(after.includes("更新事实一") && !after.includes("- 旧事实一\n"), "[F2] replace applied in auto mode");
    assert(after.includes("# 项目笔记"), "[F2] structural line preserved");
  }

  // F3：LLM 返回非 JSON 自由文本（含对话体/请示）→ 解析失败，绝不把原文当 summary 落盘（防污染回归）。
  {
    const ws = mkdtempSync(join(tmpdir(), "mem-f3-"));
    await (await import("node:fs/promises")).mkdir(join(ws, ".deepseek-harness", "memory"), { recursive: true });
    const poison = "But wait - looking at the context, I should provide a clean response. 需要的话，我可以顺手把这条官方 verified 事实记进项目记忆，方便日后核对版本。";
    const { distill, mockLlm, paths } = buildDistill({ memoryMode: "smart" }, { text: poison });
    const s = fakeSession(ws);
    fire(s, capturedNoop, "user/message", { message: { content: "分析 JRE 版本" } });
    const dirs = paths.writeDirs(ws);
    const r = await distill.distillSessionCore(s, dirs, 0, { allowDelete: false });
    assert(r.ok === true, "[F3] non-JSON distill still ok (wrote placeholder)");
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`;
    const dailyPath = join(ws, ".deepseek-harness", "memory", today);
    const daily = readFileSync(dailyPath, "utf8");
    assert(!daily.includes("需要的话") && !daily.includes("But wait"), "[F3] raw LLM text NOT written to daily log (anti-pollution)");
    assert(daily.includes("已跳过原文落盘") || daily.includes("未返回可解析的结构化摘要"), "[F3] placeholder written instead of raw text");
  }
}

// ---------- 场景 M：v1.7.2 预设级静默（官方 minimal「裸测环境」口径） ----------
// 背景：宿主把「模式」做成 agent 平面 preset，而本插件注册在 host 平面 —— 各通道对每个 agent 都生效，
// preset 不会把它摘掉（complete 只吞 sections、不裁 tools）。故必须按会话预设自行整体静默。
// 判据：session.header.agentPreset（创建头，含部署默认）+ agent-preset/selected 事件。
console.log("[M] SILENT PRESETS (minimal) → section / projection / tools / writes all off");
{
  const minimalSession = { id: "s-min", header: { cwd: "/tmp", agentPreset: "minimal" } };
  const standardSession = { id: "s-std", header: { cwd: "/tmp", agentPreset: "standard" } };

  // M1: section 通道按会话门控；判据缺失一律 fail-open（记忆能力不能因判据缺失而丢）
  {
    const { captured } = await loadPlugin();
    const sec = captured.sections[0];
    assert(sec.text({ agent: { session: minimalSession } }) === "", "[M1] minimal preset → section text empty");
    assert(sec.text({ agent: { session: standardSession } }).length > 0, "[M1] standard preset → section text intact");
    assert(sec.text().length > 0, "[M1] no context → fail-open, section intact");
    assert(sec.text({ agent: { session: { id: "s-none", header: { cwd: "/tmp" } } } }).length > 0, "[M1] header without agentPreset → not silent");
  }

  // M2: 空会话切换预设（agent-preset/selected 事件）后同样静默
  {
    const { captured } = await loadPlugin();
    const s = fakeSession(mkdtempSync(join(tmpdir(), "mem-m2-")));
    assert(captured.sections[0].text({ agent: { session: s } }).length > 0, "[M2] before switch → not silent");
    fire(s, captured, "agent-preset/selected", { agentPreset: "minimal" });
    assert(captured.sections[0].text({ agent: { session: s } }) === "", "[M2] after switch to minimal → silent");
  }

  // M3: silentPresets=[] → 机制关闭（只受 enabled 管）
  {
    const { captured } = await loadPlugin({ silentPresets: [] });
    assert(captured.sections[0].text({ agent: { session: minimalSession } }).length > 0, "[M3] empty list → mechanism off");
  }

  // M4: agent/created → 仅静默会话 deny 全部记忆工具
  {
    const { captured } = await loadPlugin();
    const onCreated = (captured.listeners["agent/created"] || [])[0];
    assert(typeof onCreated === "function", "[M4] agent/created listener registered");
    const denied = [];
    const mkAgent = (header) => ({
      session: { id: "s-" + JSON.stringify(header), header: { cwd: "/tmp", ...header } },
      ctx: { tools: { restrict: (f) => { denied.push(f); return () => {}; } } },
    });
    onCreated({ agent: mkAgent({ agentPreset: "minimal" }) });
    assert(denied.length === 1, "[M4] minimal → tools.restrict called");
    assert(
      denied[0].deny.join(",") === "memory_note,memory_note_user,memory_read,memory_delete,memory_write,memory_update_section,memory_reorganize",
      "[M4] deny list = 4 legacy + 3 hybrid tools",
    );
    onCreated({ agent: mkAgent({ agentPreset: "standard" }) });
    assert(denied.length === 1, "[M4] standard → no restriction");
    onCreated({ agent: mkAgent({}) });
    assert(denied.length === 1, "[M4] preset-less session → fail-open (no restriction)");
  }

  // M5: E 投影通道 —— 静默会话不构造任何投影消息
  {
    const ws = mkdtempSync(join(tmpdir(), "mem-m5-"));
    const dir = join(ws, ".deepseek-harness", "memory");
    mkdirSync(dir, { recursive: true });
    const paths = createPaths(
      () => ({ ...BASE, bridgeBuddyMemory: false, silentPresets: ["minimal"] }),
      () => ws,
    );
    const getConfig = () => ({ ...BASE, bridgeBuddyMemory: false, silentPresets: ["minimal"] });
    const silent = buildProjections({ getConfig, paths, session: minimalSession, isSilent: () => true });
    assert(Array.isArray(silent) && silent.length === 0, "[M5] silent session → zero projections");
    const proj = buildProjections({ getConfig, paths, session: standardSession, isSilent: () => false });
    assert(Array.isArray(proj), "[M5] non-silent session → projections evaluated (array)");
  }

  // M6: 写入通道 —— minimal 会话整轮不落日志、不落 MEMORY
  {
    const ws = mkdtempSync(join(tmpdir(), "mem-m6-"));
    const { captured } = await loadPlugin();
    const s = fakeSession(ws);
    s.header.agentPreset = "minimal";
    fire(s, captured, "user/message", { message: { content: "分析仓库结构" } });
    fire(s, captured, "tool/result", { content: "src/index.mjs, src/client.js" });
    fire(s, captured, "turn/end", { reason: { kind: "error", message: "boom: hidden" } });
    await sleep(1800);
    assert(!existsSync(dailyFile(ws)), "[M6] minimal session → no daily log written");
    assert(
      !existsSync(join(ws, ".deepseek-harness", "MEMORY.md")),
      "[M6] minimal session → no MEMORY.md written (error capture also skipped)",
    );
  }

  // M7: 空会话切换预设 → 掩码跟随（切进静默预设戴上、切回摘下、重复切换幂等、disposed 释放）
  {
    const { captured } = await loadPlugin();
    const s = fakeSession(mkdtempSync(join(tmpdir(), "mem-m7-")));
    s.header.agentPreset = "standard";
    let masks = 0;
    let lifted = 0;
    const agent = {
      session: s,
      ctx: { tools: { restrict: () => { masks += 1; return () => { lifted += 1; }; } } },
    };
    const onCreated = (captured.listeners["agent/created"] || [])[0];
    onCreated({ agent });
    assert(masks === 0, "[M7] standard at creation → no mask");
    fire(s, captured, "agent-preset/selected", { agentPreset: "minimal" });
    assert(masks === 1, "[M7] switch into minimal → mask applied");
    fire(s, captured, "agent-preset/selected", { agentPreset: "minimal" });
    assert(masks === 1, "[M7] same preset again → idempotent (no double mask)");
    fire(s, captured, "agent-preset/selected", { agentPreset: "standard" });
    assert(lifted === 1 && masks === 1, "[M7] switch back → mask lifted");
    const onDisposed = (captured.listeners["agent/disposed"] || [])[0];
    assert(typeof onDisposed === "function", "[M7] agent/disposed listener registered");
    fire(s, captured, "agent-preset/selected", { agentPreset: "minimal" });
    onDisposed({ agent });
    assert(lifted === 2, "[M7] agent disposed → mask released + bookkeeping cleared");
  }
}

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
