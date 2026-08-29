// v1.4.1 单测：budgetClip（结构行 + 尾部最新条目）与 stripSmartTag（行首标签剥除）。
// 运行：/usr/bin/env -u NODE_OPTIONS node test-v1.4.1.mjs
import assert from "node:assert/strict";
import { budgetClip, stripSmartTag } from "./src/common/text.mjs";

// ---------- budgetClip ----------

// 1. 不超预算原样返回
{
  const t = "# 标题\n- 条目一";
  assert.equal(budgetClip(t, 500), t);
}

// 2. budget<=0 视为不限
{
  const t = "# 标题\n- 条目一\n- 条目二\n- 条目三";
  assert.equal(budgetClip(t, 0), t);
  assert.equal(budgetClip(t, undefined), t);
}

// 3. 超预算：头部结构行保留 + 尾部最新条目保留 + 中间截断标记
{
  const lines = ["# new-api 记忆", "", "- 旧结论A", "- 旧结论B", "- 旧结论C", "- 新结论D"];
  const text = lines.join("\n");
  // 预算只够装 标题+空行 和最后一条
  const out = budgetClip(text, "# new-api 记忆\n".length + 1 + "- 新结论D".length);
  assert.ok(out.startsWith("# new-api 记忆"), "头部结构行应保留");
  assert.ok(out.endsWith("- 新结论D"), "尾部最新条目应保留");
  assert.ok(out.includes("已截断"), "应含截断标记");
  assert.ok(!out.includes("旧结论A"), "中间旧条目应被裁掉");
}

// 4. 多个结构行（含 <!-- 注释）全部保留
{
  const lines = ["# 标题", "<!-- distilled from 2026-08-01.md -->", "- 旧1", "- 旧2", "- 旧3", "- 旧4", "- 新"];
  const text = lines.join("\n");
  const out = budgetClip(text, "- 新".length + 2);
  assert.ok(out.includes("<!-- distilled from 2026-08-01.md -->"), "注释结构行应保留");
  assert.ok(out.endsWith("- 新"));
  assert.ok(!out.includes("- 旧1"));
}

// 5. 全是结构行时无内容行可装 → 只返回头部（不产生悬空标记）
{
  const text = "# 标题\n<!-- 注释 -->";
  const out = budgetClip(text, 1);
  assert.ok(out.includes("# 标题"));
  assert.ok(out.includes("<!-- 注释 -->"));
}

// 6. 极小预算至少保住一条尾部内容行（首行即放不下也不返回空 tail）
{
  const out = budgetClip("# 标题\n- 很长很长很长的条目\n- 新", 1);
  assert.ok(out.endsWith("- 新"), "至少保住尾部一条");
}

// 7. 空输入安全
assert.equal(budgetClip("", 100), "");
assert.equal(budgetClip(null, 100), null);

// ---------- stripSmartTag ----------

// 1. 单标签剥除，保留列表符
assert.equal(stripSmartTag("- [smart] 用户偏好中文"), "- 用户偏好中文");

// 2. 双标签（[smart] [smart]）剥净
assert.equal(stripSmartTag("- [smart] [smart] 用户偏好中文"), "- 用户偏好中文");

// 3. 无列表符的行首标签
assert.equal(stripSmartTag("[smart] 裸条目"), "裸条目");

// 4. 多行文本逐行处理（回喂 text 场景）
{
  const inText = "1|- [smart] 条目甲\n2|- [smart] [smart] 条目乙\n3|- 正常条目";
  const out = stripSmartTag(inText);
  assert.ok(out.includes("1|- 条目甲"));
  assert.ok(out.includes("2|- 条目乙"));
  assert.ok(out.includes("3|- 正常条目"));
}

// 5. 正文中间的 "smart" 字样不误伤
assert.equal(stripSmartTag("- 使用 smart 模式部署"), "- 使用 smart 模式部署");
assert.equal(stripSmartTag("- stripSmartTag 是内部函数"), "- stripSmartTag 是内部函数");

// 6. 缩进列表符兼容
assert.equal(stripSmartTag("  - [smart] 缩进条目"), "  - 缩进条目");

// 7. 空值安全
assert.equal(stripSmartTag(""), "");
assert.equal(stripSmartTag(null), null);
assert.equal(stripSmartTag(undefined), undefined);

console.log("test-v1.4.1: all assertions passed");
