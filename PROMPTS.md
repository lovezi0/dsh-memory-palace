# 提示词与蒸馏说明（PROMPTS）

> **说明文档，非真源。** 本插件所有提示词的真源在 `src/`：
> - 系统提示词注入：`src/index.mjs`（`text()` 闭包）
> - 记忆投影（非提示词，但决定模型可见内容）：`src/projection.mjs`
> - 会话命令 `/memory_reorganize` 内置提示：`src/common/prompts.mjs`
> - 记忆分工 / 子代理提示词：`src/hybrid/prompts.mjs`（`HYBRID_PROACTIVE` / `SUBAGENT_SYSTEM`）
>
> 改提示词请改源码，**本文件仅作人工可读索引与维护参照**，需与源码同步更新。
> 适用版本：见 package.json。

---

## 一、按用途分类总览

| 用途 | 名称 | 真源位置 | 注入 / 调用时机 |
|---|---|---|---|
| 系统提示词注入 | 总述 + `[记忆文件]` + `[读取]` + `[边界]` | `src/index.mjs` `text()` | 每轮 system prompt 拼接注入 |
| **记忆正文投影** | **用户级/项目级 MEMORY.md + 今日日志** | **`src/projection.mjs`** | **每 step 经 `agent/pre-step` 注入为常驻 user 消息（不在 section 内）** |
| 路径简写硬约束 | `antiMangle` | `src/index.mjs` | 随 system prompt 注入（始终） |
| plan 模式禁写提示 | `planNote` | `src/index.mjs` | 仅 plan 模式激活时追加 |
| 会话命令 `/memory_reorganize`（中文别名 `/记忆重整`）内置提示 | `REORG_COMMAND_PROMPT` | `src/common/prompts.mjs` | 用户手打命令；handler 经 `agent.steer` 作为用户消息发送 |
| **写入分工（段三）** | **`HYBRID_PROACTIVE`** | **`src/hybrid/prompts.mjs`** | **每轮 system prompt（随 `text()` 注入）** |
| **记忆子代理 system prompt** | **`SUBAGENT_SYSTEM()`** | **`src/hybrid/prompts.mjs`** | **每轮 turn/end 触发 `runMemorySubagent`** |

> v1.8.0：`SCENE_KEYWORDS`（防闲聊闸门关键词）与 `smart` 模式的自动摘要入口 `summarizeTurn` 已随模式一并删除。
> v1.8.1：`SUMMARY_PROMPT`（会话蒸馏）与 `DISTILL_PROMPT`（项目蒸馏）均已随对应功能整体移除，
> 项目记忆重整改由 `REORG_COMMAND_PROMPT`（会话命令）驱动。

---

## 二、系统提示词注入（基础说明 + 记忆分工）

真源：`src/index.mjs` 的 `systemPrompt.section.text()` 闭包。返回内容为五个块按序以空行拼接：**总述 → `[记忆文件]` → `[读取]` → `[写入分工]`（`HYBRID_PROACTIVE`，来自 `src/hybrid/prompts.mjs`） → `[边界]`**，其后追加 plan 提示与 **自定义指令（v1.7.1）**（**v1.7.1 起已无任何动态块**）。

> **section 不含任何易变内容。** 用户级/项目级 `MEMORY.md` 与**今日工作日志**均经 E 投影（`src/projection.mjs`）注入为常驻 user 消息（每个 step 可见），见 §2.7。section 只含「常量指令（五块 + plan 提示 + 用户自定义指令）」。分流依据是**内容是否恒定**：恒定 → 留 section（system prompt 位于序列最前，内容恒定才不毁前缀缓存）；易变 → 走投影追加到历史尾部、按**文件身份**各只注一次。

