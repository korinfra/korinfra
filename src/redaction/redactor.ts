import {
  reAccessKey,
  reARN,
  reAccountID,
  rePublicIPv4,
  rePublicIPv6,
  reSecretKey,
  reSecretKeyJson,
  reEmail,
  reDomain,
  reGitHubPAT,
  reJWT,
  reBearer,
  reAnthropicKey,
  reOpenAIKey,
  rePrivateKeyBlock,
  reDSN,
  sensitiveExactWords,
  sensitiveCompoundPatterns,
} from './patterns.js';
import { logger } from '../utils/logger.js';

export type RedactionLevel = 'minimal' | 'moderate' | 'strict';

// All Object.prototype method names that can be used for prototype pollution.
const PROTO_POISON_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toString',
  'toLocaleString',
  'valueOf',
]);

// Replacement tokens — must match Go constants in patterns.go
const REDACTED_ACCESS_KEY = '[ACCESS-KEY]';
const REDACTED_SECRET    = '[REDACTED]';
const REDACTED_PRIVATE_KEY = '[PRIVATE-KEY]';
const REDACTED_ACCOUNT   = '[ACCOUNT-ID]';
const REDACTED_PUBLIC_IP = '[PUBLIC-IP]';
const REDACTED_PRIVATE_IP = '[PRIVATE-IP]';
const REDACTED_EMAIL     = '[EMAIL]';
const REDACTED_DOMAIN    = '[REDACTED_DOMAIN]';
const MAX_REDACTION_INPUT_CHARS = 524_288; // 512 KB — prevent ReDoS on large inputs
const REDACTED_TRUNCATED = '[TRUNCATED_FOR_REDACTION]';

// Hot-path cache: object keys repeat heavily across resource collections.
// Bounded to 10000 entries — evict the oldest entry (FIFO via Map insertion order)
// when the cap would be exceeded to prevent unbounded memory growth.
// Note: eviction strategy is FIFO (not LRU) — the oldest-inserted key is removed
// regardless of access frequency, as a known trade-off for O(1) eviction cost.
//
// Thread-safety: safe under Node.js's single-threaded event loop — no concurrent
// access is possible. If Worker Threads are ever introduced this cache must be
// protected with a Mutex or moved to per-thread storage, as Map is not thread-safe.
// Growth is bounded by SENSITIVE_KEY_CACHE_MAX (10000) to prevent unbounded memory use.
const SENSITIVE_KEY_CACHE_MAX = 10000;
// capped at 10 k entries with FIFO eviction — bounded by design, no unbounded growth
const sensitiveKeyCache = new Map<string, boolean>();

function sensitiveKeyCacheSet(key: string, value: boolean): void {
  if (sensitiveKeyCache.size >= SENSITIVE_KEY_CACHE_MAX) {
    // Map.keys() iterates in insertion order — first key is the oldest.
    const oldest = sensitiveKeyCache.keys().next().value;
    if (oldest !== undefined) sensitiveKeyCache.delete(oldest);
  }
  sensitiveKeyCache.set(key, value);
}

function isPrivateIP(ip: string): boolean {
  const rawParts = ip.split('.');
  if (rawParts.length !== 4) return false;

  const parts: number[] = [];
  for (const raw of rawParts) {
    if (!/^\d{1,3}$/.test(raw)) return false;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    parts.push(n);
  }

  if (parts.length < 2) return false;
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined) return false;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isSensitiveKey(key: string): boolean {
  const cached = sensitiveKeyCache.get(key);
  if (cached !== undefined) return cached;

  // Split on camelCase boundaries, underscores, and hyphens to get individual words.
  // e.g. "secretAccessKey" → ["secret","access","key"], "NextToken" → ["next","token"]
  const words = key
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);

  // Single-word exact match (e.g. "password", "secret", "apikey")
  if (words.some(w => sensitiveExactWords.has(w))) {
    sensitiveKeyCacheSet(key, true);
    return true;
  }

  // Consecutive-word compound patterns (e.g. ["access","key"], ["session","token"])
  for (let i = 0; i < words.length - 1; i++) {
    for (const [first, second] of sensitiveCompoundPatterns) {
      if (words[i] === first && words[i + 1] === second) {
        sensitiveKeyCacheSet(key, true);
        return true;
      }
    }
  }

  sensitiveKeyCacheSet(key, false);
  return false;
}

/**
 * Apply regex-based redaction to a plain string.
 * Mirrors Go's Redactor.redactText.
 */
