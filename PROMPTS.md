# 提示词与智能模式蒸馏说明（PROMPTS）

> **说明文档，非真源。** 本插件所有提示词的真源在 `src/`：
> - 系统提示词注入：`src/index.mjs`（`text()` 闭包）
> - 记忆投影（非提示词，但决定模型可见内容）：`src/projection.mjs`
> - 摘要 / 蒸馏 / 关键词：`src/common/prompts.mjs`
> - hybrid 模式提示词：`src/hybrid/prompts.mjs`（`HYBRID_PROACTIVE` / `SUBAGENT_SYSTEM`）
> - 失败重试：`src/common/retry.mjs`
>
> 改提示词请改源码，**本文件仅作人工可读索引与维护参照**，需与源码同步更新。
> 适用版本：见 package.json。

---

## 一、按用途分类总览

| 用途 | 名称 | 真源位置 | 注入 / 调用时机 |
|---|---|---|---|
| 系统提示词注入 | 记忆公民指令 / 记忆自动维护说明 / 混合模式分工说明 | `src/index.mjs` `text()` | 每轮 system prompt 拼接注入 |
| 今日日志块 | `# 今日工作日志 (...)` | `src/index.mjs` `text()` | 每轮 system prompt 拼接注入（唯一随 section 注入的记忆内容） |
| **记忆正文投影** | **用户级/项目级 MEMORY.md** | **`src/projection.mjs`** | **每 step 经 `agent/pre-step` 注入为常驻 user 消息（不在 section 内）** |
| 路径简写硬约束 | `antiMangle` | `src/index.mjs` | 随 system prompt 注入（始终） |
| plan 模式禁写提示 | `planNote` | `src/index.mjs` | 仅 plan 模式激活时追加 |
| 触发闸门关键词 | `SCENE_KEYWORDS` | `src/common/prompts.mjs` | 结算闸门判定（纯文本轮次触发写） |
| 智能模式摘要 | `SUMMARY_PROMPT(allowDelete)` | `src/common/prompts.mjs` | 智能模式每轮结束 `summarizeTurn` |
| 项目记忆蒸馏 | `DISTILL_PROMPT` | `src/common/prompts.mjs` | 手动「蒸馏项目记忆」按钮 |
| **混合模式分工说明（段二）** | **`HYBRID_PROACTIVE`** | **`src/hybrid/prompts.mjs`** | **hybrid 模式下每轮 system prompt 段二（随 `text()` 注入）** |
| **记忆子代理 system prompt** | **`SUBAGENT_SYSTEM()`** | **`src/hybrid/prompts.mjs`** | **hybrid 模式每轮 turn/end 触发 `runMemorySubagent`** |

---

## 二、系统提示词注入（记忆公民指令 / 记忆说明）

真源：`src/index.mjs` 的 `systemPrompt.section.text()` 闭包。返回内容由「基础说明 + 路径简写 + 模式分支指令 + plan 提示 + 今日日志块」拼接。

> **section 不含记忆正文。** 用户级/项目级 `MEMORY.md` 经 E 投影（`src/projection.mjs`）注入为常驻 user 消息（每个 step 可见），见 §2.5。section 只含「常量指令（intro）+ 今日工作日志」。分流依据是变化频率：MEMORY.md 低频 durable → 投影；今日日志高频易变 → 留 section 每步注入（不进历史以免膨胀）。

### 2.1 基础说明（两种形态，按是否桥接 buddy 目录切换）
- **已桥接**（`paths.buddyDirs().length > 0`）：告知 agent 当前项目存在 WorkBuddy/CodeBuddy 记忆目录，本插件直接读写这些目录，不再单独创建 `.deepseek-harness/memory/`。
- **未桥接**：告知记忆位于 `~/.deepseek-harness/MEMORY.md` 及项目 `.deepseek-harness/MEMORY.md`（长期）+ `.deepseek-harness/memory/`（每日日志）。
- 两版均强调：写入用 `memory_note`（项目级）/ `memory_note_user`（用户级），读取用 `memory_read`（**禁止手动 glob/read 记忆文件**）。

