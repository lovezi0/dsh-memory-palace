# 废弃方案：为什么不用 LLM 自动摘要（`ctx.llm.stream()` 路线已废弃）

> 本文记录 dsh-memory-palace 曾尝试、后经真机验证不可行的「插件侧 LLM 自动摘要」方案，
> 以及放弃它的原因与替代方案。完整决策背景与调查过程见 `plans/v0.7.0.md`「方案修订」章节。

早期版本（v0.7.0 草案）曾尝试在每轮结束（`turn/end`）后由插件自行调用 `ctx.llm.stream()` 生成对话摘要写入每日日志。真机测试连续暴露 4 个契约/时机问题，深度调查后确认该模式不可行，**v0.7.1 起已废弃**，改为「记忆公民 prompt 主动记忆」主路径。

## 踩过的 4 个坑（均为真机实测）

1. **`messages.map is not a function`**：`createUserMessage` 返回单条 message，须包成数组传入；用错契约直接抛错。
2. **工具任务不落记忆**：`tool/result` 的文本嵌套在 `ToolResultBlock.content` 内层，只取顶层 `.text` 取到空串，含工具的轮次被误判为"无内容"。
3. **多 turn 丢记忆**：dsh agent 会把一次请求拆成多个 turn，若每个 `turn/end` 都清空缓冲，摘要拿到的就是残缺片段。
4. **`callLlm 跳过`**：`requestHeader()` 在首个快照前返回 `undefined`，且 header 未变化时不重发事件——provider/model 解析时机不稳，经常拿不到模型配置而跳过。

## 深度调查结论

- `ctx.llm.stream` 是 harness **唯一且标准**的 LLM 调用途径（compaction、session-title 等官方生态均用它；`LlmRuntime` 无 complete/generate 替代，也没有"取当前默认模型"的 API，`resolveModelInfo`/`resolveCallConfig` 都必须显式传 route）——**换工具不存在**。
- 根因不在工具本身，而在「**插件侧在 turn/end 后自行调 LLM**」这个模式：必须完整满足 provider 显式传参、调用时机敏感、流式协议（`BlockAssembler` 组装、`finish.kind` 表达失败而非抛异常）等脆弱契约，且每一轮都额外消耗一次 token。
- 历史事件不重放给插件（`constructor seeds do not emit`）——启动时日志里的 `callLlm 跳过` 正是来自真实新消息的时机窗口。

## 替代方案（v0.7.1 起）

| 角色 | 方案 | 说明 |
|---|---|---|
| 主路径 | 记忆公民 prompt 主动记忆 | 注入「记忆公民指令」，让 agent 在对话中主动调 `memory_note`/`memory_note_user` 落档：零额外 LLM 调用、模型上下文完整、无 provider 解析问题（对标 WorkBuddy 的"智能记一笔"手感） |
| 兜底 | 轮次结束自动记录 | `turn/end` 基础闸门（工具/错误/关键词/已主动记）命中 → 写原始文本截断的轻量条目，**不调 LLM** |
| 错误捕获 | 只记现象 | 检测到错误写「错误现象」到对应 MEMORY.md；根因/方案由 agent 按记忆公民指令主动记 |

> 结论：**不做插件侧自动摘要**。高质量记忆靠 agent 主动记，插件只做轻量兜底保底。
