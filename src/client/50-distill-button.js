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
