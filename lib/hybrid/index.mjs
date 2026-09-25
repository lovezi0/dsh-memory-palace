// memory-palace 记忆子代理模块：模块入口（装配）。
// v1.8.0：原 hybrid 模式已成唯一写入路径（plugin / smart 已删除），本模块由 index.mjs 无条件装配。
// 不注册任何 DSH 全局资源以外的东西；runMemorySubagent 由 index.mjs 的 _settle 每轮调用。
import { runMemorySubagent } from "./subagent.mjs";
import { registerHybridTools, attachHybridGuards } from "./tools.mjs";

export { HYBRID_PROACTIVE } from "./prompts.mjs";

/**
 * @param {{ ctx: object, getConfig: () => object, paths: object, records: object, state: object }} deps
 * @returns {{ runMemorySubagent: Function }}
 */
export function registerHybrid({ ctx, getConfig, paths, records, state }) {
  registerHybridTools({ ctx, getConfig, paths, records, state });
  attachHybridGuards(ctx, getConfig, paths, state);
  return { runMemorySubagent };
}
