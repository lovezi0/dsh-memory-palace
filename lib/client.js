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

    function projectDraft(snap) {
      const v = snap && snap.value ? snap.value : {};
      return {
        bridgeBuddyMemory: v.bridgeBuddyMemory === false ? "false" : "true",
        buddyWorkspaceMemoryDirs: Array.isArray(v.buddyWorkspaceMemoryDirs) ? v.buddyWorkspaceMemoryDirs.join(", ") : ".workbuddy/memory, .codebuddy/memory",
        userMemoryPath: v.userMemoryPath || "~/.deepseek-harness/MEMORY.md",
        workspaceMemoryDir: v.workspaceMemoryDir || ".deepseek-harness/memory",
        dailyLogRetentionDays: v.dailyLogRetentionDays != null ? String(v.dailyLogRetentionDays) : "30",
        userBudgetChars: v.userBudgetChars != null ? String(v.userBudgetChars) : "4000",
        workspaceBudgetChars: v.workspaceBudgetChars != null ? String(v.workspaceBudgetChars) : "3000"
      };
    }

    function MemoryPalaceController(scope) {
      this.scope = scope;
    }
    MemoryPalaceController.prototype.inject = function () {
      const self = this;
      return {
        hooks: { memoryPalace: self.scope },
        set: (field, value) => self.scope.set(field, value),
        unset: (field) => self.scope.unset(field)
      };
    };

    function MemoryPalaceSection(props) {
      const { t, useMemoryPalace, set, unset } = props;
      const snap = useMemoryPalace((s) => s);
      const [draft, setDraft] = react.useState(() => projectDraft(snap));
      const [dirty, setDirty] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [failed, setFailed] = react.useState(false);
      const [validation, setValidation] = react.useState(null);

      react.useEffect(() => {
        if (snap.status === "ready" && !dirty) setDraft(projectDraft(snap));
      }, [snap, dirty]);

      const disabled = !snap.writable || saving;

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
        setDraft((d) => ({ ...d, [field]: projectDraft(snap)[field] }));
        setDirty(true);
        setFailed(false);
        if (FIELD_NUMERIC.has(field)) setValidation((v) => (v === field ? null : v));
      }

      async function save() {
        setSaving(true);
        setFailed(false);
        try {
          for (const field of Object.keys(draft)) {
            const text = draft[field].trim();
            if (field === "bridgeBuddyMemory") {
              await set(field, text === "true");
            } else if (FIELD_NUMERIC.has(field)) {
              if (text === "") await unset(field);
              else await set(field, Number(text));
            } else if (field === "buddyWorkspaceMemoryDirs") {
              const list = text.split(",").map((s) => s.trim()).filter(Boolean);
              await set(field, list);
            } else {
              if (text === "") await unset(field);
              else await set(field, text);
            }
          }
          setDraft(projectDraft(snap));
          setDirty(false);
        } catch (e) {
          setFailed(true);
        } finally {
          setSaving(false);
        }
      }

      function discard() {
        setDraft(projectDraft(snap));
        setDirty(false);
        setFailed(false);
        setValidation(null);
      }

      const h = react.createElement;

      const userLayer = snap && snap.user && typeof snap.user === "object" ? snap.user : {};
      const isOverridden = (field) => field in userLayer;

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
        snap.status === "ready" && !snap.writable ? h("p", { style: errStyle }, t("readOnly")) : null,
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
      const controller = new MemoryPalaceController(ctx.settingsScope.bind({ namespace: NS }));
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "memory-palace",
        order: 20,
        label: () => t("nav"),
        locale: NS,
        inject: () => controller.inject()
      }, MemoryPalaceSection));
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "settingsScope"];
    return module.exports;
  }
});
