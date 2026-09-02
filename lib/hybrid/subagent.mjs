// memory-palace v1.6.0 hybrid 模式：记忆子 agent（turn/end 触发的轻量工具循环）。
// 职责（定案）：每轮必跑，判定+产出一体——无重点纯文本收尾（1 次调用）；有重点通过循环内
// 白名单工具把格式化摘要写入今日工作日志（2-5 次调用）。只操作今日日志，三种操作：
// 新增章节 / 章节内追加 / 标记删除（~~删除线~~ 墓碑），禁止覆盖整文件与物理删除。
// 架构依据（v1.6.0 调研）：ctx.llm.stream 支持 GenerateOptions.tools，finish.kind ===
// 'tool-calls' 时用 BlockAssembler.message() 回喂 assistant 消息 + createToolResultMessage
// 回喂工具结果，自建循环；ctx.subagents 需活 Agent 作父，插件不可用。
import { readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { BlockAssembler, createUserMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { todayISO, readMdSync } from "../common/text.mjs";
import { eventsFrom } from "../common/session.mjs";
import { appendToSectionText, upsertSectionText, createSectionText, markEntryDeletedText, parseSections, locateSection } from "../common/sections.mjs";
import { HYBRID_PROACTIVE, SUBAGENT_SYSTEM } from "./prompts.mjs";

export { HYBRID_PROACTIVE };

const MAX_ROUNDS = 6; // 循环轮次上限（含首轮）；超限降级
const SURFACE = new Set(["user/message", "assistant/message", "tool/result"]);

// 日志文件写锁（全局 promise 链串行化）：子 agent 落盘与手动蒸馏按钮/其他写路径并发防护。
let logWriteChain = Promise.resolve();
function withLogLock(file, fn) {
  const run = logWriteChain.then(fn, fn);
  logWriteChain = run.catch(() => {});
  return run;
}

// 模型解析（与 distill.mjs resolveModel 同逻辑，改动须两处同步）：summaryModel 注册表反查
// > 前缀兜底 > 会话 requestHeader 兜底。复制而非导出原因：hybrid 走独立模块定案，不碰 distill。
async function resolveModel(cfg, ctx, session) {
  const sm = (cfg.summaryModel || "").trim();
  if (sm) {
    try {
      const providers = typeof ctx.llm?.listProviders === "function" ? ctx.llm.listProviders() : [];
      for (const p of providers || []) {
        try {
          const models = await ctx.llm.listModels(p.id);
          const m = (models || []).find((x) => x.id === sm);
          if (m) return { provider: m.provider, model: m.id };
        } catch { /* 该 provider 无模型列表，跳过 */ }
      }
      const provider = sm.split("/")[0].trim();
      if (provider && sm.includes("/")) return { provider, model: sm };
    } catch { /* 注册表不可用，走会话兜底 */ }
  }
  const conf = session?.requestHeader?.()?.config;
  if (conf && conf.provider && conf.model) return { provider: conf.provider, model: conf.model };
  return null;
}

// 单次流式调用（带 tools）。finish.kind 为 error/aborted 时抛出由上层降级；tool-calls/stop 正常返回。
async function streamTurn(ctx, params, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const res = ctx.llm.stream({ ...params, signal });
  const asm = new BlockAssembler();
  for await (const ch of res) {
    signal.throwIfAborted();
    asm.push(ch);
  }
  const finish = asm.finish;
  if (finish.kind === "error" || finish.kind === "aborted") {
    throw new Error(finish.failure?.message || finish.kind);
  }
  return { finish, asm };
}

// 把本轮 surface 事件投影为消息数组（seq >= fromSeq；与 distillSessionCore 同源逻辑）。
// v1.6.2-alpha.4：eventsFrom 兼容层（宿主 0.1.2-alpha.4 删除 Session.events getter）。
function projectTurnMessages(session, fromSeq) {
  const hist = [];
  for (const e of eventsFrom(session, fromSeq)) {
    if (!SURFACE.has(e.type)) continue;
    const m = session.deriveEventMessage ? session.deriveEventMessage(e) : null;
    if (m) hist.push(m);
  }
  return hist;
}

// 今日日志回喂正文：≤ subagentLogBudget 全文；超出仅章节目录（标题 + 条目数 + 首条），
// 由子 agent 用 log_read_section 按需拉取（定案）。空日志（跨零点新一天）明确告知。
function buildLogBlock(dir, budget) {
  const file = join(dir, `${todayISO()}.md`);
  const text = readMdSync(file);
  if (!text) {
    return { file, oversized: false, body: "（今日日志为空——新的一天，直接用 append/new_section 建章节写入即可。）" };
  }
  if (text.length <= budget) {
    return { file, oversized: false, body: text };
  }
  const { sections } = parseSections(text);
  const toc = sections
    .map((s) => {
      const items = s.lines.slice(1).filter((l) => l.trim());
      const first = items[0]?.trim().slice(0, 80) || "";
      return `- ${s.title}（${items.length} 条，首条：${first}）`;
    })
    .join("\n");
  return {
    file,
    oversized: true,
    body:
      `（日志过大（${text.length} 字符），以下仅目录；需要某章节完整内容时调用 log_read_section 读取）\n${toc}`,
  };
}

// 循环内工具执行：仅两个白名单工具，其余一律报错（模型越权时结果回喂 isError，不中断循环）。
async function execLoopTool(block, logFiles, cfg) {
  const name = block.name;
  let args = {};
  try {
    args = JSON.parse(block.arguments || "{}");
  } catch {
    return { ok: false, message: "工具参数不是合法 JSON。" };
  }
  try {
    if (name === "log_read_section") {
      // v1.6.0 A 改进：一次读取多个章节（sections 数组），合并返回；兼容旧单数 section 参数。
      const file = logFiles[0];
      const md = readMdSync(file) || "";
      const wants = Array.isArray(args.sections)
        ? args.sections.filter((s) => s && typeof s === "string")
        : args.section
          ? [args.section]
          : [];
      if (!wants.length) return { ok: false, message: "sections 不能为空（数组，可一次传多个章节标题）。" };
      const parts = [];
      const missing = [];
      for (const s of wants) {
        const loc = locateSection(md, String(s).trim());
        if (!loc) {
          missing.push(String(s).trim());
          continue;
        }
        parts.push(loc.lines.slice(loc.start, loc.end).join("\n").trim());
      }
      if (!parts.length) {
        return { ok: false, message: `未找到章节：${missing.join("、")}。可用章节：${parseSections(md).sections.map((s) => s.title).join("、") || "（日志为空）"}` };
      }
      const note = missing.length ? `\n\n（以下章节未找到：${missing.join("、")}）` : "";
      return { ok: true, content: parts.join("\n\n---\n\n") + note };
    }
    if (name === "log_write_ops") {
      const ops = Array.isArray(args.ops) ? args.ops : [];
      if (!ops.length) return { ok: false, message: "ops 为空。" };
      return await applyLogOps(logFiles, todayISO(), ops);
    }
    return { ok: false, message: `未知工具 ${name}（仅 log_read_section / log_write_ops 可用）。` };
  } catch (e) {
    return { ok: false, message: `执行失败：${e?.message || String(e)}` };
  }
}

// 把 ops 序列应用到每个日志文件（读-改-写，经全局写锁串行化）。op → sections 纯函数：
// append=upsert（存在追加/不存在新增章节，"不强行匹配"）、new_section=已存在拒绝、
// mark_delete=删除线墓碑（结构行保护）。
function applyLogOps(logFiles, dateStr, ops) {
  const apply = (md) => {
    let cur = md || "";
    const results = [];
    for (const op of ops) {
      if (!op || typeof op !== "object") {
        results.push({ op: "invalid", ok: false, message: "op 非对象" });
        continue;
      }
      const section = String(op.section ?? "").trim();
      if (!section) {
        results.push({ op: op.op, ok: false, message: "section 不能为空" });
        continue;
      }
      if (op.op === "append") {
        const r = upsertSectionText(cur, section, op.entry);
        results.push({ op: "append", section, ok: r.ok, message: r.reason });
        if (r.ok) cur = r.text;
      } else if (op.op === "new_section") {
        const r = createSectionText(cur, section, op.entry);
        results.push({ op: "new_section", section, ok: r.ok, message: r.reason });
        if (r.ok) cur = r.text;
      } else if (op.op === "mark_delete") {
        const r = markEntryDeletedText(cur, section, op.oldText);
        results.push({ op: "mark_delete", section, ok: r.ok, message: r.reason });
        if (r.ok && r.text !== undefined) cur = r.text;
      } else {
        results.push({ op: op.op, ok: false, message: "未知 op（仅 append/new_section/mark_delete）" });
      }
    }
    return { cur, results };
  };
  return withLogLock(logFiles[0], async () => {
    const all = [];
    for (const file of logFiles) {
      let md = "";
      try {
        md = readFileSync(file, "utf8");
      } catch { /* 文件尚不存在 */ }
      const { cur, results } = apply(md);
      if (cur !== md) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, cur, "utf8");
      }
      all.push(...results);
    }
    const applied = all.filter((r) => r.ok).length;
    return { ok: true, applied, total: all.length, results: all, date: dateStr };
  });
}

