// memory-palace 记忆记录读写（去重追加 / 匹配删除 / 日志日期枚举）。
// 纯函数模块，无状态、可被任意模块与单测直接引用。
// v1.8.0：轻量条目（writeLightEntry）、错误捕获（captureError）与日志过期迁移（prune）
// 随 plugin 模式一并删除——日志由记忆子代理维护、永不过期不删，是证据层。
// v1.8.1：createRecords 工厂（唯一方法 appendDaily）与 readNumberedMemory / applyMemoryOp
// 随「蒸馏会话」功能一并移除——每日日志由记忆子代理维护，长期记忆由 agent 侧工具写入。
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { todayISO, normLine, isStructural } from "./text.mjs";

// 追加一行记忆，若目标文件已包含相同内容则跳过（去重），返回是否实际写入。
export async function appendLineDedup(file, line) {
  await mkdir(dirname(file), { recursive: true });
  let cur = "";
  try {
    cur = readFileSync(file, "utf8");
  } catch {
    /* 文件尚不存在 */
  }
  if (cur.includes(line)) return false;
  await writeFile(file, `${cur}\n${line}\n`, "utf8");
  return true;
}

// 在文件中按内容匹配查找记忆条目行（不修改文件）。返回每条匹配：{tier,path,content}。
export function findMatches(file, match, tier, pathShort) {
  const m = (match || "").trim();
  if (!m) return [];
  let cur = "";
  try {
    cur = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const nm = normLine(m);
  const out = [];
  for (const raw of cur.split("\n")) {
    const t = raw.trim();
    if (!t || isStructural(t)) continue;
    if (normLine(t).includes(nm)) out.push({ tier, path: pathShort, content: t });
  }
  return out;
}

// 按内容匹配删除 MEMORY.md / 每日日志中的条目行；保护结构行；返回删除条数与被删内容明细。
export async function removeLineByMatch(file, match) {
  const m = (match || "").trim();
  if (!m) return { removed: 0, ok: false, reason: "empty-match", lines: [] };
  let cur = "";
  try {
    cur = readFileSync(file, "utf8");
  } catch {
    return { removed: 0, ok: true, reason: "no-file", lines: [] };
  }
  const nm = normLine(m);
  const lines = cur.split("\n");
  const kept = [];
  let removed = 0;
  const removedLines = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      kept.push(line);
      continue;
    }
    if (isStructural(t)) {
      kept.push(line);
      continue;
    }
    if (normLine(t).includes(nm)) {
      removed++;
      removedLines.push(t);
      continue;
    }
    kept.push(line);
  }
  if (removed > 0) await writeFile(file, kept.join("\n"), "utf8");
  return { removed, ok: true, reason: "done", lines: removedLines };
}

// 读取目录下最近的非今日每日日志日期（最多 limit 份，降序）。供删除范围圈定。
export async function recentLogDates(dir, limit = 3) {
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const today = todayISO();
  return files
    .map((f) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f))
    .filter((mm) => mm && mm[1] < today)
    .map((mm) => mm[1])
    .sort()
    .reverse()
    .slice(0, limit);
}

