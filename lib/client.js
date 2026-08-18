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
      retentionHint: "超过该天数的每日日志会蒸馏进 MEMORY.md 后删除",
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
      invalidNumber: "请填数字；留空表示使用默认值。"
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
      retentionHint: "Older logs are distilled into MEMORY.md then removed",
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
      invalidNumber: "Enter a number; leave empty to use the default."
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
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "connection"];
    return module.exports;
  }
});
