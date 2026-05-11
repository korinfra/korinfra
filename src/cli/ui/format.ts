/**
 * Cross-screen formatters for consistent data display.
 */

import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import { stringWidth, middleTruncateWidth } from './width.js';

// ─── Money (compact) ──────────────────────────────────────────────────────────

/**
 * Compact money formatter — good for summary cards, charts, and headers.
 * Rounds values over $1 to whole dollars and abbreviates thousands.
 */
export function formatMoney(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}k`;
  if (usd >= 1) return `$${usd.toFixed(0)}`;
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return '<$0.01';
}

/**
 * Exact money formatter — good for detail rows, anomaly tables, and CSV previews.
 * formatMoneyExact(1204.42) => '$1,204.42'
 */
export function formatMoneyExact(usd: number): string {
  if (!Number.isFinite(usd)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(usd);
}

export function formatMoneyPerMonth(usd: number): string {
  return `${formatMoney(usd)}/mo`;
}

/**
 * Exact per-month formatter for detail rows.
 * formatMoneyPerMonthExact(1204.42) => '$1,204.42/mo'
 */
export function formatMoneyPerMonthExact(usd: number): string {
  return `${formatMoneyExact(usd)}/mo`;
}

// ─── Timestamps ───────────────────────────────────────────────────────────────

/**
 * Default to ISO 8601 UTC. Local time only when config display.tz === 'local'
 * (passed as opt-in parameter).
 *
 * formatTimestamp(iso)              → "2024-03-15 10:23Z"  (UTC, no suffix clutter)
 * formatTimestamp(iso, 'local')     → "2024-03-15 11:23 CET" (local with tz abbreviation)
 */
export function formatTimestamp(isoOrMs: string | number, tz?: 'utc' | 'local'): string {
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return String(isoOrMs);

  const pad = (n: number): string => String(n).padStart(2, '0');

  if (tz === 'local') {
    // Local time with timezone abbreviation
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const tzLabel = (() => {
      try {
        const abbr = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
          .formatToParts(d)
          .find((p) => p.type === 'timeZoneName')
          ?.value ?? 'UTC';
        return ` ${abbr}`;
      } catch {
        const offset = d.getTimezoneOffset();
        const sign = offset <= 0 ? '+' : '-';
        const absOffset = Math.abs(offset);
        return ` UTC${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
      }
    })();
    return `${date} ${time}${tzLabel}`;
  }

  // Default: UTC ISO 8601 — compact and unambiguous
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `${date} ${time}Z`;
}

// ─── Path display ─────────────────────────────────────────────────────────────

interface FormatPathOptions {
  /** Working directory for relative path calculation. Defaults to process.cwd(). */
  cwd?: string;
  /** Terminal column count for middle-truncation. Defaults to process.stdout.columns or 80. */
  cols?: number;
  /** If true, prefer relative paths when they are shorter. Default true. */
  preferRelative?: boolean;
}

/**
 * Format an absolute path for terminal display.
 * Displays relative/tilde-shortened paths, middle-truncating long ones.
 * Always store and use the real absolute path for copy/open — only the display changes.
 */
export function formatPathForTerminal(absolutePath: string, opts: FormatPathOptions = {}): string {
  const { cwd = process.cwd(), cols = process.stdout.columns ?? 80, preferRelative = true } = opts;

  const home = homedir();

  // Relative version
  let display = absolutePath;
  if (preferRelative) {
    try {
      const rel = relative(resolve(cwd), resolve(absolutePath));
      // Use relative only when it's shorter and makes sense (doesn't start with many ..)
      const upCount = rel.split(/[\\/]/).filter((s) => s === '..').length;
      if (rel.length < absolutePath.length && upCount <= 2) {
        display = rel.startsWith('.') ? rel : `./${rel}`;
      }
    } catch {
      // keep absolute
    }
  }

  // Replace home directory with ~
  if (display.startsWith(home)) {
    display = `~${display.slice(home.length)}`;
  }

  // Normalize path separators on display (forward slashes are more readable)
  display = display.replace(/\\/g, '/');

  // Middle-truncate if still too long (leave at least 12 cols margin for other content)
  const maxWidth = Math.max(20, cols - 4);
  if (stringWidth(display) > maxWidth) {
    const half = Math.floor((maxWidth - 1) / 2);
    display = middleTruncateWidth(display, { head: half, tail: half });
  }

  return display;
}

// ─── Region / Tag lists ───────────────────────────────────────────────────────

