# dsh-memory-palace <img src="assets/memory-icon.svg" width="36" height="36" alt="dsh-memory-palace" />

把 WorkBuddy 的文件式记忆系统移植进 [DeepSeek Harness](https://www.deepseek.com/harness/) —— 为 Harness 提供**跨会话持久化、人类可直接编辑的 Markdown 记忆**。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE) [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

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
# 锁定版本：dsh plugin --profile web add github:lovezi0/dsh-memory-palace#v1.4.1
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
dsh plugin --profile web add dsh-memory-palace@1.4.1

# 或先手动用 npm 安装（显式指定镜像），再装入：
npm install dsh-memory-palace --registry=https://registry.npmmirror.com/
dsh plugin --profile web add dsh-memory-palace
```

卸载：

```bash
dsh plugin --profile web remove dsh-memory-palace
```

## 配置
*面板路径为 DSH 设置 →「记忆」*
所有配置项（基础 / 自动记录 / 开发 三张卡片的字段、默认值与说明）已整理至 [CONFIG.md](./CONFIG.md)

## 开发

架构 / 构建 / 技术要点 / 蒸馏失败重试 见 [DEVELOPMENT.md](./DEVELOPMENT.md)。
提示词与智能模式蒸馏（公民指令 / 摘要 / 蒸馏） 见 [PROMPTS.md](./PROMPTS.md)。

## 版本历史

- **1.4.1**
    - 🐛修复输出预算使用错位的问题
    - 🐛增加调试模式日志级别 *默认info 仅输出元数据日志，debug 输出完整LLM text*
- **1.4.0**
    - 🔥智能模式增加最大输出Token限制
    - 🔥智能模式增加失败重试机制
    - 🔥智能模式会增加回馈存量记忆
    - 🐛修复自动记录部分设置位置错误问题
- **1.3.0**
    - 🔥新增计划模式禁止写入记忆
    - 💪设置-记忆控件样式优化 *使用dsh原生样式*
    - 💪清理重复patch信息
    - 🔥增加调试模式 *默认关闭，仅用于智能模式蒸馏失败输出调试信息*
- **1.2.3**
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

## 参考与致谢

本插件开发深度参考了以下两个开源项目（本包实现为各自机制的简化落地，不含其完整功能）：

- **[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)**
- **[dsh-sideband](https://github.com/ishuowang/dsh-sideband)**

## License

[MIT](./LICENSE)
