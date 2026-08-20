    const FIELD_NUMERIC = new Set(["dailyLogRetentionDays", "userBudgetChars", "workspaceBudgetChars"]);
    const FIELD_BOOL = new Set(["bridgeBuddyMemory", "summarize", "autoCaptureErrors"]);

    function projectDraft(snap) {
      const v = snap && snap.value ? snap.value : {};
      return {
        bridgeBuddyMemory: v.bridgeBuddyMemory === false ? "false" : "true",
        buddyWorkspaceMemoryDirs: Array.isArray(v.buddyWorkspaceMemoryDirs) ? v.buddyWorkspaceMemoryDirs.join(", ") : ".workbuddy/memory, .codebuddy/memory",
        userMemoryPath: v.userMemoryPath || "~/.deepseek-harness/MEMORY.md",
        workspaceMemoryDir: v.workspaceMemoryDir || ".deepseek-harness/memory",
        dailyLogRetentionDays: v.dailyLogRetentionDays != null ? String(v.dailyLogRetentionDays) : "30",
        userBudgetChars: v.userBudgetChars != null ? String(v.userBudgetChars) : "4000",
        workspaceBudgetChars: v.workspaceBudgetChars != null ? String(v.workspaceBudgetChars) : "3000",
        summarize: v.summarize === false ? "false" : "true",
        autoCaptureErrors: v.autoCaptureErrors === false ? "false" : "true",
        memoryMode: v.memoryMode || "plugin",
        summaryModel: v.summaryModel || ""
      };
    }

    function MemoryPalaceController(ctx) {
      this.ctx = ctx;
    }
    MemoryPalaceController.prototype.inject = function () {
      return {};
    };

    // v1.1.3：设置读写改走插件自有 route（/memory-palace/api）——dsh web 端 settingsScope 在
    // 非 loopback 连接下 persistence='memory'（set() no-op），apiproxy 又只暴露 allowlist namespace，
    // 设置页保存永远不落盘。同源 fetch 自己的 route 由服务端直写 settings-file，真正保存。
    async function apiGetFull() {
      const resp = await fetch("/memory-palace/api/settings.get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const parsed = await resp.json().catch(() => null);
      if (!parsed || parsed.ok !== true) throw new Error(parsed?.error?.message ?? `HTTP ${resp.status}`);
      // 服务端 viewOf() 整体作为 value：{ value, user, revision }。
      const v = parsed.value || {};
      return { value: v.value || {}, user: v.user || {}, revision: v.revision };
    }

    async function apiUpdate(section, expectedRevision) {
      const resp = await fetch("/memory-palace/api/settings.update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ section, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }),
      });
      const parsed = await resp.json().catch(() => null);
      if (!parsed || parsed.ok !== true) throw new Error(parsed?.error?.message ?? `HTTP ${resp.status}`);
      const v = parsed.value || {};
      return { value: v.value || {}, user: v.user || {}, revision: v.revision };
    }
