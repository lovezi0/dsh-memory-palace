# 提示词与智能模式蒸馏说明（PROMPTS）

> **说明文档，非真源。** 本插件所有提示词的真源在 `src/`：
> - 系统提示词注入：`src/index.mjs`（`text()` 闭包）
> - 摘要 / 蒸馏 / 关键词：`src/common/prompts.mjs`
> - 失败重试：`src/common/retry.mjs`
>
> 改提示词请改源码，**本文件仅作人工可读索引与维护参照**，需与源码同步更新。
> 适用版本：v1.4.0。

---

## 一、按用途分类总览

| 用途 | 名称 | 真源位置 | 注入 / 调用时机 |
|---|---|---|---|
| 系统提示词注入 | 记忆公民指令 / 记忆自动维护说明 | `src/index.mjs` `text()` | 每轮 system prompt 拼接注入 |
| 路径简写硬约束 | `antiMangle` | `src/index.mjs` | 随 system prompt 注入（始终） |
| plan 模式禁写提示 | `planNote` | `src/index.mjs` | 仅 plan 模式激活时追加 |
| 触发闸门关键词 | `SCENE_KEYWORDS` | `src/common/prompts.mjs` | 结算闸门判定（纯文本轮次触发写） |
| 智能模式摘要 | `SUMMARY_PROMPT(allowDelete)` | `src/common/prompts.mjs` | 智能模式每轮结束 `summarizeTurn` |
| 项目记忆蒸馏 | `DISTILL_PROMPT` | `src/common/prompts.mjs` | 手动「蒸馏项目记忆」按钮 |

---

## 二、系统提示词注入（记忆公民指令 / 记忆说明）

真源：`src/index.mjs` 的 `systemPrompt.section.text()` 闭包。返回内容由「基础说明 + 路径简写 + 模式分支指令 + plan 提示」拼接。

### 2.1 基础说明（两种形态，按是否桥接 buddy 目录切换）
- **已桥接**（`paths.buddyDirs().length > 0`）：告知 agent 当前项目存在 WorkBuddy/CodeBuddy 记忆目录，本插件直接读写这些目录，不再单独创建 `.deepseek-harness/memory/`。
- **未桥接**：告知记忆位于 `~/.deepseek-harness/MEMORY.md` 及项目 `.deepseek-harness/MEMORY.md`（长期）+ `.deepseek-harness/memory/`（每日日志）。
- 两版均强调：写入用 `memory_note`（项目级）/ `memory_note_user`（用户级），读取用 `memory_read`（**禁止手动 glob/read 记忆文件**）。

### 2.2 路径简写硬约束 `antiMangle`
> 提及记忆文件路径时一律用 `~` 简写（如 `~/.deepseek-harness/MEMORY.md`），不要逐字拼写绝对路径——你转述绝对路径容易漏掉目录分隔符。

真机踩坑：AI 转述绝对路径曾出现 `lovezi0.deepseek-harness` 缺分隔符，故强制喂 `~` 简写。

### 2.3 模式分支指令 `proactive`（按 `memoryMode` 切换）
| 模式 | 注入文案 | 意图 |
|---|---|---|
| `smart` | 「你的跨 session 记忆由 LLM 智能摘要自动维护（每轮结束自动提炼摘要并沉淀 durable 事实到 MEMORY.md），无需主动调用 memory_note / memory_note_user；读取全部记忆用 memory_read」 | 关掉主动记，交给摘要链路 |
| `plugin` | 「记忆公民指令」：列举 5 类**必须**主动落档场景（①完成任务/产出结果 ②修复 bug/根因 ③验证 build/test/CI ④里程碑/决策/约定 ⑤用户偏好约束），判定标准「下个 session 的我还需要吗」，格式「一句话结论 + 关键细节」 | 引导 agent 主动记 |

关键约束：无论模式，`text()` 必须**始终**返回非空（即便无记忆也要注入指令），否则 agent 不知记忆系统存在 → 永不记 → 死循环。

### 2.4 plan 模式禁写提示 `planNote`
仅 `state.planModeActive` 时追加：「当前处于 plan 模式，不要调用 memory_note / memory_note_user 写入记忆，也不要请求删除记忆（读取用 memory_read）。」属于软提示，网关物理兜底仍生效。

---

## 三、关联：触发闸门关键词 `SCENE_KEYWORDS`

真源：`src/common/prompts.mjs`。非 prompt 文本，但是摘要/兜底写门控的纯文本触发信号。

```js
export const SCENE_KEYWORDS = ["记住", "记一下", "remind", "偏好", "决定", "以后都", "约定", "采用", "根因", "修复"];
```

用途：用户文本命中任一关键词即视为「告知偏好 / 做出技术决策」，即便无工具调用也打开结算闸门（增强原方案 D：纯文本轮次也写）。与「结构信号（工具/错误/主动记）」构成 A+D 合并闸门。

---

## 四、智能模式摘要 Prompt `SUMMARY_PROMPT`

真源：`src/common/prompts.mjs`。**v1.4.0 起为函数**，支持回喂存量记忆。

### 4.1 用途与触发
智能模式（`memoryMode === "smart"`）每轮结束 `summarizeTurn` 调用，让 LLM 把「新产生的对话」提炼为结构化摘要 + 跨 session durable 事实 + 可选记忆增量维护。

