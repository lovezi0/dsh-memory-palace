// 前端 client bundle smoke test：模拟浏览器模块加载环境，验证
// 1) window.__ModuleLoader__.load 注册成功
// 2) factory 可执行，导出 apply/inject
// 3) apply 注册 settings.section slot，id/order/label 正确
// 4) inject face 提供 hooks.set/unset
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// 本文件位于 tests/ 下，lib 在仓库根，需向上一级。
const src = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let loaded = null;
global.window = {
  __ModuleLoader__: {
    load: (handoff) => {
      loaded = handoff;
    }
  }
};

const moduleCache = new Map();
function stubRequire(spec) {
  if (moduleCache.has(spec)) return moduleCache.get(spec);
  if (spec === "react") {
    const react = {
      createElement: (...a) => ({ stub: true, args: a }),
      useState: (s) => [typeof s === "function" ? s() : s, () => {}],
      useEffect: () => {},
      useMemo: (f) => f()
    };
    moduleCache.set(spec, react);
    return react;
  }
  // v1.6.0-rc1：@deepseek-ai/dsh-client-runtime/client 已被移除引用，未知 spec 继续走 throw
  // （顺带验证 bundle 无死引用）。
  throw new Error("unexpected require: " + spec);
}

// 在模块作用域内执行 bundle（IIFE，window 已注入）
const fn = new Function("window", src);
fn(global.window);

if (!loaded) throw new Error("FAIL: bundle did not register");
console.log("registered id =", loaded.id);

const exports_ = loaded.factory(stubRequire);
console.log("exports =", Object.keys(exports_));
console.log("inject =", JSON.stringify(exports_.inject));

const registrations = [];
let localeDict = null;
const ctx = {
  effect: (cb) => { if (typeof cb === "function") cb(); },
  // v1.6.0-rc1：模型枚举走 remote.session.modelCatalog（effect 被 stub 成 no-op，实际不触达；
  // 放这儿防御性兜底）。
  remote: {
    session: {
      modelCatalog: () => Promise.resolve({ ok: false })
    }
  },
  locale: {
    register: (ns, dict) => {
      localeDict = dict;
      console.log(
        "locale registered:",
        ns,
        "keys:",
        Object.keys(dict.zh).length,
        "zh +",
        Object.keys(dict.en).length,
        "en"
      );
    },
    bind: () => (key) => "[" + key + "]"
  },
  settingsScope: {
    bind: (spec) => {
      console.log("settingsScope bound:", JSON.stringify(spec));
      return {
        getSnapshot: () => ({ status: "ready", value: {}, writable: true }),
        subscribe: () => () => {},
        set: async () => {},
        unset: async () => {}
      };
    }
  },
  slots: {
    inject: (name, fn) => {
      registrations.push({ name, fn });
    },
    register: (options, component) => {
      return { name: options.name, options, component };
    }
  }
};

exports_.apply(ctx);
console.log(
  "slots.inject called for:",
  registrations.map((r) => r.name).join(", ")
);

// v1.6.0-rc1：锁定新 inject 清单（connection 已被 remote + remote.session 取代）。
const injectFace = exports_.inject;
if (!Array.isArray(injectFace) || !injectFace.includes("remote") || !injectFace.includes("remote.session") || injectFace.includes("connection")) {
  throw new Error("FAIL: unexpected inject face: " + JSON.stringify(injectFace));
}
const reg = registrations.find((r) => r.name === "settings.section");
if (!reg) throw new Error("FAIL: settings.section not injected");
const entry = reg.fn();
console.log(
  "section entry =",
  JSON.stringify({
    name: entry.name,
    id: entry.options.id,
    order: entry.options.order,
    label: entry.options.label(),
    hasComponent: typeof entry.component === "function"
  })
);
const injected = entry.options.inject ? entry.options.inject() : null;
console.log("inject face keys =", injected ? Object.keys(injected) : "none");
if (entry.options.id !== "memory-palace") throw new Error("FAIL: wrong section id");
if (typeof entry.component !== "function") throw new Error("FAIL: missing component");
// v1.1.3：设置读写改走自有 route（/memory-palace/api），inject face 不再提供 settingsScope set/unset。
if (injected === null) throw new Error("FAIL: inject face missing");

// ---- v1.7.1 特性2/3：折叠卡片渲染 + locale 键完整性 ----
// react 是 stub（createElement 返回 {stub:true,args}），故此处校验的是「组件可执行且渲染出预期结构」。
const tree = entry.component({ t: (k) => "T:" + k, fetchModels: async () => [] });
const walked = { headers: [], bodies: [] };
(function walk(node) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n);
    return;
  }
  if (typeof node !== "object" || !Array.isArray(node.args)) return;
  const props = node.args[1];
  if (props && typeof props === "object") {
    if (props.className === "mp-card-header") walked.headers.push(props);
    if (props.className === "mp-card-body") walked.bodies.push(props);
  }
  for (let i = 2; i < node.args.length; i++) walk(node.args[i]);
})(tree);

console.log("collapse cards =", walked.headers.length, "| open bodies =", walked.bodies.length);
if (walked.headers.length !== 5) throw new Error("FAIL: expected 5 collapsible cards, got " + walked.headers.length);
// 默认必须全部收起（升级计划特性2：每个板块默认仅显示 title + description）
if (walked.bodies.length !== 0) throw new Error("FAIL: cards must start collapsed");
for (const h of walked.headers) {
  if (h["aria-expanded"] !== "false") throw new Error("FAIL: card not collapsed: " + h["aria-label"]);
  if (typeof h["aria-label"] !== "string" || !h["aria-label"]) throw new Error("FAIL: card header missing aria-label");
}

const REQUIRED_KEYS = [
  "core", "coreDesc", "custom", "customDesc", "smartSummary", "smartSummaryDesc",
  "storage", "storageDesc", "dev", "devDesc", "expand", "collapse",
  "customLabel", "customHint", "customPlaceholder"
];
if (!localeDict) throw new Error("FAIL: locale dict not captured");
for (const k of REQUIRED_KEYS) {
  if (!(k in localeDict.zh)) throw new Error("FAIL: missing zh locale key: " + k);
  if (!(k in localeDict.en)) throw new Error("FAIL: missing en locale key: " + k);
}
const zhKeys = Object.keys(localeDict.zh).sort().join(",");
const enKeys = Object.keys(localeDict.en).sort().join(",");
if (zhKeys !== enKeys) throw new Error("FAIL: zh/en locale key sets differ");
console.log("locale keys:", Object.keys(localeDict.zh).length, "| zh ≡ en");

console.log("SMOKE OK");
