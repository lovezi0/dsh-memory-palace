# 开发

## 目录结构

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

## 构建与测试

```bash
npm run build
node test-load.mjs            # 后端单测：加载、注入、日志写入、buddy 桥接、去重、memory_read
node test-client-smoke.mjs    # 前端冒烟：bundle 注册、settings.section 注入
```

## 技术要点

- **纯复制构建**：`src/index.mjs`、`src/client.js` 都是标准 ESM，运行时由装载本包的 profile 解析 `@deepseek-ai/*` 依赖，因此 build 只是复制，零打包工具链。
- **同步读取**：`systemPrompt.section` 的 `text()` 必须同步（harness 源码不 await），故读盘用 `readFileSync`；写盘走异步 `node:fs/promises`，不在同步热路径上。
- **依赖约定**：`@deepseek-ai/*` 声明为 `peerDependencies`，运行时由 profile 的 `node_modules` 提供，本包不捆绑任何 harness 内部模块。
- **不引入 `dsh-storage`**：其 JSON 落地与"记忆必须可读的 Markdown"这一核心价值冲突，刻意排除。
