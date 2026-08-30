// memory-palace v1.6.0 hybrid 模式：模块入口（装配）。
// 仅在 memoryMode === "hybrid" 时由 index.mjs 调用 registerHybrid（memoryMode 切换需重启
// dsh——注册时机安全）。不注册任何 DSH 全局资源以外的东西；runMemorySubagent 由 index.mjs
// 的 _settle hybrid 分支每轮调用。
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
