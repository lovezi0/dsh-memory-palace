// memory-palace v1.6.0 hybrid 模式测试。
// 覆盖：① sections 纯函数（解析/追加/新增/替换 stale 拒绝/标删/结构行保护/删除线过滤）；
// ② 记忆子 agent 循环 mock LLM（无重点单轮 / tool-calls 多轮落盘 / 超 6 轮降级 / 不支持 tools 降级 / 20k 目录回喂）；
// ③ memory_reorganize 双门禁（未超预算拒绝 / 冷却期拒绝 / 双满足通过 + 时间戳落盘 + 备份存在）。
// 运行：npm run build 后 `/usr/bin/env -u NODE_OPTIONS node test-hybrid.mjs`（import 自 lib/）。
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseSections, locateSection, appendToSectionText, upsertSectionText, createSectionText, replaceSectionText, markEntryDeletedText } from "../lib/common/sections.mjs";
import { stripDeletedLines } from "../lib/common/text.mjs";
import { createPaths } from "../lib/common/paths.mjs";
import { runMemorySubagent } from "../lib/hybrid/subagent.mjs";
import { checkReorgGate, readLastReorg, registerHybridTools, attachHybridGuards } from "../lib/hybrid/tools.mjs";
import { registerTools } from "../lib/tools.mjs";

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
  const cfg = () => ({ enabled: true, summaryModel: "", summaryTimeoutMs: 5000, subagentLogBudget: 20000 });

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
    // v1.8.0（dsh 0.1.7）：createToolResultMessage 从「user 消息装 tool-result 块」改为独立 role=tool 消息（content 为结果块本身）。
    // 判据放宽为两版宿主通用：role=tool 或 user 消息内含 tool-result 块。
    assert.ok(secondMsg.some((m) => m.role === "tool" || (m.role === "user" && m.content?.some((b) => b.type === "tool-result"))), "第二轮应回喂 tool-result");
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

  // 场景 F（v1.6.3 用例A）：误调未知工具 run_code → 自纠改用 log_write_ops → stop
  // 期望：appliedWrites>0、mode="written"、断点推进、日志实际落盘。
  {
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    let n = 0;
    let sawUnknownReject = false;
    const ctx = {
      llm: {
        listProviders: () => [],
        listModels: async () => [],
        stream: async function* (params) {
          const last = params.messages[params.messages.length - 1];
          // round1 起应回喂到 run_code 被拒的 tool-result（unknown 拒绝文案），形状不假设，全量 JSON 匹配
          if (n >= 1 && JSON.stringify(last).includes("工具 run_code 不存在")) sawUnknownReject = true;
          n++;
          if (n === 1) {
            yield { type: "block-start", index: 0, blockType: "tool-call" };
            yield { type: "tool-call-delta", index: 0, id: "call_rc", name: "run_code", argumentsDelta: "{}" };
            yield { type: "block-end", index: 0, block: { type: "tool-call", id: "call_rc", name: "run_code", arguments: "{}" } };
            yield { type: "finish", reason: { kind: "tool-calls" } };
          } else if (n === 2) {
            yield { type: "block-start", index: 0, blockType: "tool-call" };
            yield { type: "tool-call-delta", index: 0, id: "call_w", name: "log_write_ops", argumentsDelta: '{"ops":[{"op":"append","section":"幻觉自纠","entry":"误调 run_code 被拒后自纠改用 log_write_ops 落盘"}]}' };
            yield { type: "block-end", index: 0, block: { type: "tool-call", id: "call_w", name: "log_write_ops", arguments: '{"ops":[{"op":"append","section":"幻觉自纠","entry":"误调 run_code 被拒后自纠改用 log_write_ops 落盘"}]}' } };
            yield { type: "finish", reason: { kind: "tool-calls" } };
          } else {
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "block-end", index: 0, block: { type: "text", text: "已写入。" } };
            yield { type: "finish", reason: { kind: "stop" } };
          }
        },
      },
    };
    const state = { lastSummarizedSeq: 0 };
    const r = await runMemorySubagent({ ctx, getConfig: cfg, paths: null, records: null, state, session: mkSession(baseEvents), dirs: [logDir], isError: false });
    assert.equal(r.ok, true, "自纠成功应返回 ok");
    assert.equal(r.mode, "written", "应判 written");
    assert.equal(state.lastSummarizedSeq, 2, "断点应推进");
    const content = readFileSync(join(logDir, `${today}.md`), "utf8");
    assert.ok(content.includes("## 幻觉自纠"), "应写入章节");
    assert.ok(content.includes("自纠改用 log_write_ops"), "应写入条目");
    assert.ok(sawUnknownReject, "模型应收到过 run_code 被拒的 tool-result（unknown 标记文案）");
    ok("场景F：未知工具 run_code 被拒 → 自纠 log_write_ops 落盘 + 断点推进");
    rmSync(join(logDir, `${today}.md`), { force: true });
  }

  // 场景 G（v1.6.3 用例B）：误调未知工具 run_code 后模型反复纯文本收尾（放弃），重试预算耗尽
  // 期望：mode="no-write"（ok:false）、断点不推进、dbgFail("no write applied") 被调、催促发生 ≤3 次。
  {
    // v1.8.0-alpha.4 retarget：日志改为注入式 logger（不再走 console.error），改用收集型 sink 断言。
    const sink = [];
    const logger = {
      for: () => ({
        dbgFail: (why, extra) => sink.push(`${why}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`),
        dbg: () => {},
        info: () => {},
        raw: () => {},
      }),
    };
    let n = 0;
    try {
      const ctx = {
        llm: {
          listProviders: () => [],
          listModels: async () => [],
          stream: async function* () {
            n++;
            if (n === 1) {
              // 第 0 轮误调未知工具
              yield { type: "block-start", index: 0, blockType: "tool-call" };
              yield { type: "tool-call-delta", index: 0, id: "call_rc", name: "run_code", argumentsDelta: "{}" };
              yield { type: "block-end", index: 0, block: { type: "tool-call", id: "call_rc", name: "run_code", arguments: "{}" } };
              yield { type: "finish", reason: { kind: "tool-calls" } };
            } else {
              // 之后每轮都纯文本收尾（模型拒绝再写）
              yield { type: "block-start", index: 0, blockType: "text" };
              yield { type: "block-end", index: 0, block: { type: "text", text: "无内容" } };
              yield { type: "finish", reason: { kind: "stop" } };
            }
          },
        },
      };
      const state = { lastSummarizedSeq: 0 };
      const r = await runMemorySubagent({ ctx, getConfig: cfg, paths: null, records: null, state, session: mkSession(baseEvents), dirs: [logDir], isError: false, logger });
      assert.equal(r.ok, false, "重试耗尽应失败");
      assert.equal(r.mode, "no-write", "应判 no-write");
      assert.equal(state.lastSummarizedSeq, 0, "断点不应推进");
      assert.ok(sink.some((l) => l.includes("no write applied")), "应触发 dbgFail no write applied");
      const urges = sink.filter((l) => l.includes("retry after unknown tool")).length;
      assert.equal(urges, 3, `催促应恰好 3 次（MAX_RETRY），实际 ${urges}`);
      ok("场景G：未知工具 + 反复放弃 → 催促 3 次后 no-write + 断点不推进");
    } finally {
      // v1.8.0-alpha.4：日志改为注入式 logger，无需恢复 console.error。
    }
  }

  // 场景 H（v1.6.3 用例C）：第 0 轮直接 stop（无工具调用）→ noop
  // 回归保护：防止三态判定改坏正常"无重点收尾"路径。
  {
    const ctx = {
      llm: {
        listProviders: () => [],
        listModels: async () => [],
        stream: async function* () {
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "block-end", index: 0, block: { type: "text", text: "闲聊，无实质内容。" } };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
    };
    const state = { lastSummarizedSeq: 0 };
    const r = await runMemorySubagent({ ctx, getConfig: cfg, paths: null, records: null, state, session: mkSession(baseEvents), dirs: [logDir], isError: false });
    assert.equal(r.ok, true, "无内容应成功");
    assert.equal(r.mode, "noop", "应判 noop");
    assert.equal(state.lastSummarizedSeq, 2, "断点应推进");
    ok("场景H：无工具直接 stop → noop + 断点推进（回归保护）");
  }
}

