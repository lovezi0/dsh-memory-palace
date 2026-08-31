window.__ModuleLoader__.load({
  id: "dsh-memory-palace",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    // v1.6.0-rc1：移除 require("@deepseek-ai/dsh-client-runtime/client")——该包在
    // DSH 0.1.2-alpha.2 已整体删除（原变量赋值后零使用），平台 seed 表的 react 足够。

    const NS = "memory-palace";
