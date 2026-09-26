// plan 模式判定（按会话）—— 单一判定入口，供 section 注入 / 结算闸门 / 写工具 deny 共用。
//
// 宿主事实：plan 模式是**会话级**状态，不是应用级开关 ——
//   - 状态以事件 append 到单个会话：`session.append('plan/mode', { active })`
//     （packages/plan/plan-mode/src/index.ts:434、:450）
//   - plan-mode 插件自身也按 session 保存待提交意图与已记录状态：
//     `this.pendingIntents.set(session, …)` / `this.loggedActive(session)`（同文件 :425、:434）
//   - 状态由该会话的事件流折叠：`if (event.type === 'plan/mode') …`（同文件 :154）
//
// 故本插件不得用进程级全局承载它：A 会话进 plan 会波及 B 会话 —— B 的记忆不落盘、
// B 的 system prompt 被注入 plan 提示、B 的写工具被 deny（回归测试 tests/test-planmode-crosstalk.mjs）。
//
// 判定顺序：
//   ① 拿得到会话身份（session.id）→ **只看该会话的记录**：无记录 = 该会话从未进 plan = false。
//      🔴 此处**不得**回落到全局值——那等于用别的会话的 plan 状态来判定本会话，正是本次修的串台。
//   ② 拿不到会话身份（宿主某些调用形态的 exec 不带 agent.session，如 tools/pre-execute 的载荷）
//      → 回落全局 `state.planModeActive`（= 最近一次 plan/mode 事件的值；fail-safe：偏向拦写，
//      绝不会写错项目）。
//
// ⚠️ 写成**纯函数**而非 state 上的方法：多处单测用裸 mock state 构造
// `{ planModeActive: … }`（tests/test-session-cwd.mjs、tests/test-load.mjs），
// 若挂成 `state.isPlanMode()` 这些 mock 会直接 TypeError。纯函数 + 兜底读全局，两条路径都兼容。
export function planModeOf(state, session) {
  const sid = session?.id;
  if (sid) {
    const map = state?.planModeBySession;
    // 生产路径：有会话身份 + 有分桶表 → 只看该会话（无记录即 false，绝不看全局）。
    // 单测的裸 mock state 没有 planModeBySession → 落到下面的全局兜底，保持旧行为兼容。
    if (map && typeof map.get === "function") return !!map.get(sid);
  }
  return !!state?.planModeActive;
}
