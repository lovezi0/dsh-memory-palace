# dsh-memory-palace

把 WorkBuddy 的文件式记忆系统移植进 [DeepSeek Harness](https://www.deepseek.com/) —— 为 Harness 提供**跨会话持久化、人类可直接编辑的 Markdown 记忆**。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

记忆就是普通文本文件，用记事本就能改。AI 每轮对话把它读进上下文，对话结束后把新内容追加进日志——不依赖任何私有格式、不落 JSON、不锁数据。

## 特性

- **人类可读的真源**：记忆全部存储在 Markdown 文件中（`MEMORY.md` + 每日日志 `YYYY-MM-DD.md`），任何编辑器可直接修改，数据永远属于你。
- **双层记忆**：用户级（跨项目个人偏好，默认 `~/.deepseek-harness/MEMORY.md`）+ 工作区级（项目约定，默认 `<cwd>/.deepseek-harness/memory/`）。
- **自动读写**：每轮对话将记忆注入系统提示词（同步读盘，零异步竞态）；每轮结束自动把对话摘要追加进当日日志。
- **日志蒸馏**：超过保留天数（默认 30 天）的每日日志自动蒸馏进 `MEMORY.md` 后删除，长期记忆持续沉淀。
- **WorkBuddy / CodeBuddy 桥接**：项目已存在 `.workbuddy/memory` 或 `.codebuddy/memory` 时直接读写这些目录，无需重复维护记忆。
- **三个记忆工具**：`memory_note`（项目级写入）、`memory_note_user`（用户级写入）、`memory_read`（聚合读取），全部内置去重，防止重复追加。
- **设置页集成**：DSH 设置中内置「记忆」面板（中英双语），所有配置均可图形化调整，无需改配置文件。
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

**写入（每轮结束）**——监听 `session/event` 的 `turn/end`，异步追加当日日志：

```
turn/end ──► 追加对话摘要到 YYYY-MM-DD.md（全部目标目录）
         └─► prune：超过 dailyLogRetentionDays 的日志
             蒸馏进 MEMORY.md 后删除
```

**工具**——AI 在对话中按需调用：

| 工具 | 层级 | 作用 |
|---|---|---|
| `memory_note` | 项目级 | 把约定/偏好写入当前项目全部目标 `MEMORY.md`（去重） |
| `memory_note_user` | 用户级 | 把跨项目偏好写入 `~/.deepseek-harness/MEMORY.md`（去重） |
| `memory_read` | 聚合 | 一次性读取用户级 + 项目级记忆、今日日志与最近 3 份历史日志 |

## 安装

前置要求：已安装 DeepSeek Harness 及其 CLI（`dsh` 命令可用）。

```bash
cd dsh-memory-palace
npm install
npm run build        # src/ → lib/（纯复制，零外部构建依赖）
dsh plugin --profile web add .    # 装入 web profile（profile 名按你的实际配置调整）
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
| `enabled` | `true` | 总开关，关闭后不注入、不写入 |
| `userMemoryPath` | `~/.deepseek-harness/MEMORY.md` | 用户级记忆文件路径（支持 `~` 展开） |
| `workspaceMemoryDir` | `.deepseek-harness/memory` | 无 buddy 目录时回退的项目记忆目录 |
| `dailyLogRetentionDays` | `30` | 每日日志保留天数，过期蒸馏进 `MEMORY.md` |
| `userBudgetChars` | `4000` | 注入系统提示词的用户级记忆长度上限（字符） |
| `workspaceBudgetChars` | `3000` | 注入系统提示词的工作区级记忆长度上限（字符） |
| `bridgeBuddyMemory` | `true` | 检测并直接读写 WorkBuddy / CodeBuddy 项目记忆目录 |
| `buddyWorkspaceMemoryDirs` | `[".workbuddy/memory", ".codebuddy/memory"]` | 要桥接的 buddy 目录列表（按优先级，已存在的全部同步写入） |

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
├── test-load.mjs          # 后端 cordis 单测（5 个场景：读写/桥接/去重/用户级/聚合读取）
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

- **0.5.1** — 开源发布：补充 README 与 LICENSE（MIT）。
- **0.5.0** — 新增 `memory_read` 聚合读取工具（用户级 + 项目级 + 今日 + 最近 3 份日志）。
- **0.4.0** — 新增 `memory_note` / `memory_note_user` 写入工具，内置内容去重。
- **0.3.0** — 前端「记忆」设置页（独立设置页 slot，中英双语）。
- **0.2.0** — 后端设置集成（`installSettingsSection` 注册配置面板）。
- **0.1.0** — 核心：双层 Markdown 记忆读写、系统提示词注入、每日日志与蒸馏。

## License

[MIT](./LICENSE)
