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
      // v1.7.1（特性2）：折叠卡片的展开态（key → bool）。照抄宿主 ui-settings-plugins/PluginCard
      // 的语义 —— 纯前端临时状态、**不持久化**：「用户打开哪张卡」是一次阅读手势，不是配置。
      const [openCards, setOpenCards] = react.useState({});

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
            } else if (field === "silentPresets") {
              // v1.7.2：数组型配置（同 buddyWorkspaceMemoryDirs）。空串 → 空数组 = 关闭该机制。
              section[field] = text.split(",").map((s) => s.trim()).filter(Boolean);
            } else {
              if (text !== "") section[field] = text;
            }
          }
          const full = await apiUpdate(section, remote.revision);
          // 保存成功后同步 remote（真实返回值），保留当前 draft（= 用户保存的目标值）。
          setRemote({ value: full.value, user: full.user, revision: full.revision, loaded: true });
          setDirty(false);
          // 保存完成 = 这一轮编辑动作结束 → 收起全部卡片回到总览态（对齐宿主 PluginCard 行为）。
          setOpenCards({});
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

      // ---- v1.7.1（特性2）：折叠卡片样式 —— 逐值照抄宿主 ui-settings-plugins 的 PluginCard.module.css ----
      // 竖向「name 叠在 description 上」的卡片宿主无可复用组件（它导出的 DisclosureRow 是横向 24px
      // 紧凑行，布局不同，宿主 README 亦明确区分二者），故手写；chevron 用 data URI 内联 SVG
      // （本项目 client 只能 require("react")，不引宿主图标包）。
      const cardStyle = {
        border: "0.5px solid var(--dsw-alias-border-l4, #e5e7eb)",
        // ⚠️ 必须显式写 borderColor：展开/收起靠 React diff 增删 cardOpenStyle 的 borderColor。
        // 若只依赖 shorthand 的颜色，open 态写入的 borderColor 被移除后，CSSOM 中 border-color
        // 声明随之删除 → 回退 UA 初始值 currentColor（文字色，近黑）→ 收起后边框变黑（真机 bug）。
        borderColor: "var(--dsw-alias-border-l4, #e5e7eb)",
        borderRadius: "16px",
        marginBottom: "12px",
        background: "var(--dsw-alias-bg-layer-3, #fafafa)",
        overflow: "hidden"
      };
      const cardOpenStyle = {
        ...cardStyle,
        background: "var(--dsw-alias-bg-layer-2, #ffffff)",
        borderColor: "var(--dsw-alias-label-dimmed, #c9ced6)"
      };
      const cardHeaderStyle = {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        width: "100%",
        padding: "14px 16px",
        appearance: "none",
        WebkitAppearance: "none",
        border: "0",
        background: "none",
        font: "inherit",
        textAlign: "left",
        cursor: "pointer"
      };
      const cardHeadTextStyle = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "4px" };
      const cardNameStyle = {
        fontSize: "15px",
        fontWeight: "600",
        lineHeight: "1.4",
        color: "var(--dsw-alias-label-primary, #1f2329)"
      };
      const cardDescStyle = {
        fontSize: "13px",
        lineHeight: "1.5",
        color: "var(--dsw-alias-label-tertiary, #8a919f)"
      };
      const cardBodyStyle = {
        borderTop: "0.5px solid var(--dsw-alias-border-l2, #e5e7eb)",
        margin: "0 16px",
        paddingBottom: "8px"
      };
      const chevronStyle = {
        flexShrink: 0,
        width: "14px",
        height: "14px",
        backgroundImage:
          "url(data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14' fill='none'%3E%3Cpath d='M3.5 5.25L7 8.75L10.5 5.25' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E)",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
        backgroundSize: "14px 14px",
        transition: "transform .16s"
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

      const toggleCard = (key) => setOpenCards((o) => ({ ...o, [key]: !o[key] }));
      // 折叠卡片：header 自身是 button（整行可点 + aria-expanded + aria-label），body 仅在展开时渲染。
      const card = (key, title, desc, children) =>
        h("div", { style: openCards[key] ? cardOpenStyle : cardStyle }, [
          h("button", {
            type: "button",
            className: "mp-card-header",
            "aria-expanded": openCards[key] ? "true" : "false",
            "aria-label": `${t(openCards[key] ? "collapse" : "expand")}: ${title}`,
            style: cardHeaderStyle,
            onClick: () => toggleCard(key)
          }, [
            h("span", { style: cardHeadTextStyle }, [
              h("span", { style: cardNameStyle }, title),
              h("span", { style: cardDescStyle }, desc)
            ]),
            h("span", { style: openCards[key] ? { ...chevronStyle, transform: "rotate(180deg)" } : chevronStyle })
          ]),
          openCards[key] ? h("div", { className: "mp-card-body", style: cardBodyStyle }, children) : null
        ]);

      const num = (field) => ({
        type: "text",
        inputMode: "numeric",
        value: draft[field],
        disabled,
        style: { ...inputStyle, borderColor: validation === field ? "var(--dsw-alias-label-error, #d54941)" : "var(--dsw-alias-border-l2, #e5e7eb)" },
        onChange: (e) => edit(field, e.target.value)
      });

      return h("div", { className: "memory-palace-settings", style: sectionStyle }, [
        // 强制覆盖宿主 Webview 全局样式对原生 checkbox 尺寸的覆盖（内联 style 可能不敌全局 CSS）。
        h("style", null,
          ".memory-palace-settings input[type=checkbox]{width:18px!important;height:18px!important;margin:0;flex-shrink:0!important;cursor:pointer;}" +
          // v1.7.1（特性2）：展开区首条元素自带 borderTop（row/toggle 共用该样式），会与
          // .mp-card-body 的 border-top 叠成双线 → 去掉首条的边框与上内边距。
          ".memory-palace-settings .mp-card-body > *:first-child{border-top:0!important;padding-top:0!important;}" +
          ".memory-palace-settings .mp-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4b5bff);outline-offset:-2px;border-radius:16px;}"
        ),
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
        card("core", t("core"), t("coreDesc"), [
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
            }), "buddyWorkspaceMemoryDirs"),
          // v1.7.2：静默预设（极简模式等）。命中后本插件在该会话整体隐身（提示词/投影/工具/写入/子代理）。
          // 用普通文本输入（非 num —— 这里填的是预设 id 列表，不是数字）。
          row(t("silentPresetsLabel"), t("silentPresetsHint"),
            h("input", {
              type: "text",
              value: draft.silentPresets,
              disabled,
              style: { ...inputStyle, borderColor: "var(--dsw-alias-border-l2, #e5e7eb)" },
              placeholder: "minimal",
              onChange: (e) => edit("silentPresets", e.target.value)
            }), "silentPresets")
        ]),
        // v1.7.1（特性3）：自定义指令。非空时经 system prompt 追加到「记忆分工说明」之后；
        // 它是恒定内容（用户配置一次不变），故放 section 而非 E 投影 —— 零缓存成本。
        card("custom", t("custom"), t("customDesc"), [
          row(t("customLabel"), t("customHint"),
            h("textarea", {
              value: draft.customInstructions,
              disabled,
              rows: 6,
              placeholder: t("customPlaceholder"),
              style: {
                ...inputStyle,
                height: "auto",
                minHeight: "120px",
                padding: "10px 12px",
                lineHeight: "1.6",
                resize: "vertical"
              },
              onChange: (e) => edit("customInstructions", e.target.value)
            }), "customInstructions")
        ]),
        card("smartSummary", t("smartSummary"), t("smartSummaryDesc"), [
          // ---- v1.8.0：本卡片内三处删除已落地——① 记忆写入总开关：写入恒定进行，停写只剩
          // profile config 的 enabled=false 与静默预设（silentPresets，见「核心」卡片）；
          // ② 记忆模式下拉与模式条件块（随原 plugin / smart 两模式删除）；
          // ③ 错误自动记录、日志保留天数两项配置。
          // 记忆子代理参数提为常显（先前包在 hybrid 条件块里）。
          // 注意：本注释刻意不写已删配置的 key 字面量——client-smoke 有源码级负向断言守着。
          h("div", null, [
            row(t("reorgCooldownLabel"), t("reorgCooldownHint"), h("input", num("reorgCooldownDays")), "reorgCooldownDays"),
            row(t("subagentLogBudgetLabel"), t("subagentLogBudgetHint"), h("input", num("subagentLogBudget")), "subagentLogBudget")
          ]),
          // ---- v1.6.3：蒸馏/模型参数常显（v1.8.0 起 summaryModel 只被手动蒸馏与记忆子代理读取）----
          // summaryMaxTokens/projectMaxTokens/feedbackEnabled 覆盖「蒸馏会话」+「蒸馏项目记忆」两条手动链路。
          h("div", null, [
            row(t("summaryModelLabel"), t("summaryModelHint"),
              h("select", {
                // 已存储值不在下拉选项内（如旧版双前缀脏数据）→ 归零为「复用当前会话模型」，
                // 避免 select 显示悬空值、保存时又把脏值写回 profile 条目 config。
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
        ]),
        card("storage", t("storage"), t("storageDesc"), [
          row(t("userPathLabel"), t("userPathHint"), h("input", { ...num("userMemoryPath"), type: "text" }), "userMemoryPath"),
          row(t("wsDirLabel"), t("wsDirHint"), h("input", { ...num("workspaceMemoryDir"), type: "text" }), "workspaceMemoryDir"),
          // ---- v1.8.0：日志保留天数配置已删除 —— 日志由记忆子代理维护、永不过期不删 ----
          row(t("userBudgetLabel"), t("userBudgetHint"), h("input", num("userBudgetChars")), "userBudgetChars"),
          row(t("wsBudgetLabel"), t("wsBudgetHint"), h("input", num("workspaceBudgetChars")), "workspaceBudgetChars")
        ]),
        card("dev", t("dev"), t("devDesc"), [
          row(t("distillTimeoutLabel"), t("distillTimeoutHint"), h("input", num("summaryTimeoutMs")), "summaryTimeoutMs"),
          toggle(t("distillDebugLogLabel"), t("distillDebugLogHint"), "distillDebugLog")
        ])
      ]);
    }