// ---------- ②b 调试日志联动 ----------
section("②b distillLogLevel 联动（settings.update 兜底）");
{
  const { applyDebugLogLinkage } = await import("../lib/api.mjs");
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

// ---------- ③b memory_reorganize 预执行闸门（置位重整标记）+ description 引导 ----------
// v1.8.1：重整流程期间禁用 memory_read（只覆盖近三天，读不到更早日志）——手动命令与 agent
// 自动调用工具两条路径都置位；工具 description 亦须改引导用文件读取工具。
section("③b memory_reorganize 闸门置位 + description");
{
  const tmp = mkdtempSync(join(tmpdir(), "mp-reorg-guard-"));
  mkdirSync(join(tmp, ".deepseek-harness"), { recursive: true });
  const memFile = join(tmp, ".deepseek-harness", "MEMORY.md");
  writeFileSync(memFile, `## 大章节\n${Array.from({ length: 300 }, (_, i) => `- 条目${i} ${"y".repeat(40)}`).join("\n")}\n`, "utf8");
  const cfg = () => ({
    enabled: true, bridgeBuddyMemory: false, workspaceMemoryDir: ".deepseek-harness/memory",
    workspaceBudgetChars: 3000, reorgCooldownDays: 7,
  });
  const paths = createPaths(cfg, () => tmp);
  const marks = [];
  const state = {
    reorgBySession: new Map(),
    reorgSkipFirstStep: new Map(),
    markReorg: (session, opts) => marks.push({ id: session?.id, opts }),
  };
  const listeners = {};
  const ctx = { on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); } };
  attachHybridGuards(ctx, cfg, paths, state);
  const guard = (listeners["tools/pre-execute"] || [])[0];
  assert.ok(typeof guard === "function", "应注册 tools/pre-execute 闸门");

  const session = { id: "s-reorg", header: { cwd: tmp } };
  const askRes = await guard(
    { name: "memory_reorganize", agent: { session }, arguments: { newContent: "## x\n- y" } },
    async () => ({ kind: "allow" }),
  );
  assert.equal(askRes.kind, "ask", "门禁通过 → 走原生确认弹窗（ask）");
  assert.equal(marks.length, 1, "门禁通过应置位重整标记");
  assert.equal(marks[0].id, "s-reorg", "重整标记应绑定发起会话");
  ok("memory_reorganize 闸门：通过 → ask + 置位重整标记");

  writeFileSync(memFile, "## 小\n- a\n", "utf8");
  const denyRes = await guard(
    { name: "memory_reorganize", agent: { session: { id: "s-small", header: { cwd: tmp } } }, arguments: { newContent: "## x\n- y" } },
    async () => ({ kind: "allow" }),
  );
  assert.equal(denyRes.kind, "deny", "未超预算 → deny");
  assert.equal(marks.length, 1, "被门禁拒绝时不得置位重整标记");
  ok("memory_reorganize 闸门：门禁不过 → deny 且不置位");

  // description：引导用文件读取工具，且明示 memory_read 在重整期间被禁用（不再引导 memory_read）
  const toolDefs = [];
  registerHybridTools({ ctx: { tools: { register: (d) => toolDefs.push(d) } }, getConfig: cfg, paths, state });
  const reorgDef = toolDefs.find((d) => d.name === "memory_reorganize");
  assert.ok(reorgDef, "memory_reorganize 工具应已注册");
  assert.ok(/file-reading tools/.test(reorgDef.description), "description 应引导用文件读取工具");
  assert.ok(/memory_read tool is DISABLED/.test(reorgDef.description), "description 应明示 memory_read 在重整期间被禁用");
  assert.ok(!/memory_read with scope/.test(reorgDef.description), "description 不得再引导 memory_read 读取");
  ok("memory_reorganize description：引导文件读取 + 明示 memory_read 禁用");
}

