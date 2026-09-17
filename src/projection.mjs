// memory-palace E 投影 —— 记忆正文与今日日志的独立注入通道。
//
// 背景（v1.6.3 及以前）：用户级 + 项目级 MEMORY.md 走 systemPrompt.section，受
// 「仅首次注入」限制（`alreadyInjected` 打了标记就不撕，只有 compaction 清），
// 导致记忆正文在 turn 1 的 step 2 之后就消失、全程不再进场。
//
// 现在：记忆正文改经 `agent/pre-step` 投影为**独立 user 消息**，常驻对话历史：
// - 每个 step 都可见（消息在历史里，不依赖注入时机）；
// - v1.7.1 起去重判据由「全文深比较」改为「**文件身份**」（首行 heading，含路径 + 日期）：
//   同一文件只注一次，内容再变也不重注 —— 记忆正文由 agent 自己写入，其内容本就在
//   上下文（tool/call 参数）里，重注纯属冗余；换文件（跨日期日志）才视为新身份注入；
// - v1.7.1 起**今日工作日志由 systemPrompt.section 迁入本通道**。日志是 agent 唯一
//   「不知道自己缺」的内容（hybrid 子代理以独立 LLM stream 写入、不回注主对话），
//   必须注入；迁出后 section 只剩恒定指令 → system prompt 恒定 → 前缀缓存永久有效
//   （此前日志在 section 里每步求值，一变就让序列最前的整段前缀作废）。
// - compaction 把消息移出 surface 后，身份判据即判为缺失 → 自动重注**磁盘最新版**，
//   顺带完成一次「刷新到最新」。
//
// 实现照抄宿主 `packages/context/agent-instructions/src/index.ts` 三件套（API 全公开、无第一方特权）：
// 1. `inject: ['sessionProjections']`（服务随 dsh-base 默认装载）
// 2. `ctx.on('agent/pre-step', async ({agent, messages, step, signal}, next) => {...})`
// 3. `createUserMessage()`（来自 @deepseek-ai/dsh-llm）
// 投递方式：同步版——折叠进 `decision.messages`（`toSpliced(lastClaimedIndex + 1, 0, ...pending)`），
// 不做异步 inbox 刷新（agent-instructions 注释明写异步投影有两个 commit 边界的时序约束，
// 本版刻意回避；记忆更新后下一步自然带上新内容）。
//
// 🔴 契约风险：pre-step 监听器抛错会让**整个 turn 失败**（宿主测试
// packages/acp/acp/tests/turns.spec.ts:150-156 锚定），故钩子内整体 try-catch，
// 任何异常降级为「本步不投影」并留一行 stderr 线索，绝不冒泡。详见 DEVELOPMENT.md §7.4。
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { expandHome, toHomeShort, todayISO, readMdSync, budgetClip, stripSmartTag, stripDeletedLines } from "./common/text.mjs";

// 投影消息的 source 标注。
// - kind: 'plugin' → 明确标注"插件注入"，供下游按 source 过滤（子 agent 去噪 / turnBuffer 采集）。
// - form: 'instructions' → 宿主 ContextForm 联合内的合法值（曾拟用 'memory'，但其不在该联合内，
//   属类型不合法；'instructions' 语义接近"指令性内容"且类型安全，UI 按指令样式呈现）。
const PROJECTION_SOURCE = Object.freeze({
  kind: "plugin",
  plugin: "dsh-memory-palace",
  form: "instructions",
});

// v1.7.1 判据：投影身份 = 消息首行 heading（已编码目标文件路径 + 日期）。
// 只比身份、不比正文 —— 同一文件投影过一次后，内容再变也不重注。
function projectionIdentity(msg) {
  const text = msg?.content?.[0]?.text ?? "";
  const i = text.indexOf("\n");
  return i === -1 ? text : text.slice(0, i);
}

// 只在双方都是本插件投影时才比身份 —— 规避真实用户消息与宿主注入消息
// （runtime context / skill 目录等）因首行文本巧合而误撞。
function isOwnProjection(msg) {
  return msg?.source?.kind === "plugin" && msg?.source?.plugin === "dsh-memory-palace";
}

function sameProjectionIdentity(left, right) {
  return isOwnProjection(left) && isOwnProjection(right)
    && projectionIdentity(left) === projectionIdentity(right);
}

// 扫描当前 surface，判断该身份是否已经作为本插件消息存在于会话历史中。
// 存在 → 不重复注入（"同一文件只注一次"靠它实现）。
// compaction 把消息移出 surface 后即判为缺失 → 自动重注磁盘最新版
// （身份不变、正文刷新，故无需 injectedSessionIds 之类的标记机制）。
function alreadyOnSurface(session, desired) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return false;
  for (const seq of nodes) {
    const event = typeof session.eventAt === "function" ? session.eventAt(seq) : undefined;
    if (event?.type === "user/message" && sameProjectionIdentity(event.data, desired)) return true;
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
 * 收集本步要投影的消息（用户级 / 项目级 MEMORY.md / 今日工作日志，各自独立一条）。
 * 拆成多条独立消息（v1.7.0 定案，v1.7.1 扩展）：否则"某一条内容一改，其余连带重发"。
 * @param {{ getConfig: () => object, paths: object }} deps
 * @returns {object[]} 按 [用户级, 项目级…, 今日日志…] 顺序的消息数组（可能为空）
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
  // 今日工作日志（v1.7.1 由 systemPrompt.section 迁入）。heading 沿用原 section 格式，
  // 天然含日期与目录 → 跨天 / 换目录自动成为新身份。预算沿用 workspaceBudgetChars，
  // 与项目级 MEMORY.md 各自独立 budgetClip，互不挤占。
  for (const dir of paths.readDirs()) {
    const text = readMdSync(join(dir, `${todayISO()}.md`));
    if (!text) continue;
    const clipped = stripSmartTag(stripDeletedLines(budgetClip(text, cfg.workspaceBudgetChars)));
    const msg = buildProjection(clipped, `# 今日工作日志 (${todayISO()} @ ${toHomeShort(dir)})`);
    if (msg) out.push(msg);
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
      // 逐条去重（按**文件身份**、非内容）：已被本步 messages 覆盖、或已在 surface 上的，跳过。
      const pending = desired.filter((msg) =>
        !messages.some((m) => sameProjectionIdentity(m, msg))
        && !decision.messages.some((m) => sameProjectionIdentity(m, msg))
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
