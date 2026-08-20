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
