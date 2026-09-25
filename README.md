# dsh-memory-palace <img src="assets/memory-icon.svg" width="36" height="36" alt="dsh-memory-palace" />

把 WorkBuddy 的文件式记忆系统移植进 [DeepSeek Harness](https://www.deepseek.com/harness/) —— 为 Harness 提供**跨会话持久化、人类可直接编辑的 Markdown 记忆**。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE) [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com) [![npm](https://img.shields.io/npm/v/dsh-memory-palace.svg?label=npm&labelColor=000000&color=ff4b01)](https://www.npmjs.com/package/dsh-memory-palace) [![DeepSeek Harness:0.1.7-rc.2](https://img.shields.io/badge/DeepSeek%20Harness-0.1.7--rc.2-success.svg?labelColor=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness) [![Desktop: supported](https://img.shields.io/badge/Desktop-supported-success.svg?labelColor=4D6BFE)](#安装)

## 特性

- **人类可读的真源**：记忆以纯 Markdown 存储，任何编辑器都能直接修改，数据始终属于你。
- **双层记忆**：用户级（跨项目个人偏好）+ 工作区级（项目约定），互不干扰。
- **WorkBuddy / CodeBuddy 桥接**：项目已有对应记忆目录时直接读写，无需重复维护。
- **记忆工具**：AI 可主动写入、聚合读取、按内容删除（删除需人工确认），写入自带去重。
- **手动蒸馏**：会话标题栏一键把当前对话或项目记忆提炼成长期记忆。
- **设置页集成**：全部配置均可在 DSH 设置面板中图形化调整（按板块折叠），无需改配置文件。
- **自定义指令**：不适合写进记忆的特殊指令可在设置页配置，插件经系统提示词注入。
- **记忆注入**：长期记忆与今日日志以「会话起始快照」常驻上下文、按文件身份各只注入一次 —— 既保证每个步骤都可见，又不破坏前缀缓存、不堆积冗余快照。
- **记忆写入（v1.8.0 起唯一模式）**：**记忆子代理**每轮自动整理今日日志并去重（章节化、标删），**长期记忆 `MEMORY.md` 由主 AI 主动维护**，兼顾自动化与可控性。
    - v1.8.0 破坏性变更：原「主动记忆（插件模式）」与「智能模式」已整体移除。二者的能力已被覆盖——主动落档由分工指令引导主 AI 承担，逐轮摘要由记忆子代理写进日志承担。
- **标准插件包**：经官方插件机制一键安装，无需改动 harness。

## 记忆文件布局

```
~/.deepseek-harness/
└── MEMORY.md                      # 用户级记忆（跨项目个人偏好）

<项目根>/
├── .workbuddy/memory/             # 桥接 WorkBuddy 记忆（存在时优先写入）
│   ├── MEMORY.md                  # 项目级约定（buddy 目录保持嵌套，兼容 WB/CB 原生格式）
│   └── 2026-08-16.md              # 每日工作日志
├── .codebuddy/memory/             # 桥接 CodeBuddy 记忆（存在时，结构同 .workbuddy）
└── .deepseek-harness/             # dsh 原生目录（读取恒在首位；无 buddy 时作为写入目标创建）
    ├── MEMORY.md                  # 项目级约定（长期记忆，与 memory/ 同级）
    └── memory/
        └── 2026-08-16.md          # 每日工作日志
```

## 工作原理

**读取（每轮对话）**——两条通道并行：

```
① 系统提示词（恒定）：记忆分工指令 / 自定义指令等固定内容，前缀缓存友好
② 对话历史投影（易变）：用户级 + 项目级长期记忆、今日日志——按文件身份各注入一次，压缩后自动重注最新版
```

> 投影**逐文件独立截断**：用户级 `MEMORY.md` 受「用户级预算」约束，项目级 `MEMORY.md` 与今日日志各受「工作区预算」约束、互不挤占 —— 预算说的是**每个文件**的上限，不是所有文件合计的总量。被截掉的部分不丢，随时可用 `memory_read` 读取。

**写入（每轮结束）**——交给记忆子代理异步处理：

```
本轮结束 ──► 前置闸门：enabled / 计划模式 / 静默预设 / 有可用记忆目录 → 否则跳过
         │
         ├─► 记忆子代理把本轮实质内容写成章节化条目 → 今日日志（重复/过时条目标删）
         └─► 长期记忆由主 AI 按分工指令主动维护（memory_write / memory_update_section）
```

日志文件头统一为日期标题，写入时自动补齐（历史文件不回填）。日志由子代理维护、**永不过期不删**（作为可追溯的证据层）。

> 写入没有独立的开关：**插件装上并启用即视为记忆写入启用**。停写只有两条路——profile config 里设 `enabled: false`，或命中静默预设（`silentPresets`）。

**工具**——AI 在对话中按需调用：

| 工具 | 层级 | 作用 |
|---|---|---|
| `memory_note` | 项目级 | 把约定/偏好写入当前项目全部目标 `MEMORY.md`（去重） |
| `memory_note_user` | 用户级 | 把跨项目偏好写入 `~/.deepseek-harness/MEMORY.md`（去重） |
| `memory_read` | 按需 | 读取记忆。`scope` 默认 `memory`（用户级 + 项目级）；可选 `project`（仅项目级，与 `memory_write` 的写侧 scope 同名）/ `today` / `yesterday` / `daily`（近三天日志）/ `all`（长期记忆 + 日志） |
| `memory_delete` | 用户级/项目级/每日级 | 按内容删除记忆条目（两阶段确认：先预览匹配位置与内容，用户确认后再删；删除动作经 harness 原生确认弹窗硬闸门，真人点允许才真正执行） |
| `memory_write` | 项目级/用户级 | 章节化写入：章节存在则末尾追加，不存在则新建章节（章节化格式规范） |
| `memory_update_section` | 项目级/用户级 | 整章节精确替换/单条标记删除：oldText 归一化精确匹配防 stale，失败拒绝并回显实际内容 |
| `memory_reorganize` | 仅项目级 | 全量重整 MEMORY.md：双门禁（超出注入预算 且 距上次重整 ≥ 冷却天数）机器校验，原子替换 + 时间戳注释，用户确认弹窗 |

## 安装

### CLI 版（`web` profile）

方式一：直接通过 GitHub 安装（推荐，`lib/` 构建产物已随仓库分发，装即用）

```bash
dsh plugin --profile web add github:lovezi0/dsh-memory-palace
# 锁定版本：dsh plugin --profile web add github:lovezi0/dsh-memory-palace#v1.7.2
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

# 或先手动用 npm 安装（显式指定镜像），再装入：
npm install dsh-memory-palace --registry=https://registry.npmmirror.com/
dsh plugin --profile web add dsh-memory-palace
```
### CLI 版卸载

```bash
dsh plugin --profile web remove dsh-memory-palace
```

### Desktop 版
- github: `github:lovezi0/dsh-memory-palace`
- npm: `dsh-memory-palace`

## 配置
*面板路径为 DSH 设置 →「记忆」*
所有配置项（核心 / 自定义指令 / 记忆写入 / 存储路径与预算 / 开发 五张卡片的字段、默认值与说明）已整理至 [CONFIG.md](./CONFIG.md)

## 开发

架构 / 构建 / 技术要点 / 蒸馏失败重试 见 [DEVELOPMENT.md](./DEVELOPMENT.md)。
提示词与蒸馏（分工指令 / 会话蒸馏 / 项目蒸馏） 见 [PROMPTS.md](./PROMPTS.md)。

## 版本历史

- **1.8.0**
    - **1.8.0-alpha.1**
        - 💥移除插件模式与智能模式，记忆写入统一为混合模式
        - 💥配置项 memoryMode / autoCaptureErrors / dailyLogRetentionDays 删除（旧值静默失效）
        - 💥移除记忆写入总开关
        - 🐛memory文件格式错误时读取漂移的问题
        - 💪适配deepseek harness 0.1.7-rc.2
        - 💪适配deepseek harness desktop
- **v1.7.2-legacy** — dsh-memory-palace 从 v1.0.0 的基础记忆读写（防闲聊闸门、公民指令、删除工具）起步，逐步演进到 v1.7.2 的「混合模式 + 独立通道注入 + 自定义指令 + 记忆子 agent 蒸馏」，全程主线是不断增强记忆生成/注入方式，同时持续修复模式互串、工具串台、缓存堆积等稳定性缺陷。历史，见 [CHANGELOG.md](./CHANGELOG.md)
- **outdated（0.x）** — 双层 Markdown 记忆读写 / 设置页集成等 0.x 历史，见 [CHANGELOG.md](./CHANGELOG.md)

## 参考与致谢

本插件开发深度参考了以下两个开源项目（本包实现为各自机制的简化落地，不含其完整功能）：

- **[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)**
- **[dsh-sideband](https://github.com/ishuowang/dsh-sideband)**

## License

[MIT](./LICENSE)
