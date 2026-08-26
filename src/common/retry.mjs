// memory-palace 蒸馏 LLM 调用失败重试（v1.4.0 特性2）。
// 纯函数 + 通用重试驱动，与具体 distill 逻辑解耦，可被 test-load.mjs 直接单测。
//
// 设计要点（已与用户确认）：
// - 错误分三类：retryable（5xx/网络/超时/中断，可重试）、limited（429/529 限流，可重试但分类不同）、
//   fatal（401/403/404 鉴权/模型不存在/永久客户端错误，不重试）。
// - 退避：指数退避 delay = min(BASE_DELAY_MS * FACTOR^attempt, MAX_DELAY_MS) + 抖动（≤15%）。
// - 上限：通用 MAX_RETRIES=3；500 类服务端错误单独限到 HTTP500_MAX_RETRIES=1（500 多为主服务挂，
//   重试意义不大且拖慢降级）。
// - 每次尝试【独立超时】：makeAttempt 内部每次新开 AbortSignal.timeout(timeoutMs)，避免单次超时耗尽累计预算。
export const RETRY_CONSTANTS = {
  BASE_DELAY_MS: 2000,
  FACTOR: 2,
  MAX_RETRIES: 3,
  MAX_DELAY_MS: 32000,
  HTTP500_MAX_RETRIES: 1,
};

// 把一个可能携带状态码的 error / finish.failure 归一为分类结果。
// 入参 err 可能是：stream 抛出的 Error、ctx.llm.stream 同步抛出的错误、或 finish.failure 对象。
export function classifyFailure(err) {
  const e = err && typeof err === "object" ? err : {};
  const status =
    e.status ??
    e.statusCode ??
    e.code ??
    e.response?.status ??
    (typeof e.status === "number" ? e.status : undefined);
  const code = e.code || e.name;
  const message = String(e.message || e.statusText || "")
    .concat(" ", String(e.response?.statusText || ""))
    .trim();

  // fatal：鉴权 / 模型不存在 / 永久客户端错误 —— 重试无意义。
  if (status === 401 || status === 403) return { kind: "fatal", status, message };
  if (status === 404) return { kind: "fatal", status, message };
  if (status === 400) return { kind: "fatal", status, message };

  // limited：限流 / 过载 —— 可重试，但 caller 可按 limited 走更激进退避（此处同用指数退避即可）。
  if (status === 429 || status === 529) return { kind: "limited", status, message };

  // retryable：5xx 服务端错误（含 500，单独限重试次数见 runWithRetry）。
  if (typeof status === "number" && status >= 500 && status < 600) {
    return { kind: "retryable", status, message };
  }

  // 网络类错误（连接重置/超时/连接拒绝）——DNS 解析失败(ENOTFOUND) 不重试（见升级计划：通常需人工干预）。
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "ENETUNREACH"
  ) {
    return { kind: "retryable", status, message };
  }

  // 超时 / 中断：AbortSignal 触发、显式 aborted/timeout 字样。
  if (
    e.name === "AbortError" ||
    code === "ABORT_ERR" ||
    /aborted|timeout|timed out|deadline/i.test(message)
  ) {
    return { kind: "retryable", status, message };
  }

  // 兜底：未知错误不盲目重试（避免死循环），按 fatal 处理。
  return { kind: "fatal", status, message };
}

// 指数退避 + 抖动（≤15%）。attempt 从 0 起算。
export function backoffDelayMs(attempt) {
  const { BASE_DELAY_MS, FACTOR, MAX_DELAY_MS } = RETRY_CONSTANTS;
  const n = Math.max(0, attempt | 0);
  const base = Math.min(BASE_DELAY_MS * Math.pow(FACTOR, n), MAX_DELAY_MS);
  const jitter = Math.random() * (base * 0.15);
  return Math.round(base + jitter);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 重试失败后的结构化错误（caller 据此降级，不向上抛裸 Error）。
export class LlmRetryExhausted extends Error {
  constructor(cls, attempts) {
    super(`llm call exhausted after ${attempts} attempt(s): ${cls.kind} ${cls.status || ""} ${cls.message}`);
    this.name = "LlmRetryExhausted";
    this.cls = cls;
    this.attempts = attempts;
  }
}

/**
 * 通用重试驱动。
 * @param {() => Promise<{ finish?: { kind?: string, failure?: any }, text?: string }>} makeAttempt
 *   单次尝试：内部自行创建独立 AbortSignal 并处理流；返回 { finish, text }。
 *   成功 → finish.kind 为 undefined/'done'/'max-tokens'；失败 → finish.kind 为 'error'/'aborted'（含 failure）
 *   或抛异常（网络/超时）。
 * @param {{ maxRetries?: number, classify?: (e:any)=>any, onAttempt?: (info:any)=>void }} opts
 * @returns {Promise<{ finish?: any, text?: string, attempts: number }>}
 */
export async function runWithRetry(makeAttempt, opts = {}) {
  const { maxRetries = RETRY_CONSTANTS.MAX_RETRIES, onAttempt } = opts;
  const classify = opts.classify || classifyFailure;
  let lastCls = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (onAttempt) onAttempt({ attempt, maxRetries });
    try {
      const res = await makeAttempt(attempt);
      const kind = res?.finish?.kind;
      if (kind === "error" || kind === "aborted") {
        const cls = classify(res.finish?.failure || {});
        lastCls = cls;
        // 500 类单独限重试次数；其余按 maxRetries。
        const cap = cls.status === 500 ? RETRY_CONSTANTS.HTTP500_MAX_RETRIES : maxRetries;
        if ((cls.kind === "retryable" || cls.kind === "limited") && attempt < cap) {
          await sleep(backoffDelayMs(attempt));
          continue;
        }
        throw new LlmRetryExhausted(cls, attempt + 1);
      }
      // 成功 / max-tokens：直接返回，文本解析交给 caller。
      return { ...res, attempts: attempt + 1 };
    } catch (err) {
      const cls = classify(err);
      lastCls = cls;
      const cap = cls.status === 500 ? RETRY_CONSTANTS.HTTP500_MAX_RETRIES : maxRetries;
      if ((cls.kind === "retryable" || cls.kind === "limited") && attempt < cap) {
        await sleep(backoffDelayMs(attempt));
        continue;
      }
      throw new LlmRetryExhausted(cls, attempt + 1);
    }
  }
  // 理论不可达（循环内必然返回或抛出），兜底。
  throw new LlmRetryExhausted(lastCls || { kind: "fatal", message: "unknown" }, maxRetries + 1);
}
