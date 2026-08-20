// 构建脚本：把 src/ 下所有文件复制为 lib/（ESM），保证 index.mjs 引用的任意同级模块都能在 lib/ 解析。
// .mjs 已是标准 ESM，运行时 @deepseek-ai/* 由装载本包的 profile 的 node_modules 解析，
// 因此此处不需要打包/转译，纯复制 + 零依赖拼接即可保持 build 步骤存在且零外部依赖。
// 入口约定：src/index.mjs → lib/index.js（package.json main 指向 lib/index.js）；
//          src/client/*.js → lib/client.js（浏览器 bundle 单文件，dsh.client.inject 引用）。
import { mkdirSync, cpSync, copyFileSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// npm run build 运行时 cwd 即为包根目录。
const root = process.cwd();
const src = join(root, "src");
const lib = join(root, "lib");
mkdirSync(lib, { recursive: true });

// 递归复制整个 src/ 到 lib/（保持原扩展名，如 common/、distill.mjs、tools.mjs 等模块）。
if (existsSync(src)) cpSync(src, lib, { recursive: true });

// 服务端入口：src/index.mjs → lib/index.js（与 package.json main 对齐）。
copyFileSync(join(src, "index.mjs"), join(lib, "index.js"));
// 清理冗余：递归复制产生的 lib/index.mjs 与入口重命名后的 lib/index.js 内容重复，且无人引用（main 指向 index.js），删除以免随仓库分发。
rmSync(join(lib, "index.mjs"), { force: true });

// 浏览器 bundle：src/client/ 目录按序拼接 → lib/client.js（单自包含 bundle）。
// 背景：dsh 客户端模块系统（packages/client/modules）的 makeRequire/import 只认平台 seed、
// 已注册 factory 与 boot graph row，插件相对 require("./x") 会直接 throw——多文件必须经
// 零依赖拼接合为一个 bundle 才能被浏览器加载器消费；顺序即闭包作用域依赖顺序。
const CLIENT_PARTS = [
  "00-head.js",
  "10-locales.js",
  "20-common.js",
  "30-settings-section.js",
  "40-sparkle.js",
  "50-distill-button.js",
  "90-tail.js",
];
const clientDir = join(src, "client");
const clientSource = CLIENT_PARTS.map((f) => readFileSync(join(clientDir, f), "utf8")).join("\n\n");
writeFileSync(join(lib, "client.js"), clientSource);
// 移除递归复制产生的 lib/client/（parts 已拼入 lib/client.js，不随包分发）。
rmSync(join(lib, "client"), { recursive: true, force: true });

console.log("built lib/ from src/ (recursive copy + index.js entry rename + client bundle concat)");