### 2.1 记忆总述与 `[记忆文件]`（两种形态，按是否桥接 buddy 目录切换）
- **总述**（一句）：记忆真源是 Markdown 文件而非数据库，分三层、读写权限不同。
- **`[记忆文件]`** 四条，每条自带权限：用户级 MEMORY.md / 项目级 MEMORY.md **可写**（`memory_note_user` / `memory_note`，或 `memory_write` / `memory_update_section` 的对应 `scope`）；每日日志由记忆子代理每轮自动维护，agent **只读**——不写、不改文件头、不重排；**章节**一条要求按语义自选章节名、别都塞默认章节，并说明 `memory_note` 系列省略 `section` 时的默认落点（「项目约定」/「用户偏好」）。
- **两形态差异只在路径与桥接说明**：已桥接（`paths.buddyDirs().length > 0`）→ 只给角色名 + 「当前项目已存在 WorkBuddy/CodeBuddy 记忆目录…不再单独创建 `.deepseek-harness/memory/`」；未桥接 → 三条分别带 `~/.deepseek-harness/MEMORY.md` / `.deepseek-harness/MEMORY.md`（项目根下）/ `.deepseek-harness/memory/YYYY-MM-DD.md`（项目根下）。

### 2.2 `[读取]`（五条标签式，语义逐字保留）

每条 `标签：内容`，与 `[记忆文件]` 同构：
- `快照`：上下文里的记忆是**会话起始快照**，不随记忆文件之后的更新刷新。
- `必须重读`：需要**当前**磁盘状态时**必须** `memory_read` 重读（改记忆前、据记忆作答前、用户问「现在 / 最新」时）。
- `不必重读`：上下文里已有、且不涉时效的，不必再读——不要为"确认一下"重复调用。
- `取日志`：`scope` 默认 `'memory'` = 用户级 + 项目级 MEMORY.md；要日志才显式传 `today` / `daily` / `all`。
- `禁止`：手动 glob/read 记忆文件；看不到的内容不要编造。

> **两条纪律**：① 顺序刻意——快照先于指令、"必须"先于"不必"，负向祈使在模型侧更"粘"，不能让它压过正向；② **重构只改排版、不动语义**——工具名（`memory_read`）、条件、分支、举例必须逐字保留。曾有一次把「必须 `memory_read` 重读」压成「必须重读」、并删掉三个分支，属事故级改动。

### 2.3 `[边界]`（原 `antiMangle` 并入，两条 `- ` 条目）
- `- 记忆是补充，不替代回答与交付：不要把记忆原文直接当答案，也不要用读记忆代替动手核实。`
- `- 提及记忆文件路径时一律用 ~ 简写…`：提及记忆文件路径时不要逐字拼写绝对路径——真机踩坑：AI 转述绝对路径易缺分隔符（`~/.deepseek-harness` 被拼成 `~.deepseek-harness`）。

### 2.4 写入分工 `[写入分工]`（v1.8.0 起恒为 `HYBRID_PROACTIVE`）
| 分支 | 注入文案 | 意图 |
|---|---|---|
| **（唯一）** | `[写入分工]`（`HYBRID_PROACTIVE`）①日志由子代理每轮自动维护（含去重标删），agent 无需记录过程；②MEMORY.md **只在「下个会话不做就会做错」时才写**，写前自检（是否在解释代码怎么实现？去掉行号/报错全文/临时链接后还立得住吗？）→ **再对已有记忆归类（强化→不写或并入原句 / 修正推翻→整章节精确替换或标删 / 补充→追加；三类都不属→不写就是正确的沉淀）**、**优先 `memory_update_section` 合并，其次 `memory_write` 追加**；③项目级仅双门禁满足时可 `memory_reorganize` 全量重整（**只允许落盘一次**），否则不得反复尝试；④用户级禁止重整；⑤不写密钥/token/密码/个人身份信息，**除非用户明确要求，否则不记录任何凭据**，确需记录只写「在哪个配置项 / 文件读取」 | 日志/长期记忆职责分离，agent 主写 MEMORY.md，且**只记 durable 结论、不记过程流水** |

> v1.8.0：原 `plugin`（记忆公民指令）与 `smart`（记忆自动维护说明）两个分支已删除，`proactive` 直接取 `HYBRID_PROACTIVE`。
> **注意**：`HYBRID_PROACTIVE` 只讲分工、不含工具清单——工具指引（`memory_note` / `memory_read`）在 §2.1 的 `[记忆文件]` 与 §2.2 的 `[读取]` 里，不可误删。

关键约束：`text()` 必须**始终**返回非空（即便无记忆也要注入指令），否则 agent 不知记忆系统存在 → 永不记 → 死循环。

