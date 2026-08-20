// memory-palace 共享纯函数：日期/时间戳、路径简写、文本提取、预算截断、行归一化。
// 全部无状态、纯函数，可被任意模块与单测直接引用。

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// 本地日期（YYYY-MM-DD）。绝不能再用 toISOString()——它返回 UTC 日期，本地 0-8 点会
// 把记忆写到"昨天"的日志（真机实测：本地 2026-08-18 00:26 的条目写进了 2026-08-17.md）。
export const todayISO = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};

// 本地时间戳（YYYY-MM-DDTHH-mm-ss，`:` 换 `-` 兼容 Windows 文件名）。
// 同 todayISO 的教训：必须用本地时间，不能用 toISOString()（UTC 会差 8 小时）。
// 供项目记忆蒸馏备份文件名（MEMORY.md.{时间戳}）使用。
export const nowStamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

// 自己展开 ~，避免依赖 dsh-home-paths 的解析负担（homedir 即可）。
export function expandHome(p) {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(1));
  }
  return p;
}

// 反向简写：home 下的绝对路径 → ~ 简写（统一正斜杠）。AI 转述绝对路径极易拼错
// （实测出现过 lovezi0.deepseek-harness 缺分隔符），一律喂给它 ~ 简写。
export function toHomeShort(p) {
  if (!p) return p;
  const h = homedir();
  if (p === h) return "~";
  if (p.startsWith(h + "\\") || p.startsWith(h + "/")) {
    return "~" + p.slice(h.length).replace(/\\/g, "/");
  }
  return p;
}

// 读取 Markdown 文件（同步，systemPrompt section 要求同步）。
export function readMdSync(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

// v1.2.0 预算截断：注入 system prompt 时按字符上限截断（保留头部 + 截断标记）。
// budget <= 0 / 未配置视为不限。userBudgetChars / workspaceBudgetChars 在 text() 注入路径生效，
// 修复 v1.1.x 之前两配置为死配置的问题（与 README「注入系统提示词的长度上限」语义对齐）。
export function budgetClip(text, budget) {
  if (!text || !budget || budget <= 0) return text;
  if (text.length <= budget) return text;
  return text.slice(0, budget) + `\n…（已截断，原 ${text.length} 字符，仅注入前 ${budget} 字符）`;
}

// 行归一化：去掉 `- `/`* ` 前缀、合并空白、转小写，使"带不带前缀"的子串匹配都鲁棒。
export const normLine = (s) => s.replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim().toLowerCase();

// 结构行（标题 / 蒸馏注释）受保护，永不被删除。
export const isStructural = (t) => t.startsWith("#") || t.startsWith("<!--");

// 从单个 content block 抽取文本。兼容两类：
// - text block：顶层 {type:"text", text:"..."}（user/assistant 消息）
// - tool-result block：{type:"tool-result", content: ContentBlock[]}，文本嵌套在 content 内（真机 tool/result 即如此，
//   若只取 .text 会取空——这是此前「工具任务轮次不落记忆」的根因）
export function blockText(x) {
  if (typeof x === "string") return x;
  if (!x || typeof x !== "object") return "";
  if (typeof x.text === "string") {
    // 丢弃 harness 注入的运行时上下文快照块（真机 assistant/message 常以一个
    // "Current runtime context. This snapshot supersedes…" 开头的独立 text block 出现），
    // 避免把 DSH file policy 等系统噪声记进记忆。
    if (/^Current runtime context\./i.test(x.text)) return "";
    return x.text;
  }
  if (Array.isArray(x.content)) return x.content.map(blockText).join("");
  return "";
}

export function extractText(event) {
  try {
    const d = event?.data ?? {};
    // user/message 的 event.data 直接是 UserMessage（无外层包装）→ 走 d.content；
    // assistant/message、tool/result 的 event.data 带 {message: ...} → 走 d.message.content。
    const c = d.message?.content ?? d.content ?? d.text;
    let text;
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.map(blockText).join("");
    else if (c && typeof c === "object") text = JSON.stringify(c);
    else text = "";
    // 剥离 harness 注入的 <system-reminder>…</system-reminder> 系统块（实测 hello 轮次会抓到可用 skills 列表），
    // 避免把系统噪声记进记忆 / 误命中关键词。runtime-context 快照块在 blockText 层按块丢弃。
    return text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, "").trim();
  } catch {
    return "";
  }
}

// 从工具执行结果中识别错误。in-session 错误未必以 turn/end 的 reason.kind==='error' 暴露——
// 代码运行报错、工具执行失败常以 tool/result 形式呈现，agent 看到错误后正常收尾（reason.kind 为 completed），
// 故需单独扫描工具结果文本。命中即视为错误信号（受 autoCaptureErrors 门控）。
export function extractToolErrorText(turn) {
  for (const b of turn) {
    if (b.role !== "tool") continue;
    if (/code run failed|exception[:\s]|referenceerror|typeerror|syntaxerror|error:\s|traceback|执行失败|运行出错|运行报错/i.test(b.text)) {
      return b.text.slice(0, 300);
    }
  }
  return null;
}
