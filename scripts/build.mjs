// 构建脚本：把 src/ 下所有文件复制为 lib/（ESM），保证 index.mjs 引用的任意同级模块都能在 lib/ 解析。
// .mjs 已是标准 ESM，运行时 @deepseek-ai/* 由装载本包的 profile 的 node_modules 解析，
// 因此此处不需要打包/转译，纯复制即可保持 build 步骤存在且零外部依赖。
// 入口约定：src/index.mjs → lib/index.js（package.json main 指向 lib/index.js）；
//          src/client.js → lib/client.js（浏览器 bundle 入口，dsh.client.inject 引用）。
import { mkdirSync, cpSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// npm run build 运行时 cwd 即为包根目录。
const root = process.cwd();
const src = join(root, "src");
const lib = join(root, "lib");
mkdirSync(lib, { recursive: true });

// 递归复制整个 src/ 到 lib/（保持原扩展名，如 index.mjs、client.js 及未来新增的同目录模块）。
if (existsSync(src)) cpSync(src, lib, { recursive: true });

// 入口重命名：src/index.mjs → lib/index.js（与 package.json main 对齐）。
copyFileSync(join(src, "index.mjs"), join(lib, "index.js"));
// 浏览器 bundle：src/client.js → lib/client.js。
copyFileSync(join(src, "client.js"), join(lib, "client.js"));
// 清理冗余：递归复制产生的 lib/index.mjs 与入口重命名后的 lib/index.js 内容重复，且无人引用（main 指向 index.js），删除以免随仓库分发。
rmSync(join(lib, "index.mjs"), { force: true });

console.log("built lib/ from src/ (recursive copy + index.js/client.js entry rename)");
