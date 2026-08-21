# dsh-memory-palace

把 WorkBuddy 的文件式记忆系统移植进 [DeepSeek Harness](https://www.deepseek.com/harness/) —— 为 Harness 提供**跨会话持久化、人类可直接编辑的 Markdown 记忆**。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

记忆就是普通文本文件，用记事本就能改。AI 每轮对话把它读进上下文，对话结束后把新内容追加进日志——不依赖任何私有格式、不落 JSON、不锁数据。

## 特性

- **人类可读的真源**：记忆全部存储在 Markdown 文件中（`MEMORY.md` + 每日日志 `YYYY-MM-DD.md`），任何编辑器可直接修改，数据永远属于你。
- **双层记忆**：用户级（跨项目个人偏好，默认 `~/.deepseek-harness/MEMORY.md`）+ 工作区级（项目约定，默认 `<cwd>/.deepseek-harness/memory/`）。
- **自动读写**：每轮对话将记忆注入系统提示词；每轮结束自动把轻量记录追加进当日日志。
- **日志迁移**：超过保留天数（默认 30 天）的每日日志自动迁移进 `MEMORY.md` 后删除，长期记忆持续沉淀。
- **WorkBuddy / CodeBuddy 桥接**：项目已存在 `.workbuddy/memory` 或 `.codebuddy/memory` 时直接读写这些目录，无需重复维护记忆。
- **记忆工具**：`memory_note`（项目级写入）、`memory_note_user`（用户级写入）、`memory_read`（聚合读取）、`memory_delete`（按内容删除，两阶段确认），全部内置去重，防止重复追加。
- **会话标题栏「记忆」按钮**：支持手动蒸馏：①蒸馏会话 / ②蒸馏项目记忆。
- **设置页集成**：DSH 设置中内置「记忆」面板（中英双语），所有配置均可图形化调整，无需改配置文件。
- **主动记忆（主路径，插件模式）**：注入「记忆公民指令」引导 agent 在「修复 bug/根因+绕过」「验证 build/test 通过」「完成里程碑/关键决策」「用户表达偏好/约束」时主动调 `memory_note` / `memory_note_user` 落档 — 对标 WorkBuddy 的"智能记一笔"手感。
- **智能模式（LLM 智能会话摘要）**：智能模式下，每轮命中防闲聊闸门后由 harness 把本会话**新增对话增量**（按 session 事件 seq 断点）提炼成摘要——`summary` 写每日日志（带 `[smart]` 标记）+ durable 事实写 MEMORY.md。
- **标准 npm 插件包**：经 `dsh plugin` 一键装入 profile，`cordis.patch.yml` 声明 bundle patch，零手动改动 harness。

## 记忆文件布局

```
~/.deepseek-harness/
└── MEMORY.md                      # 用户级记忆（跨项目个人偏好）

<项目根>/
├── .workbuddy/memory/             # 桥接 WorkBuddy 记忆（已存在时，按序优先）
│   ├── MEMORY.md                  # 项目级约定（buddy 目录保持嵌套，兼容 WB/CB 原生格式）
│   └── 2026-08-16.md              # 每日工作日志
├── .codebuddy/memory/             # 桥接 CodeBuddy 记忆（已存在时，结构同 .workbuddy）
└── .deepseek-harness/             # 回退目录（无 buddy 目录时自动创建）
    ├── MEMORY.md                  # 项目级约定（长期记忆，与 memory/ 同级）
    └── memory/
        └── 2026-08-16.md          # 每日工作日志
```

> **布局迭代（v1.1.x）**：早期版本曾把项目级 MEMORY.md 放在 `.deepseek-harness/memory/MEMORY.md`（嵌套）；现已改为与 `memory/` **同级**（`.deepseek-harness/MEMORY.md`）。旧嵌套位置仍会被读取（向后兼容、不丢旧数据），但**写入一律走同级**。

> **桥接规则**：`bridgeBuddyMemory` 开启时，只要项目里存在任一 buddy 记忆目录，就**只**读写这些目录，不再创建 `.deepseek-harness/memory/`；全部不存在时才回退到 dsh 目录。buddy 目录绝不被主动创建。

## 工作原理

**读取（每轮对话）**——`systemPrompt.section` 同步读盘，把以下内容拼进系统提示词：

```
用户级 MEMORY.md
+ 工作区 MEMORY.md
+ 今日日志 YYYY-MM-DD.md
→ 注入 system prompt，让 AI 跨会话保持一致
```

**写入（每轮结束）**——监听 `session/event` 的 `turn/end`，经「防闲聊闸门」判定后异步追加：

```
turn/end ──► 轻量兜底闸门
         │     有工具调用 / 有错误 / agent 主动记 / 命中偏好·决策关键词 → 放行
         │     否则：跳过（不写、不调 LLM）
         ├─► 轻量条目写入 YYYY-MM-DD.md（全部目标目录；可关）
         ├─► 若本轮出错且开启「对话出错自动记录」→ 「错误现象」写入对应 MEMORY.md
         └─► prune：超过 dailyLogRetentionDays 的日志蒸馏进 MEMORY.md 后删除
```

**工具**——AI 在对话中按需调用：

| 工具 | 层级 | 作用 |
|---|---|---|
| `memory_note` | 项目级 | 把约定/偏好写入当前项目全部目标 `MEMORY.md`（去重） |
| `memory_note_user` | 用户级 | 把跨项目偏好写入 `~/.deepseek-harness/MEMORY.md`（去重） |
| `memory_read` | 聚合 | 一次性读取用户级 + 项目级记忆、今日日志与最近 3 份历史日志 |
| `memory_delete` | 用户级/项目级/每日级 | 按内容删除记忆条目（两阶段确认：先预览匹配位置与内容，用户确认后再删；删除动作经 harness 原生确认弹窗硬闸门，真人点允许才真正执行） |

## 安装

前置要求：已安装 DeepSeek Harness 及其 CLI（`dsh` 命令可用）。

方式一：直接通过 GitHub 安装（推荐，`lib/` 构建产物已随仓库分发，装即用）

```bash
dsh plugin --profile web add github:lovezi0/dsh-memory-palace
# 锁定版本：dsh plugin --profile web add github:lovezi0/dsh-memory-palace#v1.2.2
```

方式二：clone 后本地安装（开发 / 修改源码场景）

```bash
git clone https://github.com/lovezi0/dsh-memory-palace.git
cd dsh-memory-palace
npm install
npm run build        # src/ → lib/（服务端递归复制 + 客户端零依赖拼接，无外部构建依赖）
dsh plugin --profile web add .    # 装入 web profile（profile 名按你的实际配置调整）
```

方式三：通过 npm 安装（已发布到 npm registry，可走镜像加速）

```bash
# 直接由 dsh 从 npm 拉取并装入（本机若已配镜像会自动走镜像）
dsh plugin --profile web add dsh-memory-palace
# 锁定版本：
dsh plugin --profile web add dsh-memory-palace@1.2.2

# 或先手动用 npm 安装（显式指定镜像），再装入：
npm install dsh-memory-palace --registry=https://registry.npmmirror.com/
dsh plugin --profile web add dsh-memory-palace
```

卸载：

```bash
dsh plugin --profile web remove dsh-memory-palace
```

## 配置

可在 DSH 设置 →「记忆」面板中调整，或通过 profile 配置注入：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| 总开关 | `true` | 总开关，关闭后不注入、不写入 |
| 用户级记忆路径 | `~/.deepseek-harness/MEMORY.md` | 用户级记忆文件路径（支持 `~` 展开） |
| 工作区记忆目录 | `.deepseek-harness/memory` | 无 buddy 目录时回退的项目记忆目录 |
| 日志保留天数 | `30` | 每日日志保留天数，过期迁移进 `MEMORY.md` |
| 用户级记忆字数上限 | `4000` | 注入系统提示词的用户级记忆长度上限（字符） |
| 工作区级记忆字数上限 | `3000` | 注入系统提示词的工作区级记忆长度上限（字符） |
| 桥接 Buddy 记忆 | `true` | 检测并直接读写 WorkBuddy / CodeBuddy 项目记忆目录 |
| Buddy 记忆目录列表 | `[".workbuddy/memory", ".codebuddy/memory"]` | 要桥接的 buddy 目录列表（按优先级，已存在的全部同步写入） |

### 自动记录（设置页「记忆 → 自动记录」卡片）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| 记忆模式 | `plugin` | 两种互斥模式：`plugin`=记忆公民指令+轮次轻量+错误捕获（默认）；`smart`=LLM 智能会话摘要（summary→每日日志 + durable→MEMORY.md，带 `[smart]` 标记）。**切换需重启 dsh 生效** |
| 轮次结束自动记录 | `true` | 插件模式下：它是「agent 主动记忆」主路径失效时的安全网，保证实质工作不丢，代价是只留原始文本、不做总结。智能模式下该开关仍为总闸门 |
| 摘要模型 | `""`（空=复用当前会话模型） | 智能模式专用：留空自动复用当前会话 provider/model；填 `provider/model`（如 `deepseek/deepseek-chat`）固定廉价模型省 token |
| 对话出错自动记录 | `true` | 插件模式下：自动捕获 in-session 错误并写入「错误现象」到对应 MEMORY.md；「根因/方案」由 agent 主动记；默认开启，**关闭无需重启 dsh**。智能模式下错误由 LLM 摘要统一提炼 |

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

## 开发

目录结构、构建与测试、技术要点见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## 版本历史

- **1.2.2**
    - 🐛修复智能模式自定义摘要模型不生效的问题
- **1.2.1**
    - 💪发布npm
- **1.2.0**
    - 🔥会话标题栏【记忆】按钮
    - 🔥手动蒸馏会话与项目记忆
    - 🐛修复记忆预算注入无效
    - 💪项目混合式模块化重构
- **1.1.4**
    - 🔥智能模式摘要上线
- **1.1.2**
    - 🐛修复记忆设置保存不生效的问题
- **1.1.1**
    - 💪每日日志格式简化
- **1.1.0**
    - 🔥新增「智能模式/插件模式」切换功能
- **1.0.0**
    - 🔥新增防闲聊闸门
    - 🔥新增记忆公民指令
    - 🔥新增删除记忆工具
- **outdated（0.x）** — 双层 Markdown 记忆读写 / 设置页集成等 0.x 历史，见 [CHANGELOG.md](./CHANGELOG.md)

## 废弃方案

插件侧 LLM 自动摘要（`ctx.llm.stream()` 路线）曾在 v0.7.1 因 4 个契约/时机坑废弃；**v1.1.0 已重新论证并以「智能模式」可选形态复活**——经 `session.events` / `deriveEventMessage` / `requestHeader()?.config` 根除旧坑，默认仍为插件模式。见 [废弃方案：为什么不用 LLM 自动摘要](./ABANDONED-LLM-SUMMARY.md)。

## 参考与致谢

本插件开发深度参考了以下两个开源项目（本包实现为各自机制的简化落地，不含其完整功能）：

- **[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)**
- **[dsh-sideband](https://github.com/ishuowang/dsh-sideband)**

## License

[MIT](./LICENSE)