// ---------- ③c v1.8.1-alpha.2：写入形状层 + 守卫文案不再诱导绕道 + size 回显 ----------
section("③c 写入规范（形状层）+ 守卫文案 + size 回显");
{
  const tmp = mkdtempSync(join(tmpdir(), "mp-shape-"));
  mkdirSync(join(tmp, ".deepseek-harness"), { recursive: true });
  writeFileSync(join(tmp, ".deepseek-harness", "MEMORY.md"), "# 项目笔记\n\n## 环境必知\n- 旧条目\n", "utf8");
  const cfg = () => ({
    enabled: true, bridgeBuddyMemory: false, workspaceMemoryDir: ".deepseek-harness/memory",
    workspaceBudgetChars: 100, userBudgetChars: 50, userMemoryPath: join(tmp, "USER-MEMORY.md"),
    reorgCooldownDays: 7, summaryTimeoutMs: 60000,
  });
  const paths = createPaths(cfg, () => tmp);
  const toolDefs = [];
  registerHybridTools({ ctx: { tools: { register: (d) => toolDefs.push(d) } }, getConfig: cfg, paths, state: {} });
  const byName = (n) => toolDefs.find((d) => d.name === n);
  const wDef = byName("memory_write"), uDef = byName("memory_update_section"), rDef = byName("memory_reorganize");

  // 形状层：三个写入工具 description 同一套（一条一事 / 禁源码坐标 / 禁一次性过程）
  for (const [n, d] of [["memory_write", wDef], ["memory_update_section", uDef], ["memory_reorganize", rDef]]) {
    assert.ok(/one fact per entry/i.test(d.description), `${n} description 应含「一条一事」`);
    assert.ok(/source coordinate/i.test(d.description), `${n} description 应禁源码坐标`);
    assert.ok(/one-off material/.test(d.description), `${n} description 应禁一次性过程`);
  }
  // memory_write：去掉诱导塞细节的 "then key details"
  assert.ok(!/then key details/.test(wDef.description), "memory_write 不得再写 'then key details'（诱导塞细节）");
  // memory_reorganize：门禁失败不再引导绕道；含一次落盘 / 参考线 / 两删一提一重构
  assert.ok(!/use memory_update_section instead/.test(rDef.description), "门禁失败不得再引导改用 memory_update_section");
  assert.ok(/REFERENCE LINE, not a hard target/.test(rDef.description), "应声明预算为参考线而非硬指标");
  assert.ok(/ONLY ONE write is allowed/.test(rDef.description), "应声明只允许落盘一次");
  assert.ok(/drop obsolete/.test(rDef.description) && /restructure/.test(rDef.description), "应写明两删一提一重构任务");
  ok("三个写入工具 description：形状层统一 + 去掉诱导措辞 + 一次落盘");

  // 守卫文案：冷却拒绝不再把 agent 推向绕道路径
  const p2 = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const nowIso = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  const guardFile = join(tmp, "guard-target.md");
  writeFileSync(guardFile, `## 大章节\n${"- x xx\n".repeat(80)}\n<!-- memory-palace:last-reorg:${nowIso} -->\n`, "utf8");
  const gate = checkReorgGate(guardFile, { workspaceBudgetChars: 10, reorgCooldownDays: 7 });
  assert.equal(gate.overBudget, true, "守卫样本应超预算");
  assert.equal(gate.cooled, false, "守卫样本应在冷却期内");
  assert.ok(/仅允许落盘一次/.test(gate.reason), `冷拒绝应明示「只允许落盘一次」：${gate.reason}`);
  assert.ok(!/章节级修正/.test(gate.reason), "冷拒绝不得再引导 memory_update_section 做章节级修正");
  ok("守卫文案：冷却拒绝只表达「停止 + 报告」，不给出替代路径");

  // size 回显：按 scope 取预算（project → workspaceBudgetChars / user → userBudgetChars）
  const exec = { agent: { session: { id: "s-size", header: { cwd: tmp } } } };
  const r1 = await wDef.execute({ scope: "project", section: "环境必知", entry: "新增条目甲" }, exec);
  assert.ok(r1.ok, "memory_write(project) 应写入成功");
  assert.ok(/当前 \d+\/100 字符（[\d.]+×）/.test(r1.message), `project 回显应含「当前 N/100 字符（x×）」：${r1.message}`);
  const r2 = await wDef.execute({ scope: "user", section: "偏好", entry: "偏好甲" }, exec);
  assert.ok(r2.ok, "memory_write(user) 应写入成功");
  assert.ok(/当前 \d+\/50 字符（[\d.]+×）/.test(r2.message), `user 回显应含「当前 N/50 字符（x×）」：${r2.message}`);
  ok("size 回显：按 scope 取预算（project 100 / user 50）");

  // 兜底：cfg 缺 userBudgetChars 时须回落 schema 默认 8000（不是 v1.8.0 之前的旧值 4000）
  const defs2 = [];
  const cfgNoUser = () => ({
    enabled: true, bridgeBuddyMemory: false, workspaceMemoryDir: ".deepseek-harness/memory",
    workspaceBudgetChars: 6000, userMemoryPath: join(tmp, "USER2.md"),
  });
  registerHybridTools({ ctx: { tools: { register: (d) => defs2.push(d) } }, getConfig: cfgNoUser, paths, state: {} });
  const r3 = await defs2.find((d) => d.name === "memory_write").execute({ scope: "user", section: "偏好", entry: "乙" }, exec);
  assert.ok(/\/8000 字符/.test(r3.message), `缺 userBudgetChars 时应回落 8000：${r3.message}`);
  ok("size 回显兜底：userBudgetChars 缺失 → 8000（与 schema 默认一致）");

  // 基础写入工具（memory_note / memory_note_user）也须同一套形状规范 + 去掉推流水账措辞
  const baseDefs = [];
  registerTools({ ctx: { tools: { register: (d) => baseDefs.push(d) }, on: () => {} }, getConfig: cfg, paths, state: {} });
  for (const n of ["memory_note", "memory_note_user"]) {
    const d = baseDefs.find((x) => x.name === n);
    assert.ok(d, `${n} 应已注册`);
    assert.ok(/conclusion first/i.test(d.description), `${n} 应含「结论先行」`);
    assert.ok(/source coordinate/i.test(d.description), `${n} 应禁源码坐标`);
    assert.ok(/one-off material/.test(d.description), `${n} 应禁一次性过程`);
    assert.ok(/must-reuse base addresses/.test(d.description), `${n} 应含「URL 只留基址」`);
    assert.ok(!/after completing tasks/i.test(d.description), `${n} 不得再推「完成任务后就写」式流水账`);
    assert.ok(!/then key details/.test(d.description), `${n} 不得再写 'then key details'`);
  }
  ok("基础写入工具（memory_note / _user）：形状层一致 + 无流水账措辞");
}

