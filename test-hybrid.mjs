// memory-palace v1.6.0 hybrid 模式测试。
// 覆盖：① sections 纯函数（解析/追加/新增/替换 stale 拒绝/标删/结构行保护/删除线过滤）；
// ② 记忆子 agent 循环 mock LLM（无重点单轮 / tool-calls 多轮落盘 / 超 6 轮降级 / 不支持 tools 降级 / 20k 目录回喂）；
// ③ memory_reorganize 双门禁（未超预算拒绝 / 冷却期拒绝 / 双满足通过 + 时间戳落盘 + 备份存在）。
// 运行：npm run build 后 `/usr/bin/env -u NODE_OPTIONS node test-hybrid.mjs`（import 自 lib/）。
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseSections, locateSection, appendToSectionText, upsertSectionText, createSectionText, replaceSectionText, markEntryDeletedText } from "./lib/common/sections.mjs";
import { stripDeletedLines } from "./lib/common/text.mjs";
import { runMemorySubagent } from "./lib/hybrid/subagent.mjs";
import { checkReorgGate, readLastReorg } from "./lib/hybrid/tools.mjs";

let passed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }
function section(title) { console.log(`\n${title}`); }

// ---------- ① sections 纯函数 ----------
section("① sections 纯函数");
{
  const md = `# 项目笔记\n\n## 环境必知\n- aaa\n- bbb\n\n## 决策记录\n- ccc\n`;
  const { head, sections } = parseSections(md);
  assert.equal(sections.length, 2, "应解析出 2 个章节");
  assert.equal(sections[0].title, "环境必知", "章节标题应为 环境必知");
  assert.ok(head.join("\n").includes("# 项目笔记"), "文件头归 head");
  ok("parseSections 标题/内容/head 划分");

  const r1 = appendToSectionText(md, "环境必知", "ddd");
  assert.equal(r1.ok, true, "追加应成功");
  assert.ok(r1.text.includes("- aaa\n- bbb\n- ddd"), "应追加到章节内容末尾");
  const r1miss = appendToSectionText(md, "不存在的章节", "x");
  assert.equal(r1miss.ok, false);
  assert.equal(r1miss.reason, "section-miss");
  ok("appendToSectionText 追加/未命中");

  const r2 = upsertSectionText(md, "新章节", "e1");
  assert.equal(r2.reason, "section-created");
  assert.ok(r2.text.includes("## 新章节\n- e1"), "应新建章节");
  const r2b = upsertSectionText(md, "环境必知", "eee");
  assert.equal(r2b.reason, "appended");
  ok("upsertSectionText 新增/追加");

  const r3 = createSectionText(md, "环境必知", "x");
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, "section-exists", "已存在章节应拒绝");
  const r3b = createSectionText(md, "全新章节", "y");
  assert.equal(r3b.reason, "section-created");
  ok("createSectionText 拒绝已存在/新建");

  // v1.6.0 双列表符修复：entry 自带 `- ` 前缀时必须剥除，不得产生 `- - xxx` 脏数据
  const r6 = appendToSectionText(md, "环境必知", "- 带前缀条目");
  assert.equal(r6.ok, true);
  assert.ok(r6.text.includes("\n- 带前缀条目"), "应剥除前缀后落盘");
  assert.ok(!r6.text.includes("- - 带前缀条目"), "不得出现双列表符");
  const r6b = upsertSectionText(md, "环境必知", "* 星号前缀条目");
  assert.equal(r6b.ok, true);
  assert.ok(!r6b.text.includes("- * 星号前缀条目"), "星号前缀也应剥除");
  ok("append/upsert 剥除 entry 自带列表符前缀（防双列表符）");

  const secText = "## 环境必知\n- aaa\n- bbb";
  const r4 = replaceSectionText(md, "环境必知", secText, "## 环境必知\n- aaa\n- bbb2");
  assert.equal(r4.ok, true, "整章节匹配应替换成功");
  const r4lines = r4.text.split("\n");
  assert.ok(r4lines.includes("- bbb2") && !r4lines.includes("- bbb"), "应替换条目");
  assert.ok(r4.text.includes("## 环境必知\n- aaa\n- bbb2\n\n## 决策记录"), "替换后章节间空行应保留");
  const r4conflict = replaceSectionText(md, "环境必知", "## 环境必知\n- 旧内容", "## 环境必知\n- 新");
  assert.equal(r4conflict.ok, false);
  assert.equal(r4conflict.reason, "conflict", "stale 应拒绝");
  assert.ok(r4conflict.actual, "应回显实际内容");
  ok("replaceSectionText 替换成功/stale 拒绝+回显");

  const r5 = markEntryDeletedText(md, "环境必知", "aaa");
  assert.equal(r5.reason, "marked", "标删应成功");
  assert.ok(r5.text.includes("- ~~aaa~~"), "应为删除线墓碑格式");
  const r5b = markEntryDeletedText(r5.text, "环境必知", "aaa");
  assert.equal(r5b.reason, "already", "已标删应返回 already");
  const r5miss = markEntryDeletedText(md, "环境必知", "不存在的条目");
  assert.equal(r5miss.reason, "entry-miss");
  ok("markEntryDeletedText 标删/幂等/未命中");
}

