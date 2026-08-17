# dsh-memory-palace

把 WorkBuddy 的文件式记忆系统移植进 [DeepSeek Harness](https://www.deepseek.com/harness/) —— 为 Harness 提供**跨会话持久化、人类可直接编辑的 Markdown 记忆**。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

记忆就是普通文本文件，用记事本就能改。AI 每轮对话把它读进上下文，对话结束后把新内容追加进日志——不依赖任何私有格式、不落 JSON、不锁数据。

## 特性

- **人类可读的真源**：记忆全部存储在 Markdown 文件中（`MEMORY.md` + 每日日志 `YYYY-MM-DD.md`），任何编辑器可直接修改，数据永远属于你。
- **双层记忆**：用户级（跨项目个人偏好，默认 `~/.deepseek-harness/MEMORY.md`）+ 工作区级（项目约定，默认 `<cwd>/.deepseek-harness/memory/`）。
- **自动读写**：每轮对话将记忆注入系统提示词（同步读盘，零异步竞态）；每轮结束自动把轻量记录追加进当日日志（主路径由 agent 主动记，自动记录作兜底）。
- **日志蒸馏**：超过保留天数（默认 30 天）的每日日志自动蒸馏进 `MEMORY.md` 后删除，长期记忆持续沉淀。
- **WorkBuddy / CodeBuddy 桥接**：项目已存在 `.workbuddy/memory` 或 `.codebuddy/memory` 时直接读写这些目录，无需重复维护记忆。
- **记忆工具**：`memory_note`（项目级写入）、`memory_note_user`（用户级写入）、`memory_read`（聚合读取）、`memory_delete`（按内容删除，两阶段确认 + 原生确认弹窗），全部内置去重，防止重复追加。
- **设置页集成**：DSH 设置中内置「记忆」面板（中英双语），所有配置均可图形化调整，无需改配置文件。
- **主动记忆（主路径）**：注入「记忆公民指令」引导 agent 在「修复 bug/根因+绕过」「验证 build/test 通过」「完成里程碑/关键决策」「用户表达偏好/约束」时主动调 `memory_note` / `memory_note_user` 落档——零额外 LLM 调用、模型上下文完整，对标 WorkBuddy 的"智能记一笔"手感。
- **轻量兜底记录（可开关）**：每轮结束对「有实质内容/工具/错误/明确记一笔」的轮次自动写轻量记录到每日日志（不调 LLM）；纯闲聊/无价值轮次不写。
- **自动错误捕获（可开关）**：对话中出错时自动将「错误现象」按层级写入对应 `MEMORY.md`（用户级/项目级）；「根因/方案」由 agent 按记忆公民指令主动记；可在设置中关闭，默认开、关闭无需重启。
- **标准 npm 插件包**：经 `dsh plugin` 一键装入 profile，`cordis.patch.yml` 声明 bundle patch，零手动改动 harness。

## 记忆文件布局

```
~/.deepseek-harness/
└── MEMORY.md                      # 用户级记忆（跨项目个人偏好）

<项目根>/
├── .workbuddy/memory/             # 桥接 WorkBuddy 记忆（已存在时，按序优先）
│   ├── MEMORY.md                  # 项目级约定
│   └── 2026-08-16.md              # 每日工作日志
├── .codebuddy/memory/             # 桥接 CodeBuddy 记忆（已存在时）
└── .deepseek-harness/memory/      # 回退目录（无 buddy 目录时自动创建）
    ├── MEMORY.md
    └── 2026-08-16.md
```

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
# 锁定版本：dsh plugin --profile web add github:lovezi0/dsh-memory-palace#v0.5.1
```

方式二：clone 后本地安装（开发 / 修改源码场景）

```bash
git clone https://github.com/lovezi0/dsh-memory-palace.git
cd dsh-memory-palace
npm install
npm run build        # src/ → lib/（纯复制，零外部构建依赖）
dsh plugin --profile web add .    # 装入 web profile（profile 名按你的实际配置调整）
```

方式三：从 npm registry 安装（若已发布）

```bash
dsh plugin --profile web add dsh-memory-palace
```

卸载：

```bash
dsh plugin --profile web remove dsh-memory-palace
```

> `dsh plugin add .` 会在 profile 目录执行 `pnpm add <绝对路径>` 并自动把本包的 patch 层（`cordis.patch.yml`）注册进 profile 的 bundles。修改源码后重新 `npm run build` 并**重启 dsh** 即可生效，通常无需重新 add。

## 配置

可在 DSH 设置 →「记忆」面板中调整，或通过 profile 配置注入：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| 总开关 | `true` | 总开关，关闭后不注入、不写入 |
| 用户级记忆路径 | `~/.deepseek-harness/MEMORY.md` | 用户级记忆文件路径（支持 `~` 展开） |
| 工作区记忆目录 | `.deepseek-harness/memory` | 无 buddy 目录时回退的项目记忆目录 |
| 日志保留天数 | `30` | 每日日志保留天数，过期蒸馏进 `MEMORY.md` |
| 用户级记忆字数上限 | `4000` | 注入系统提示词的用户级记忆长度上限（字符） |
| 工作区级记忆字数上限 | `3000` | 注入系统提示词的工作区级记忆长度上限（字符） |
| 桥接 Buddy 记忆 | `true` | 检测并直接读写 WorkBuddy / CodeBuddy 项目记忆目录 |
| Buddy 记忆目录列表 | `[".workbuddy/memory", ".codebuddy/memory"]` | 要桥接的 buddy 目录列表（按优先级，已存在的全部同步写入） |

### 自动记录（设置页「记忆 → 自动记录」卡片）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| 轮次结束自动记录 | `true` | 它是「agent 主动记忆」主路径失效时的安全网，保证实质工作不丢，代价是只留原始文本、不做总结。 |
| 对话出错自动记录 | `true` | 自动捕获 in-session 错误并写入「错误现象」到对应 MEMORY.md；「根因/方案」由 agent 主动记；默认开启，**关闭无需重启 dsh** |

## 开发

### 目录结构

```
dsh-memory-palace/
├── src/
│   ├── index.mjs          # 插件后端入口（cordis 插件：name/Config/inject/apply）
│   └── client.js          # 前端 client bundle（设置页「记忆」面板，中英双语）
├── scripts/
│   └── build.mjs          # 构建脚本：src/ 纯复制到 lib/
├── cordis.patch.yml       # bundle patch：向 profile 注入本插件配置
├── test-load.mjs          # 后端 cordis 单测（主动记忆注入/轻量兜底/错误捕获/桥接/去重/删除/确认弹窗等 60+ 项）
├── test-client-smoke.mjs  # 前端 client bundle 冒烟测试
├── lib/                   # 构建产物（由 src/ 复制，勿手改）
└── package.json
```

### 构建与测试

```bash
npm run build
node test-load.mjs            # 后端单测：加载、注入、日志写入、buddy 桥接、去重、memory_read
node test-client-smoke.mjs    # 前端冒烟：bundle 注册、settings.section 注入、set/unset 接口
```

### 技术要点

- **纯复制构建**：`src/index.mjs`、`src/client.js` 都是标准 ESM，运行时由装载本包的 profile 解析 `@deepseek-ai/*` 依赖，因此 build 只是复制，零打包工具链。
- **同步读取**：`systemPrompt.section` 的 `text()` 必须同步（harness 源码不 await），故读盘用 `readFileSync`；写盘走异步 `node:fs/promises`，不在同步热路径上。
- **依赖约定**：`@deepseek-ai/*` 声明为 `peerDependencies`，运行时由 profile 的 `node_modules` 提供，本包不捆绑任何 harness 内部模块。
- **不引入 `dsh-storage`**：其 JSON 落地与"记忆必须可读的 Markdown"这一核心价值冲突，刻意排除。

## 版本历史

- **1.0.0** — 防闲聊闸门 / 记忆公民指令 / 新增删除记忆工具
- **outdated（0.x）** — 双层 Markdown 记忆读写 / 设置页集成等 0.x 历史，见 [CHANGELOG.md](./CHANGELOG.md)

## 废弃方案

插件侧 LLM 自动摘要（`ctx.llm.stream()` 路线）因契约/时机问题已废弃——4 个真机坑、深度调查结论与替代方案见 [废弃方案：为什么不用 LLM 自动摘要](./ABANDONED-LLM-SUMMARY.md)。

## License

[MIT](./LICENSE)
