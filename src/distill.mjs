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

  // 模型解析（v1.2.3 修复）：summaryModel 存的是注册表 models[].id 原样（client 下拉 value = m.id），
  // pi-ai getModel(provider, id) 按 model.id 全等匹配（pi-ai models.js: getModels(provider).find(m => m.id === id)），
  // 所以 model 参数必须【原样直传】summaryModel——绝不能 split 拆段。v1.2.2 之前拆段把
  // `nvidia/nemotron-3-ultra-550b-a55b` 变成裸 id `nemotron-3-ultra-550b-a55b`，全等匹配失败抛 UNKNOWN_MODEL。
  // provider 取 summaryModel 首段（带前缀 id 的 route key，如 nvidia/nemotron-3-ultra-550b-a55b → nvidia）。
  // summaryModel 为空 → 会话 requestHeader config 兜底（复用当前会话 provider/model，原样直传）。
  // 边界：裸 id 格式（如 GLM-4.7-Flash，无 provider 前缀）首段取不到正确 provider → 需要
  // ctx.llm.listProviders() 反查注册表；当前配置（nvidia 带前缀 / zai 裸 id）用首段即可，裸 id 场景暂不处理。
  function resolveModel(summaryModel, session) {
    const sm = (summaryModel || "").trim();
    if (sm) {
      const provider = sm.split("/")[0].trim();
      if (provider) return { provider, model: sm };
    }
    const conf = session?.requestHeader?.()?.config;
    if (conf && conf.provider && conf.model) return { provider: conf.provider, model: conf.model };
    return null;
  }

  // 项目蒸馏乐观锁：按目标 MEMORY.md 绝对路径防并发重复蒸馏。
  const distillLocks = new Set();

  // 蒸馏核心（v1.2.0 抽取）：对指定 session 的 [fromSeq, ∞) surface 事件做 LLM 智能摘要并写盘。
  // 自动智能模式（summarizeTurn，增量断点）与按钮「蒸馏会话」（全量 fromSeq=0）共用本核心。
  // 返回 { ok, summary, durableCount }；失败 { ok:false }（调用方各自决定降级策略）。
  async function distillSessionCore(session, dirs, fromSeq) {
    const dbg = (why, extra) => console.error(`[memory-palace] distill skip: ${why}`, extra ?? "");
    if (!session) {
      dbg("no session");
      return { ok: false };
    }
    const c = cfg();
    // 1. 模型解析：summaryModel 原样直传（注册表 id）> 复用当前会话模型；皆缺 → 降级。
    const resolved = resolveModel(c.summaryModel, session);
    if (!resolved) {
      dbg("no model", { summaryModel: c.summaryModel, header: JSON.stringify(session.requestHeader?.()?.config) });
      return { ok: false };
    }
    const { provider, model } = resolved;
    // 2. 输入：取 seq >= fromSeq 的 surface 事件，投影成模型视角 Message[]。
    const SURFACE = new Set(["user/message", "assistant/message", "tool/result"]);
    const newEvents = (session.events || []).filter(
      (e) => e.seq >= fromSeq && SURFACE.has(e.type),
    );
    const hist = [];
    for (const e of newEvents) {
      const m = session.deriveEventMessage ? session.deriveEventMessage(e) : null;
      if (m) hist.push(m);
    }
    if (!hist.length) {
      dbg("no events in range", { fromSeq, eventsLen: (session.events || []).length, newEvents: newEvents.length, hasDerive: !!session.deriveEventMessage });
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
        asm.push(ch);
      }
    } catch (e) {
      dbg("stream aborted/timeout/error", { message: e?.message ?? "", aborted: signal.aborted, reason: signal.reason?.message ?? "" });
      return { ok: false };
    }
    const finish = asm.finish;
    if (finish && (finish.kind === "error" || finish.kind === "aborted")) {
      dbg("llm finish", { kind: finish.kind, message: finish.failure?.message ?? "" });
      return { ok: false };
    }
    if (finish && finish.kind === "max-tokens") {
      dbg("llm finish max-tokens (attempting partial JSON)", {});
    }
    const text = asm
      .blocks()
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    if (!text) {
      dbg("empty llm text");
      return { ok: false };
    }
    // 4. 解析 JSON：{summary, durable:[{scope,fact}]}；解析失败回退全文当 summary。
    let summary = text;
    let durable = [];
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
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

    const raw = readMdSync(memFile);
    if (!raw) return { ok: false, message: `项目记忆为空（${memShort}），无需蒸馏。` };

    if (distillLocks.has(memFile)) return { ok: false, message: "蒸馏正在进行中，请稍候再试。" };
    distillLocks.add(memFile);
    try {
      // 模型解析：与 distillSessionCore 同序（summaryModel 原样直传 > 会话 requestHeader）。
      const resolved = resolveModel(c.summaryModel, session);
      if (!resolved) {
        return { ok: false, message: "无法确定蒸馏模型（summaryModel 未配置且会话无模型信息）。" };
      }
      const { provider, model } = resolved;

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
        asm.push(ch);
      }
      const finish = asm.finish;
      if (finish && (finish.kind === "error" || finish.kind === "aborted")) {
        return { ok: false, message: `蒸馏失败（LLM ${finish.kind}）：${finish.failure?.message ?? ""}` };
      }
      const text = asm
        .blocks()
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim();
      if (!text) return { ok: false, message: "蒸馏结果为空，未覆盖任何文件。" };

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
      return {
        ok: true,
        message: `蒸馏成功：${memShort} 已更新（原 ${raw.length} 字符 → ${text.length} 字符），备份 ${toHomeShort(backup)}。`,
      };
    } catch (e) {
      return { ok: false, message: `蒸馏失败：${e?.message || String(e)}` };
    } finally {
      distillLocks.delete(memFile);
    }
  }

  return { distillSessionCore, summarizeTurn, distillProjectMemory, distillLocks };
}
