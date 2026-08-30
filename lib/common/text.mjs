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
// （实测出现过缺分隔符，如 ~/.deepseek-harness 被拼成 ~.deepseek-harness），一律喂给它 ~ 简写。
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

// v1.4.1 重写：修 LIFO/FIFO 错配（旧实现 slice(0, budget) 只留头部，而写入追加在尾部——
// 最新结论永远进不了注入视野，"写了等于没写"）。新策略：保留全部结构行（# / <!--）+
// 从尾部向前累积内容行至预算用尽，中间以截断标记衔接。budget <= 0 / 未配置视为不限。
export function budgetClip(text, budget) {
  if (!text || !budget || budget <= 0) return text;
  if (text.length <= budget) return text;
  const lines = text.split("\n");
  const head = [];
  let i = 0;
  // 头部连续结构行（文件标题/注释区）与空行无条件保留
  while (i < lines.length && (!lines[i].trim() || isStructural(lines[i].trim()))) {
    head.push(lines[i]);
    i++;
  }
  // 尾部向前累积内容行至预算用尽
  const tail = [];
  let used = 0;
  let j = lines.length - 1;
  while (j >= i && used < budget) {
    const cost = lines[j].length + 1;
    if (used + cost > budget && tail.length > 0) break;
    tail.unshift(lines[j]);
    used += cost;
    j--;
  }
  if (j < i) return head.join("\n") + (head.length ? "\n" : "") + tail.join("\n");
  const marker = `…（已截断，原 ${text.length} 字符，仅注入结构行与尾部最近条目）`;
  return [...head, marker, ...tail].join("\n");
}

// v1.4.1：剥除行首 `[smart]` 标记（含重复），保留列表符与其余内容。用于注入与回喂的读侧——
// 模型全程不可见该标签（写侧 v1.4.1 起不再拼接），存量磁盘条目自然消亡、无需迁移。
// 逐行处理：允许行首有 `N|` 计数前缀（readNumberedMemory 的回喂格式）与列表符，
// 只剥「列表符/行首之后紧跟的 [smart] 标记序列」；正文中间的 "smart" 字样不误伤。
export function stripSmartTag(text) {
  if (!text) return text;
  return text
    .split("\n")
    .map((line) =>
      line.replace(/^(\s*(?:\d+\|)?\s*[-*]\s+|\s*(?:\d+\|)\s*)?(\[smart\]\s*)+/, "$1"),
    )
    .join("\n");
}

// v1.6.0：注入侧删除线过滤——整行都是删除线墓碑（`~~...~~`，可带 `- ` 列表符）的条目
// 视为已作废，注入 system prompt 时剔除（省 token、防模型把墓碑当现行有效）；
// 行内局部删除线（`- 旧名 ~~原名~~` 之类）不是墓碑，不滤。文件本体保留墓碑供审计。
export function stripDeletedLines(text) {
  if (!text) return text;
  return text
    .split("\n")
    .filter((line) => !/^\s*(?:-\s+)?~~[\s\S]+~~\s*$/.test(line))
    .join("\n");
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
