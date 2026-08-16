# dsh-memory-palace 项目笔记

把 WorkBuddy 记忆系统移植为 DeepSeek Harness 插件（标准 npm 包）。

## 核心约束（不可妥协）
- 记忆真源 = 人类可读 Markdown（用户级 `~/.deepseek-harness/MEMORY.md` + 工作区 `<cwd>/.deepseek-harness/memory/{MEMORY.md, YYYY-MM-DD.md}`）。`.deepseek-harness` 命名贴合 harness（harness 真实数据目录约定是 `~/.dsh`，本插件单独用 `.deepseek-harness` 与 WorkBuddy 的 `.workbuddy` 解耦）。
- 排除 `dsh-storage`（落 JSON，破坏可读）。

## 架构（标准 npm 包）
- 入口 `src/index.mjs`（ESM JS）→ 经 `npm run build`（scripts/build.mjs 纯复制）产出 `lib/index.js`；`package.json` 的 `main` 指向它。
- 导出 `name='memory-palace'` + `Config` + `inject` + `apply`。读取：`systemPrompt.section` **同步**函数，每次 `readFileSync` 实时读盘（harness 的 section.text 不 await）。写入：`session/event` 的 `turn/end` → 异步追加当日日志；可选工具 `memory_note` → 写 `MEMORY.md`；>30 天日志蒸馏进 `MEMORY.md` 后删。
- `dsh.bundle.patch: "./cordis.patch.yml"` 声明本包的 patch 层；该文件里 `insert.name` 填【包名】`dsh-memory-palace`（不是路径），`id` 须等于入口导出的 cordis `name`（`memory-palace`）。

## 集成（dsh plugin 命令，harness 零手动改动）
- `dsh plugin --profile web add .` 本质：在 profile 目录跑 `pnpm add <绝对路径>`；`reconcilePlugins` 检查每个 dependency 是否声明 `dsh.bundle.patch`，有则自动加进 profile 的 `dsh.profile.bundles`（并软链进 profile/node_modules）。
- 安装（标准 npm 流程，等价于用户参考命令）：
  cd D:\Workspace\AI\workbuddy\dsh-memory-palace
  npm install
  npm run build
  dsh plugin --profile web add .
- 卸载：`dsh plugin --profile web remove dsh-memory-palace`
- 不要再手写 `profiles/web/cordis.patch.yml` 的 insert 块（旧方案），否则与 bundle 机制双重加载。

## 版本管理（AI 硬约定）
- **每次对插件做任何实质更新（新功能 / bug 修复 / 配置/文档变更）后，必须同步提升 `package.json` 的 `version`**（语义化版本：功能新增升 minor `0.x.0`，纯修复/小调整升 patch `0.x.y`）。
- 升版本与 `npm run build` 一起作为"更新完成"的收尾动作；未升版本视为更新未完成。
- 当前版本：`0.2.0`（设置页集成 feature）。

## 协作约定（AI 行为边界）
- 完成功能修改后，AI 必须**向用户给出重新部署插件的命令**，但**绝不得自己执行** `dsh plugin --profile web add` / `remove` 等部署/卸载操作——安装、重新加载、卸载一律由用户手动完成。
- 改完代码后的标准重新部署流程（供用户执行，AI 不代跑）：
  1. 重建（必做）：`cd D:\Workspace\AI\workbuddy\dsh-memory-palace && npm run build`（复制 src/index.mjs → lib/index.js；本插件以绝对路径 `dsh plugin --profile web add .` 装入 profile，profile 的 node_modules 软链指向本包，build 后即更新，**重启 dsh 生效**，通常无需再次 add）。
  2. 如需彻底重载：`dsh plugin --profile web remove dsh-memory-palace` → `npm run build` → `dsh plugin --profile web add .`。
  3. 验证：`env -u NODE_OPTIONS node D:/Workspace/AI/workbuddy/dsh-memory-palace/test-load.mjs`（本机 Windows 自动化环境 web/headless 静默，单测是唯一可观察通道）。

