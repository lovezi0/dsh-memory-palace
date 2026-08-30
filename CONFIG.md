# 配置

*本文件从 README 拆分而出，集中收录 dsh-memory-palace 的全部配置项。所有配置均可在 **DSH 设置 →「记忆」面板**中图形化调整，无需改配置文件*

## 基础（设置页「记忆」主面板）

| 配置项 | 设置 key | 默认值 | 说明 |
|---|---|---|---|
| 用户级记忆路径 | `userMemoryPath` | `~/.deepseek-harness/MEMORY.md` | 用户级记忆文件路径（支持 `~` 展开） |
| 工作区记忆目录 | `workspaceMemoryDir` | `.deepseek-harness/memory` | 无 buddy 目录时回退的项目记忆目录 |
| 日志保留天数 | `dailyLogRetentionDays` | `30` | 每日日志保留天数，过期迁移进 `MEMORY.md`。**混合模式下不可用**（hybrid 日志永不过期不删，作为子代理维护的证据层保留） |
| 用户级记忆字数上限 | `userBudgetChars` | `4000` | 注入系统提示词的用户级记忆长度上限（字符） |
| 工作区级记忆字数上限 | `workspaceBudgetChars` | `3000` | 注入系统提示词的工作区级记忆长度上限（字符） |
| 桥接 Buddy 记忆 | `bridgeBuddyMemory` | `true` | 检测并直接读写 WorkBuddy / CodeBuddy 项目记忆目录 |
| Buddy 记忆目录列表 | `buddyWorkspaceMemoryDirs` | `[".workbuddy/memory", ".codebuddy/memory"]` | 要桥接的 buddy 目录列表（按优先级，已存在的全部同步写入） |

> **桥接规则**：`bridgeBuddyMemory` 开启时，只要项目里存在任一 buddy 记忆目录，就**只**读写这些目录，不再创建 `.deepseek-harness/memory/`；全部不存在时才回退到 dsh 目录。buddy 目录绝不被主动创建。

## 自动记录（设置页「记忆 → 自动记录」卡片）

| 配置项 | 设置 key | 默认值 | 说明 |
|---|---|---|---|
| 记忆模式 | `memoryMode` | `plugin` | 三种互斥模式（切换需重启 dsh 生效）：`plugin`=记忆公民指令+轮次轻量+错误捕获（默认）；`smart`=LLM 智能会话摘要（summary→每日日志 + durable→MEMORY.md）；`hybrid`=记忆子代理自动维护今日日志（章节化、标删去重）+ agent 主动维护 MEMORY.md（章节化写入、整章节替换、门禁内全量重整） |
| 轮次结束自动记录 | `summarize` | `true` | 插件模式下：它是「agent 主动记忆」主路径失效时的安全网，保证实质工作不丢，代价是只留原始文本、不做总结。智能模式下该开关仍为总闸门 |
| 摘要模型 | `summaryModel` | `""`（空=复用当前会话模型） | 智能模式专用：留空自动复用当前会话 provider/model；可选已配置的模型|
| 对话出错自动记录 | `autoCaptureErrors` | `true` | 插件模式下：自动捕获 in-session 错误并写入「错误现象」到对应 MEMORY.md；「根因/方案」由 agent 主动记；智能模式下错误由 LLM 摘要统一提炼 |
| 摘要最大输出 Token | `summaryMaxTokens` | `2000` | 智能模式专用：**最终输出软预算**（prompt 约束，思考不受限；实际硬上限由模型自身 maxTokens 决定）。过小会让模型在 prompt 内收敛不够、durable 事实被挤；可上调以容纳更多 durable 事实。**仅「智能模式」下显示** |
| 蒸馏最大输出 Token | `projectMaxTokens` | `8000` | 智能模式专用：**最终输出软预算**（prompt 约束，思考不受限；实际硬上限由模型自身 maxTokens 决定）。手动「蒸馏项目记忆」LLM 的成稿长度预算；过小会让模型在 prompt 内收敛不够。可上调。**仅「智能模式」下显示** |
| 蒸馏时回喂存量记忆 | `feedbackEnabled` | `false` | 智能模式专用：开启后把项目级+用户级 MEMORY.md 全文（逐行编号、无截断）回喂 LLM 做增量维护；自动与手动均回喂，delete 仅手动按钮开放、自动模式跳过防误删。**仅「智能模式」下显示**（hybrid 下不参与——子代理自带日志回喂） |
| 重整冷却(天) | `reorgCooldownDays` | `7` | 混合模式专用：项目级 MEMORY.md 全量重整的冷却天数（距上次重整）；与「超出注入预算」双条件**同时满足**才允许 `memory_reorganize`；时间戳以 HTML 注释落在 MEMORY.md 文件尾。**仅「混合模式」下显示** |
| 子代理日志回喂预算(字符) | `subagentLogBudget` | `20000` | 混合模式专用：记忆子代理回喂今日工作日志的字符上限；超出时仅回喂章节目录，子代理用 `log_read_section` 按需读取章节。**仅「混合模式」下显示** |

## 开发（设置页「记忆 → 开发」卡片）

| 配置项 | 设置 key | 默认值 | 说明 |
|---|---|---|---|
| 蒸馏超时(毫秒) | `summaryTimeoutMs` | `60000` | 蒸馏 LLM 调用超时（覆盖智能模式摘要与手动蒸馏两条链路），超时视为失败并降级；设置页以秒显示（默认 60 秒） |
| 蒸馏调试日志 | `distillDebugLog` | `false` | 调试开关：向 dsh 服务端 stderr 输出蒸馏 LLM 调用诊断。info 级别仅输出元数据（模型解析/请求参数/流进度/错误详情，不含文本）；配合 `distillLogLevel=debug`（见下）会额外打印 LLM 原始响应文本（分隔符包裹），仅限受信本地排障。平时关闭 |
| 蒸馏日志级别 | `distillLogLevel` | `info` | **平铺独立配置键（不进设置页 UI）**，经 profile/settings.yaml 设置。可选 `info` \| `debug`：info=仅元数据诊断；debug=额外打印 LLM 原始响应。读不到时默认 `info`。与 `distillDebugLog` 平铺双键设计以保证向后兼容（旧版忽略未知键不崩） |

> **设置保存（v1.1.4 起）**：设置页保存已**真正落盘**
>
> 历史方案（仍可用作兜底）：直接在 profile 的 `cordis.patch.yml` 注入配置（id-targeted config override，与插件 bundle insert 的 id 一致）：
>
> ```yaml
> - id: memory-palace
>   name: 'dsh-memory-palace'
>   config:
>     memoryMode: smart
>     summaryModel: ''
> ```
>
> 修改后重启 dsh 生效。