export function redact(text: string, level: RedactionLevel): string {
  if (typeof text !== 'string') return String(text);

  if (text.length > MAX_REDACTION_INPUT_CHARS) {
    logger.warn({ inputSize: text.length }, 'Redactor input truncated — potential data loss, check caller');
    const truncated = text.slice(0, MAX_REDACTION_INPUT_CHARS);
    return `${redact(truncated, level)}${REDACTED_TRUNCATED}`;
  }

  // Always: access keys
  let s = text.replace(reAccessKey, REDACTED_ACCESS_KEY);

  // Always: Anthropic API keys
  s = s.replace(reAnthropicKey, REDACTED_SECRET);

  // Always: OpenAI API keys
  s = s.replace(reOpenAIKey, REDACTED_SECRET);

  // Always: PEM private key blocks
  s = s.replace(rePrivateKeyBlock, REDACTED_PRIVATE_KEY);

  // Always: GitHub PATs
  s = s.replace(reGitHubPAT, REDACTED_SECRET);

  // Always: JWTs
  s = s.replace(reJWT, REDACTED_SECRET);

  // Always: Bearer tokens — keep the "Bearer " prefix, redact the token value
  s = s.replace(reBearer, (_fullMatch, _token: string) => `Bearer ${REDACTED_SECRET}`);

  // Always: DSN connection strings (postgresql://, mysql://, redis://, etc.)
  s = s.replace(reDSN, REDACTED_SECRET);

  // Always: secret key=value patterns — preserve the key name, redact value
  s = s.replace(reSecretKey, (fullMatch, value: string) => {
    const keyPart = fullMatch.slice(0, fullMatch.length - value.length);
    return keyPart + REDACTED_SECRET;
  });

  // Always: JSON-format secret key patterns — preserve key name, redact value
  s = s.replace(reSecretKeyJson, (fullMatch, value: string) => {
    const keyPart = fullMatch.slice(0, fullMatch.length - value.length - 1); // -1 for closing "
    return keyPart + REDACTED_SECRET + '"';
  });

  if (level === 'minimal') return s;

  // Moderate+: ARNs and standalone account IDs
  s = s.replace(reARN, (fullMatch: string, accountId: string) => fullMatch.replace(accountId, REDACTED_ACCOUNT));
  s = s.replace(reAccountID, (_fullMatch: string, ctx: string) => ctx + REDACTED_ACCOUNT);

  // Moderate+: IPv6 addresses
  s = s.replace(rePublicIPv6, '[PUBLIC-IPv6]');

  // Moderate+: public IPs (non-private IPv4); strict also redacts private
  s = s.replace(rePublicIPv4, (m) => {
    if (isPrivateIP(m)) {
      return level === 'strict' ? REDACTED_PRIVATE_IP : m;
    }
    return REDACTED_PUBLIC_IP;
  });

  // Moderate+: email addresses
  s = s.replace(reEmail, REDACTED_EMAIL);

  if (level !== 'strict') return s;

  // Strict: domain names — allow AWS-internal hostnames through unchanged
  // Also skip filenames whose extension matches a known code/config TLD (e.g. main.tf, index.ts)
  const CODE_EXTS = new Set(['tf', 'ts', 'js', 'mjs', 'cjs', 'py', 'go', 'rs', 'rb', 'sh', 'md', 'json', 'yaml', 'yml', 'toml', 'hcl', 'sql', 'cs', 'java', 'kt', 'cpp', 'cc', 'h', 'c', 'r', 'pl']);
  s = s.replace(reDomain, (m) => {
    if (m.endsWith('.amazonaws.com') || m.endsWith('.compute.internal')) return m;
    const lastDot = m.lastIndexOf('.');
    if (lastDot !== -1) {
      const ext = m.slice(lastDot + 1).toLowerCase();
      // Single-segment filename (no dots before last dot) with a code extension → not a domain
      if (CODE_EXTS.has(ext) && !m.slice(0, lastDot).includes('.')) return m;
    }
    return REDACTED_DOMAIN;
  });

  return s;
}

/**
 * Deep-clone obj and redact all string values.
 * - Keys matching sensitiveKeywords have their entire value replaced.
 * - Other string values go through `redact(value, level)`.
 * - null / undefined / non-string primitives pass through unchanged.
 * - Nested objects and arrays are handled recursively (max depth: 50).
 * - Cyclic references are replaced with [REDACTED] (safe fallback).
 * - 12-digit numbers are treated as AWS account IDs and redacted.
 */
export function redactObject(obj: unknown, level: RedactionLevel, _depth = 0): unknown {
  return redactObjectInternal(obj, level, _depth, new WeakSet<object>());
}

function redactObjectInternal(
  obj: unknown,
  level: RedactionLevel,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth > 50) return REDACTED_SECRET;

  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') return redact(obj, level);

  // Numeric 12-digit values are likely AWS account IDs — redact them
  if (typeof obj === 'number' && /^\d{12}$/.test(String(obj))) {
    return REDACTED_ACCOUNT;
  }

  if (Array.isArray(obj)) {
    if (seen.has(obj)) return REDACTED_SECRET;
    seen.add(obj);
    const redacted = obj.map(item => redactObjectInternal(item, level, depth + 1, seen));
    seen.delete(obj);
    return redacted;
  }

  if (typeof obj === 'object') {
    const source = obj as Record<string, unknown>;
    if (seen.has(source)) return REDACTED_SECRET;
    seen.add(source);

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source)) {
      // Skip prototype-poisoning keys (all Object.prototype method names)
      if (PROTO_POISON_KEYS.has(k)) continue;
      if (isSensitiveKey(k)) {
        // Sensitive key: replace entire value regardless of type (no subtree traversal)
        result[k] = REDACTED_SECRET;
      } else if (typeof v === 'string') {
        result[k] = redact(v, level);
      } else {
        result[k] = redactObjectInternal(v, level, depth + 1, seen);
      }
    }
    seen.delete(source);
    return result;
  }

  // Other primitives (boolean, bigint, symbol) pass through
  return obj;
}