## 环境必知
- 依赖解析：`@deepseek-ai/*` 是 peerDependencies，运行时由装载本包的 profile 的 node_modules 提供；本包 `npm install` 会在 dsh-memory-palace/node_modules 装 peer 副本（独立目录，非符号链接，不污染 harness）。
- `NODE_OPTIONS` 必须 `env -u` 移除 genie-safe-delete shim，否则本机文件写操作被拦（Bash 下）。
- 该 Windows 自动化环境 web/headless 均静默退出（stdout 被吞），无法观察运行时；用 `test-load.mjs` 做 cordis 单测验证。

## DSH 设置页集成（`@deepseek-ai/dsh-settings`）
- 通过 `installSettingsSection` 将 `memory-palace` namespace 注册到 DSH 设置服务；运行时以 resolved settings（用户设置覆盖层 + cordis 组合 base）为准。
- 暴露字段：`enabled`、`bridgeBuddyMemory`、`buddyWorkspaceMemoryDirs`、`userMemoryPath`、`workspaceMemoryDir`、`dailyLogRetentionDays`、`userBudgetChars`、`workspaceBudgetChars`，均带 `.description()` 供 UI 渲染。
- `buddyWorkspaceMemoryDirs` 在设置表单中为字符串数组；`bridgeBuddyMemory` 为开关；用户修改后写入 `D:\DeepSeek Harness\settings.yaml`，无需改 `cordis.patch.yml`。
- 新增依赖：`@deepseek-ai/dsh-settings` 已加入 `peerDependencies` 与 `devDependencies`。

## 前端设置 UI（独立「记忆」设置页，v0.3.0 起）
- **双层架构**：后端 `installSettingsSection` 只注册数据层；UI 层是前端 slot 系统（`settings.section` = 左侧导航项，React 组件）。第三方插件要显示设置必须提供浏览器端 client bundle。
- `src/client.js` → `lib/client.js`（build 纯复制）：`window.__ModuleLoader__.load({id, factory})` 格式，手写 `React.createElement`（不引 tsdown）。注册 `settings.section`（id=`memory-palace`、order=20、label=记忆），组件用 `ctx.settingsScope.bind({namespace})` 读写，保存逐字段 `set/unset`。
- package.json 需声明 `exports["./client"]` 与 `dsh.client`（platform: web + inject 列表，仿 `dsh-client-ui-settings-general`）。
- 前端 cordis 服务 inject 名 = `["slots","locale","settingsScope"]`（settingsScope 由 dsh-client-ui-settings 提供）。
- 验证：`node test-client-smoke.mjs`（模拟 __ModuleLoader__ 环境）+ `node test-load.mjs`（后端）+ `node --check`。真实浏览器渲染需真机确认。

## 记忆写入工具（v0.4.0 起，含真实会话回放修复）
- `memory_note`：**项目级**（写 writeDirs() 全部目标 MEMORY.md），带去重（`appendLineDedup`：已含同内容行则跳过）。
- `memory_note_user`：**用户级**（写 `expandHome(cfg.userMemoryPath)`，默认 `~/.deepseek-harness/MEMORY.md`），自动 mkdir + 去重。跨项目个人偏好用它。
- `memory_read`（v0.5.0）：**读取全部记忆**——用户级 MEMORY.md + 项目级 MEMORY.md + 今日日志 + 最近 3 份历史日志。AI 说"读取记忆"时用它，禁止 AI 手动 glob/read 记忆文件（会漏掉每日日志，只找 MEMORY.md）。
- 教训（来自 `test/session.jsonl` 回放）：①插件必须提供写用户级记忆的工具，否则 AI 只能用 run_code 拼路径（沙箱 process.env 为空，HOME 不可得）；②写工具必须去重，否则 AI 反复调用同一内容会重复追加；③工具 description 要明确层级（项目级/用户级），避免误导；④读取也要提供聚合工具——AI 手动翻文件时查找模式不完整（只找 MEMORY.md，漏掉 YYYY-MM-DD.md）。
- dsh web 环境：除 `run_code` 外，其他工具**不可直接调用**（报 "unknown tool: only run_code is callable directly"），须在 run_code 里经 `tools.*` 调用——这是 web 策略，非插件问题。

## 验证命令
- 全链路：`node D:/Workspace/AI/workbuddy/dsh-memory-palace/test-load.mjs`（本机 Windows Git Bash 下 `env -u NODE_OPTIONS` 会命中错误 env 实现导致输出被吞；如确需绕过 genie-safe-delete shim，请用 `/usr/bin/env -u NODE_OPTIONS node ...`）。