// ---------- 缺陷修复回归（v1.8.0-alpha.1：D1 entry 扁平化 / D3 标题一致性） ----------
section("缺陷修复回归（v1.8.0-alpha.1）");
{
  const md1 = "# 项目笔记\n\n## 环境必知\n- aaa\n";
  const baseCount = parseSections(md1).sections.length;

  // D1：多行 entry（含 \n## 标题 / \n# 标题）必须扁平化为单行，不得生成真实章节
  const f1 = upsertSectionText(md1, "环境必知", "结论一\n## 伪造标题\n- 伪造条目\n# 伪造H1");
  assert.equal(f1.ok, true, "D1: 多行 entry 应写入成功（扁平化）");
  assert.equal(f1.flattened, true, "D1: 应标记 flattened");
  assert.equal(parseSections(f1.text).sections.length, baseCount, "D1: 不得新增任何章节");
  assert.ok(f1.text.includes("- 结论一；伪造标题；伪造条目；伪造H1"), "D1: 应合并为单行");
  assert.ok(!f1.text.includes("## 伪造标题") && !f1.text.includes("# 伪造H1"), "D1: 注入标题不得落盘");
  ok("D1 entry 扁平化（多行/标题注入不落盘）");

  // D1：append 路径与新建章节路径同样扁平化
  const f1b = appendToSectionText(md1, "环境必知", "行A\n行B");
  assert.equal(f1b.ok, true);
  assert.ok(f1b.text.includes("- 行A；行B"), "D1: append 路径应合并单行");
  assert.equal(f1b.flattened, true);
  const f1c = upsertSectionText(md1, "全新章节", "内容甲\n## 注入标题");
  assert.equal(f1c.reason, "section-created");
  assert.ok(!f1c.text.includes("## 注入标题"), "D1: 新建路径不得注入标题");
  assert.ok(f1c.text.includes("- 内容甲；注入标题"), "D1: 新建路径合并单行");
  ok("D1 append / 新建章节路径扁平化");

  // D3：replace 模式校验 newText 标题行与 section 一致
  const d3md = "## 章节A\n- 旧1\n- 旧2\n";
  const d3 = replaceSectionText(d3md, "章节A", "## 章节A\n- 旧1\n- 旧2", "## 章节B\n- 新1");
  assert.equal(d3.ok, false, "D3: 静默改名应被拒绝");
  assert.equal(d3.reason, "heading-mismatch");
  assert.ok(d3.actual.includes("章节A"), "D3: actual 应回显当前内容");
  const d3b = replaceSectionText(d3md, "章节A", "## 章节A\n- 旧1\n- 旧2", "- 新1\n- 新2");
  assert.equal(d3b.ok, false, "D3: 缺标题行应拒绝（防章节标题整行被吃）");
  assert.equal(d3b.reason, "heading-mismatch");
  const d3c = replaceSectionText(d3md, "章节A", "## 章节A\n- 旧1\n- 旧2", "##  章节A \n- 新1");
  assert.equal(d3c.ok, true, "D3: 标题一致（容忍前缀/空白差异）应放行");
  ok("D3 replace 模式校验标题一致性");
}

console.log(`\n${passed} 项断言全部通过`);