### 2.5 plan 模式禁写提示 `planNote`
仅当**当前会话**处于 plan 模式时追加：「当前处于 plan 模式，不要调用 memory_note / memory_note_user 写入记忆，也不要请求删除记忆（读取用 memory_read）。」属于软提示，网关物理兜底仍生效。

> 判定走 `planModeOf(state, context.agent.session)`（`common/planmode.mjs`）：宿主 plan 模式是**会话级**状态（`session.append('plan/mode')`），故按会话判定——别的会话进 plan 不得往本会话 prompt 里塞这条提示。

### 2.6 自定义指令 `[用户自定义指令]`（v1.7.1 特性3；v1.8.4 真源迁移）

真源：**`$DSH_HOME/profiles/<profile>/.memory-palace/user-commands.md`**（`src/common/user-commands.mjs`）。配置项 `customInstructions` 已摘除——不读、不迁移，存量 profile 里的旧值静默失效。设置页「自定义指令」板块仍可编辑，读写走的都是这个文件。
文件全文 **非空**（trim 后）时，追加在「五块 + plan 提示」之后：**`[用户自定义指令]` 独占一行**，其下是文件原文（原样保留，不重排、不加缩进）—— 即 system prompt 里呈现为「总述 → `[记忆文件]` → `[读取]` → `[写入分工]` → `[边界]` →（plan 模式下）`[plan 模式]` → **[用户自定义指令]** → 指令原文」的顺序。前缀与 `[plan 模式]` 同风格，便于模型识别段落来源。

- **前缀独占一行**：早期实现把首行拼在前缀同一行（`[用户自定义指令] 第一行`），多行指令的后几行会看起来游离在块外、与其它 `[标签]\n- 条目` 块排版不一致。

- 它是**恒定内容**（改文件才变），故留在 section 而非走投影 —— 与分流依据一致，零缓存成本。
- 留空或纯空白 → 不注入，`text()` 原样返回 `introFull`（不留空段、不留空白）。
- 读取按 `mtimeMs` 缓存（section 每步调用）；读盘异常吞掉返空串，绝不抛错毁 turn。
- 对全部会话生效；不进 E 投影、不参与投影身份去重。

### 2.7 记忆正文投影（非 prompt，但决定模型可见内容）

真源：`src/projection.mjs`。用户级与项目级 `MEMORY.md` 经 `agent/pre-step` 投影为**两条独立的常驻 user 消息**：

- **内容形态**：`# 用户级记忆 (<~ 简写路径>)\n<正文>` / `# 项目级记忆 (<~ 简写路径>)\n<正文>`；正文经 `budgetClip` 截断（**逐文件独立**：用户级按 `userBudgetChars`；项目级 `MEMORY.md` 与今日日志各按 `workspaceBudgetChars`，互不挤占 —— 预算说的是**每个文件**的上限，不是合计总量），并剥 `[smart]` 标签与删除线墓碑。
- **source 标注**：`{ kind: 'plugin:dsh-memory-palace', form: 'instructions' }`（0.1.7 起宿主删除通用 `plugin` kind，按 v3→v4 迁移约定用 `plugin:<包名>`；`form` 必须是宿主 `ContextForm` 联合内的合法值）。
- **拆两条消息**的原因：否则「项目记忆一改，用户记忆连带重发」。
- **去重与重注**：按**文件身份**（消息首行 heading，含目标路径与日期）去重 —— 同一文件只注一次，内容再变也不重注；compaction 把消息移出 surface 后，后续 step 自动重注磁盘最新版。
- **指令优先级说明**：投影是 user 角色，强约束建议放 harness 的 `AGENTS.md`（system 优先级），`MEMORY.md` 只放动态事实。

---

## 四、记忆子代理提示词

真源：`src/hybrid/prompts.mjs`。

### 4.1 写入分工 `HYBRID_PROACTIVE`（注入 `[写入分工]` 块）

注入 system prompt 的 `[写入分工]` 块（v1.8.0 起唯一形态；原 smart 的「无需主动调用」与 plugin 的「记忆公民指令」已删除）。九个一级条目 + 六个二级条目，统一 `标签：内容` 语法：