### 2.2 路径简写硬约束 `antiMangle`
> 提及记忆文件路径时一律用 `~` 简写（如 `~/.deepseek-harness/MEMORY.md`），不要逐字拼写绝对路径——你转述绝对路径容易漏掉目录分隔符。

真机踩坑：AI 转述绝对路径易出现缺分隔符（如 `~/.deepseek-harness` 被拼成 `~.deepseek-harness`），故强制喂 `~` 简写。

### 2.3 模式分支指令 `proactive`（按 `memoryMode` 切换）
| 模式 | 注入文案 | 意图 |
|---|---|---|
| `smart` | 「你的跨 session 记忆由 LLM 智能摘要自动维护（每轮结束自动提炼摘要并沉淀 durable 事实到 MEMORY.md），无需主动调用 memory_note / memory_note_user；读取全部记忆用 memory_read」 | 关掉主动记，交给摘要链路 |
| `plugin` | 「记忆公民指令」：列举 5 类**必须**主动落档场景（①完成任务/产出结果 ②修复 bug/根因 ③验证 build/test/CI ④里程碑/决策/约定 ⑤用户偏好约束），判定标准「下个 session 的我还需要吗」，格式「一句话结论 + 关键细节」 | 引导 agent 主动记 |
| `hybrid` | 「记忆分工说明」`HYBRID_PROACTIVE`：①日志由子代理每轮自动维护（含去重标删），agent 无需记录过程；②MEMORY.md 由 agent 主动调 `memory_write` 维护（章节化）；③项目级仅双门禁满足时可 `memory_reorganize` 全量重整，否则只能 `memory_update_section` 章节级修正；④用户级禁止重整 | 日志/长期记忆职责分离，agent 主写 MEMORY.md |

关键约束：无论模式，`text()` 必须**始终**返回非空（即便无记忆也要注入指令），否则 agent 不知记忆系统存在 → 永不记 → 死循环。

### 2.4 plan 模式禁写提示 `planNote`
仅 `state.planModeActive` 时追加：「当前处于 plan 模式，不要调用 memory_note / memory_note_user 写入记忆，也不要请求删除记忆（读取用 memory_read）。」属于软提示，网关物理兜底仍生效。

### 2.5 记忆正文投影（非 prompt，但决定模型可见内容）

真源：`src/projection.mjs`。用户级与项目级 `MEMORY.md` 经 `agent/pre-step` 投影为**两条独立的常驻 user 消息**：

- **内容形态**：`# 用户级记忆 (<~ 简写路径>)\n<正文>` / `# 项目级记忆 (<~ 简写路径>)\n<正文>`；正文经 `budgetClip` 按 `userBudgetChars` / `workspaceBudgetChars` 截断，并剥 `[smart]` 标签与删除线墓碑。
- **source 标注**：`{ kind: 'plugin', plugin: 'dsh-memory-palace', form: 'instructions' }`（`form` 必须是宿主 `ContextForm` 联合内的合法值）。
- **拆两条消息**的原因：否则「项目记忆一改，用户记忆连带重发」。
- **去重与重注**：内容不变只写一次；上下文压缩把消息移出 surface 后，后续 step 自动重注。
- **指令优先级说明**：投影是 user 角色，强约束建议放 harness 的 `AGENTS.md`（system 优先级），`MEMORY.md` 只放动态事实。

---

## 三、关联：触发闸门关键词 `SCENE_KEYWORDS`

真源：`src/common/prompts.mjs`。非 prompt 文本，但是摘要/兜底写门控的纯文本触发信号。

```js
export const SCENE_KEYWORDS = ["记住", "记一下", "remind", "偏好", "决定", "以后都", "约定", "采用", "根因", "修复"];
```

用途：用户文本命中任一关键词即视为「告知偏好 / 做出技术决策」，即便无工具调用也打开结算闸门（增强原方案 D：纯文本轮次也写）。与「结构信号（工具/错误/主动记）」构成 A+D 合并闸门。

---

## 四、智能模式摘要 Prompt `SUMMARY_PROMPT`

真源：`src/common/prompts.mjs`。函数式，支持回喂存量记忆。

### 4.1 用途与触发
智能模式（`memoryMode === "smart"`）每轮结束 `summarizeTurn` 调用，让 LLM 把「新产生的对话」提炼为结构化摘要 + 跨 session durable 事实 + 可选记忆增量维护。

