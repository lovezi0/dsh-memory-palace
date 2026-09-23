    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "memory-palace: dictionaries");
      const t = ctx.locale.bind(NS);
      // v1.1.3：设置读写走自有 route（/memory-palace/api），不再 bind settingsScope——
      // 非 loopback 下 settingsScope persistence=memory（set() no-op），保存永不落盘。
      const controller = new MemoryPalaceController(ctx);
      // v1.7.2-alpha.2：设置面板 nav 条目换成自家 sparkle-twinkle 星标——宿主无 nav 图标位，
      // 走「label 传节点 + CSS 隐藏回退齿轮」两步（原理/失效面见 40-sparkle.js 的 ensureNavStarStyles）。
      ensureNavStarStyles();
      const navLabel = () =>
        react.createElement("span", { className: "mp-nav-label" }, [
          react.createElement("span", {
            key: "star",
            className: "mp-nav-star",
            "aria-hidden": "true",
            dangerouslySetInnerHTML: { __html: SPARKLE_SVG },
          }),
          t("nav"),
        ]);
      // v1.6.0-rc1：枚举已配置模型改走 ctx.remote.session.modelCatalog()（ApiProxy 已删），
      // 枚举失败则降级为空列表。
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "memory-palace",
        order: 20,
        label: navLabel,
        locale: NS,
        inject: () => controller.inject()
      }, (props) => MemoryPalaceSection({ ...props, fetchModels: () => fetchModelOptions(ctx) })));
      // v1.2.0：会话标题栏「记忆」按钮——headerUtilities 区（右对齐），order:-1 排在 Session log 左边。
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "memory-palace-distill",
        order: -1,
        locale: NS
      }, DistillButton));
    }

    exports.apply = apply;
    // v1.6.0-rc1：connection → remote + remote.session（模型枚举走 ctx.remote.session.modelCatalog）。
    exports.inject = ["slots", "locale", "remote", "remote.session"];
    return module.exports;
  }
});
