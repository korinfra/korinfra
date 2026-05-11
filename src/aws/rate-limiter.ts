import pThrottle from 'p-throttle';
import type { ApiCallRecord } from './types.js';
import { redact } from '../redaction/redactor.js';
import { tuiLog } from '../utils/tui-log.js';

// Per-service call rates (calls/second) matching Go ServiceRateLimiter
const SERVICE_LIMITS: Record<string, { limit: number; interval: number }> = {
  ec2: { limit: 20, interval: 1000 },
  rds: { limit: 10, interval: 1000 },
  s3: { limit: 30, interval: 1000 },
  lambda: { limit: 15, interval: 1000 },
  ecs: { limit: 10, interval: 1000 },
  elasticache: { limit: 10, interval: 1000 },
  elb: { limit: 10, interval: 1000 },
  dynamodb: { limit: 10, interval: 1000 },
  cloudwatch: { limit: 20, interval: 1000 },
  costexplorer: { limit: 5, interval: 1000 },
  pricing: { limit: 5, interval: 1000 },
  sts: { limit: 10, interval: 1000 },
  tagging: { limit: 10, interval: 1000 },
  cloudtrail: { limit: 2, interval: 1000 },
};

const DEFAULT_LIMIT = { limit: 10, interval: 1000 };

// In-memory API call log. Actual SQLite persistence (api_call_log table) is the
// responsibility of the scan orchestrator, which holds the db handle and scan_id.
// This buffer lets callers flush records via flushApiCallLog() for batch inserts.
const apiCallLog: ApiCallRecord[] = [];

export function logApiCall(record: ApiCallRecord): void {
  // Trim proactively when crossing 10000 — reduce to 9000 (90% capacity)
  if (apiCallLog.length >= 10_000) {
    tuiLog(`[korinfra] WARNING: apiCallLog approaching capacity (${apiCallLog.length}), trimming to 9000`);
    apiCallLog.splice(0, apiCallLog.length - 9_000);
  }
  apiCallLog.push(record);
}

export function flushApiCallLog(): ApiCallRecord[] {
  return apiCallLog.splice(0);
}

export function clearApiCallLog(): void {
  apiCallLog.splice(0);
}

export function schedulePeriodicFlush(
  onFlush: (records: ApiCallRecord[]) => void,
  intervalMs = 30_000,
): ReturnType<typeof setInterval> {
  const handle = setInterval(() => {
    const records = flushApiCallLog();
    if (records.length > 0) onFlush(records);
  }, intervalMs);
  handle.unref();
  return handle;
}

export function getApiCallLog(): readonly ApiCallRecord[] {
  return apiCallLog;
}

// Cache throttled wrappers per service+region so each region gets its own token bucket
type AnyFn = (fn: () => Promise<unknown>) => Promise<unknown>;
interface ThrottleCacheEntry {
  fn: AnyFn;
  lastUsed: number;
}
const throttleCache = new Map<string, ThrottleCacheEntry>();
const THROTTLE_CACHE_MAX = 200;
const THROTTLE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function evictThrottleCache(): void {
  if (throttleCache.size <= THROTTLE_CACHE_MAX) return;
  const now = Date.now();
  // First pass: remove expired entries
  for (const [key, entry] of throttleCache) {
    if (now - entry.lastUsed > THROTTLE_CACHE_TTL_MS) {
      throttleCache.delete(key);
    }
  }
  // If still over limit, remove oldest entry by LRU
  if (throttleCache.size > THROTTLE_CACHE_MAX) {
    let oldest: [string, ThrottleCacheEntry] | undefined;
    for (const entry of throttleCache) {
      if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) {
        oldest = entry;
      }
    }
    if (oldest) {
      throttleCache.delete(oldest[0]);
    }
  }
}

/**
 * Returns a rate-limited executor for the given service and region.
 * Each (service, region) pair gets its own independent token bucket so that
 * throttling in one region does not slow down calls in another.
 * Usage: await getRateLimiter('ec2', 'us-east-1')(() => client.describeInstances(...))
 */
