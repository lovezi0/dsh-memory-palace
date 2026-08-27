// memory-palace 蒸馏业务：会话蒸馏核心（自动智能模式 + 按钮「蒸馏会话」共用）+ 项目记忆蒸馏。
// 经 createDistill 工厂注入 ctx/config/paths/records/运行时状态；返回句柄供 index.mjs 装配与 api.mjs 调用。
import { mkdir, unlink, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SUMMARY_PROMPT, DISTILL_PROMPT } from "./common/prompts.mjs";
import { expandHome, readMdSync, toHomeShort, nowStamp } from "./common/text.mjs";
import { appendLineDedup, readNumberedMemory, applyMemoryOp } from "./common/records.mjs";
import { runWithRetry, RETRY_CONSTANTS } from "./common/retry.mjs";

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

  // 单次 LLM 流尝试（供 runWithRetry 调用）：每次【新建独立 AbortSignal】，避免单次超时耗尽累计预算。
  // 返回 { finish, text, chunks, deltaChars, gotFirstChunk, tFirstChunk, elapsed }；流中抛错（网络/超时/中断）原样向上抛，
  // 由 runWithRetry 分类决定是否重试。finish.kind 为 error/aborted 时不抛（让 runWithRetry 据此决定重试/降级）。
  async function streamOnce(params, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    const t0 = Date.now();
    let gotFirstChunk = false, tFirstChunk = null, chunks = 0, deltaChars = 0;
    const res = ctx.llm.stream({ ...params, signal });
    const asm = new BlockAssembler();
    try {
      for await (const ch of res) {
        signal.throwIfAborted();
        chunks++;
        deltaChars += (ch.text?.length || 0);
        if (!gotFirstChunk) { gotFirstChunk = true; tFirstChunk = Date.now() - t0; }
        asm.push(ch);
      }
    } catch (e) {
      // 流中抛错（网络/超时/中断）：原样抛出供 runWithRetry 分类重试或失败。
      throw e;
    }
    const finish = asm.finish;
    const text = asm
      .blocks()
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    return { finish, text, chunks, deltaChars, gotFirstChunk, tFirstChunk, elapsed: Date.now() - t0 };
  }

  // 蒸馏核心（v1.2.0 抽取）：对指定 session 的 [fromSeq, ∞) surface 事件做 LLM 智能摘要并写盘。
  // 自动智能模式（summarizeTurn，增量断点）与按钮「蒸馏会话」（全量 fromSeq=0）共用本核心。
  // 返回 { ok, summary, durableCount }；失败 { ok:false }（调用方各自决定降级策略）。
  async function distillSessionCore(session, dirs, fromSeq, opts) {
    const allowDelete = !!(opts && opts.allowDelete);
    // 回喂存量记忆（v1.4.0 特性3）：智能模式级能力——feedbackEnabled 开启即在【自动智能模式（turn/end）
    // 与手动蒸馏按钮】两条链路都回喂项目级 + 用户级 MEMORY.md 全文（逐行编号、无截断）。
    // delete 仍仅手动蒸馏（allowDelete=true）开放；自动模式 memoryOps 中的 delete 在 §5.5 被 !allowDelete 跳过。
    // 回喂目标严格限定为 MEMORY.md；每日日志（.deepseek-harness/memory/YYYY-MM-DD.md）不读取、不改写、不删旧行。
    const useFeedback = !!cfg().feedbackEnabled;
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
    // 2.5 回喂存量记忆（v1.4.0 特性3）：仅当 useFeedback 时，读取项目级 + 用户级 MEMORY.md 全文
    // （逐行编号、无截断）作为上下文前置消息，让 LLM 基于既有记忆做 add/replace/delete 增量维护。
    let messages = hist;
    const feedbackFiles = { project: null, user: null };
    if (useFeedback) {
      const sessCwd = session?.header?.cwd ?? undefined;
      const projectMem = paths.memoryFileOf(dirs[0], sessCwd);
      const userMem = expandHome(cfg().userMemoryPath);
      // 始终记录目标文件路径（即使文件尚不存在），便于后续 add 操作创建文件。
      feedbackFiles.project = projectMem;
      feedbackFiles.user = userMem;
      let fbText = "";
      if (projectMem) {
        const pm = readNumberedMemory(projectMem);
        if (pm.text) fbText += "【项目级记忆（逐行编号，行号从 1 开始）】\n" + pm.text + "\n";
      }
      if (userMem) {
        const um = readNumberedMemory(userMem);
        if (um.text) fbText += "【用户级记忆（逐行编号，行号从 1 开始）】\n" + um.text + "\n";
      }
      if (fbText) {
        messages = [
          createUserMessage({
            content: [{ type: "text", text: "以下是现有记忆（仅供你增量维护参考，不要当作本次对话内容）：\n" + fbText }],
            source: { kind: "plugin", plugin: "memory-palace" },
          }),
          ...hist,
        ];
      }
      dbg("session feedback", { hasProject: !!feedbackFiles.project, hasUser: !!feedbackFiles.user });
    }
    // 3. LLM 调用：借鉴 dsh-sideband 的 summarizeJob（src/summarizer.ts）——
    //    a) SUMMARY_PROMPT 放 system 参数（GenerateOptions.system），指令不占 user 消息、模型更遵守；
    //    b) AbortSignal.timeout 超时保护（默认 60s，Config.summaryTimeoutMs 可调），流循环内 throwIfAborted，
    //       杜绝「LLM 慢/挂起 → for await 无限等待」导致的摘要静默失败；
    //    c) finish.kind 细化：error/aborted → 失败降级（探针带 failure.message）；max-tokens → 尝试用已有文本
    //       （解析失败时抽取 {...} JSON 块兜底，仍失败则 summary 置空、记极简占位，绝不把 LLM 自由文本当 summary 落盘）。
    const timeoutMs = c.summaryTimeoutMs || 60000;
    const t0 = Date.now();
    dbg("session request", { provider, model, messages: messages.length, maxTokens: "(model native cap)", timeoutMs, maxRetries: RETRY_CONSTANTS.MAX_RETRIES });
    let result;
    try {
      result = await runWithRetry(
        () => streamOnce({ provider, model, system: SUMMARY_PROMPT({ allowDelete, outputBudget: c.summaryMaxTokens }), messages }, timeoutMs),
        {
          maxRetries: RETRY_CONSTANTS.MAX_RETRIES,
          onAttempt: ({ attempt, maxRetries }) => dbg("session attempt", { attempt, maxRetries }),
        },
      );
    } catch (e) {
      const cls = e?.cls || { kind: "fatal", message: String(e?.message ?? e) };
      dbgFail("session distill exhausted", { kind: cls.kind, status: cls.status ?? "", attempts: e?.attempts });
      return { ok: false };
    }
    const { finish, text, chunks, deltaChars, tFirstChunk } = result;
    dbg("session finish", { kind: finish?.kind, attempts: result.attempts });
    dbg("session stream done", { chunks, deltaChars, firstChunkMs: tFirstChunk });
    // 本地调试（受 distillDebugLog + distillLogLevel==="debug" 双门控）：把 LLM 原始响应 text 原样打到 stderr，
    // 并用分隔符整段包裹，便于从 stderr 一眼框住起止、不与其它 dbg 行混淆。
    if (cfg().distillDebugLog && cfg().distillLogLevel === "debug") {
      console.error("[memory-palace][debug] session llm raw text begin >>>");
      console.error("--------------------------->");
      console.error(text);
      console.error("<----------------------------");
      console.error("[memory-palace][debug] session llm raw text end <<<");
    }
    if (finish && finish.kind === "max-tokens") {
      console.error("[memory-palace] distill warn: llm finish max-tokens (attempting partial JSON)", JSON.stringify({}));
    }
    if (!text) {
      dbgFail("empty llm text");
      return { ok: false };
    }
    // 4. 解析 JSON：{summary, durable:[{scope,fact}], memoryOps:[...]}。
    // 防污染（v1.4.0 修复）：解析失败【绝不】退化成"全文当 summary"——否则对话原文 / 助手独白 / 向用户的请示
    // 会被整段灌进每日日志。先尝试从自由文本抽取最后一个 {...} JSON 块再解析；仍失败则 summary 留空。
    let summary = "";
    let durable = [];
    let memoryOps = [];
    let jsonOk = false;
    const tryParseJson = (s) => {
      try {
        const o = JSON.parse(s);
        return o && typeof o === "object" ? o : null;
      } catch { return null; }
    };
    let parsed = tryParseJson(text);
    if (!parsed) {
      const block = text.match(/\{[\s\S]*\}/);
      if (block) parsed = tryParseJson(block[0]);
    }
    if (parsed) {
      jsonOk = true;
      if (typeof parsed.summary === "string") summary = parsed.summary;
      if (Array.isArray(parsed.durable)) durable = parsed.durable;
      if (Array.isArray(parsed.memoryOps)) memoryOps = parsed.memoryOps;
    }
    // 5. 写盘：summary → 每日日志 [smart] 前缀；durable → MEMORY.md `- [smart] fact`（按 scope 分层，去重）。
    // v1.2.0 修复：手动蒸馏（按钮）时 dirs 按 session.header.cwd 解析，但 memoryFileOf 缺省用闭包
    // activeCwd——会话 cwd ≠ activeCwd 时 isDshDir 判假，durable 会落进旧嵌套 memory/MEMORY.md。
    // 此处显式传会话 cwd，使 dsh 目录正确解析到同级 MEMORY.md（自动模式 activeCwd 即会话 cwd，行为不变）。
    const sessCwd = session?.header?.cwd ?? undefined;
    for (const dir of dirs) {
      // summary 为空（解析失败/未产出）→ 记极简占位，绝不把 LLM 自由文本当 summary 落盘（v1.4.0 防污染）。
      const dailyLine = summary
        ? `\n[smart] ${summary}\n\n`
        : "\n[smart] 本段会话已蒸馏，但 LLM 未返回可解析的结构化摘要，已跳过原文落盘以避免污染记忆。\n\n";
      await records.appendDaily(dir, dailyLine);
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
    // 5.5 应用 memoryOps（v1.4.0 特性3 增量维护）：useFeedback 时由 LLM 产出（自动/手动皆可能）。
    // add → 追加到对应 MEMORY.md（file 由 scope 决定，可能即时创建）；replace/delete → applyMemoryOp
    // （写前重读 + normLine 精确匹配 + 结构行保护，防止 stale 行号误改/误删）。
    // 自动模式（allowDelete=false）prompt 同步禁用 delete，且下方 delete op 经 !allowDelete 跳过；
    // 自动模式仅允许 add/replace 增量维护，delete 仅手动蒸馏按钮开放。
    let opApplied = 0, opSkipped = 0;
    for (const op of memoryOps) {
      if (!op || typeof op !== "object") continue;
      const scope = op.scope === "user" ? "user" : "project";
      const file = scope === "user" ? feedbackFiles.user : feedbackFiles.project;
      if (!file) { opSkipped++; continue; }
      if (op.op === "delete" && !allowDelete) { opSkipped++; continue; }
      const r = await applyMemoryOp(file, op).catch(() => ({ ok: false, reason: "exception" }));
      if (r && r.ok && r.changed) opApplied++;
      else if (r && !r.ok) dbgFail("memoryOp rejected", { op: op.op, reason: r.reason, line: r.line });
    }
    dbg("session memoryOps", { total: memoryOps.length, applied: opApplied, skipped: opSkipped });
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
      let provider = null, model = null;
      // 模型解析：与 distillSessionCore 同序（summaryModel 注册表反查 > 会话 requestHeader）。
      const resolved = await resolveModel(c.summaryModel, session);
      if (!resolved) {
        return { ok: false, message: "无法确定蒸馏模型（summaryModel 未配置且会话无模型信息）。" };
      }
      ({ provider, model } = resolved);
      dbg("project request", { provider, model, inputChars: raw.length, maxTokens: "(model native cap)", timeoutMs: c.summaryTimeoutMs || 60000 });

      // LLM 蒸馏：system = 固化 DISTILL_PROMPT，user = MEMORY.md 全文。带失败重试（runWithRetry）。
      const timeoutMs = c.summaryTimeoutMs || 60000;
      let result;
      try {
        result = await runWithRetry(
          () => streamOnce(
            {
              provider,
              model,
              system: DISTILL_PROMPT({ outputBudget: c.projectMaxTokens }),
              messages: [
                createUserMessage({
                  content: [{ type: "text", text: raw }],
                  source: { kind: "plugin", plugin: "memory-palace" },
                }),
              ],
            },
            timeoutMs,
          ),
          {
            maxRetries: RETRY_CONSTANTS.MAX_RETRIES,
            onAttempt: ({ attempt, maxRetries }) => dbg("project attempt", { attempt, maxRetries }),
          },
        );
      } catch (e) {
        const cls = e?.cls || { kind: "fatal", message: String(e?.message ?? e) };
        dbgFail("project distill exhausted", { kind: cls.kind, status: cls.status ?? "", attempts: e?.attempts });
        const kindZh = cls.kind === "fatal" ? "失败" : "限流/超时";
        return { ok: false, message: `蒸馏${kindZh}（重试 ${e?.attempts || 0} 次后仍失败）：${cls.message || ""}` };
      }
      const { finish, text, chunks, deltaChars, gotFirstChunk, tFirstChunk } = result;
      // 本地调试（受 distillDebugLog + distillLogLevel==="debug" 双门控，与会话蒸馏路径一致）：分隔符包裹整段原始响应。
      if (cfg().distillDebugLog && cfg().distillLogLevel === "debug") {
        console.error("[memory-palace][debug] project llm raw text begin >>>");
        console.error("--------------------------->");
        console.error(text);
        console.error("<----------------------------");
        console.error("[memory-palace][debug] project llm raw text end <<<");
      }
      if (finish && finish.kind === "max-tokens") {
        dbg("project finish", { kind: "max-tokens", attempts: result.attempts });
      } else {
        dbg("project finish", { kind: finish?.kind, attempts: result.attempts });
      }
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
      dbgFail("project distill timeout/error", { elapsed: Date.now() - t0, message: e?.message ?? String(e), stack: (e?.stack || "").split("\n")[0] });
      const msg = `蒸馏失败：模型「${model || "?"}」在 ${elapsedS}s 内未成功完成（写入/覆盖阶段异常：${e?.message ?? String(e)}）。`;
      return { ok: false, message: msg };
    } finally {
      distillLocks.delete(memFile);
    }
  }

  return { distillSessionCore, summarizeTurn, distillProjectMemory, distillLocks };
}
