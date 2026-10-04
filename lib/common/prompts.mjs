// memory-palace 共享常量：会话命令「重整项目记忆」的内置提示词。
// 纯常量模块，无状态、可被任意模块与单测直接引用。
// SCENE_KEYWORDS（plugin 模式防闲聊闸门关键词）已随 plugin 模式删除。
// SUMMARY_PROMPT（手动「蒸馏会话」）与 DISTILL_PROMPT（手动「蒸馏项目记忆」）
// 均已随对应功能整体移除——项目记忆重整改由 /memory_reorganize 会话命令 + memory_reorganize 工具承担。
//
// 关于「为何不走 memory_read」：memory_read 的 scope 只能覆盖 today / yesterday / 近三天
// （见 tools.mjs 的 scope 分派），无法指定任意日期，不足以支撑「通盘重整」；故重整期间由
// index.mjs 给该会话戴上 deny memory_read 的工具掩码，改由 agent 用文件读取能力直接读
// 项目 MEMORY.md 与工作日志目录（可覆盖全部历史日期）。

// 命令消息前缀：index.mjs 据此把「本次命令注入的用户消息」与用户后续真实消息区分开
// （后者出现即视为重整流程结束，摘除掩码）。
export const REORG_MESSAGE_PREFIX = "【项目记忆重整任务】";

/**
 * 会话命令 /memory_reorganize 的内置提示（作为用户消息正文发送给模型）。
 * @param {{ budget?: number, memFile?: string, logDirs?: string[] }} opts
 * @returns {string}
 */
export function REORG_COMMAND_PROMPT({ budget, memFile, logDirs } = {}) {
  const dirs = Array.isArray(logDirs) ? logDirs.filter((d) => typeof d === "string" && d) : [];
  const budgetText = budget != null && Number.isFinite(Number(budget)) ? `${budget} 字符` : "工作区注入预算";
  return (
    REORG_MESSAGE_PREFIX + "\n" +
    "请对当前工作区的**项目级记忆**执行一次全量重整。\n" +
    "\n" +
    "【读取】memory_read 本次已被禁用，不要调用它；请用你可用的文件读取能力（若当前环境只能经代码执行读文件，就用它）直接读取：\n" +
    "1. 项目级 MEMORY.md：" + (memFile || "（路径见宿主工作区）") + "\n" +
    (dirs.length
      ? "2. 工作日志目录：" + dirs.join("  ／  ") + "——列出目录下的 `YYYY-MM-DD.md` 日志并按需读取（含历史日期，不要只看今天）。\n"
      : "") +
    "\n" +
    "【任务定义】基于现有 MEMORY.md 与**对应工作日期的日志**，做「两删一提一重构」：\n" +
    "1. 删过时条目（已失效 / 已被推翻）；\n" +
    "2. 删重复信息（同一事实散落多处）；\n" +
    "3. 冗余提炼（合并表述、压缩修饰，**但不丢精度**）；\n" +
    "4. 重构文件结构（章节归位、同类聚合、层级清晰）。\n" +
    "\n" +
    "【约束】\n" +
    "1. 保持 `## 章节` + `- 条目` 格式；**绝不丢失仍然有效的关键信息**（硬约束、明确禁止项、前提、决策及其理由、可复用入口、已验证的坑）。\n" +
    "2. 预算 " + budgetText + " 是**健康参考线**，尽量贴近即可——**严禁为达标删除仍有效的信息**。\n" +
    "3. **只依据**现有 MEMORY.md 与工作日志：**不得新增**原记忆中没有的章节或结论；日志只用于核对与补全遗漏的必要事实，**不得把已被推翻 / 已过时的历史结论重新引入**。\n" +
    "4. 条目形状：一条一事、结论先行、简明（需要展开就拆 `- 父项` + 缩进子项）；禁源码坐标（`文件:行号`）、禁一次性过程（报错全文 / 命令输出 / 临时 URL）。\n" +
    "5. 只操作**项目级** MEMORY.md；用户级 MEMORY.md 禁止改动。\n" +
    "\n" +
    "【落盘纪律】\n" +
    "1. **只允许落盘一次**（调用一次 memory_reorganize 工具）——草稿不会自动保存，**想清楚再写定**，不要在草稿层面反复推倒重来；**一次到位 = 质量最优**（多轮压缩是有损重编码，精度逐轮衰减）。\n" +
    "2. 写入**必须**调用 memory_reorganize 工具——它是唯一会整档备份原文件、并自动追加重整时间戳的路径。不要用 memory_write / memory_update_section 代替，也不要手写覆盖记忆文件。\n" +
    "3. 若 memory_reorganize 被门禁或确认拦截：**停止**，向用户如实报告最终结果（当前 N 字符 / 参考预算 M / 仍超出的原因 / 建议提高预算或由用户指定删除哪些条目）——**绝不**改用其它工具继续删改凑数。"
  );
}
