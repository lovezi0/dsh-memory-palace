// memory-palace 蒸馏业务：项目记忆蒸馏（按钮「蒸馏项目记忆」）。
// 经 createDistill 工厂注入 ctx/config/paths；返回句柄供 index.mjs 装配与 api.mjs 调用。
// v1.8.1：原「蒸馏会话」链路（distillSessionCore）已随该功能整体移除；本文件只剩项目记忆蒸馏。
import { mkdir, unlink, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { DISTILL_PROMPT } from "./common/prompts.mjs";
import { readMdSync, toHomeShort, nowStamp } from "./common/text.mjs";
import { runWithRetry, RETRY_CONSTANTS } from "./common/retry.mjs";

/**
 * @param {{ ctx: object, getConfig: () => object, paths: object }} deps
 */
export function createDistill({ ctx, getConfig, paths, logger }) {
  const cfg = () => getConfig();

  // 日志（v1.8.0-alpha.4）：原 stderr 输出改为经统一 logger 落盘
  // （`<profileDir>/.memory-palace/logs/<sessionId>/{info,debug}.log`，见 common/logger.mjs）。
  // 按【会话】取作用域日志器——工厂级闭包会让并发会话的日志落到同一目录；logger 未注入时降级为 no-op。
  // dbgFail=失败/跳过留痕（warn 级 → info.log）；dbg=详单（debug 级 → debug.log）；
  // 两者统一受 distillDebugLog 门控：关闭时（默认）本插件零输出（既不写终端也不写文件）。
  // 隐私红线：只打计数/字符数/错误 message+stack 首行等元数据，绝不打印对话或 MEMORY.md 文本
  // （唯一例外：distillLogLevel=debug 时的 LLM 原始响应，经 raw() 显式落 debug.log）。
  const noop = () => {};
  const logFor = (session) => (typeof logger?.for === "function" ? logger.for(session?.id, "distill") : null);

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
    const log = logFor(session);
    const dbg = log ? log.dbg : noop;
    const dbgFail = log ? log.dbgFail : noop;
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

  // ---------- v1.2.0 项目记忆蒸馏（按钮「蒸馏项目记忆」） ----------
  // 流程：读主目标 MEMORY.md → DISTILL_PROMPT 蒸馏 → 写 memory-cover.md（同目录，保证 rename 原子）
  // → 完整性检查 → 备份 MEMORY.md.{时间戳} → rename 覆盖 → cover 随 rename 消失。
  async function distillProjectMemory(cwd, session) {
    const log = logFor(session);
    const dbg = log ? log.dbg : noop;
    const dbgFail = log ? log.dbgFail : noop;
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
      // 模型解析：summaryModel 注册表反查 > 会话 requestHeader。
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
                  source: { kind: "plugin:dsh-memory-palace" },
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
      // 本地调试（受 distillDebugLog + distillLogLevel==="debug" 双门控）：原始响应写入 debug.log。
      if (cfg().distillLogLevel === "debug") log?.raw(text);
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

  return { distillProjectMemory, distillLocks };
}
