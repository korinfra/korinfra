export interface RetryConfig {
  /** Maximum number of attempts. Default: 5 */
  maxAttempts: number;
  /** Initial wait between retries in ms. Default: 1000 */
  initialWaitMs: number;
  /** Maximum wait between retries in ms. Default: 60000 */
  maxWaitMs: number;
  /** Backoff multiplier. Default: 2.0 */
  multiplier: number;
}

const DEFAULTS: RetryConfig = {
  maxAttempts: 5,
  initialWaitMs: 1000,
  maxWaitMs: 60_000,
  multiplier: 2.0,
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const timer = setTimeout(resolve, ms);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * retryWithBackoff retries fn with exponential backoff and ±25% jitter.
 * Respects AbortSignal. Wraps the last error with the attempt count.
 *
 * Backoff formula: initialWaitMs * multiplier^attempt, capped at maxWaitMs.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
  signal?: AbortSignal,
): Promise<T> {
  const cfg: RetryConfig = {
    maxAttempts: config?.maxAttempts ?? DEFAULTS.maxAttempts,
    initialWaitMs: config?.initialWaitMs ?? DEFAULTS.initialWaitMs,
    maxWaitMs: config?.maxWaitMs ?? DEFAULTS.maxWaitMs,
    multiplier: config?.multiplier ?? DEFAULTS.multiplier,
  };

  // Clamp to valid values (mirror Go's defensive defaults)
  if (cfg.maxAttempts <= 0) cfg.maxAttempts = 5;
  if (cfg.initialWaitMs <= 0) cfg.initialWaitMs = 1000;
  if (cfg.maxWaitMs <= 0) cfg.maxWaitMs = 60_000;
  if (cfg.multiplier <= 0) cfg.multiplier = 2.0;

  let lastError: unknown;

  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error(`retry cancelled: ${String(signal.reason)}`);
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Don't retry client errors (4xx) — they won't succeed on retry
      if (err instanceof Error) {
        const awsErr = err as { $metadata?: { httpStatusCode?: number }; status?: number; statusCode?: number };
        const status = awsErr.$metadata?.httpStatusCode ?? awsErr.status ?? awsErr.statusCode ?? (() => {
          const m = err.message.match(/\bstatus(?:\s+code)?[:\s]+([45]\d{2})\b/i)
                 ?? err.message.match(/\bHTTP[/\s]+\d(?:\.\d)?\s+([45]\d{2})\b/i)
                 ?? err.message.match(/^([45]\d{2})\b/);
          return m ? parseInt(m[1] as string, 10) : 0;
        })();
        if (status >= 400 && status < 500) throw err;
        // Also check for common AWS SDK non-retryable error names
        const name = (err as { name?: string }).name ?? '';
        if (['UnauthorizedException', 'AccessDeniedException', 'InvalidParameterException',
             'ValidationException', 'InvalidRequestException'].includes(name)) throw err;
      }
    }

    // Don't sleep after the last attempt
    if (attempt === cfg.maxAttempts - 1) {
      break;
    }

    // Exponential backoff: initialWait * multiplier^attempt
    let wait = cfg.initialWaitMs * Math.pow(cfg.multiplier, attempt);
    if (wait > cfg.maxWaitMs) {
      wait = cfg.maxWaitMs;
    }

    // ±25% jitter
    const jitter = wait * 0.25 * (2 * Math.random() - 1);
    const sleepMs = Math.max(0, Math.round(wait + jitter));

    await sleep(sleepMs, signal);
  }

  const cause = lastError instanceof Error ? lastError : new Error(String(lastError));
  throw new Error(`all ${cfg.maxAttempts} attempts failed, last error: ${cause.message}`, {
    cause,
  });
}
