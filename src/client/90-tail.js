    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "memory-palace: dictionaries");
      const t = ctx.locale.bind(NS);
      // 设置读写走自有 route（/memory-palace/api），不再 bind settingsScope——
      // 非 loopback 下 settingsScope persistence=memory（set() no-op），保存永不落盘。
      const controller = new MemoryPalaceController(ctx);
      // 设置面板 nav 条目换成自家 sparkle-twinkle 星标——宿主无 nav 图标位，
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
      // 枚举已配置模型改走 ctx.remote.session.modelCatalog()（ApiProxy 已删），
      // 枚举失败则降级为空列表。
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "memory-palace",
        order: 20,
        label: navLabel,
        locale: NS,
        inject: () => controller.inject()
      }, (props) => MemoryPalaceSection({ ...props, fetchModels: () => fetchModelOptions(ctx) })));
      // 会话标题栏「记忆」按钮（含 conversation.session.header.utilities 注入）已随
      // 「蒸馏项目记忆」功能整体移除——项目记忆重整改由会话命令 /memory_reorganize 触发。
    }

    exports.apply = apply;
    // connection → remote + remote.session（模型枚举走 ctx.remote.session.modelCatalog）。
    exports.inject = ["slots", "locale", "remote", "remote.session"];
    return module.exports;
  }
});