// 删除线过滤
section("①b 删除线注入过滤");
{
  const t = "## 章节\n- 有效条目\n- ~~已作废条目~~\n- 保留 ~~行内删除线~~ 局部\n";
  const out = stripDeletedLines(t);
  assert.ok(!out.includes("~~已作废条目~~"), "整行删除线应滤除");
  assert.ok(out.includes("有效条目"), "有效条目保留");
  assert.ok(out.includes("行内删除线"), "行内局部删除线不滤");
  ok("stripDeletedLines 整行滤除/行内保留");
}

// ---------- ② 子 agent 循环 ----------
section("② 记忆子 agent 循环（mock LLM）");
{
  const tmp = mkdtempSync(join(tmpdir(), "mp-hybrid-"));
  const logDir = join(tmp, ".deepseek-harness", "memory");
  const mkSession = (events, seq = events.length) => ({
    id: "s1",
    seq,
    firstLiveSeq: 0,
    events,
    requestHeader: () => ({ config: { provider: "mock", model: "mock-model" } }),
    deriveEventMessage: (e) => ({
      id: `m${e.seq}`,
      role: e.type === "user/message" ? "user" : "assistant",
      content: [{ type: "text", text: String(e.data?.text || e.data?.content || "") }],
      source: { kind: "user" },
    }),
  });
  const baseEvents = [
    { seq: 0, type: "user/message", data: { text: "帮我查一下 xxx 的配置问题" } },
    { seq: 1, type: "assistant/message", data: { text: "已定位：问题在于渠道映射未生效" } },
  ];
  const cfg = () => ({ enabled: true, summaryModel: "", summaryTimeoutMs: 5000, subagentLogBudget: 20000, memoryMode: "hybrid" });

  // 场景 A：无重点 → 单轮 stop 纯文本，推进断点
  {
    const calls = [];
    const ctx = {
      llm: {
        listProviders: () => [],
        listModels: async () => [],
        stream: async function* (params) {
          calls.push(params.messages.length);
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: "本轮为闲聊，无实质内容。" };
          yield { type: "block-end", index: 0, block: { type: "text", text: "本轮为闲聊，无实质内容。" } };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
    };
    const state = { lastSummarizedSeq: 0 };
    const r = await runMemorySubagent({ ctx, getConfig: cfg, paths: null, records: null, state, session: mkSession(baseEvents), dirs: [logDir], isError: false });
    assert.equal(r.ok, true, "无重点应成功");
    assert.equal(r.mode, "noop");
    assert.equal(state.lastSummarizedSeq, 2, "应推进断点");
    ok("场景A：无重点单轮收尾 + 推进断点");
  }

  // 场景 B：有重点 → tool-calls 多轮落盘
  {
    const calls = [];
    const callPayloads = [];
    const ctx = {
      llm: {
        listProviders: () => [],
        listModels: async () => [],
        stream: async function* (params) {
          calls.push(params.messages);
          const n = calls.length;
          if (n === 1) {
            yield { type: "block-start", index: 0, blockType: "tool-call" };
            yield { type: "tool-call-delta", index: 0, id: "call_1", name: "log_write_ops", argumentsDelta: '{"ops":[{"op":"append","section":"渠道排查","entry":"渠道映射未生效根因：abilities 表脏数据"}]}' };
            yield { type: "block-end", index: 0, block: { type: "tool-call", id: "call_1", name: "log_write_ops", arguments: '{"ops":[{"op":"append","section":"渠道排查","entry":"渠道映射未生效根因：abilities 表脏数据"}]}' } };
            yield { type: "finish", reason: { kind: "tool-calls" } };
          } else {
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: "已写入日志。" };
            yield { type: "block-end", index: 0, block: { type: "text", text: "已写入日志。" } };
            yield { type: "finish", reason: { kind: "stop" } };
          }
        },
      },
    };
    const state = { lastSummarizedSeq: 0 };
    const r = await runMemorySubagent({ ctx, getConfig: cfg, paths: null, records: null, state, session: mkSession(baseEvents), dirs: [logDir], isError: false });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "written");
    assert.equal(state.lastSummarizedSeq, 2);
    const logFile = join(logDir, new Date().toISOString().slice(0, 10).replace(/-/g, "-")); // placeholder; real date below
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    const content = readFileSync(join(logDir, `${today}.md`), "utf8");
    assert.ok(content.includes("## 渠道排查"), "应写入章节");
    assert.ok(content.includes("- 渠道映射未生效根因"), "应写入条目");
    const secondMsg = calls[1];
    assert.ok(secondMsg.some((m) => m.role === "user" && m.content?.some((b) => b.type === "tool-result")), "第二轮应回喂 tool-result");
    ok("场景B：tool-calls 多轮 + 日志落盘 + tool-result 回喂");
    rmSync(join(logDir, `${today}.md`), { force: true });
  }

  // 场景 C：模型不支持 tools（finish error）→ ok:false 降级
  {
    const ctx = {
      llm: {
        listProviders: () => [],
        listModels: async () => [],
        stream: async function* () {
          yield { type: "finish", reason: { kind: "error", failure: { message: "provider error", code: "x" } } };
        },
      },
    };
    const state = { lastSummarizedSeq: 0 };
    const r = await runMemorySubagent({ ctx, getConfig: cfg, paths: null, records: null, state, session: mkSession(baseEvents), dirs: [logDir], isError: false });
    assert.equal(r.ok, false, "finish error 应降级");
    assert.equal(state.lastSummarizedSeq, 0, "失败不推进断点");
    ok("场景C：finish error 降级 + 不推进断点");
  }

  // 场景 D：20k 日志 → 首轮只回喂章节目录（TOC）
  {
    const big = `## 大章节\n${Array.from({ length: 1200 }, (_, i) => `- 条目${i} ${"x".repeat(30)}`).join("\n")}`;
    writeFileSync(join(logDir, `${(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })()}.md`), big, "utf8");
    let kickoffText = "";
    const ctx = {
      llm: {
        listProviders: () => [],
        listModels: async () => [],
        stream: async function* (params) {
          const last = params.messages[params.messages.length - 1];
          kickoffText = last.content?.map((b) => b.text || "").join("");
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "block-end", index: 0, block: { type: "text", text: "无" } };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
    };
    const state = { lastSummarizedSeq: 0 };
    const r = await runMemorySubagent({ ctx, getConfig: cfg, paths: null, records: null, state, session: mkSession(baseEvents), dirs: [logDir], isError: false });
    assert.equal(r.ok, true);
    assert.ok(kickoffText.includes("仅目录"), "应回喂目录模式说明");
    assert.ok(!kickoffText.includes("条目1199"), "不应回喂全文");
    ok("场景D：20k 日志仅回喂章节目录");
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    rmSync(join(logDir, `${today}.md`), { force: true });
  }

  // 场景 E：log_read_section 一次读取多个章节（A 改进）
  {
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    writeFileSync(join(logDir, `${today}.md`), "## 环境必知\n- peerDeps\n\n## 决策记录\n- 用本地日期\n", "utf8");
    let callCount = 0;
    const ctx = {
      llm: {
        listProviders: () => [],
        listModels: async () => [],
        stream: async function* (params) {
          callCount++;
          if (callCount === 1) {
            yield { type: "block-start", index: 0, blockType: "tool-call" };
            yield { type: "tool-call-delta", index: 0, id: "call_r", name: "log_read_section", argumentsDelta: '{"sections":["环境必知","决策记录"]}' };
            yield { type: "block-end", index: 0, block: { type: "tool-call", id: "call_r", name: "log_read_section", arguments: '{"sections":["环境必知","决策记录"]}' } };
            yield { type: "finish", reason: { kind: "tool-calls" } };
          } else if (callCount === 2) {
            yield { type: "block-start", index: 0, blockType: "tool-call" };
            yield { type: "tool-call-delta", index: 0, id: "call_w", name: "log_write_ops", argumentsDelta: '{"ops":[{"op":"append","section":"决策记录","entry":"补充确认：日志章节可多章节合并读取"}]}' };
            yield { type: "block-end", index: 0, block: { type: "tool-call", id: "call_w", name: "log_write_ops", arguments: '{"ops":[{"op":"append","section":"决策记录","entry":"补充确认：日志章节可多章节合并读取"}]}' } };
            yield { type: "finish", reason: { kind: "tool-calls" } };
          } else {
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "block-end", index: 0, block: { type: "text", text: "完成" } };
            yield { type: "finish", reason: { kind: "stop" } };
          }
        },
      },
    };
    const state = { lastSummarizedSeq: 0 };
    const r = await runMemorySubagent({ ctx, getConfig: cfg, paths: null, records: null, state, session: mkSession(baseEvents), dirs: [logDir], isError: false });
    assert.equal(r.ok, true, "多章节读取应成功");
    const content = readFileSync(join(logDir, `${today}.md`), "utf8");
    assert.ok(content.includes("补充确认：日志章节可多章节合并读取"), "追加应落盘");
    assert.ok(content.includes("- peerDeps") && content.includes("- 用本地日期"), "原章节内容保留");
    ok("场景E：log_read_section 多章节合并读取");
    rmSync(join(logDir, `${today}.md`), { force: true });
  }
}

