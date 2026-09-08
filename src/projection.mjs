// memory-palace v1.7.0 特性1：E 投影 —— 记忆正文的独立注入通道。
//
// 背景（v1.6.3 及以前）：用户级 + 项目级 MEMORY.md 走 systemPrompt.section，受
// 「仅首次注入」限制（`alreadyInjected` 打了标记就不撕，只有 compaction 清），
// 导致记忆正文在 turn 1 的 step 2 之后就消失、全程不再进场。
//
// 现在：两份 MEMORY.md 改经 `agent/pre-step` 投影为**独立 user 消息**，常驻对话历史：
// - 每个 step 都可见（消息在历史里，不依赖注入时机）；
// - 内容未变只写一次（进历史后后续 step 的 decision.messages 已含它 → 去重命中）；
// - compaction 把消息移出 surface 后，后续 step 找不到 → 自动重注（白送）。
//
// 实现照抄宿主 `packages/context/agent-instructions/src/index.ts` 三件套（API 全公开、无第一方特权）：
// 1. `inject: ['sessionProjections']`（服务随 dsh-base 默认装载）
// 2. `ctx.on('agent/pre-step', async ({agent, messages, step, signal}, next) => {...})`
// 3. `createUserMessage()`（来自 @deepseek-ai/dsh-llm）
// 投递方式：同步版——折叠进 `decision.messages`（`toSpliced(lastClaimedIndex + 1, 0, desired)`），
// 不做异步 inbox 刷新（agent-instructions 注释明写异步投影有两个 commit 边界的时序约束，
// 本版刻意回避；记忆更新后下一步自然带上新内容）。
//
// 🔴 契约风险：pre-step 监听器抛错会让**整个 turn 失败**（宿主测试
// packages/acp/acp/tests/turns.spec.ts:150-156 锚定），故钩子内整体 try-catch，
// 任何异常降级为「本步不投影」并留一行 stderr 线索，绝不冒泡。详见 DEVELOPMENT.md §7.4。
import { isDeepStrictEqual } from "node:util";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { expandHome, toHomeShort, readMdSync, budgetClip, stripSmartTag, stripDeletedLines } from "./common/text.mjs";

// 投影消息的 source 标注。
// - kind: 'plugin' → 明确标注"插件注入"，供下游按 source 过滤（子 agent 去噪 / turnBuffer 采集）。
// - form: 'instructions' → 宿主 ContextForm 联合内的合法值（曾拟用 'memory'，但其不在该联合内，
//   属类型不合法；'instructions' 语义接近"指令性内容"且类型安全，UI 按指令样式呈现）。
const PROJECTION_SOURCE = Object.freeze({
  kind: "plugin",
  plugin: "dsh-memory-palace",
  form: "instructions",
});

// 同一份内容是否已在这批消息里（逐字段深比较，照抄 agent-instructions 的 sameContextPayload）。
function sameContextPayload(left, right) {
  return isDeepStrictEqual(left.content, right.content)
    && isDeepStrictEqual(left.source, right.source);
}

// 扫描当前 surface，判断该 payload 是否已经作为本插件消息存在于会话历史中。
// 存在 → 不重复注入（"内容不变只写一次"靠它实现）。
function alreadyOnSurface(session, desired) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return false;
  for (const seq of nodes) {
    const event = typeof session.eventAt === "function" ? session.eventAt(seq) : undefined;
    if (event?.type === "user/message" && sameContextPayload(event.data, desired)) return true;
  }
  return false;
}

// 构造一条投影消息；内容为空（文件不存在 / 无记忆）时返回 null。
function buildProjection(text, heading) {
  if (!text) return null;
  return createUserMessage({
    content: [{ type: "text", text: `${heading}\n${text}` }],
    source: PROJECTION_SOURCE,
  });
}

/**
 * 收集本步要投影的记忆消息（用户级 + 项目级，各自独立一条）。
 * 两者拆成两条独立消息（v1.7.0 定案）：否则"项目记忆一改，用户记忆连带重发"。
 * @param {{ getConfig: () => object, paths: object }} deps
 * @returns {object[]} 按 [用户级, 项目级…] 顺序的消息数组（可能为空）
 */
export function buildProjections({ getConfig, paths }) {
  const cfg = getConfig();
  if (!cfg.enabled) return [];
  const out = [];
  // 用户级 MEMORY.md
  const userFile = expandHome(cfg.userMemoryPath);
  const userText = readMdSync(userFile);
  if (userText) {
    const clipped = stripSmartTag(stripDeletedLines(budgetClip(userText, cfg.userBudgetChars)));
    const msg = buildProjection(clipped, `# 用户级记忆 (${toHomeShort(userFile)})`);
    if (msg) out.push(msg);
  }
  // 项目级 MEMORY.md：按 readDirs 顺序（dsh 优先叠加 buddy），同一文件路径只取一次。
  const seen = new Set();
  for (const dir of paths.readDirs()) {
    for (const file of paths.memoryReadCandidates(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readMdSync(file);
      if (!text) continue;
      const clipped = stripSmartTag(stripDeletedLines(budgetClip(text, cfg.workspaceBudgetChars)));
      const msg = buildProjection(clipped, `# 项目级记忆 (${toHomeShort(file)})`);
      if (msg) out.push(msg);
    }
  }
  return out;
}

/**
 * 注册 E 投影钩子。
 * @param {{ ctx: object, getConfig: () => object, paths: object }} deps
 */
export function registerProjection({ ctx, getConfig, paths }) {
  ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
    // 先让瀑布流继续，拿到宿主与其他插件合成后的决策——投影要折叠进它的 messages。
    const decision = await next();
    try {
      signal?.throwIfAborted?.();
      if (decision.kind !== "enter") return decision;
      const session = agent?.session;
      const desired = buildProjections({ getConfig, paths });
      if (!desired.length) return decision;
      // 逐条去重：已被本步的 messages 覆盖、或已在 surface 上的，跳过。
      const pending = desired.filter((msg) =>
        !messages.some((m) => sameContextPayload(m, msg))
        && !decision.messages.some((m) => sameContextPayload(m, msg))
        && !alreadyOnSurface(session, msg));
      if (!pending.length) return decision;
      // 折叠位置：紧跟在"本步被认领的消息"之后，使直接提示在前、驱动追加的 runtime context 在后。
      // 照抄 agent-instructions：lastClaimedIndex 可能为 -1（本步无认领消息），此时插到最前。
      const lastClaimedIndex = decision.messages.findLastIndex((m) => messages.includes(m));
      const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, ...pending);
      return { ...decision, messages: entered };
    } catch (error) {
      // 🔴 绝不冒泡：pre-step 抛错会让整个 turn 失败（宿主契约，见文件头）。
      // 契约失效时表现为"记忆正文不注入"，这行 warn 是唯一排查线索。
      console.error(
        `[memory-palace] projection skipped (step ${step}): ${error?.message || String(error)}`,
      );
      return decision;
    }
  });
}