- `日志不归你`：子代理每轮自动提炼摘要写今日日志（含去重标删）；agent 无需调用工具记录过程、不复述。
- `归属`：长期记忆 MEMORY.md（项目级与用户级）由 agent 主动维护。
- `写 MEMORY.md 的时机`（三个二级）：**必写**=用户明确要求「记住」（按归属选层级：跨项目→用户级 / 本项目→项目级）；**才写**=只在「不做就会做错 / 返工 / 重踩坑」时（用户当场声明的约定或偏好、关键决策、踩坑修复等 durable 结论）；**不写**=过程流水或一次性临时状态。
- `写前自检`：是否在解释「代码怎么实现」；去掉行号 / 报错全文 / 临时链接后还立得住吗。
- `已有记忆归类`：**强化**→不写或并入原句；**修正 / 推翻**→整章节精确替换或标删（只叙述旧→新、而文件已含新结论的算强化）；**补充**→追加；**三类都不属**→不写就是正确的沉淀。
- `怎么写`：优先 `memory_update_section` 合并 / 改写，其次 `memory_write` 追加（章节不存在自动新建）；一次一事实；绝不手写覆盖。
- `全量重整`：仅「超预算 且 距上次重整 ≥ 冷却期」两条件同时满足可 `memory_reorganize`，只允许落盘一次。
- `重整取材`：必须用文件读取工具直接读 MEMORY.md 与 `memory/YYYY-MM-DD.md`（含更早日期）——`memory_read` 被禁用，它只覆盖近三天。
- `门禁不过`：不要反复尝试——未超预算→`memory_update_section` 日常维护；冷却期内→停止并如实报告，不得换工具凑数。
- `用户级`：禁止全量重整，只允许增量写入与整章节精确替换。
- `密级`：不写密钥 / token / 密码 / 个人身份信息——除非用户明确要求，否则不记录任何凭据。

> **两条同源规则**：① 排版与日志条目形状同源（一条一事、`标签：内容`、超长拆子项），prompt 自己也不能是"一堵墙"；② **重构不得压缩语义**——工具名、条件、分支、举例逐字保留，改完逐句 diff 对照。

### 4.2 记忆子代理 system prompt `SUBAGENT_SYSTEM()`

hybrid 模式每轮 turn/end 触发 `runMemorySubagent`（`src/hybrid/subagent.mjs`），子代理执行「判定 + 产出一体」：
- **判定**：本轮是否有实质内容（完成任务/修 bug/决策/结论/用户偏好）。无重点、或本轮结论已在今日日志且无旧条目需要标删 → 纯文本收尾（1 次调用，仍推进断点；**零操作收尾也是合格产出**）；有重点 → 工具循环写入日志（2-5 次调用）。
- **工具白名单**（仅循环内，非 DSH 全局）：
  - `log_read_section(sections[])`：**一次读取多个章节**（合并返回，未找到的章节注明）——日志回喂超 `subagentLogBudget` 仅给章节目录时按需拉取；prompt 强制要求多章节在单次调用中传齐，避免多轮往返；
  - `log_write_ops(ops[])`：批量提交 `{op:"new_section"|"append"|"mark_delete", section, entry?, oldText?}`。
- **日志 ops 规则**（prompt 明文）：
  - 只能通过 `log_write_ops` 写，禁止重写整文件；三种 op：新增章节 / 章节内追加（upsert，不强行匹配现有章节）/ 标记删除（删除线墓碑，非物理删除）；
  - 去重是子代理职责：回喂日志中已存在的结论禁止重复追加，语义重复/矛盾用 `mark_delete` 标记过时条目；
  - 条目格式：一行一条、结论开头 + 关键细节、客观第三人称、禁止标签与对话体。
  - 不记一次性信息：搜索结果 / 临时路径（临时目录、一次性生成物）/ 工具报错原文；踩坑只记「什么条件下会失败 + 怎么修」，可复用入口路径照常记。