### 4.2 函数签名
```js
SUMMARY_PROMPT({ allowDelete = false, outputBudget } = {})
```
- `allowDelete = true`：**手动蒸馏按钮**场景，开放 `add` / `replace` / `delete` 三类记忆维护指令。
- `allowDelete = false`：**自动智能模式**场景，仅开放 `add` / `replace`，**禁止 delete**（避免误删记忆）。
- `outputBudget`（v1.4.1 新增）：最终输出软预算 token 数（取自 `summaryMaxTokens`，默认 2000）。注入 prompt 的【输出长度约束】：最终 JSON 控制在约 `outputBudget` token（≈`outputBudget*1.8` 字）内；**思考/推理不受限**，但成稿须精炼不超预算。该值仅作为 prompt 软约束，**不**传给 harness API、更不乘倍——API 层已不传 `maxTokens`，思考+输出合计靠模型自身原生帽兜底。

> 注意：回喂是否实际发生由 `distill.mjs` 按 `cfg().feedbackEnabled` 决定（智能模式级，自动/手动均生效）；本 prompt 仅声明能力边界——`allowDelete` 决定 prompt 是否允许 delete 指令。

### 4.3 输出契约（LLM 返回 JSON）
```json
{
  "summary": "一段客观第三人称中文摘要（做了什么/关键结果）",
  "durable": [{ "scope": "project|user", "fact": "一句话客观事实" }],
  "memoryOps": [
    { "op": "add", "scope": "project", "fact": "..." },
    { "op": "replace", "line": 12, "oldText": "精确原文", "newText": "替换后全文" },
    { "op": "delete", "line": 7, "oldText": "精确原文" }
  ]
}
```
- `durable` 最多 3 条；`scope`：`project`=项目约定/决策，`user`=跨项目个人偏好。闲聊/一次性/错误现象不提炼。
- `memoryOps` 的 `replace`/`delete` 必须带 `oldText` 精确匹配（匹配失败被拒、不改任何内容）；结构行（`#` / `<!--`）受保护，禁删。

### 4.4 输出风格硬约束（v1.4.0 防污染）
- summary 必须**客观、第三人称、陈述性**；**严禁**提问/提议/请示/寒暄/自我指涉/内心独白/对话体——在写记忆，不在对话。
- durable 每条必须**可独立成立的客观事实**；严禁把「助手说过的话/未确认提议」当事实。
- 仅含未决提问无结论 → summary 写「本次对话为未决讨论，暂无确定结论」，durable 留空，绝不照抄对话体。

---

## 五、项目记忆蒸馏 Prompt `DISTILL_PROMPT`

真源：`src/common/prompts.mjs`。固化自 `upgrade plan/v1.2.0/记忆蒸馏Prompt.md`。

### 5.1 用途与触发
手动「蒸馏项目记忆」按钮调用：system = 本 prompt（函数式，注入 `outputBudget`），user = 项目 `MEMORY.md` 全文，输出 = 精炼后的项目记忆，**直接覆盖写回**（手动蒸馏开放 delete，`allowDelete:true`）。

> **v1.4.1 起为函数**：`DISTILL_PROMPT({ outputBudget } = {})`。`outputBudget` 取自 `projectMaxTokens`（默认 8000），注入【输出长度约束】：提炼后的项目记忆控制在约 `outputBudget` token（≈`outputBudget*1.8` 字）内；思考不受限，成稿须精炼不超预算。该值仅 prompt 软约束，**不**传给 API（API 层不传 maxTokens，靠模型原生帽兜底）。

### 5.2 提炼总原则
只留「以后还会用到」，删「一次性过程」；判断标准：删了这条下次开会会不会出错/返工/重踩坑？会→留，不会→删。

### 5.3 常见归档维度（v1.4.1 起：参考，非强制；可按材料实际内容增删维度）
1. 定位 —— 任务本质 + 最终产出
2. 当前状态 —— 推进到哪、卡哪、下一步
3. 核心约束 —— 绝对不能变（丢了会出事才叫约束）
4. AI 行为边界 —— 谁能做/绝不做/留给用户；若设置该章节，「谁授权/谁拍板」约定集中于此
5. 关键路径 —— 绝对路径/命令/数据源/模板/依赖（原样精确保留，禁占位符）
6. 决策记录 —— 为什么这么做，带日期/版本锚点；废弃方案标「已废弃」不删
7. 坑与教训 —— 现象→根因→解法，一条一坑

### 5.4 写法规则与输出骨架
- 结论先行、强动词（必须/绝不/勿/除非…明确同意）、精确值（路径版本原样）、时间锚点。
- 骨架章节（**参考**，可按内容增删/合并/改名，以契合为先，无关章节不硬凑）：`# <项目名> 项目笔记` + 核心约束 + AI 行为边界 + 关键路径 + 决策记录 + 坑与教训。
- 输出前自检 6 条（一次性过程/约束删否/边界无歧义/路径精确/坑三要素/**条目归在最契合章节、不为凑骨架错位归类**）。

---

## 六、文档维护说明

- 本文件只收录**提示词与提示词常量**（系统提示词注入 / 闸门关键词 / 摘要 prompt / 蒸馏 prompt）。
- **智能模式蒸馏失败重试**属蒸馏行为机制，非提示词，说明在 `DEVELOPMENT.md`「智能模式蒸馏 —— 失败重试」（真源 `src/common/retry.mjs`）。
- 改提示词请改源码（`src/index.mjs` 系统提示词闭包 / `src/common/prompts.mjs`），本文件同步更新。