// 记忆子 agent 主入口。每轮必跑（定案：不走闸门）；plan 模式拦截由调用方（index.mjs _settle）负责。
// 返回 { ok, mode }：mode = "noop"（无重点收尾）| "written"（有落盘）| "no-tool-support"；
// ok=false 表示整体失败（调用方降级 writeLightEntry，不推进断点）。
export async function runMemorySubagent({ ctx, getConfig, paths, state, session, dirs, isError }) {
  const cfg = getConfig();
  // 调试日志（v1.6.0）：与 distill.mjs 同款门控。dbgFail=失败/跳过留痕（无条件输出，排障可观测）；
  // dbg=受 distillDebugLog 开关控制的详单（模型解析/请求参数/流进度/ops 结果计数）。
  // 隐私红线：只打计数/字符数/元数据/错误 message，绝不打印对话或日志正文文本。
  const dbgFail = (why, extra) => console.error(`[memory-palace] subagent skip: ${why}`, extra ? JSON.stringify(extra) : "");
  const dbg = (why, extra) => { if (!cfg.distillDebugLog) return; console.error(`[memory-palace][debug] subagent ${why}`, extra !== undefined ? JSON.stringify(extra) : ""); };
  if (!cfg.enabled || !session || !dirs.length) {
    dbgFail("disabled or no session/dirs", { enabled: !!cfg.enabled, hasSession: !!session, dirs: dirs.length });
    return { ok: false, mode: "disabled" };
  }
  const resolved = await resolveModel(cfg, ctx, session);
  if (!resolved) {
    dbgFail("no model", { summaryModel: cfg.summaryModel });
    return { ok: false, mode: "no-model" };
  }
  const { provider, model } = resolved;
  dbg("entry", { sessionId: session.id, fromSeq: state.lastSummarizedSeq, provider, model });

  const hist = projectTurnMessages(session, state.lastSummarizedSeq);
  if (!hist.length) {
    dbg("no events in range", { fromSeq: state.lastSummarizedSeq });
    return { ok: true, mode: "noop" };
  }

  const log = buildLogBlock(dirs[0], cfg.subagentLogBudget || 20000);
  const logFiles = dirs.map((dir) => join(dir, `${todayISO()}.md`));
  dbg("log feed", { file: log.file, oversized: log.oversized, chars: log.body.length, logFiles: logFiles.length });

  // 首轮 user 消息：本轮对话已在 hist 中逐条保留，末尾追加日志回喂 + 任务指令。
  const brief = isError ? "\n\n（提示：本轮对话中出现过错误信号，错误现象值得记录。）" : "";
  const kickoff = createUserMessage({
    content: [
      {
        type: "text",
        text:
          `【今日工作日志（${todayISO()}）】\n${log.body}\n\n` +
          `请按系统指令处理上面的本轮对话（对话见前文消息）：判定是否有实质内容需要写入日志，并执行。${brief}`,
      },
    ],
    source: { kind: "plugin", plugin: "memory-palace" },
  });

  const tools = [
    {
      name: "log_read_section",
      description:
        "读取今日工作日志中指定章节的完整内容（含标题行与全部条目）。sections 接受数组，可一次读取多个章节（合并返回，未找到的章节会注明）——需要多个章节时务必在单次调用中全部传入，避免多轮往返。仅在回喂为目录模式（日志过大）时需要调用；全文回喂时无需调用。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          sections: {
            type: "array",
            description: "要读取的章节标题列表（不含 `## ` 前缀），可一次传多个。",
            items: { type: "string" },
          },
        },
        required: ["sections"],
      },
    },
    {
      name: "log_write_ops",
      description:
        "批量写入今日工作日志（只能操作今日日志）。ops 数组，每个元素：\n" +
        '- {"op":"append","section":"章节名","entry":"条目文本（一行，结论先行+关键细节，【不带 - 前缀】——插件会自动补）"}：章节存在则末尾追加，不存在则自动新增章节（不要强行匹配语义不符的章节）；\n' +
        '- {"op":"new_section","section":"新章节名","entry":"首条条目（不带 - 前缀）"}：显式新建章节（已存在会拒绝，改用 append）；\n' +
        '- {"op":"mark_delete","section":"章节名","oldText":"日志中该条目原文（可带或不带 - 前缀）"}：把重复/过时/被推翻的旧条目标记为删除线墓碑（非物理删除），oldText 逐行匹配，匹配失败会被拒绝；\n' +
        "一条消息可带多个 ops 一次提交；entry 为客观第三人称单行文本（不带列表符），禁止对话体与任何标签。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          ops: {
            type: "array",
            description: "日志写操作数组（见 description）。",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { type: "string", description: "append | new_section | mark_delete" },
                section: { type: "string", description: "章节标题（不含 ## 前缀）。" },
                entry: { type: "string", description: "append/new_section 的条目文本（一行）。" },
                oldText: { type: "string", description: "mark_delete 的目标条目原文。" },
              },
              required: ["op", "section"],
            },
          },
        },
        required: ["ops"],
      },
    },
  ];

  const system = SUBAGENT_SYSTEM();
  const messages = [...hist, kickoff];
  const timeoutMs = cfg.summaryTimeoutMs || 60000;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const { finish, asm } = await streamTurn(ctx, { provider, model, system, messages, tools }, timeoutMs);
      if (finish.kind === "stop") {
        state.lastSummarizedSeq = session.seq;
        dbg("done", { round, mode: round === 0 ? "noop" : "written" });
        return { ok: true, mode: round === 0 ? "noop" : "written" };
      }
      if (finish.kind !== "tool-calls") {
        // max-tokens 等异常收尾：返回失败，断点不推进——下一次 turn/end 子代理自动补蒸。
        // v1.6.0 定案：不降级 writeLightEntry（无格式原文会破坏日志章节化结构），宁缺勿滥。
        dbgFail(`finish ${finish.kind}`, { round });
        return { ok: false, mode: `finish-${finish.kind}` };
      }
      messages.push(asm.message({ kind: "model", provider, model }));
      const calls = asm.blocks().filter((b) => b.type === "tool-call");
      dbg("tool-calls round", { round, calls: calls.length, names: calls.map((c) => c.name) });
      for (const call of calls) {
        const result = await execLoopTool(call, logFiles, cfg);
        const body = result.ok && result.content !== undefined ? String(result.content) : JSON.stringify(result);
        messages.push(
          createToolResultMessage({
            callId: call.id,
            content: [{ type: "text", text: body }],
            isError: !result.ok,
          }),
        );
        if (!result.ok) dbgFail(`tool ${call.name} rejected`, { message: result.message, opApplied: result.applied });
        else dbg("tool ok", { name: call.name, applied: result.applied, total: result.total });
      }
    }
    dbgFail("max-rounds exceeded", { rounds: MAX_ROUNDS });
    return { ok: false, mode: "max-rounds" };
  } catch (e) {
    if (e?.name === "TimeoutError" || /timeout|abort/i.test(String(e?.message))) {
      dbgFail("timeout", { timeoutMs });
      return { ok: false, mode: "timeout" };
    }
    dbgFail("error", { message: e?.message || String(e) });
    return { ok: false, mode: "error", message: e?.message || String(e) };
  }
}