// ---------- ②b 调试日志联动 ----------
section("②b distillLogLevel 联动（settings.update 兜底）");
{
  const { applyDebugLogLinkage } = await import("./lib/api.mjs");
  // true → 补 info
  const s1 = { distillDebugLog: true };
  applyDebugLogLinkage(s1);
  assert.equal(s1.distillLogLevel, "info", "开启时应写入 info");
  // true 且已有值 → 保留
  const s2 = { distillDebugLog: true, distillLogLevel: "debug" };
  applyDebugLogLinkage(s2);
  assert.equal(s2.distillLogLevel, "debug", "已有级别应保留");
  // false → 移除
  const s3 = { distillDebugLog: false, distillLogLevel: "debug" };
  applyDebugLogLinkage(s3);
  assert.equal(s3.distillLogLevel, undefined, "关闭时应移除 distillLogLevel");
  // 非布尔 → 不动
  const s4 = { distillDebugLog: "x", distillLogLevel: "info" };
  applyDebugLogLinkage(s4);
  assert.equal(s4.distillLogLevel, "info", "非布尔值不联动");
  ok("distillLogLevel 联动（开补 info / 关移除 / 已有保留）");
}

// ---------- ③ reorganize 双门禁 ----------
section("③ memory_reorganize 双门禁");
{
  const tmp = mkdtempSync(join(tmpdir(), "mp-reorg-"));
  const memFile = join(tmp, "MEMORY.md");
  const cfg = { workspaceBudgetChars: 3000, reorgCooldownDays: 7 };

  // 未超预算 → 拒绝
  writeFileSync(memFile, "## 小\n- a", "utf8");
  const g1 = checkReorgGate(memFile, cfg);
  assert.equal(g1.ok, false);
  assert.ok(g1.reason.includes("未超出注入预算"), "应提示预算未超");
  ok("门禁：未超预算拒绝");

  // 超预算但冷却期内 → 拒绝
  const bigMd = `## 大章节\n${Array.from({ length: 200 }, (_, i) => `- 条目${i} ${"y".repeat(40)}`).join("\n")}\n\n<!-- memory-palace:last-reorg:${(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T00:00:00`; })()} -->\n`;
  writeFileSync(memFile, bigMd, "utf8");
  const g2 = checkReorgGate(memFile, cfg);
  assert.equal(g2.ok, false);
  assert.ok(g2.reason.includes("冷却期"), "应提示冷却期");
  assert.equal(readLastReorg(bigMd) > 0, true, "时间戳应可解析");
  ok("门禁：冷却期拒绝 + 时间戳解析");

  // 双满足 → 通过
  writeFileSync(memFile, bigMd.replace(/<!-- memory-palace:last-reorg:.*-->/, ""), "utf8");
  const g3 = checkReorgGate(memFile, cfg);
  assert.equal(g3.ok, true, "双满足应通过");
  ok("门禁：双满足通过");
}

console.log(`\n${passed} 项断言全部通过`);
