# dsh-memory-palace <img src="assets/memory-icon.svg" width="36" height="36" alt="dsh-memory-palace" />

把 WorkBuddy 的文件式记忆系统移植进 [DeepSeek Harness](https://www.deepseek.com/harness/) —— 为 Harness 提供**跨会话持久化、人类可直接编辑的 Markdown 记忆**。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE) [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com) [![npm](https://img.shields.io/npm/v/dsh-memory-palace.svg?label=npm&labelColor=000000&color=ff4b01)](https://www.npmjs.com/package/dsh-memory-palace) [![DeepSeek Harness:0.1.2-rc.1](https://img.shields.io/badge/DeepSeek%20Harness-0.1.2--rc.1-success.svg?labelColor=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

## 特性

- **人类可读的真源**：记忆以纯 Markdown 存储，任何编辑器都能直接修改，数据始终属于你。
- **双层记忆**：用户级（跨项目个人偏好）+ 工作区级（项目约定），互不干扰。
- **日志自动沉淀**：超过保留期的每日日志自动并入长期记忆，结论不丢。
- **WorkBuddy / CodeBuddy 桥接**：项目已有对应记忆目录时直接读写，无需重复维护。
- **记忆工具**：AI 可主动写入、聚合读取、按内容删除（删除需人工确认），写入自带去重。
- **手动蒸馏**：会话标题栏一键把当前对话或项目记忆提炼成长期记忆。
- **设置页集成**：全部配置均可在 DSH 设置面板中图形化调整，无需改配置文件。
- **主动记忆（插件模式）**：以指令引导 AI 在完成任务、修复问题、确定决策、获知偏好时主动落档。
- **智能模式**：由模型自动提炼每轮新增内容，摘要进日志、长期事实进记忆。
- **记忆注入**：长期记忆全程常驻、每个步骤都可见；今日日志按轮次注入，避免上下文膨胀。
- **混合模式（🔥推荐）**：子代理每轮自动整理日志并去重，长期记忆由主 AI 主动维护，兼顾自动化与可控性。
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
① 长期记忆：全程常驻，每个步骤都可见；内容未变只写一次，压缩后自动重注
② 今日日志：随系统提示词按轮次注入（高频变化，不进对话历史以免膨胀）
```

**写入（每轮结束）**——经「防闲聊闸门」判定后异步追加：

```
本轮结束 ──► 闸门：有工具调用 / 有错误 / AI 主动记 / 命中偏好·决策关键词 → 放行
         │      否则跳过（不写、不调模型）
         ├─► 摘要写入今日日志
         ├─► 出错且开启「自动记录错误」→ 错误现象写入长期记忆
         └─► 超期日志并入长期记忆后删除
```

日志文件头统一为日期标题，写入时自动补齐（历史文件不回填）。

**工具**——AI 在对话中按需调用：

| 工具 | 层级 | 作用 |
|---|---|---|
| `memory_note` | 项目级 | 把约定/偏好写入当前项目全部目标 `MEMORY.md`（去重） |
| `memory_note_user` | 用户级 | 把跨项目偏好写入 `~/.deepseek-harness/MEMORY.md`（去重） |
| `memory_read` | 聚合 | 一次性读取用户级 + 项目级记忆、今日日志与最近 3 份历史日志 |
| `memory_delete` | 用户级/项目级/每日级 | 按内容删除记忆条目（两阶段确认：先预览匹配位置与内容，用户确认后再删；删除动作经 harness 原生确认弹窗硬闸门，真人点允许才真正执行） |
| `memory_write`（hybrid） | 项目级/用户级 | 章节化写入：章节存在则末尾追加，不存在则新建章节（章节化格式规范） |
| `memory_update_section`（hybrid） | 项目级/用户级 | 整章节精确替换/单条标记删除：oldText 归一化精确匹配防 stale，失败拒绝并回显实际内容 |
| `memory_reorganize`（hybrid） | 仅项目级 | 全量重整 MEMORY.md：双门禁（超出注入预算 且 距上次重整 ≥ 冷却天数）机器校验，原子替换 + 时间戳注释，用户确认弹窗 |

## 安装

前置要求：已安装 DeepSeek Harness 及其 CLI（`dsh` 命令可用）。

方式一：直接通过 GitHub 安装（推荐，`lib/` 构建产物已随仓库分发，装即用）

```bash
dsh plugin --profile web add github:lovezi0/dsh-memory-palace
# 锁定版本：dsh plugin --profile web add github:lovezi0/dsh-memory-palace#v1.7.0
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

- **1.7.0**
    - 🔥新增独立通道注入记忆文件
    - 🐛修复存在多种记忆路径时读取冲突的问题
    - 💪优化记忆子 agent 投影消息节省 token
    - 💪优化 SUBAGENT_SYSTEM 记忆输出格式
- **1.6.3**
    - npm publish
    - **1.6.3.alpha.4**
        - 🐛修复三种记忆模式配置互串的问题
        - 🐛修复记忆子agent工具幻觉问题
- **1.6.2**
    - **1.6.2.alpha.4**
        - 🔥适配deepseek harness 0.1.2-alpha.4
    - **1.6.2.alpha.2**
        - 原1.6.0发布
- **1.6.1**
    - 原1.6.0.alpha.1发布
- **1.6.0**
    - 🔥适配deepseek harness 0.1.2-alpha.2
- **1.6.0.alpha.1** *未发布npm*
    - 🔥新增混合模式(hybrid) *仍默认插件模式，建议切换至混合模式*
    - 🔥新增记忆子agent处理轮次会话日志
    - 💪优化记忆文件结构做到真正人类可读
    - 💪优化调试模式参数保存
- **1.4.2.alpha.1** *未发布npm*
    - 💪记忆注入：仅首次注入 + compaction 重注
    - 💪优化手动项目蒸馏prompt
    - 💪[smart] 标签全移除
    - 🐛修复记忆文件LIFO/FIFO 错配
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
