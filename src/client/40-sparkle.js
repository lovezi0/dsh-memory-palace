    // ---- v1.2.0 会话标题栏「记忆」按钮（蒸馏入口）----
    // sparkle-twinkle.svg 内联（client 侧只能 require("react")、不能按包内路径取资源；该文件也不在
    // package.json files 数组内，不随 npm 分发——files 里只多列了 assets/memory-icon.svg 供宿主插件面板读取）。
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

    // ---- v1.8.0 设置面板 nav 图标（「记忆」条目）----
    // 宿主 SettingsRoot.navIcon(id) 是**硬编码白名单**（account/models/agent-presets/plugins/archived-sessions），
    // 未列出的第三方 section 一律回退齿轮图标，且 slots 契约（id/order/label）没开 nav 图标位、
    // 官方文档亦无「从 manifest 取 nav 图标」的机制（manifest icon 只进插件管理面板的卡片/行）。
    // 故在插件边界内绕行两步：
    //   ① label 返回 React 节点 —— 宿主 ui-slots 的 resolveSlotLabel 是 `typeof label === 'function' ? label() : label`
    //      （原样返回、不做字符串强转），SettingsRoot 直接把它当 children 渲染，节点可行；
    //   ② 注入 CSS 用 :has() 命中「含本星标的 nav 按钮」，隐藏其**直接子 svg**（即宿主齿轮；星标在 label span 内部，不在命中面）。
    // 失效面：宿主若改结构/去掉 :has 支持 → 退化为「齿轮 + 星标」并排，不报错、不影响功能（有意选的可降级方案）。
    function ensureNavStarStyles() {
      if (typeof document === "undefined") return; // 非浏览器环境（单测/构建期）静默跳过
      injectDistillStyles(); // 星标动画 keyframes 与蒸馏按钮共用同一份样式表
      if (document.getElementById("memory-palace-nav-star-styles")) return;
      const style = document.createElement("style");
      style.id = "memory-palace-nav-star-styles";
      style.textContent = [
        // 星标容器：与宿主 navIcon 同尺寸（16px）、紧贴文字前。
        ".mp-nav-star{display:inline-flex;flex:none;align-items:center;margin-right:8px;line-height:0}",
        ".mp-nav-star svg{display:block;width:16px;height:16px}",
        "button:has(.mp-nav-star)>svg{display:none!important}"
      ].join("");
      document.head.appendChild(style);
    }
