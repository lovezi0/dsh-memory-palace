// memory-palace 蒸馏业务：会话蒸馏核心（自动智能模式 + 按钮「蒸馏会话」共用）+ 项目记忆蒸馏。
// 经 createDistill 工厂注入 ctx/config/paths/records/运行时状态；返回句柄供 index.mjs 装配与 api.mjs 调用。
import { mkdir, unlink, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SUMMARY_PROMPT, DISTILL_PROMPT } from "./common/prompts.mjs";
import { expandHome, readMdSync, toHomeShort, nowStamp } from "./common/text.mjs";
import { appendLineDedup } from "./common/records.mjs";

/**
 * @param {{ ctx: object, getConfig: () => object, paths: object, records: object, state: object }} deps
 */
export function createDistill({ ctx, getConfig, paths, records, state }) {
  const cfg = () => getConfig();

  // 调试日志（v1.3.0）：dbgFail=失败/跳过留痕（无条件输出，不受开关控制，保证排障可观测）；
  // dbg=受 distillDebugLog 开关控制的详单（模型解析/请求参数/流进度计数/错误详情）。
  // 隐私红线：只打计数/字符数/元数据/错误 message+stack 首行，绝不打印对话或 MEMORY.md 文本。
  const dbgFail = (why, extra) => console.error(`[memory-palace] distill skip: ${why}`, extra ? JSON.stringify(extra) : "");
  const dbg = (why, extra) => { if (!cfg().distillDebugLog) return; console.error(`[memory-palace][debug] ${why}`, extra !== undefined ? JSON.stringify(extra) : ""); };

  // 模型解析（v1.2.3 修复）：summaryModel 存的是注册表 models[].id 原样（client 下拉 value = m.id），
  // pi-ai getModel(provider, id) 按 model.id 全等匹配（pi-ai models.js: getModels(provider).find(m => m.id === id)），
  // 所以 model 参数必须【原样直传】summaryModel——绝不能 split 拆段。v1.2.2 之前拆段把
  // `nvidia/nemotron-3-ultra-550b-a55b` 变成裸 id `nemotron-3-ultra-550b-a55b`，全等匹配失败抛 UNKNOWN_MODEL。
  // provider 解析优先级：
  //   1) 注册表反查（最稳）：遍历 ctx.llm.listProviders()，对每个 provider 调 listModels，
  //      找 m.id === summaryModel 全等命中 → 返回 { provider: m.provider, model: m.id }。
  //      带前缀 id（nvidia/nemotron-3-ultra-550b-a55b）与裸 id（mimo-v2.5 属 xiaomi）都能一次命中。
  //   2) 首段兜底：listProviders 不可用（测试 mock 等）时，取 summaryModel 首段当 provider（openai/gpt-4o 格式）。
  // summaryModel 为空 → 会话 requestHeader config 兜底（复用当前会话 provider/model，原样直传）。
  async function findModelInRegistry(modelId) {
    try {
      const providers = typeof ctx.llm?.listProviders === "function" ? ctx.llm.listProviders() : [];
      for (const p of providers || []) {
        try {
          const models = await ctx.llm.listModels(p.id);
          const m = (models || []).find((x) => x.id === modelId);
          if (m) return { provider: m.provider, model: m.id };
        } catch { /* 该 provider 无模型列表或不可用，跳过 */ }
      }
    } catch { /* listProviders 不可用，跳过反查 */ }
    return null;
  }
  async function resolveModel(summaryModel, session) {
    const sm = (summaryModel || "").trim();
    if (sm) {
      const hit = await findModelInRegistry(sm);
      if (hit) { dbg("resolveModel: registry hit", { provider: hit.provider, model: hit.model }); return hit; }
      const provider = sm.split("/")[0].trim();
      if (provider && sm.includes("/")) { dbg("resolveModel: prefix fallback", { provider, model: sm }); return { provider, model: sm }; }
    }
    const conf = session?.requestHeader?.()?.config;
    if (conf && conf.provider && conf.model) { dbg("resolveModel: session fallback", { provider: conf.provider, model: conf.model }); return { provider: conf.provider, model: conf.model }; }
    dbgFail("resolveModel: no model resolved", { summaryModel: sm, hasHeader: !!(conf && conf.provider) });
    return null;
  }

  // 项目蒸馏乐观锁：按目标 MEMORY.md 绝对路径防并发重复蒸馏。
  const distillLocks = new Set();

  // 蒸馏核心（v1.2.0 抽取）：对指定 session 的 [fromSeq, ∞) surface 事件做 LLM 智能摘要并写盘。
  // 自动智能模式（summarizeTurn，增量断点）与按钮「蒸馏会话」（全量 fromSeq=0）共用本核心。
  // 返回 { ok, summary, durableCount }；失败 { ok:false }（调用方各自决定降级策略）。
  async function distillSessionCore(session, dirs, fromSeq) {
    if (!session) {
      dbgFail("no session");
      return { ok: false };
    }
    const c = cfg();
    // 1. 模型解析：summaryModel 注册表反查（带前缀/裸 id 均可）> 复用当前会话模型；皆缺 → 降级。
    const resolved = await resolveModel(c.summaryModel, session);
    if (!resolved) {
      dbgFail("no model", { summaryModel: c.summaryModel, header: JSON.stringify(session.requestHeader?.()?.config) });
      return { ok: false };
    }
    const { provider, model } = resolved;
    // 2. 输入：取 seq >= fromSeq 的 surface 事件，投影成模型视角 Message[]。
    const SURFACE = new Set(["user/message", "assistant/message", "tool/result"]);
    const newEvents = (session.events || []).filter(
      (e) => e.seq >= fromSeq && SURFACE.has(e.type),
    );
    dbg("session core entry", { sessionId: session.id, fromSeq, eventsLen: newEvents.length });
    const hist = [];
    for (const e of newEvents) {
      const m = session.deriveEventMessage ? session.deriveEventMessage(e) : null;
      if (m) hist.push(m);
    }
    if (!hist.length) {
      dbgFail("no events in range", { fromSeq, eventsLen: (session.events || []).length, newEvents: newEvents.length, hasDerive: !!session.deriveEventMessage });
      return { ok: false };
    }
    // 3. LLM 调用：借鉴 dsh-sideband 的 summarizeJob（src/summarizer.ts）——
    //    a) SUMMARY_PROMPT 放 system 参数（GenerateOptions.system），指令不占 user 消息、模型更遵守；
    //    b) AbortSignal.timeout 超时保护（默认 60s，Config.summaryTimeoutMs 可调），流循环内 throwIfAborted，
    //       杜绝「LLM 慢/挂起 → for await 无限等待」导致的摘要静默失败；
    //    c) finish.kind 细化：error/aborted → 失败降级（探针带 failure.message）；max-tokens → 尝试用已有文本
    //       （JSON.parse 失败自然回落全文/降级，不会产生坏数据）。
    const timeoutMs = c.summaryTimeoutMs || 60000;
    const signal = AbortSignal.timeout(timeoutMs);
    const t0 = Date.now();
    let gotFirstChunk = false, tFirstChunk = null, chunks = 0, deltaChars = 0;
    dbg("session request", { provider, model, messages: hist.length, maxTokens: 800, timeoutMs });
    const res = ctx.llm.stream({
      provider,
      model,
      system: SUMMARY_PROMPT,
      messages: hist,
      maxTokens: 800,
      signal,
    });
      const asm = new BlockAssembler();
      try {
        for await (const ch of res) {
          signal.throwIfAborted();
          chunks++;
          deltaChars += (ch.text?.length || 0);
          if (!gotFirstChunk) { gotFirstChunk = true; tFirstChunk = Date.now() - t0; dbg("session first chunk", { ms: tFirstChunk }); }
          asm.push(ch);
        }
    } catch (e) {
      dbgFail("stream aborted/timeout/error", { message: e?.message ?? "", aborted: signal.aborted, reason: signal.reason?.message ?? "" });
      return { ok: false };
    }
    const finish = asm.finish;
    dbg("session finish", { kind: finish?.kind });
    dbg("session stream done", { chunks, deltaChars, firstChunkMs: tFirstChunk });
    if (finish && (finish.kind === "error" || finish.kind === "aborted")) {
      dbgFail("llm finish", { kind: finish.kind, message: finish.failure?.message ?? "" });
      return { ok: false };
    }
    if (finish && finish.kind === "max-tokens") {
      console.error("[memory-palace] distill warn: llm finish max-tokens (attempting partial JSON)", JSON.stringify({}));
    }
    const text = asm
      .blocks()
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    if (!text) {
      dbgFail("empty llm text");
      return { ok: false };
    }
    // 4. 解析 JSON：{summary, durable:[{scope,fact}]}；解析失败回退全文当 summary。
    let summary = text;
    let durable = [];
    let jsonOk = false;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        jsonOk = true;
        if (typeof parsed.summary === "string") summary = parsed.summary;
        if (Array.isArray(parsed.durable)) durable = parsed.durable;
      }
    } catch {
      /* 非 JSON：全文当 summary */
    }
    // 5. 写盘：summary → 每日日志 [smart] 前缀；durable → MEMORY.md `- [smart] fact`（按 scope 分层，去重）。
    // v1.2.0 修复：手动蒸馏（按钮）时 dirs 按 session.header.cwd 解析，但 memoryFileOf 缺省用闭包
    // activeCwd——会话 cwd ≠ activeCwd 时 isDshDir 判假，durable 会落进旧嵌套 memory/MEMORY.md。
    // 此处显式传会话 cwd，使 dsh 目录正确解析到同级 MEMORY.md（自动模式 activeCwd 即会话 cwd，行为不变）。
    const sessCwd = session?.header?.cwd ?? undefined;
    for (const dir of dirs) {
      await records.appendDaily(dir, `\n[smart] ${summary}\n\n`);
    }
    for (const d of durable) {
      if (!d || typeof d !== "object") continue;
      const fact = String(d.fact ?? "").trim();
      if (!fact) continue;
      const line = `- [smart] ${fact}`;
      if (d.scope === "user") {
        await appendLineDedup(expandHome(c.userMemoryPath), line).catch(() => {});
      } else {
        for (const dir of dirs) {
          await appendLineDedup(paths.memoryFileOf(dir, sessCwd), line).catch(() => {});
        }
      }
    }
    dbg("session parsed", { jsonOk, summaryChars: summary.length, durableCount: durable.length });
    dbg("session write done", { dirs: dirs.length, durableWritten: durable.length });
    return { ok: true, summary, durableCount: durable.length };
  }

  // 智能模式核心：LLM 智能会话摘要（增量范围，产物带 [smart] 标记）。
  // 输入：capturedTurn（本轮缓冲，仅用于失败降级）、dirs（写盘目标）、isError。
  // 核心逻辑在 distillSessionCore；此处只负责增量断点（state.lastSummarizedSeq）的推进。
  // 失败返回 false 由调用方降级轻量条目；handler 永不 reject（调用方包 catch）。
  async function summarizeTurn(capturedTurn, dirs, isError) {
    if (!state.activeSession) return false;
    const r = await distillSessionCore(state.activeSession, dirs, state.lastSummarizedSeq);
    if (r.ok) state.lastSummarizedSeq = state.activeSession.seq;
    return r.ok;
  }

  // ---------- v1.2.0 项目记忆蒸馏（按钮「蒸馏项目记忆」） ----------
  // 流程：读主目标 MEMORY.md → DISTILL_PROMPT 蒸馏 → 写 memory-cover.md（同目录，保证 rename 原子）
  // → 完整性检查 → 备份 MEMORY.md.{时间戳} → rename 覆盖 → cover 随 rename 消失。
  async function distillProjectMemory(cwd, session) {
    const c = cfg();
    if (!c.enabled) return { ok: false, message: "memory-palace 已停用。" };
    const dirs = paths.writeDirs(cwd);
    if (!dirs.length) return { ok: false, message: "当前工作区没有可用的记忆目录。" };
    // 只蒸馏主目标（最高优先级 buddy 目录或 dsh 目录）；多 buddy 目录并存时不逐目录蒸馏。
    const primary = dirs[0];
    const memFile = paths.memoryFileOf(primary, cwd);
    if (!memFile) return { ok: false, message: "无法解析项目 MEMORY.md 路径。" };
    const memShort = toHomeShort(memFile);
    dbg("project entry", { cwd, memFile: toHomeShort(memFile) });

    const raw = readMdSync(memFile);
    if (!raw) return { ok: false, message: `项目记忆为空（${memShort}），无需蒸馏。` };
    dbg("project loaded", { memFile: toHomeShort(memFile), rawChars: raw.length });

    if (distillLocks.has(memFile)) return { ok: false, message: "蒸馏正在进行中，请稍候再试。" };
    distillLocks.add(memFile);
    try {
      const t0 = Date.now();
      let gotFirstChunk = false, tFirstChunk = null, chunks = 0, deltaChars = 0;
      let provider = null, model = null;
      // 模型解析：与 distillSessionCore 同序（summaryModel 注册表反查 > 会话 requestHeader）。
      const resolved = await resolveModel(c.summaryModel, session);
      if (!resolved) {
        return { ok: false, message: "无法确定蒸馏模型（summaryModel 未配置且会话无模型信息）。" };
      }
      ({ provider, model } = resolved);
      dbg("project request", { provider, model, inputChars: raw.length, maxTokens: 4000, timeoutMs: c.summaryTimeoutMs || 60000 });

      // LLM 蒸馏：system = 固化 DISTILL_PROMPT，user = MEMORY.md 全文。
      const timeoutMs = c.summaryTimeoutMs || 60000;
      const signal = AbortSignal.timeout(timeoutMs);
      const res = ctx.llm.stream({
        provider,
        model,
        system: DISTILL_PROMPT,
        messages: [
          createUserMessage({
            content: [{ type: "text", text: raw }],
            source: { kind: "plugin", plugin: "memory-palace" },
          }),
        ],
        maxTokens: 4000,
        signal,
      });
      const asm = new BlockAssembler();
      for await (const ch of res) {
        signal.throwIfAborted();
        chunks++;
        deltaChars += (ch.text?.length || 0);
        if (!gotFirstChunk) { gotFirstChunk = true; tFirstChunk = Date.now() - t0; dbg("project first chunk", { ms: tFirstChunk }); }
        asm.push(ch);
      }
      const finish = asm.finish;
      if (finish && (finish.kind === "error" || finish.kind === "aborted")) {
        const kindZh = finish.kind === "aborted" ? "被中断" : "出错";
        dbgFail("project finish failed", { kind: finish.kind, message: finish.failure?.message ?? "" });
        return { ok: false, message: `蒸馏${kindZh}（LLM ${finish.kind}）：${finish.failure?.message ?? ""}` };
      }
      dbg("project finish", { kind: finish?.kind });
      const text = asm
        .blocks()
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim();
      if (!text) { dbgFail("project empty result", { chunks, deltaChars }); return { ok: false, message: "蒸馏结果为空，未覆盖任何文件。" }; }

      // 写 cover（与 MEMORY.md 同目录，同文件系统保证 rename 原子）。
      const coverFile = join(dirname(memFile), "memory-cover.md");
      await mkdir(dirname(memFile), { recursive: true });
      await writeFile(coverFile, text, "utf8");
      // 完整性检查：回读非空才算写入完整；失败则删除 cover、原记忆不动。
      if (!readMdSync(coverFile)) {
        await unlink(coverFile).catch(() => {});
        return { ok: false, message: "memory-cover.md 未完整写入，本次蒸馏失败（原记忆未动）。" };
      }

      // 原子替换：备份 → 覆盖（两次 rename，同目录）；覆盖失败回滚备份。
      // 备份名用【本地时间戳】（nowStamp），与 todayISO 同源教训——toISOString 是 UTC 会差 8 小时。
      const backup = `${memFile}.${nowStamp()}`;
      await rename(memFile, backup);
      try {
        await rename(coverFile, memFile);
      } catch (e) {
        await rename(backup, memFile).catch(() => {});
        throw e;
      }
      dbg("project write done", { coverChars: text.length, backup: toHomeShort(backup) });
      return {
        ok: true,
        message: `蒸馏成功：${memShort} 已更新（原 ${raw.length} 字符 → ${text.length} 字符），备份 ${toHomeShort(backup)}。`,
      };
    } catch (e) {
      const elapsedS = Math.round((Date.now() - t0) / 1000);
      dbgFail("project distill timeout/error", { elapsed: Date.now() - t0, chunks, deltaChars, gotFirstChunk, message: e?.message ?? String(e), stack: (e?.stack || "").split("\n")[0] });
      let msg;
      if (gotFirstChunk) {
        msg = `蒸馏中途超时：模型「${model}」已在 ${tFirstChunk}ms 返回首个字符、累计 ${deltaChars} 字符，但在 ${elapsedS}s 内未结束（疑似输出中断或已被服务端截断）。`;
      } else {
        msg = `蒸馏超时：模型「${model}」在 ${elapsedS}s 内未返回任何内容，疑似未响应或限流。`;
      }
      return { ok: false, message: msg };
    } finally {
      distillLocks.delete(memFile);
    }
  }

  return { distillSessionCore, summarizeTurn, distillProjectMemory, distillLocks };
}
