// memory-palace 记忆文件路径解析（工厂）。
// 全部函数接受可选 cwd（缺省用运行时 activeCwd）——按钮蒸馏 route 按 session.header.cwd 显式传参，
// 避免依赖闭包 activeCwd 造成「会话 cwd ≠ 活跃 cwd」时写错位置（v1.2.0 修过的手动蒸馏 bug）。
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

/**
 * @param {() => object} getConfig - 读取当前生效配置（settings 热读）。
 * @param {() => string | null} [getCwd] - 默认 cwd 读取器（运行时 activeCwd）。
 */
export function createPaths(getConfig, getCwd = () => null) {
  const cfg = () => getConfig();
  const activeCwd = () => getCwd() || null;

  // 磁盘上【已存在】的 buddy 项目记忆目录（按配置顺序）。绝不主动新建 buddy 目录。
  function buddyDirs(cwd = activeCwd()) {
    const c = cfg();
    if (!c.enabled || !c.bridgeBuddyMemory || !cwd) return [];
    return c.buddyWorkspaceMemoryDirs
      .map((rel) => join(cwd, rel))
      .filter((d) => existsSync(d));
  }
  // 读取源：存在 buddy 目录则用它们；否则仅当 legacy dsh 目录已存在才读（不创建）。
  function readDirs(cwd = activeCwd()) {
    const c = cfg();
    if (!c.enabled) return [];
    const b = buddyDirs(cwd);
    if (b.length) return b;
    const d = cwd ? join(cwd, c.workspaceMemoryDir) : null;
    // 不设 existsSync 门槛：即便每日日志目录尚未创建，也要能读到同级的 .deepseek-harness/MEMORY.md
    return d ? [d] : [];
  }
  // 写入目标：存在 buddy 目录则全部同步写入；否则回退 dsh 目录（按需创建）。
  function writeDirs(cwd = activeCwd()) {
    const c = cfg();
    if (!c.enabled) return [];
    const b = buddyDirs(cwd);
    if (b.length) return b;
    const d = cwd ? join(cwd, c.workspaceMemoryDir) : null;
    return d ? [d] : [];
  }

  // 项目级 MEMORY.md 路径解析：
  // - dsh 原生目录（workspaceMemoryDir，默认 .deepseek-harness/memory）：MEMORY.md 与 memory/ 同级
  //   = join(cwd, dirname(workspaceMemoryDir), "MEMORY.md")，即 .deepseek-harness/MEMORY.md
  //   （读取兼容：旧嵌套位置 .deepseek-harness/memory/MEMORY.md 仍存在时不丢数据）
  // - buddy 目录（.workbuddy/memory 等）：保持嵌套 memory/MEMORY.md（与 WB/CB 原生格式兼容）
  function dshDailyDir(cwd = activeCwd()) {
    const c = cfg();
    return cwd ? join(cwd, c.workspaceMemoryDir) : null;
  }
  function dshMemoryFile(cwd = activeCwd()) {
    const c = cfg();
    return cwd ? join(cwd, dirname(c.workspaceMemoryDir), "MEMORY.md") : null;
  }
  function isDshDir(dir, cwd = activeCwd()) {
    const d = dshDailyDir(cwd);
    return !!(d && dir && dir === d);
  }
  // 写入用：返回该目录对应的 MEMORY.md 绝对路径（dsh 原生→同级；buddy→嵌套；已是文件则原样返回）
  function memoryFileOf(dir, cwd = activeCwd()) {
    if (!dir) return dir;
    if (dir.endsWith("MEMORY.md")) return dir; // 用户级路径本身即文件
    return isDshDir(dir, cwd) ? dshMemoryFile(cwd) : join(dir, "MEMORY.md");
  }
  // 读取用：dsh 原生返回 [同级, 旧嵌套] 两个候选；buddy 仅嵌套；已是文件则原样返回
  function memoryReadCandidates(dir, cwd = activeCwd()) {
    if (!dir) return [];
    if (dir.endsWith("MEMORY.md")) return [dir];
    if (isDshDir(dir, cwd)) {
      const f = dshMemoryFile(cwd);
      return f ? [f, join(dir, "MEMORY.md")] : [join(dir, "MEMORY.md")];
    }
    return [join(dir, "MEMORY.md")];
  }

  return { buddyDirs, readDirs, writeDirs, dshDailyDir, dshMemoryFile, isDshDir, memoryFileOf, memoryReadCandidates };
}
