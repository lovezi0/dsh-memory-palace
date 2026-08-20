window.__ModuleLoader__.load({
  id: "dsh-memory-palace",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");

    const NS = "memory-palace";


    const zh = {
      nav: "记忆",
      title: "记忆",
      intro: "memory-palace 记忆宫殿：跨会话持久化的 Markdown 记忆。",
      core: "核心",
      smartSummary: "自动记录",
      storage: "存储路径与预算",
      bridgeLabel: "桥接 buddy 项目记忆",
      bridgeHint: "项目已存在 .workbuddy / .codebuddy 记忆目录时直接读写，不再建 .deepseek-harness/memory/",
      dirsLabel: "buddy 记忆目录（逗号分隔，按序优先）",
      dirsHint: "例如：.workbuddy/memory, .codebuddy/memory",
      userPathLabel: "用户级记忆文件",
      userPathHint: "跨项目个人偏好记忆，默认 ~/.deepseek-harness/MEMORY.md",
      wsDirLabel: "工作区记忆目录（回退）",
      wsDirHint: "无 buddy 目录时回退到该目录，默认 .deepseek-harness/memory",
      retentionLabel: "日志保留天数",
      retentionHint: "超过该天数的每日日志会迁移进 MEMORY.md 后删除",
      userBudgetLabel: "用户级预算（字符）",
      userBudgetHint: "用户级 MEMORY.md 的最大字符数",
      wsBudgetLabel: "工作区预算（字符）",
      wsBudgetHint: "工作区 MEMORY.md 的最大字符数",
      summarizeLabel: "轮次结束自动记录",
      summarizeHint: "它是「agent 主动记忆」主路径失效时的安全网，保证实质工作不丢，代价是只留原始文本、不做总结。",
      autoCaptureErrorsLabel: "对话出错时自动记录到记忆",
      autoCaptureErrorsHint: "对话中（含代码运行报错、工具执行失败）出错时，自动把「错误现象」写入对应 MEMORY.md（用户级/项目级）；「根因/方案」由 agent 按记忆公民指令主动记。默认开，关闭无需重启。",
      memoryModeLabel: "记忆模式",
      memoryModeHintPlugin: "插件模式：记忆公民指令 + 轮次轻量 + 错误捕获。切换需重启 dsh 生效。",
      memoryModeHintSmart: "智能模式：LLM 智能会话摘要（summary→每日日志 + durable→MEMORY.md）。切换需重启 dsh 生效。",
      summaryModelLabel: "摘要模型（智能模式）",
      summaryModelHint: "留空=复用当前会话的 provider/model；也可固定廉价小模型省 token。",
      save: "保存",
      saving: "保存中…",
      discard: "放弃",
      unsaved: "未保存",
      overridden: "已覆盖",
      reset: "恢复默认",
      readOnly: "本部署的设置为只读。",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      invalidNumber: "请填数字；留空表示使用默认值。",
      // ---- v1.2.0 会话标题栏「记忆」按钮（蒸馏入口）----
      btnMemory: "记忆",
      distillSession: "蒸馏会话",
      distillProject: "蒸馏项目记忆",
      confirmSessionTitle: "确认蒸馏会话",
      confirmSessionTips: "插件已自动生成会话记忆，手动蒸馏可能会导致记忆重复。",
      confirmProjectTitle: "确认蒸馏项目记忆",
      confirmProjectTips: "只有当项目记忆过大时才建议蒸馏，过度蒸馏可能导致关键信息丢失，当前记忆大小：{size} 字符。",
      cancel: "取消",
      confirm: "确认",
      distilling: "蒸馏中…",
      notifySessionDone: "会话记忆蒸馏完成",
      notifyProjectDone: "项目记忆蒸馏完成",
      notifyFail: "记忆蒸馏失败"
    };

    const en = {
      nav: "Memory",
      title: "Memory",
      intro: "memory-palace: persistent, human-readable Markdown memory across sessions.",
      core: "Core",
      smartSummary: "Auto-record",
      storage: "Storage & budgets",
      bridgeLabel: "Bridge buddy project memory",
      bridgeHint: "Read/write directly into existing .workbuddy / .codebuddy memory dirs instead of creating .deepseek-harness/memory/",
      dirsLabel: "Buddy memory dirs (comma-separated, first wins)",
      dirsHint: "e.g. .workbuddy/memory, .codebuddy/memory",
      userPathLabel: "User memory file",
      userPathHint: "Cross-project preferences, default ~/.deepseek-harness/MEMORY.md",
      wsDirLabel: "Workspace memory dir (fallback)",
      wsDirHint: "Used when no buddy dir exists, default .deepseek-harness/memory",
      retentionLabel: "Daily log retention (days)",
      retentionHint: "Older logs are migrated into MEMORY.md then removed",
      userBudgetLabel: "User budget (chars)",
      userBudgetHint: "Max chars for the user-level MEMORY.md",
      wsBudgetLabel: "Workspace budget (chars)",
      wsBudgetHint: "Max chars for the workspace MEMORY.md",
      summarizeLabel: "Auto-record at turn end",
      summarizeHint: "It is the safety net when the 'agent proactive memory' main path fails: substantive work is never lost, at the cost of keeping only raw text without summarization.",
      autoCaptureErrorsLabel: "Auto-record conversation errors",
      autoCaptureErrorsHint: "On in-session errors, auto write the 'error' into the corresponding MEMORY.md (user/project); 'root cause / fix' is recorded proactively by the agent. On by default; off takes effect without restart.",
      memoryModeLabel: "Memory mode",
      memoryModeHintPlugin: "Plugin mode: memory-citizen instructions + turn-end light entries + error capture. Switching requires a dsh restart.",
      memoryModeHintSmart: "Smart mode: LLM conversation summarization (summary -> daily log + durable -> MEMORY.md). Switching requires a dsh restart.",
      summaryModelLabel: "Summary model (smart mode)",
      summaryModelHint: "Leave empty to reuse the current session's provider/model, or pin a cheap model (provider/model) to save tokens.",
      save: "Save",
      saving: "Saving…",
      discard: "Discard",
      unsaved: "Unsaved",
      overridden: "Overridden",
      reset: "Reset",
      readOnly: "Settings are read-only in this deployment.",
      saveFailed: "This deployment did not accept these values; they are kept for you to edit.",
      invalidNumber: "Enter a number; leave empty to use the default.",
      // ---- v1.2.0 session-header Memory button (distill entry) ----
      btnMemory: "Memory",
      distillSession: "Distill session",
      distillProject: "Distill project memory",
      confirmSessionTitle: "Confirm session distillation",
      confirmSessionTips: "The plugin already generates session memory automatically; manual distillation may create duplicates.",
      confirmProjectTitle: "Confirm project memory distillation",
      confirmProjectTips: "Distill only when project memory is too large; over-distillation may lose key info. Current size: {size} chars.",
      cancel: "Cancel",
      confirm: "Confirm",
      distilling: "Distilling…",
      notifySessionDone: "Session memory distilled",
      notifyProjectDone: "Project memory distilled",
      notifyFail: "Memory distillation failed"
    };


    const FIELD_NUMERIC = new Set(["dailyLogRetentionDays", "userBudgetChars", "workspaceBudgetChars"]);
    const FIELD_BOOL = new Set(["bridgeBuddyMemory", "summarize", "autoCaptureErrors"]);

    function projectDraft(snap) {
      const v = snap && snap.value ? snap.value : {};
      return {
        bridgeBuddyMemory: v.bridgeBuddyMemory === false ? "false" : "true",
        buddyWorkspaceMemoryDirs: Array.isArray(v.buddyWorkspaceMemoryDirs) ? v.buddyWorkspaceMemoryDirs.join(", ") : ".workbuddy/memory, .codebuddy/memory",
        userMemoryPath: v.userMemoryPath || "~/.deepseek-harness/MEMORY.md",
        workspaceMemoryDir: v.workspaceMemoryDir || ".deepseek-harness/memory",
        dailyLogRetentionDays: v.dailyLogRetentionDays != null ? String(v.dailyLogRetentionDays) : "30",
        userBudgetChars: v.userBudgetChars != null ? String(v.userBudgetChars) : "4000",
        workspaceBudgetChars: v.workspaceBudgetChars != null ? String(v.workspaceBudgetChars) : "3000",
        summarize: v.summarize === false ? "false" : "true",
        autoCaptureErrors: v.autoCaptureErrors === false ? "false" : "true",
        memoryMode: v.memoryMode || "plugin",
        summaryModel: v.summaryModel || ""
      };
    }

    function MemoryPalaceController(ctx) {
      this.ctx = ctx;
    }
    MemoryPalaceController.prototype.inject = function () {
      return {};
    };

    // v1.1.3：设置读写改走插件自有 route（/memory-palace/api）——dsh web 端 settingsScope 在
    // 非 loopback 连接下 persistence='memory'（set() no-op），apiproxy 又只暴露 allowlist namespace，
    // 设置页保存永远不落盘。同源 fetch 自己的 route 由服务端直写 settings-file，真正保存。
    async function apiGetFull() {
      const resp = await fetch("/memory-palace/api/settings.get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const parsed = await resp.json().catch(() => null);
      if (!parsed || parsed.ok !== true) throw new Error(parsed?.error?.message ?? `HTTP ${resp.status}`);
      // 服务端 viewOf() 整体作为 value：{ value, user, revision }。
      const v = parsed.value || {};
      return { value: v.value || {}, user: v.user || {}, revision: v.revision };
    }

    async function apiUpdate(section, expectedRevision) {
      const resp = await fetch("/memory-palace/api/settings.update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ section, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }),
      });
      const parsed = await resp.json().catch(() => null);
      if (!parsed || parsed.ok !== true) throw new Error(parsed?.error?.message ?? `HTTP ${resp.status}`);
      const v = parsed.value || {};
      return { value: v.value || {}, user: v.user || {}, revision: v.revision };
    }


    function MemoryPalaceSection(props) {
      const { t, getConnection } = props;
      const [remote, setRemote] = react.useState({ value: null, user: {}, revision: undefined, loaded: false });
      const [draft, setDraft] = react.useState(() => projectDraft({ value: null }));
      const [dirty, setDirty] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [failed, setFailed] = react.useState(false);
      const [validation, setValidation] = react.useState(null);
      const [modelOptions, setModelOptions] = react.useState([]);

      // 初始加载（从自有 route 读真实值，绕过 apiproxy allowlist）。
      react.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const full = await apiGetFull();
            if (alive) {
              setRemote({ value: full.value, user: full.user, revision: full.revision, loaded: true });
              setDraft(projectDraft({ value: full.value }));
            }
          } catch (e) {
            if (alive) setRemote((r) => ({ ...r, loaded: true }));
          }
        })();
        return () => { alive = false; };
      }, []);

      // 外部变更后校准 draft（仅未编辑时）。
      react.useEffect(() => {
        if (remote.loaded && remote.value && !dirty) setDraft(projectDraft(remote));
      }, [remote, dirty]);

      react.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const conn = getConnection && getConnection();
            if (!conn || !conn.api || !conn.api.llm || typeof conn.api.llm.models !== "function") return;
            const r = await conn.api.llm.models({});
            const groups = (r && r.result && r.result.value && r.result.value.groups) || (r && r.groups) || [];
            const opts = [];
            for (const g of groups || []) {
              for (const m of (g && g.models) || []) {
                opts.push({ value: g.id + "/" + m.id, label: g.name + " / " + m.name });
              }
            }
            if (alive) setModelOptions(opts);
          } catch (e) {
            /* 枚举失败：保持空列表，下拉只剩「复用当前会话模型」 */
          }
        })();
        return () => { alive = false; };
      }, []);

      react.useEffect(() => {
        if (remote.loaded && remote.value && !dirty) setDraft(projectDraft(remote));
      }, [remote, dirty]);

      const disabled = !remote.loaded || saving;

      function edit(field, text) {
        setDraft((d) => ({ ...d, [field]: text }));
        setDirty(true);
        setFailed(false);
        if (FIELD_NUMERIC.has(field)) {
          const valid = text === "" || (Number.isFinite(Number(text)) && String(Number(text)) === text.trim());
          setValidation((v) => (valid ? null : field));
        }
      }

      function resetField(field) {
        setDraft((d) => ({ ...d, [field]: projectDraft(remote)[field] }));
        setDirty(true);
        setFailed(false);
        if (FIELD_NUMERIC.has(field)) setValidation((v) => (v === field ? null : v));
      }

      async function save() {
        setSaving(true);
        setFailed(false);
        try {
          // 整节替换（replace 语义）：空值字段省略 → 自动回退 base/schema 默认。
          const section = {};
          for (const field of Object.keys(draft)) {
            const text = draft[field].trim();
            if (FIELD_BOOL.has(field)) {
              section[field] = text === "true";
            } else if (FIELD_NUMERIC.has(field)) {
              if (text !== "") section[field] = Number(text);
            } else if (field === "buddyWorkspaceMemoryDirs") {
              section[field] = text.split(",").map((s) => s.trim()).filter(Boolean);
            } else {
              if (text !== "") section[field] = text;
            }
          }
          const full = await apiUpdate(section, remote.revision);
          // 保存成功后同步 remote（真实返回值），保留当前 draft（= 用户保存的目标值）。
          setRemote({ value: full.value, user: full.user, revision: full.revision, loaded: true });
          setDirty(false);
        } catch (e) {
          setFailed(true);
        } finally {
          setSaving(false);
        }
      }

      function discard() {
        setDraft(projectDraft(remote));
        setDirty(false);
        setFailed(false);
        setValidation(null);
      }

      const h = react.createElement;

      const userLayer = remote.user && typeof remote.user === "object" ? remote.user : {};
      const isOverridden = (field) => field in userLayer;

      const toggle = (label, hint, field, disabledOverride) =>
        h("div", { style: toggleStyle }, [
          h("div", null, [
            h("p", { style: { ...labelStyle, margin: 0 } }, label),
            h("p", { style: hintStyle }, hint)
          ]),
          h("input", {
            type: "checkbox",
            checked: draft[field] === "true",
            disabled: disabled || disabledOverride,
            onChange: (e) => edit(field, e.target.checked ? "true" : "false")
          })
        ]);

      const row = (label, hint, control, field) => h("div", { style: fieldStyle }, [
        h("div", { style: headStyle }, [
          h("label", { style: labelStyle }, label),
          dirty && field ? h("span", { style: mutedBadgeStyle }, t("unsaved")) : null,
          !dirty && field && isOverridden(field) ? h("span", { style: badgeStyle }, t("overridden")) : null
        ]),
        control,
        hint ? h("p", { style: hintStyle }, hint) : null
      ]);

      const inputStyle = {
        boxSizing: "border-box",
        width: "100%",
        border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
        background: "var(--dsw-alias-bg-layer-3, #fafafa)",
        height: "34px",
        font: "inherit",
        color: "var(--dsw-alias-label-primary, #1f2329)",
        borderRadius: "8px",
        padding: "0 12px",
        fontSize: "13px",
        lineHeight: "1.5"
      };
      const toggleStyle = {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "12px 0",
        borderTop: "1px solid var(--dsw-alias-border-l2, #e5e7eb)"
      };

      const cardStyle = {
        border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
        borderRadius: "12px",
        padding: "14px 16px",
        marginBottom: "12px",
        background: "var(--dsw-alias-bg-layer-2, #ffffff)"
      };
      const groupTitleStyle = {
        margin: "0 0 4px",
        fontSize: "13px",
        fontWeight: "500",
        color: "var(--dsw-alias-label-primary, #1f2329)"
      };
      const sectionStyle = {
        maxWidth: "760px",
        color: "var(--dsw-alias-label-primary, #1f2329)",
        display: "flex",
        flexDirection: "column",
        gap: "12px"
      };
      const headingStyle = { margin: 0, fontSize: "18px", fontWeight: "600" };
      const introStyle = { color: "var(--dsw-alias-label-tertiary, #8a919f)", margin: 0, fontSize: "13px" };
      const actionsStyle = { display: "flex", gap: "8px", alignItems: "center" };
      const btnPrimary = {
        border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
        background: "var(--dsw-alias-bg-module-platform, #f2f3f5)",
        color: "var(--dsw-alias-label-primary, #1f2329)",
        borderRadius: "8px",
        padding: "6px 14px",
        fontSize: "13px",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1
      };
      const btnAccent = {
        border: "1px solid var(--dsw-alias-brand-primary, #4b5bff)",
        background: "var(--dsw-alias-brand-primary, #4b5bff)",
        color: "#fff",
        borderRadius: "8px",
        padding: "6px 14px",
        fontSize: "13px",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1
      };
      const fieldStyle = {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "12px 0",
        borderTop: "1px solid var(--dsw-alias-border-l2, #e5e7eb)"
      };
      const headStyle = { display: "flex", alignItems: "center", gap: "8px" };
      const labelStyle = {
        minWidth: "0",
        color: "var(--dsw-alias-label-primary, #1f2329)",
        flex: 1,
        fontSize: "13px",
        fontWeight: "500",
        lineHeight: "1.5"
      };
      const badgeStyle = {
        whiteSpace: "nowrap",
        background: "var(--dsw-alias-bg-module-platform, #f2f3f5)",
        color: "var(--dsw-alias-label-secondary, #6b7280)",
        borderRadius: "999px",
        padding: "1px 8px",
        fontSize: "11px",
        fontWeight: "500",
        lineHeight: "17px"
      };
      const mutedBadgeStyle = {
        whiteSpace: "nowrap",
        color: "var(--dsw-alias-label-tertiary, #8a919f)",
        borderRadius: "999px",
        padding: "1px 8px",
        fontSize: "11px",
        lineHeight: "17px"
      };
      const hintStyle = { color: "var(--dsw-alias-label-tertiary, #8a919f)", margin: 0, fontSize: "12px", lineHeight: "1.5" };
      const errStyle = { color: "var(--dsw-alias-label-error, #d54941)", margin: 0, fontSize: "12px", lineHeight: "1.5" };

      const num = (field) => ({
        type: "text",
        inputMode: "numeric",
        value: draft[field],
        disabled,
        style: { ...inputStyle, borderColor: validation === field ? "var(--dsw-alias-label-error, #d54941)" : undefined },
        onChange: (e) => edit(field, e.target.value)
      });

      return h("div", { style: sectionStyle }, [
        h("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" } }, [
          h("div", null, [
            h("h3", { style: headingStyle }, t("title")),
            h("p", { style: introStyle }, t("intro"))
          ]),
          h("div", { style: actionsStyle }, [
            h("button", { type: "button", style: btnPrimary, disabled, onClick: discard }, t("discard")),
            h("button", { type: "button", style: btnAccent, disabled, onClick: save }, saving ? t("saving") : t("save"))
          ])
        ]),
        failed ? h("p", { style: errStyle }, t("saveFailed")) : null,
        h("div", { style: cardStyle }, [
          h("p", { style: groupTitleStyle }, t("core")),
          h("div", { style: toggleStyle }, [
            h("div", null, [
              h("p", { style: { ...labelStyle, margin: 0 } }, t("bridgeLabel")),
              h("p", { style: hintStyle }, t("bridgeHint"))
            ]),
            h("input", {
              type: "checkbox",
              checked: draft.bridgeBuddyMemory === "true",
              disabled,
              onChange: (e) => edit("bridgeBuddyMemory", e.target.checked ? "true" : "false")
            })
          ]),
          row(t("dirsLabel"), t("dirsHint"),
            h("input", {
              ...num("buddyWorkspaceMemoryDirs"),
              type: "text",
              placeholder: ".workbuddy/memory, .codebuddy/memory"
            }), "buddyWorkspaceMemoryDirs")
        ]),
        h("div", { style: cardStyle }, [
          h("p", { style: groupTitleStyle }, t("smartSummary")),
          row(t("memoryModeLabel"), draft.memoryMode === "smart" ? t("memoryModeHintSmart") : t("memoryModeHintPlugin"),
            h("select", {
              value: draft.memoryMode === "smart" ? "smart" : "plugin",
              disabled,
              onChange: (e) => edit("memoryMode", e.target.value),
              style: { ...inputStyle, height: "34px" }
            }, [
              h("option", { value: "plugin" }, "插件模式"),
              h("option", { value: "smart" }, "智能模式")
            ]), "memoryMode"),
          draft.memoryMode === "smart"
            ? row(t("summaryModelLabel"), t("summaryModelHint"),
                h("select", {
                  value: draft.summaryModel || "",
                  disabled,
                  onChange: (e) => edit("summaryModel", e.target.value)
                }, [
                  h("option", { value: "" }, "复用当前会话模型"),
                  ...modelOptions.map((o) => h("option", { value: o.value }, o.label))
                ]), "summaryModel")
            : h("div", null, [
                toggle(t("summarizeLabel"), t("summarizeHint"), "summarize"),
                toggle(t("autoCaptureErrorsLabel"), t("autoCaptureErrorsHint"), "autoCaptureErrors")
              ])
        ]),
        h("div", { style: cardStyle }, [
          h("p", { style: groupTitleStyle }, t("storage")),
          row(t("userPathLabel"), t("userPathHint"), h("input", { ...num("userMemoryPath"), type: "text" }), "userMemoryPath"),
          row(t("wsDirLabel"), t("wsDirHint"), h("input", { ...num("workspaceMemoryDir"), type: "text" }), "workspaceMemoryDir"),
          row(t("retentionLabel"), t("retentionHint"), h("input", num("dailyLogRetentionDays")), "dailyLogRetentionDays"),
          row(t("userBudgetLabel"), t("userBudgetHint"), h("input", num("userBudgetChars")), "userBudgetChars"),
          row(t("wsBudgetLabel"), t("wsBudgetHint"), h("input", num("workspaceBudgetChars")), "workspaceBudgetChars")
        ])
      ]);
    }


    // ---- v1.2.0 会话标题栏「记忆」按钮（蒸馏入口）----
    // sparkle-twinkle.svg 内联（assets/ 不在 package.json files 数组、不随 npm 分发，不能按路径引用）。
    // 类名/渐变 id 加 mpd- 前缀防全局冲突；twinkle 动画 keyframes 由注入的样式表提供。
    const SPARKLE_SVG =
      '<svg width="14" height="14" viewBox="0 0 11 10" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="mpd-grad-1" x1="0" y1="3" x2="7" y2="10" gradientUnits="userSpaceOnUse">' +
      '<stop stop-color="#426EFE"></stop><stop offset="1" stop-color="#5979E1" stop-opacity="0.4"></stop></linearGradient>' +
      '<linearGradient id="mpd-grad-2" x1="6" y1="0" x2="10" y2="4" gradientUnits="userSpaceOnUse">' +
      '<stop stop-color="#426EFE"></stop><stop offset="1" stop-color="#4F70DC" stop-opacity="0.4"></stop></linearGradient></defs>' +
      '<path class="mpd-star-big" d="M3.80671 9.79513C3.72888 10.0318 3.39417 10.0318 3.31634 9.79513L2.8653 8.42365C2.66042 7.80074 2.17185 7.31217 1.54894 7.1073L0.177462 6.65626C-0.0591539 6.57843 -0.0591539 6.24371 0.177462 6.16589L1.54894 5.71484C2.17185 5.50997 2.66042 5.0214 2.8653 4.39849L3.31634 3.02701C3.39417 2.79039 3.72888 2.79039 3.80671 3.02701L4.25775 4.39849C4.46262 5.0214 4.9512 5.50997 5.57411 5.71484L6.94558 6.16589C7.1822 6.24371 7.1822 6.57843 6.94558 6.65626L5.57411 7.1073C4.9512 7.31217 4.46262 7.80074 4.25775 8.42365L3.80671 9.79513Z" fill="url(#mpd-grad-1)"></path>' +
      '<path class="mpd-star-small" d="M8.15819 3.90034C8.11449 4.03322 7.92653 4.03322 7.88282 3.90034L7.62954 3.13018C7.51449 2.78038 7.24013 2.50602 6.89033 2.39097L6.12016 2.13769C5.98729 2.09398 5.98729 1.90602 6.12016 1.86231L6.89033 1.60903C7.24013 1.49398 7.51449 1.21962 7.62954 0.869819L7.88282 0.0996549C7.92653 -0.0332183 8.11449 -0.0332183 8.15819 0.0996549L8.41148 0.869819C8.52653 1.21962 8.80089 1.49398 9.15069 1.60903L9.92085 1.86231C10.0537 1.90602 10.0537 2.09398 9.92085 2.13769L9.15069 2.39097C8.80089 2.50602 8.52653 2.78038 8.41148 3.13018L8.15819 3.90034Z" fill="url(#mpd-grad-2)"></path></svg>';

    // 一次性注入按钮/下拉/弹窗所需样式（含 twinkle keyframes）；id 防重复，挂载即注入不随卸载移除。
    function injectDistillStyles() {
      if (document.getElementById("memory-palace-distill-styles")) return;
      const style = document.createElement("style");
      style.id = "memory-palace-distill-styles";
      style.textContent = [
        "@keyframes mpd-tw1{0%,100%{opacity:1}50%{opacity:.3}}",
        "@keyframes mpd-tw2{0%,100%{opacity:1}50%{opacity:.3}}",
        ".mpd-star-big{animation:mpd-tw1 2s ease-in-out infinite}",
        ".mpd-star-small{animation:mpd-tw2 1.5s ease-in-out infinite .5s}",
        ".mpd-item:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f5)}"
      ].join("");
      document.head.appendChild(style);
    }


    // 会话标题栏「记忆」胶囊按钮：点击开合下拉（蒸馏会话/蒸馏项目记忆）→ 自绘确认弹窗 → fetch route → 浏览器通知。
    function DistillButton(props) {
      const h = react.createElement;
      const { sessionId, t } = props;
      const [open, setOpen] = react.useState(false);
      const [confirming, setConfirming] = react.useState(null); // "session" | "project" | null
      const [busy, setBusy] = react.useState(false);
      const [status, setStatus] = react.useState(""); // Notification 未授权时的内联降级提示
      const [size, setSize] = react.useState(null);
      const [hover, setHover] = react.useState(false);

      react.useEffect(() => { injectDistillStyles(); }, []);

      // 点击外部关闭下拉。
      react.useEffect(() => {
        if (!open) return;
        const onDoc = (e) => {
          const el = e && e.target;
          if (el && el.closest && !el.closest("[data-memory-palace-distill]")) setOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
      }, [open]);

      async function apiCall(method, body) {
        try {
          const resp = await fetch(`/memory-palace/api/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body || {}),
          });
          return await resp.json().catch(() => null);
        } catch (e) {
          return null;
        }
      }

      // 结果提示：优先浏览器通知（Notification 门控，参考 dsh-web-ui-notify）；未授权降级内联文本。
      function notify(title, body) {
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification(title, { body: body || "" });
            return;
          }
        } catch (e) { /* 通知不可用：降级内联 */ }
        setStatus((body || title || "").toString());
        window.setTimeout(() => setStatus(""), 8000);
      }

      async function pick(kind) {
        setOpen(false);
        if (kind === "project") {
          const r = await apiCall("distill.project.preview", { sessionId });
          const v = r && r.ok && r.value ? r.value : null;
          setSize(v && typeof v.size === "number" ? v.size : null);
        }
        setConfirming(kind);
      }

      async function run() {
        const kind = confirming;
        setConfirming(null);
        setBusy(true);
        try {
          const method = kind === "session" ? "distill.session" : "distill.project";
          const r = await apiCall(method, { sessionId });
          const v = r && r.ok ? r.value : null;
          const errMsg = r && r.error && r.error.message ? r.error.message : "";
          if (v && v.ok === true) {
            notify(kind === "session" ? t("notifySessionDone") : t("notifyProjectDone"), (v.summary || v.message || "").slice(0, 120));
          } else {
            notify(t("notifyFail"), errMsg || (v && v.message) || "");
          }
        } catch (e) {
          notify(t("notifyFail"), String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }

      const sizeText = size == null ? "…" : String(size).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      const caretStyle = {
        width: 0,
        height: 0,
        borderLeft: "3px solid transparent",
        borderRight: "3px solid transparent",
        borderTop: "4px solid currentColor",
        opacity: 0.65
      };
      // 胶囊按钮样式对齐「Session log」下载按钮（HeaderAction.module.css）。
      const pillStyle = {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "5px",
        height: "32px",
        padding: "6px 12px",
        border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
        borderRadius: "18px",
        background: hover ? "var(--dsw-alias-interactive-bg-hover, #f2f3f5)" : "transparent",
        color: "var(--dsw-alias-label-primary, #1f2329)",
        fontFamily: "var(--dsw-font-family, inherit)",
        fontSize: "13px",
        fontWeight: 400,
        lineHeight: "20px",
        cursor: busy ? "wait" : "pointer",
        whiteSpace: "nowrap",
        opacity: busy ? 0.7 : 1
      };
      const menuStyle = {
        position: "absolute",
        top: "calc(100% + 4px)",
        right: "0",
        minWidth: "176px",
        background: "var(--dsw-alias-bg-layer-2, #ffffff)",
        border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
        borderRadius: "12px",
        padding: "5px",
        zIndex: 100
      };
      const itemStyle = {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: "13px",
        color: "var(--dsw-alias-label-primary, #1f2329)",
        padding: "8px 10px",
        borderRadius: "8px",
        cursor: "pointer",
        lineHeight: "1.4"
      };
      const overlayStyle = {
        position: "fixed",
        inset: "0",
        background: "rgba(0,0,0,0.25)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000
      };
      const modalStyle = {
        background: "var(--dsw-alias-bg-layer-2, #ffffff)",
        border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
        borderRadius: "12px",
        padding: "16px",
        minWidth: "300px",
        maxWidth: "440px",
        boxSizing: "border-box"
      };
      const modalTitleStyle = { margin: "0 0 8px", fontSize: "14px", fontWeight: 500, lineHeight: "1.5" };
      const modalTipsStyle = {
        margin: "0 0 14px",
        fontSize: "13px",
        color: "var(--dsw-alias-label-secondary, #6b7280)",
        lineHeight: "1.6"
      };
      const modalActionsStyle = { display: "flex", justifyContent: "flex-end", gap: "8px" };
      const btnCancelStyle = {
        color: "var(--dsw-alias-label-secondary, #6b7280)",
        background: "var(--dsw-alias-bg-module-platform, #f2f3f5)",
        border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
        borderRadius: "8px",
        padding: "6px 14px",
        fontSize: "12px",
        fontWeight: 500,
        cursor: "pointer"
      };
      const btnOkStyle = {
        color: "#fff",
        background: "#426EFE",
        border: "1px solid #426EFE",
        borderRadius: "8px",
        padding: "6px 14px",
        fontSize: "12px",
        fontWeight: 500,
        cursor: "pointer"
      };
      const statusStyle = {
        position: "absolute",
        top: "calc(100% + 4px)",
        right: "0",
        maxWidth: "280px",
        background: "var(--dsw-alias-bg-layer-3, #fafafa)",
        border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
        borderRadius: "8px",
        padding: "6px 10px",
        fontSize: "12px",
        color: "var(--dsw-alias-label-secondary, #6b7280)",
        zIndex: 100
      };

      return h("div", { "data-memory-palace-distill": "", style: { position: "relative", display: "inline-flex" } }, [
        h("button", {
          type: "button",
          style: pillStyle,
          disabled: busy,
          title: t("btnMemory"),
          onClick: () => setOpen(!open),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false)
        }, [
          h("span", { dangerouslySetInnerHTML: { __html: SPARKLE_SVG } }),
          h("span", null, busy ? t("distilling") : t("btnMemory")),
          h("span", { style: caretStyle })
        ]),
        open
          ? h("div", { style: menuStyle }, [
              h("div", { className: "mpd-item", style: itemStyle, onClick: () => pick("session") }, t("distillSession")),
              h("div", { className: "mpd-item", style: itemStyle, onClick: () => pick("project") }, t("distillProject"))
            ])
          : null,
        status ? h("div", { style: statusStyle }, status) : null,
        confirming
          ? h("div", {
              style: overlayStyle,
              onClick: (e) => { if (e && e.target === e.currentTarget) setConfirming(null); }
            }, [
              h("div", { style: modalStyle }, [
                h("p", { style: modalTitleStyle }, confirming === "session" ? t("confirmSessionTitle") : t("confirmProjectTitle")),
                h("p", { style: modalTipsStyle }, confirming === "session" ? t("confirmSessionTips") : t("confirmProjectTips", { size: sizeText })),
                h("div", { style: modalActionsStyle }, [
                  h("button", { type: "button", style: btnCancelStyle, onClick: () => setConfirming(null) }, t("cancel")),
                  h("button", { type: "button", style: btnOkStyle, onClick: run }, t("confirm"))
                ])
              ])
            ])
          : null
      ]);
    }


    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "memory-palace: dictionaries");
      const t = ctx.locale.bind(NS);
      // v1.1.3：设置读写走自有 route（/memory-palace/api），不再 bind settingsScope——
      // 非 loopback 下 settingsScope persistence=memory（set() no-op），保存永不落盘。
      const controller = new MemoryPalaceController(ctx);
      // v1.1.0：枚举已配置模型供「摘要模型」下拉（connection 服务，枚举失败则降级为空列表）。
      const getConnection = () => {
        try {
          return ctx.get("connection");
        } catch {
          return null;
        }
      };
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "memory-palace",
        order: 20,
        label: () => t("nav"),
        locale: NS,
        inject: () => controller.inject()
      }, (props) => MemoryPalaceSection({ ...props, getConnection })));
      // v1.2.0：会话标题栏「记忆」按钮——headerUtilities 区（右对齐），order:-1 排在 Session log 左边。
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "memory-palace-distill",
        order: -1,
        locale: NS
      }, DistillButton));
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "connection"];
    return module.exports;
  }
});
