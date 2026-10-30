// 用户自定义指令的唯一真源：<profileContext.dir>/.memory-palace/user-commands.md
//
// 旧版把自定义指令放在配置项 `customInstructions`（profile 的 cordis.patch.yml），
// 本模块【不读配置】——该字段已从 schema 摘除，存量值静默失效。
//
// 取径依据：profileContext.dir = $DSH_HOME/profiles/<profile>，由宿主 CLI 与 Desktop
// 经同一个 runProfile 提供（与 common/logger.mjs 的日志落点同根），故两端都可用。
// 拿不到 profileContext 时**绝不猜路径**：读取返回空串、写入抛错。
//
// 读路径是同步的（systemPrompt.section.text() 必须是同步函数，每步调用），
// 故按 mtimeMs 缓存：文件未变就复用上次内容，避免每步都读盘。
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** profile 私有目录名（与日志落点共用）。 */
export const USER_COMMANDS_DIR = ".memory-palace";
/** 自定义指令文件名。 */
export const USER_COMMANDS_FILE = "user-commands.md";

/** 去掉 BOM，其余原样保留（用户排版由用户决定）。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * @param {{ ctx: object }} deps
 * @returns {{ file: () => string | null, readSync: () => string, read: () => Promise<string>, write: (text: string) => Promise<{ path: string, text: string }> }}
 */
export function createUserCommands({ ctx }) {
  // file → 上次读到的内容；mtimeMs = -1 表示强制重读。
  let cache = { file: null, mtimeMs: -1, text: "" };

  function file() {
    const pc = typeof ctx?.get === "function" ? ctx.get("profileContext") : undefined;
    const dir = pc?.dir;
    return typeof dir === "string" && dir ? join(dir, USER_COMMANDS_DIR, USER_COMMANDS_FILE) : null;
  }

  // 同步读取（供 system prompt 每步调用）。任何异常都不外抛——section.text() 抛错会毁整轮对话。
  function readSync() {
    const target = file();
    if (!target) {
      cache = { file: null, mtimeMs: -1, text: "" };
      return "";
    }
    try {
      const info = statSync(target);
      if (cache.file === target && cache.mtimeMs === info.mtimeMs) return cache.text;
      const text = stripBom(readFileSync(target, "utf8"));
      cache = { file: target, mtimeMs: info.mtimeMs, text };
      return text;
    } catch {
      // 文件不存在 / 不可读：视为无自定义指令，并清掉旧缓存（防删除后仍注入）。
      cache = { file: target, mtimeMs: -1, text: "" };
      return "";
    }
  }

  async function read() {
    return readSync();
  }

  // 原子写：先写同目录临时文件再 rename，避免半截内容被注入。
  async function write(text) {
    const target = file();
    if (!target) {
      throw Object.assign(new Error("无法定位 user-commands.md：当前运行环境没有 profileContext.dir"), {
        code: "no-profile",
        status: 503,
      });
    }
    const body = stripBom(String(text ?? ""));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, target);
    // 强制下次 readSync 重新 stat（同毫秒写入时 mtime 可能未变）。
    cache = { file: target, mtimeMs: -1, text: body };
    return { path: target, text: body };
  }

  return { file, readSync, read, write };
}
