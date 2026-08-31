    // v1.6.0-rc1：模型枚举改走 ctx.remote.session.modelCatalog()——ApiProxy 包已在
    // DSH 0.1.2-alpha.2 删除（旧 conn.api.llm.models 死了）。服务缺席 / 非 ok / 异常
    // 一律降级为空列表，下拉只剩「复用当前会话模型」，UX 不变。
    async function fetchModelOptions(ctx) {
      try {
        const remote = ctx && ctx.remote;
        if (!remote || !remote.session || typeof remote.session.modelCatalog !== "function") return [];
        const response = await remote.session.modelCatalog();
        if (!response || !response.ok || !response.value) return [];
        const opts = [];
        for (const g of response.value.groups || []) {
          for (const m of (g && g.models) || []) {
            // m.id 已含 provider 前缀（如 nvidia/nemotron-3-ultra-550b-a55b），直接用，避免重复拼接
            opts.push({ value: m.id, label: (g.name || g.id) + " / " + (m.name || m.id) });
          }
        }
        return opts;
      } catch (e) {
        return [];
      }
    }

    function MemoryPalaceSection(props) {
      const { t, fetchModels } = props;
      const [remote, setRemote] = react.useState({ value: null, user: {}, revision: undefined, loaded: false });
      const [draft, setDraft] = react.useState(() => projectDraft({ value: null }));
      const [dirty, setDirty] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [failed, setFailed] = react.useState(false);
      const [validation, setValidation] = react.useState(null);
      const [modelOptions, setModelOptions] = react.useState([]);

      // 初始加载（从自有 route 读真实值）。
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
            const opts = await (fetchModels && fetchModels());
            if (alive) setModelOptions(Array.isArray(opts) ? opts : []);
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
              if (text !== "") {
                const n = Number(text);
                section[field] = field === "summaryTimeoutMs" ? n * 1000 : n;
              }
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

      // 左侧文字容器：min-width:0 + flexShrink:1 让长描述正常换行收缩，不再撑爆 flex 把 checkbox 挤变形。
      const toggleLabelBoxStyle = { flexShrink: 1, minWidth: 0 };
      const toggle = (label, hint, field, disabledOverride) =>
        h("div", { style: toggleStyle }, [
          h("div", { style: toggleLabelBoxStyle }, [
            h("p", { style: { ...labelStyle, margin: 0 } }, label),
            h("p", { style: hintStyle }, hint)
          ]),
          h("input", {
            type: "checkbox",
            checked: draft[field] === "true",
            disabled: disabled || disabledOverride,
            style: checkboxStyle,
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
      const selectStyle = {
        ...inputStyle,
        height: "34px",
        appearance: "none",
        WebkitAppearance: "none",
        backgroundImage: "url(data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E)",
        backgroundPosition: "right 12px center",
        backgroundRepeat: "no-repeat",
        backgroundSize: "12px 12px",
        paddingRight: "32px"
      };
      const checkboxStyle = {
        width: "18px",
        height: "18px",
        margin: "0",
        accentColor: "var(--dsw-alias-brand-primary, #4b5bff)",
        // 锁死：不被 flex 长描述挤压缩（flex-shrink 默认 1 会在布局阶段无视 width/!important）。
        flexShrink: 0,
        flexGrow: 0,
        alignSelf: "center"
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

      return h("div", { className: "memory-palace-settings", style: sectionStyle }, [
        // 强制覆盖宿主 Webview 全局样式对原生 checkbox 尺寸的覆盖（内联 style 可能不敌全局 CSS）。
        h("style", null, ".memory-palace-settings input[type=checkbox]{width:18px!important;height:18px!important;margin:0;flex-shrink:0!important;cursor:pointer;}"),
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
            h("div", { style: { flexShrink: 1, minWidth: 0 } }, [
              h("p", { style: { ...labelStyle, margin: 0 } }, t("bridgeLabel")),
              h("p", { style: hintStyle }, t("bridgeHint"))
            ]),
            h("input", {
              type: "checkbox",
              checked: draft.bridgeBuddyMemory === "true",
              disabled,
              style: checkboxStyle,
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
          // 轮次结束自动记录(summarize)：三种记忆模式的共用总闸门，始终显示，置于记忆模式之上、不随模式切换隐藏。
          toggle(t("summarizeLabel"), t("summarizeHint"), "summarize"),
          row(t("memoryModeLabel"),
            draft.memoryMode === "smart"
              ? t("memoryModeHintSmart")
              : draft.memoryMode === "hybrid"
                ? t("memoryModeHintHybrid")
                : t("memoryModeHintPlugin"),
            h("select", {
              value: ["plugin", "smart", "hybrid"].includes(draft.memoryMode) ? draft.memoryMode : "plugin",
              disabled,
              onChange: (e) => edit("memoryMode", e.target.value),
              style: selectStyle
            }, [
              h("option", { value: "plugin" }, "插件模式"),
              h("option", { value: "smart" }, "智能模式"),
              h("option", { value: "hybrid" }, "混合模式")
            ]), "memoryMode"),
          draft.memoryMode === "smart"
            ? h("div", null, [
                row(t("summaryModelLabel"), t("summaryModelHint"),
                  h("select", {
                    // 已存储值不在下拉选项内（如旧版双前缀脏数据）→ 归零为「复用当前会话模型」，
                    // 避免 select 显示悬空值、保存时又把脏值写回 settings.yaml。
                    value: modelOptions.some((o) => o.value === draft.summaryModel) ? draft.summaryModel : "",
                    disabled,
                    style: selectStyle,
                    onChange: (e) => edit("summaryModel", e.target.value)
                  }, [
                    h("option", { value: "" }, "复用当前会话模型"),
                    ...modelOptions.map((o) => h("option", { value: o.value }, o.label))
                  ]), "summaryModel"),
                toggle(t("feedbackEnabledLabel"), t("feedbackEnabledHint"), "feedbackEnabled"),
                row(t("summaryMaxTokensLabel"), t("summaryMaxTokensHint"), h("input", num("summaryMaxTokens")), "summaryMaxTokens"),
                row(t("projectMaxTokensLabel"), t("projectMaxTokensHint"), h("input", num("projectMaxTokens")), "projectMaxTokens")
              ])
            : draft.memoryMode === "hybrid"
              ? h("div", null, [
                  row(t("reorgCooldownLabel"), t("reorgCooldownHint"), h("input", num("reorgCooldownDays")), "reorgCooldownDays"),
                  row(t("subagentLogBudgetLabel"), t("subagentLogBudgetHint"), h("input", num("subagentLogBudget")), "subagentLogBudget")
                ])
              : h("div", null, [
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
        ]),
        h("div", { style: cardStyle }, [
          h("p", { style: groupTitleStyle }, t("dev")),
          row(t("distillTimeoutLabel"), t("distillTimeoutHint"), h("input", num("summaryTimeoutMs")), "summaryTimeoutMs"),
          toggle(t("distillDebugLogLabel"), t("distillDebugLogHint"), "distillDebugLog")
        ])
      ]);
    }