### 4.2 函数签名
```js
SUMMARY_PROMPT({ allowDelete = false, outputBudget } = {})
```
- `allowDelete = true`：**手动蒸馏按钮**场景，开放 `add` / `replace` / `delete` 三类记忆维护指令。
- `allowDelete = false`：**自动智能模式**场景，仅开放 `add` / `replace`，**禁止 delete**（避免误删记忆）。
- `outputBudget`：最终输出软预算 token 数（取自 `summaryMaxTokens`，默认 2000）。注入 prompt 的【输出长度约束】：最终 JSON 控制在约 `outputBudget` token（≈`outputBudget*1.8` 字）内；**思考/推理不受限**，但成稿须精炼不超预算。该值仅作为 prompt 软约束，**不**传给 harness API、更不乘倍——API 层已不传 `maxTokens`，思考+输出合计靠模型自身原生帽兜底。

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

### 4.4 输出风格硬约束（防污染）
- summary 必须**客观、第三人称、陈述性**；**严禁**提问/提议/请示/寒暄/自我指涉/内心独白/对话体——在写记忆，不在对话。
- durable 每条必须**可独立成立的客观事实**；严禁把「助手说过的话/未确认提议」当事实。
- 仅含未决提问无结论 → summary 写「本次对话为未决讨论，暂无确定结论」，durable 留空，绝不照抄对话体。

---

## 四·五、混合模式提示词

真源：`src/hybrid/prompts.mjs`。

### 4.5.1 分工说明 `HYBRID_PROACTIVE`（注入段二）

hybrid 模式下注入 system prompt 的「段二」，替代 smart 的「无需主动调用」与 plugin 的「记忆公民指令」。四点分工：
1. 日志由子代理每轮自动维护（含去重：重复/过时条目删除线标记），agent 无需重复记录过程性信息；
2. MEMORY.md（项目/用户）由 agent 主动调 `memory_write` 追加（章节化），过时内容用 `memory_update_section` 整章节替换或标删；
3. 项目级 MEMORY.md 仅「超出注入预算 且 距上次重整 ≥ 冷却期」双条件同时满足才可 `memory_reorganize` 全量重整，重整前先读日志对照、勿丢关键信息；
4. 用户级 MEMORY.md 禁止全量重整。

### 4.5.2 记忆子代理 system prompt `SUBAGENT_SYSTEM()`

hybrid 模式每轮 turn/end 触发 `runMemorySubagent`（`src/hybrid/subagent.mjs`），子代理执行「判定 + 产出一体」：
- **判定**：本轮是否有实质内容（完成任务/修 bug/决策/结论/用户偏好）。无重点 → 纯文本收尾（1 次调用，仍推进断点）；有重点 → 工具循环写入日志（2-5 次调用）。
- **工具白名单**（仅循环内，非 DSH 全局）：
  - `log_read_section(sections[])`：**一次读取多个章节**（合并返回，未找到的章节注明）——日志回喂超 `subagentLogBudget` 仅给章节目录时按需拉取；prompt 强制要求多章节在单次调用中传齐，避免多轮往返；
  - `log_write_ops(ops[])`：批量提交 `{op:"new_section"|"append"|"mark_delete", section, entry?, oldText?}`。
- **日志 ops 规则**（prompt 明文）：
  - 只能通过 `log_write_ops` 写，禁止重写整文件；三种 op：新增章节 / 章节内追加（upsert，不强行匹配现有章节）/ 标记删除（删除线墓碑，非物理删除）；
  - 去重是子代理职责：回喂日志中已存在的结论禁止重复追加，语义重复/矛盾用 `mark_delete` 标记过时条目；
  - 条目格式：一行一条、结论开头 + 关键细节、客观第三人称、禁止标签与对话体。
