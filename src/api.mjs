// memory-palace 自有同源 route（/memory-palace/api）：设置读写（真保存）+ 手动蒸馏（会话/项目）。
// 经 registerApi 注入 ctx/paths/distill/运行时状态/设置面；在 index.mjs 装配时调用一次。
// 机制（v1.1.3）：client 直接 fetch 本 route，handler 内走服务端 settings.replace → settings-file 持久化，
// 绕开 settingsScope（非 loopback 下 set() no-op）与 apiproxy allowlist 两层限制（参考 dsh-better-sidebar）。
import { readMdSync } from "./common/text.mjs";

const API_MAX_BODY_BYTES = 1 << 20;

function apiHeader(headers, name) {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function apiParseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

function apiIsLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function apiCanonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

function apiIsTrustedAuthority(hostUrl, trustedHosts) {
  return (trustedHosts || []).some((entry) => {
    const entryUrl = apiParseAuthority(entry);
    if (entryUrl === undefined) return false;
    return apiCanonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

// 同源 + loopback/trusted 校验（照抄 dsh-better-sidebar 的 isTrustedApiRequest）。
function apiIsTrustedRequest(request, trustedHosts) {
  const host = apiHeader(request.headers, "host");
  if (host === undefined) return false;
  const hostUrl = apiParseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!apiIsLoopbackHostname(hostUrl.hostname) && !apiIsTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (apiHeader(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = apiHeader(request.headers, "origin");
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

async function apiReadJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > API_MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { code: "bad-request", status: 400 });
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("request body is not valid JSON"), { code: "bad-request", status: 400 });
  }
}

function apiWriteJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function apiWriteOk(res, value) {
  apiWriteJson(res, 200, { ok: true, value });
}

function apiWriteError(res, error) {
  apiWriteJson(res, error?.status ?? 500, {
    ok: false,
    error: {
      code: error?.code ?? "internal",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

/**
 * @param {{ ctx: object, paths: object, distill: object, state: object, getSettingsFace: () => object | null }} deps
 */
export function registerApi({ ctx, paths, distill, state, getSettingsFace }) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: "/memory-palace/api",
        handler: async (req, res) => {
          const fence = (r) => apiIsTrustedRequest(r, ctx.webRuntime?.trustedHosts ?? []);
          if (!fence(req)) {
            apiWriteJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
            return;
          }
          if (req.method !== "POST") {
            apiWriteJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
            return;
          }
          const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
          const method = pathname.startsWith("/memory-palace/api/") ? pathname.slice("/memory-palace/api/".length) : undefined;
          if (method === undefined || method.includes("/")) {
            apiWriteError(res, Object.assign(new Error("unknown memory-palace API method"), { code: "not-found", status: 404 }));
            return;
          }
          try {
            const payload = await apiReadJsonBody(req);
            const face = getSettingsFace();
            if (method === "settings.get") {
              apiWriteOk(res, face?.get() ?? { value: undefined, user: undefined, revision: undefined });
              return;
            }
            if (method === "settings.update") {
              const section = payload?.section;
              if (section === null || typeof section !== "object" || Array.isArray(section)) {
                throw Object.assign(new Error("section must be a plain object"), { code: "bad-request", status: 400 });
              }
              if (!face) {
                throw Object.assign(new Error("settings service is not mounted"), { code: "settings-rejected", status: 503 });
              }
              const expectedRevision = typeof payload?.expectedRevision === "number" ? payload.expectedRevision : undefined;
              apiWriteOk(res, await face.replace(section, expectedRevision));
              return;
            }
            // ---- v1.2.0 手动蒸馏（会话标题栏「记忆」按钮）----
            if (method === "distill.session" || method === "distill.project" || method === "distill.project.preview") {
              const sid = typeof payload?.sessionId === "string" ? payload.sessionId : "";
              // sessions 服务不在顶层 inject（测试环境无此服务时插件仍应激活），route 内惰性解析。
              let session = null;
              try {
                const store = ctx.get("sessions");
                session = store && typeof store.get === "function" ? store.get(sid) : null;
              } catch {
                session = null;
              }
              if (!session) {
                throw Object.assign(new Error(`session not found: ${sid || "(empty)"}`), { code: "not-found", status: 404 });
              }
              const cwd = session.header?.cwd ?? null;
              if (!cwd) {
                throw Object.assign(new Error("session has no cwd"), { code: "bad-request", status: 400 });
              }
              if (method === "distill.session") {
                const dirs = paths.writeDirs(cwd);
                if (!dirs.length) {
                  throw Object.assign(new Error("no memory dirs for this workspace"), { code: "bad-request", status: 400 });
                }
                // 整段会话全量蒸馏（fromSeq=0）；成功后推进增量断点，防智能模式对同段事件重复摘要。
                const r = await distill.distillSessionCore(session, dirs, 0);
                if (r.ok && session.id === state.summarySessionId) state.lastSummarizedSeq = session.seq;
                apiWriteOk(res, r);
                return;
              }
              if (method === "distill.project.preview") {
                const dirs = paths.writeDirs(cwd);
                if (!dirs.length) {
                  throw Object.assign(new Error("no memory dirs for this workspace"), { code: "bad-request", status: 400 });
                }
                const memFile = paths.memoryFileOf(dirs[0], cwd);
                apiWriteOk(res, { size: readMdSync(memFile).length });
                return;
              }
              // distill.project
              apiWriteOk(res, await distill.distillProjectMemory(cwd, session));
              return;
            }
            apiWriteError(res, Object.assign(new Error(`unknown memory-palace API method "${method}"`), { code: "not-found", status: 404 }));
          } catch (error) {
            apiWriteError(res, error);
          }
        },
      }),
    "memory-palace: /memory-palace/api routes",
  );
}