export function getRateLimiter(service: string, region: string): <T>(fn: () => Promise<T>) => Promise<T> {
  const key = `${service.toLowerCase()}:${region}`;
  let entry = throttleCache.get(key);
  if (!entry) {
    evictThrottleCache();
    const cfg = SERVICE_LIMITS[service.toLowerCase()] ?? DEFAULT_LIMIT;
    // pThrottle wraps the function; we create a single shared throttled fn per service+region
    const throttled = pThrottle({ limit: cfg.limit, interval: cfg.interval })(
      (fn: () => Promise<unknown>) => fn(),
    ) as AnyFn;
    entry = { fn: throttled, lastUsed: Date.now() };
    throttleCache.set(key, entry);
  } else {
    entry.lastUsed = Date.now();
  }
  const { fn: throttled } = entry;
  return <T>(fn: () => Promise<T>) => throttled(fn) as Promise<T>;
}

const THROTTLE_ERRORS = new Set([
  'ThrottlingException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
  'Throttling',
  'RequestThrottled',
]);

const AUTH_ERRORS = new Set([
  'ExpiredTokenException',
  'ExpiredToken',
  'InvalidClientTokenId',
  'InvalidToken',
  'AuthFailure',
  'NotAuthorized',
  'AccessDenied',
  'UnauthorizedOperation',
  'TokenRefreshRequired',
  'CredentialsError',
  // Local credential loading failures (e.g. empty/corrupt SSO token cache file)
  'CredentialLoadError',
]);

// Patterns that indicate a local credential loading failure rather than an AWS API error.
// These come from the SDK credential provider chain before any network call is made.
const CREDENTIAL_LOAD_PATTERNS = [
  /Failed to (load|refresh) (SSO token|token|credential)/i,
  /Unexpected end of JSON input/i,           // empty token cache file
  /Could not load credentials from any providers/i,
  /Profile .+ not found/i,
  /credential_process.*failed/i,
];

export function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = ('name' in err ? (err as { name: string }).name : '')
    ?? ('Code' in err ? (err as { Code: string }).Code : '');
  if (AUTH_ERRORS.has(name)) return true;
  // Also detect local credential provider chain failures (before any network call)
  const msg = 'message' in err ? String(err instanceof Error && err.message ? err.message : '') : '';
  return CREDENTIAL_LOAD_PATTERNS.some((p) => p.test(msg));
}

function isThrottleError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  // $retryable: false — SDK explicitly marks as non-retriable
  if ('$retryable' in err && (err).$retryable === false) return false;
  // $metadata present — SDK already handled retries, do not retry again
  if ('$metadata' in err) return false;
  if ('name' in err) {
    return THROTTLE_ERRORS.has((err as { name: string }).name);
  }
  return false;
}

/**
 * Wraps an AWS API call with rate limiting, retry on throttle, and call logging.
 *
 * Retry strategy:
 * - Up to 3 attempts with exponential backoff (1000ms * 2^attempt) + jitter (0-1000ms).
 * - Only retries on throttle errors (ThrottlingException, RequestLimitExceeded, etc.).
 */
export async function throttledCall<T>(
  service: string,
  operation: string,
  region: string,
  fn: () => Promise<T>,
  estimatedCost = 0,
): Promise<T> {
  const limit = getRateLimiter(service, region);
  const start = Date.now();
  let error: string | undefined;

  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoffMs = 2 ** attempt * 1000 + Math.random() * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    try {
      const result = await limit(fn);
      logApiCall({
        service,
        operation,
        region,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - start,
        estimatedCost,
      });
      return result;
    } catch (err) {
      lastErr = err;
      if (!isThrottleError(err) || attempt === MAX_ATTEMPTS - 1) {
        error = redact(err instanceof Error ? err.message : String(err), 'moderate');
        logApiCall({
          service,
          operation,
          region,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - start,
          estimatedCost,
          error,
        });
        const safeMessage = redact(
          err instanceof Error ? err.message : (typeof err === 'string' ? err : 'AWS call failed'),
          'moderate'
        );
        throw new Error(safeMessage, { cause: err });
      }
      // Throttle error — loop and retry
    }
  }

  // Unreachable, but satisfies TypeScript
  throw lastErr;
}
