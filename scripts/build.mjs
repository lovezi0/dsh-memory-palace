// 构建脚本：把 src/index.mjs 复制为 lib/index.js（ESM），把 src/client.js 复制为 lib/client.js（浏览器 bundle）。
// .mjs 已是标准 ESM，运行时 @deepseek-ai/* 由装载本包的 profile 的 node_modules 解析，
// 因此此处不需要打包/转译，纯复制即可保持 build 步骤存在且零外部依赖。
import { mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

// npm run build 运行时 cwd 即为包根目录。
const root = process.cwd();
mkdirSync(join(root, "lib"), { recursive: true });
copyFileSync(join(root, "src", "index.mjs"), join(root, "lib", "index.js"));
copyFileSync(join(root, "src", "client.js"), join(root, "lib", "client.js"));
console.log("built lib/index.js from src/index.mjs");
console.log("built lib/client.js from src/client.js");