- **格式规范段（7 正 + 3 反）**——旧产物是「一堵墙」（单章节 + 零嵌套 + 零加粗 + 200 字长句），故把格式细则写进 prompt：
  - 正面：①文件头由插件维护、子代理不写；②一主题一 `##` 章节、同主题超 3 条再拆 `###`；③一条一事实 ≤120 字，超长拆父项 + 两空格缩进子项（**缩进必须模型自己写**，`upsertSectionText` 只原样保留中间换行与缩进）；④关键结论/决策/纠错 `**加粗**`、重要约束标 `（重要）`；⑤行内分组 `**结论**：` / `**待办**：` / `**约束**：` / `**产出**：` / `**用户约定**：`；⑥允许一句「用户意图/反馈」作语境，禁止流水账；⑦可复现命令/脚本用代码块。
  - 反模式：过程流水（"用户提出…我已改…"）、自我过程表述（"我搜索了 A/B/C"）、把多个结论塞进 200 字长句。
- **失败语义**：超 6 轮 / 超时 `summaryTimeoutMs` / 模型不支持 tools → **本轮放弃、不降级 `writeLightEntry`**（无格式原文会破坏日志章节化结构）；断点不推进，下一次 turn/end 子代理自动补蒸。
- **环境边界段**：本环境不是代码执行环境，`run_code` 等工具均不存在；子代理只能调用 `log_write_ops` / `log_read_section`，不得模仿上文出现过的任何工具调用。
- **输入去噪**（非 prompt 但影响子代理可见内容）：`projectTurnMessages` 按 `source.kind` 排除注入类消息（`agent-instructions` / `plugin` / `skill-catalog` 等），只喂真实用户对话 + assistant/tool 消息。实测单轮输入 6967 → 3849 字符（−44.8%）。

### 4.5.3 注入侧删除线过滤

注入 system prompt 前用 `stripDeletedLines`（`src/common/text.mjs`）剔除**整行**删除线墓碑（`~~...~~`，可带 `- ` 列表符）——文件保留墓碑供审计，注入侧过滤防模型把已作废条目当现行有效；行内局部删除线（`- 旧名 ~~原名~~`）不滤。

### 4.5.4 日志文件头规范

子代理**不写文件头**（prompt 明文），由 `ensureLogHeader`（`src/common/sections.mjs`）在 `applyLogOps` 落盘前补齐 `# YYYY-MM-DD`：空文件写入标题；首行空或直接以 `##` 开头则补标题；已有同日标题原样返回（幂等）。仅在写入时补齐，历史文件不回填。

---

## 五、项目记忆蒸馏 Prompt `DISTILL_PROMPT`

真源：`src/common/prompts.mjs`。

### 5.1 用途与触发
手动「蒸馏项目记忆」按钮调用：system = 本 prompt（函数式，注入 `outputBudget`），user = 项目 `MEMORY.md` 全文，输出 = 精炼后的项目记忆，**直接覆盖写回**（手动蒸馏开放 delete，`allowDelete:true`）。

`DISTILL_PROMPT({ outputBudget } = {})`。`outputBudget` 取自 `projectMaxTokens`（默认 8000），注入【输出长度约束】：提炼后的项目记忆控制在约 `outputBudget` token（≈`outputBudget*1.8` 字）内；思考不受限，成稿须精炼不超预算。该值仅 prompt 软约束，**不**传给 API（API 层不传 maxTokens，靠模型原生帽兜底）。

### 5.2 提炼总原则
只留「以后还会用到」，删「一次性过程」；判断标准：删了这条下次开会会不会出错/返工/重踩坑？会→留，不会→删。

### 5.3 常见归档维度（参考，非强制；可按材料实际内容增删维度）
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

- 本文件只收录**提示词与提示词常量**（系统提示词注入 / 闸门关键词 / 摘要 prompt / 蒸馏 prompt），另收录「记忆正文投影」与「日志文件头规范」——它们不是提示词，但直接决定模型可见内容，故在此登记。
- **智能模式蒸馏失败重试**属蒸馏行为机制，非提示词，说明在 `DEVELOPMENT.md`「智能模式蒸馏 —— 失败重试」（真源 `src/common/retry.mjs`）。
- **投影通道的契约风险与降级**见 `DEVELOPMENT.md`「记忆注入通道」§7.4。
- 改提示词请改源码（`src/index.mjs` 系统提示词闭包 / `src/common/prompts.mjs` / `src/hybrid/prompts.mjs`），本文件同步更新。
