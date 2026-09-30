    // 会话标题栏「记忆」胶囊按钮：点击开合下拉（仅「蒸馏项目记忆」）→ 自绘确认弹窗 → fetch route → 浏览器通知。
    // v1.8.1：原「蒸馏会话」下拉项与整条会话蒸馏链路已移除，本按钮只剩项目记忆蒸馏。
    function DistillButton(props) {
      const h = react.createElement;
      const { sessionId, t } = props;
      const [open, setOpen] = react.useState(false);
      const [confirming, setConfirming] = react.useState(null); // "project" | null
      const [busy, setBusy] = react.useState(false);
      const [status, setStatus] = react.useState(""); // Notification 未授权时的内联降级提示
      const [size, setSize] = react.useState(null);

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

      // 唯一入口「蒸馏项目记忆」：先取当前 MEMORY.md 字符数（供确认弹窗提示），再开确认弹窗。
      async function pick() {
        setOpen(false);
        const r = await apiCall("distill.project.preview", { sessionId });
        const v = r && r.ok && r.value ? r.value : null;
        setSize(v && typeof v.size === "number" ? v.size : null);
        setConfirming("project");
      }

      async function run() {
        setConfirming(null);
        setBusy(true);
        try {
          const r = await apiCall("distill.project", { sessionId });
          const v = r && r.ok ? r.value : null;
          const errMsg = r && r.error && r.error.message ? r.error.message : "";
          if (v && v.ok === true) {
            notify(t("notifyProjectDone"), (v.message || "").slice(0, 120));
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
          className: "mpd-pill",
          disabled: busy,
          title: t("btnMemory"),
          onClick: () => setOpen(!open)
        }, [
          h("span", { dangerouslySetInnerHTML: { __html: SPARKLE_SVG } }),
          h("span", null, busy ? t("distilling") : t("btnMemory")),
          h("span", { style: caretStyle })
        ]),
        open
          ? h("div", { style: menuStyle }, [
              h("div", { className: "mpd-item", style: itemStyle, onClick: pick }, t("distillProject"))
            ])
          : null,
        status ? h("div", { style: statusStyle }, status) : null,
        confirming
          ? h("div", {
              style: overlayStyle,
              onClick: (e) => { if (e && e.target === e.currentTarget) setConfirming(null); }
            }, [
              h("div", { style: modalStyle }, [
                h("p", { style: modalTitleStyle }, t("confirmProjectTitle")),
                h("p", { style: modalTipsStyle }, t("confirmProjectTips", { size: sizeText })),
                h("div", { style: modalActionsStyle }, [
                  h("button", { type: "button", style: btnCancelStyle, onClick: () => setConfirming(null) }, t("cancel")),
                  h("button", { type: "button", style: btnOkStyle, onClick: run }, t("confirm"))
                ])
              ])
            ])
          : null
      ]);
    }