- **格式规范段（7 正 + 3 反）**——旧产物是「一堵墙」（单章节 + 零嵌套 + 零加粗 + 200 字长句），故把格式细则写进 prompt：
  - 正面：①文件头由插件维护、子代理不写；②一主题一 `##` 章节、同主题超 3 条再拆 `###`；③一条一事实 ≤120 字，超长拆父项 + 两空格缩进子项（**缩进必须模型自己写**，`upsertSectionText` 只原样保留中间换行与缩进）；④关键结论/决策/纠错 `**加粗**`、重要约束标 `（重要）`；⑤行内分组 `**结论**：` / `**待办**：` / `**约束**：` / `**产出**：` / `**用户约定**：`；⑥允许一句「用户意图/反馈」作语境，禁止流水账；⑦可复现命令/脚本用代码块。
  - 反模式：过程流水（"用户提出…我已改…"）、自我过程表述（"我搜索了 A/B/C"）、把多个结论塞进 200 字长句。
- **密级段**：不写密钥 / token / 密码 / 个人身份信息；**除非用户明确要求，否则不存储任何凭据**——需要时只记「在哪个配置项 / 文件读取」。
- **失败语义**：超 6 轮 / 超时 `summaryTimeoutMs` / 模型不支持 tools → **本轮放弃、不降级 `writeLightEntry`**（无格式原文会破坏日志章节化结构）；断点不推进，下一次 turn/end 子代理自动补蒸。
- **环境边界段**：本环境不是代码执行环境，`run_code` 等工具均不存在；子代理只能调用 `log_write_ops` / `log_read_section`，不得模仿上文出现过的任何工具调用。
- **输入去噪**（非 prompt 但影响子代理可见内容）：`projectTurnMessages` 按 `source.kind` 排除注入类消息（`agent-instructions` / `plugin` / `skill-catalog` 等），只喂真实用户对话 + assistant/tool 消息。实测单轮输入 6967 → 3849 字符（−44.8%）。

### 4.3 注入侧删除线过滤

注入 system prompt 前用 `stripDeletedLines`（`src/common/text.mjs`）剔除**整行**删除线墓碑（`~~...~~`，可带 `- ` 列表符）——文件保留墓碑供审计，注入侧过滤防模型把已作废条目当现行有效；行内局部删除线（`- 旧名 ~~原名~~`）不滤。

### 4.4 日志文件头规范

子代理**不写文件头**（prompt 明文），由 `ensureLogHeader`（`src/common/sections.mjs`）在 `applyLogOps` 落盘前补齐 `# YYYY-MM-DD`：空文件写入标题；首行空或直接以 `##` 开头则补标题；已有同日标题原样返回（幂等）。仅在写入时补齐，历史文件不回填。

### 4.5 写入工具 description：形状层规范（v1.8.1）

真源：`src/tools.mjs`（`memory_note` / `memory_note_user`）与 `src/hybrid/tools.mjs`（`memory_write` / `memory_update_section` / `memory_reorganize`）。**全部写入路径共用同一套形状规范**（防「换个工具写就绕过规范」的后门）：

- **五个写入工具现在都产章节化格式**：`memory_note` / `memory_note_user` 已收口到 `upsertSectionText`（与 `memory_write` 同一实现、同一去重判据 `sectionHasEntry`）；`section` 参数可选，默认「项目约定」/「用户偏好」。
- **一条一事**、结论先行、客观第三人称；条目简明，需展开就拆 `- 父项` + 两空格缩进子项（`memory_note` 系列的 `content` 是单行、经 `flattenEntry` 扁平化，无父子结构）。
- **禁源码坐标**（`file.go:123`）——行号随版本失效，属一次性排查过程。
- **禁一次性过程**（报错全文 / 命令输出 / 临时 URL）。
- **路径**只写可复用入口（目录、配置文件名、命令）；**URL** 只留下次必须照填的基址形态。
- 分层：**决策层**（要不要写 / 优先合并 / 写前查重）在 `HYBRID_PROACTIVE`（§4.1），**形状层**在 description —— 两层不重复同一套规则。
- **显式触发句**：`memory_note` / `memory_note_user` 的 description 各自补一句 `or when the user explicitly asks you to remember it`——模型做写入决策时**读的是 description**，只写进 system prompt 会打对折（用户说"记住这个"时的漏写就是这么来的）。两处口径一致：用户级那句额外限定 `not tied to this project`。

