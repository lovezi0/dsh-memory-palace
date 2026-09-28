// dsh-memory-palace v1.8.0-alpha.4：统一日志落盘模块。
//
// 背景：插件原先所有诊断输出走 console.error → dsh 服务端 stderr。但 Desktop 下 stderr 只进
// host 进程内存（apps/desktop/src/host-process.ts:204 存末 64KB），仅崩溃时随报告落盘，正常运行
// 时完全不可见；而插件其余落盘点只有 Markdown 记忆文件 —— 于是子代理的失败/跳过、蒸馏链路的
// 跳过原因全都无痕可查。
//
// 落点（与 dsh 原生 @deepseek-ai/dsh-plugin-manager 同构）：
//   <profileContext.dir>/.memory-palace/logs/<session-id>/<level>.log
//   其中 profileContext.dir = $DSH_HOME/profiles/<profile>。取径依据：宿主 CLI 与 Desktop 都经
//   同一个 runProfile 启动（apps/cli/src/profile-boot.ts:298 provide、apps/desktop-host/src/index.ts:25
//   runProfile({profile:'desktop'})），故 ctx.get('profileContext').dir 两端都可用。
//
// 门控：统一受 distillDebugLog 控制 —— false（默认）时零输出（既不写终端也不写文件）。
// 分级：按【行级别】分流 —— warn/info → info.log；debug → debug.log。
//
// 失败安全：调用方都位于 turn 结算 / pre-step 钩子栈上，抛错会污染整个 turn（agent/pre-step 抛错
// 毁 turn 是已知宿主契约），故所有 fs 错误一律吞掉；写入经独立 promise 链串行（不与记忆落盘锁
// 共用 —— 日志 IO 不得拖慢记忆写入，且二者语义无关）。
import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 单文件大小上限（字节）；超出后停止追加（不删旧内容）。 */
const MAX_FILE_BYTES = 1024 * 1024;
/**
 * 拿不到会话身份时的兜底目录名。
 * ⚠️ 必须与 index.mjs 既有的 `__nosession__` 约定一致（`sid || "__nosession__"`），
 * 否则会出现两套"无身份"目录并存，排查时难以判断哪份是哪条路径落的。
 */
const NO_SESSION = "__nosession__";

/** 本地时间戳（禁用 toISOString：UTC 会跨日错位，见 AGENTS.md §⑤）。 */
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/** JSON 化额外字段；循环引用等异常一律降级为字符串（日志失败不得影响主流程）。 */
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {{ ctx: object, getConfig: () => object }} deps
 * @returns {{ for: (sessionId?: string, scope?: string) => object }}
 */
export function createLogger({ ctx, getConfig }) {
  let chain = Promise.resolve(); // 独立写链（全局串行）
  const capped = new Set();      // 已达大小上限的文件（停止追加）
  const prepared = new Set();    // 已确保存在的目录

  // 落盘根 = profile 目录 + 私有尾目录。profileContext 缺失（测试 mock / 非 dsh 启动的宿主）时
  // 返回 null → 放弃落盘，绝不猜路径（process.cwd() 在 CLI 下是用户目录；import.meta.url 在
  // 本地软链安装下解析到开发仓库路径，二者都不可靠）。
  function logRoot() {
    const pc = typeof ctx?.get === "function" ? ctx.get("profileContext") : undefined;
    const dir = pc?.dir;
    return typeof dir === "string" && dir ? join(dir, ".memory-palace", "logs") : null;
  }

  function fileOf(root, sessionId, level) {
    const box = typeof sessionId === "string" && sessionId ? sessionId : NO_SESSION;
    return join(root, box, level === "debug" ? "debug.log" : "info.log");
  }

  async function put(file, text) {
    if (capped.has(file)) return;
    const dir = dirname(file);
    if (!prepared.has(dir)) {
      // 0700/0600：与原生 plugin-manager 同款收紧（日志含 cwd / sessionId / 路径等本机信息）。
      // Windows 下 mode 不生效但不报错（plugin-manager 同样如此）；Linux/macOS 上生效。
      await mkdir(dir, { recursive: true, mode: 0o700 });
      prepared.add(dir);
    }
    const info = await stat(file).catch(() => null);
    if (info !== null && info.size >= MAX_FILE_BYTES) {
      capped.add(file);
      return;
    }
    // mode 仅在文件首次创建时生效（已存在则忽略），故对新老文件都安全。
    await appendFile(file, text, { encoding: "utf8", mode: 0o600 });
  }

  /** 入链写入（fire-and-forget）：调用点同步返回，异常全部吞掉。 */
  function enqueue(file, text) {
    chain = chain.then(() => put(file, text)).catch(() => {});
  }

  /** 门控 + 取径 + 入链；任一环节不可用即静默返回。 */
  function emit(sessionId, level, scope, why, extra) {
    let cfg = null;
    try {
      cfg = getConfig();
    } catch {
      return;
    }
    if (!cfg?.distillDebugLog) return;
    const root = logRoot();
    if (!root) return;
    const tail = extra === undefined ? "" : ` ${safeJson(extra)}`;
    enqueue(fileOf(root, sessionId, level), `${stamp()} [${level}] ${scope} · ${why}${tail}\n`);
  }

  return {
    /** 等待已入链的写入全部落盘（测试用；生产侧 fire-and-forget，无需等待）。 */
    flush: () => chain,
    /**
     * 绑定会话与模块名，返回该作用域的日志器。
     * @param {string|undefined} sessionId 会话 id（缺省落 __nosession__/）
     * @param {string} scope 模块名（subagent / distill / projection / plugin）
     */
    for(sessionId, scope) {
      const name = scope || "plugin";
      return {
        /** 失败/跳过留痕（warn 级 → info.log）。 */
        dbgFail: (why, extra) => emit(sessionId, "warn", name, why, extra),
        /** 详单（debug 级 → debug.log）。 */
        dbg: (why, extra) => emit(sessionId, "debug", name, why, extra),
        /** 信息行（info 级 → info.log），如子代理终态台账。 */
        info: (why, extra) => emit(sessionId, "info", name, why, extra),
        /** LLM 原始响应等文本块（debug 级 → debug.log）；调用点须已过双门控。 */
        raw(text) {
          let cfg = null;
          try {
            cfg = getConfig();
          } catch {
            return;
          }
          if (!cfg?.distillDebugLog) return;
          const root = logRoot();
          if (!root) return;
          enqueue(
            fileOf(root, sessionId, "debug"),
            `${stamp()} [debug] ${name} · llm raw text begin >>>\n` +
              `--------------------------->\n${text}\n<----------------------------\n` +
              `${stamp()} [debug] ${name} · llm raw text end <<<\n`,
          );
        },
      };
    },
  };
}
