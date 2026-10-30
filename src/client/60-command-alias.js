    // 中文会话命令：宿主 server 命令名限 ^[a-z][a-z0-9_-]*$，中文无法直接注册；
    // 但 client 的 commandUi contribution 只查重名、不限字符集——把 name 写成中文，
    // 斜杠菜单即可用中文检索，回车 / 点选都能精确认领（与宿主 /model 的菜单行为同源）。
    // 执行链与英文命令完全一致：action 里转发 /memory_reorganize，服务端逻辑零分叉。
    const REORG_COMMAND_NAME = "memory_reorganize";
    const REORG_ALIAS_NAME = "记忆重整";

    // 命令反馈：command/run 与 command/done 都是宿主 log-only 事件，
    // 客户端要等下一次会话装载才随日志回放渲染——命令执行完当场"什么都没发生"。
    // 故命令结算后一律经 composer notice 立即回显（成功 info / 失败 error），
    // 不依赖会话流刷新，也不污染模型上下文。
    // 通道不可用时静默（会话流里最终仍有命令行，不影响主流程）。
    function notifyComposer(ctx, sessionId, level, text) {
      try {
        const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
        const actx = sessions && typeof sessions.scope === "function" ? sessions.scope(sessionId) : undefined;
        const conversation = actx && typeof actx.get === "function" ? actx.get("conversation") : undefined;
        if (conversation && conversation.input && typeof conversation.input.for === "function") {
          conversation.input.for(actx).notify(level, text);
        }
      } catch {
        /* 提示通道不可用：忽略 */
      }
    }

    function registerCommandAlias(ctx, t) {
      // commandUi 是可选服务：无命令面的部署（或测试替身）缺席时静默跳过，绝不阻塞主体。
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["commandUi"], (scope) => {
        const commandUi = scope && scope.commandUi;
        if (!commandUi || typeof commandUi.register !== "function") return;
        const contribution = {
          name: REORG_ALIAS_NAME,
          label: () => t("reorgAliasLabel"),
          description: () => t("reorgAliasDesc"),
          available: () => true,
          ui: {
            kind: "action",
            run: (session) => {
              const sessionId = session && session.sessionId;
              if (!sessionId) return;
              void (async () => {
                try {
                  // 成功/失败结果由下方的 command/executed 监听统一回显（转发同样会 emit）。
                  const response = await ctx.remote.commands.execute(sessionId, "/" + REORG_COMMAND_NAME, []);
                  if (!response || response.ok !== true) {
                    // RPC 本身失败（未进入 handler）→ 不会有 command/executed，自行提示。
                    const message = response && response.error && response.error.message
                      ? response.error.message
                      : "";
                    notifyComposer(ctx, sessionId, "error", t("commandFailed") + (message ? " " + message : ""));
                  }
                } catch (error) {
                  const message = error && error.message ? error.message : String(error);
                  notifyComposer(ctx, sessionId, "error", t("commandFailed") + " " + message);
                }
              })();
            }
          }
        };
        if (typeof scope.effect === "function") {
          scope.effect(() => commandUi.register(contribution), "memory-palace: 中文命令 alias");
        } else {
          commandUi.register(contribution);
        }
      });
      // 英文命令与中文别名的结算都经过这里：log-only 事件不实时推送，必须主动回显。
      if (typeof ctx.on === "function") {
        ctx.on("command/executed", (sessionId, name, result) => {
          if (name !== REORG_COMMAND_NAME || !result) return;
          const failed = result.kind === "error";
          const text = result.text || (failed ? t("commandFailed") : t("commandStarted"));
          notifyComposer(ctx, sessionId, failed ? "error" : "info", text);
        });
      }
    }