> v1.8.1 同时**移除**两类有害措辞：① 旧 description 的 "then key details: commands/paths/numbers"（**鼓励塞实现细节**）；② 门禁失败时的 "use memory_update_section instead" 与「请用 memory_update_section 做章节级修正」（**把 agent 推向绕道路径**——实测中 agent 正是照此做了 13 次章节级暴力删改）。拦截消息只表达「停止 + 上报」，不给替代路径。

---

## 五、会话命令 `/memory_reorganize`（中文别名 `/记忆重整`）内置提示 `REORG_COMMAND_PROMPT`

真源：`src/common/prompts.mjs`。

### 5.1 用途与触发
用户手打会话命令 `/memory_reorganize`（或中文别名 `/记忆重整`——client 侧 contribution 转发，见 DEVELOPMENT.md「会话命令」）时，`src/index.mjs` 的 handler 先过门禁（`enabled` → 会话静默 → plan 模式 → 有活动工作区 → `checkReorgGate`：超注入预算 **且** 过冷却），通过后把本提示作为一条 `source.kind='user'` 的**用户消息** `agent.steer` 给模型（宿主命令注册表自身不提交消息，必须 handler 亲自提交）。提示首行固定为 `REORG_MESSAGE_PREFIX`（`【项目记忆重整任务】`），用于把命令注入的消息与用户后续真实消息区分开（后者出现即摘除重整期掩码）。

### 5.2 内容要点
- **读取**：给出项目 `MEMORY.md` 绝对路径 + 工作日志目录绝对路径，要求列出 `memory/*.md`（含历史日期）自行读取；**明示 `memory_read` 本次已禁用**（其 scope 只到近三天，读不到更早日志）；不硬绑具体工具名（不同 profile 的 agent 工具集不同，必要时经代码执行读文件）。
- **任务定义（v1.8.1）**：基于现有 MEMORY.md 与**对应工作日期的日志**做「**两删一提一重构**」——删过时条目 / 删重复信息 / 冗余提炼（**不丢精度**）/ 重构文件结构。
- **约束**：保持 `## 章节` + `- 条目` 格式；绝不丢失仍有效的关键信息（硬约束、禁止项、前提、决策及理由、可复用入口、已验证的坑）；**预算 `workspaceBudgetChars` 是「健康参考线」而非硬指标**——严禁为达标删除仍有效信息；**只依据**现有 MEMORY.md + 工作日志，**不得新增**原记忆没有的章节/结论，不得把已过时结论重新引入；**归并时默认并入已有章节，新建章节须先证明语义最近的 2 个章节装不下，同一主题散落多章时先并为一章再补写**；条目形状同写入工具规范（一条一事、禁源码坐标、禁一次性过程）；只动项目级、禁改用户级。
- **落盘纪律（v1.8.1）**：**只允许落盘一次**（草稿不会自动保存 → 想清楚再写定，不要反复推倒重来；一轮到位 = 质量最优）；**必须调用 `memory_reorganize` 工具写入**（唯一会整档备份原文件的路径，机器自动追加时间戳）；被门禁/确认拦截时**停止**并向用户如实报告最终结果——**绝不**改用其它工具继续删改凑数。

### 5.3 参数
`REORG_COMMAND_PROMPT({ budget, memFile, logDirs } = {})`——`budget` 取 `workspaceBudgetChars`；`memFile` / `logDirs` 由 `paths.memoryFileOf` 与 `paths.readDirs` 解析后注入正文；用户输入的补充说明追加在末尾（`【用户补充】…`）。

---

## 六、文档维护说明

- 本文件只收录**提示词与提示词常量**（系统提示词注入 / 会话命令内置提示 / 子代理 prompt），另收录「记忆正文投影」与「日志文件头规范」——它们不是提示词，但直接决定模型可见内容，故在此登记。
- **重整流程（门禁 / 禁用 `memory_read` / 首步跳过投影）**属行为机制，非提示词，说明在 `DEVELOPMENT.md`「会话命令 /memory_reorganize」与「记忆子代理要点」。
- **投影通道的契约风险与降级**见 `DEVELOPMENT.md`「记忆注入通道」§7.4。
- 改提示词请改源码（`src/index.mjs` 系统提示词闭包 / `src/common/prompts.mjs` / `src/hybrid/prompts.mjs`），本文件同步更新。
