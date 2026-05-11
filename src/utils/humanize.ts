/**
 * formatCost formats a dollar amount with 2 decimal places and comma thousands separator.
 * Negative amounts get a "-$" prefix.
 * Examples: 12345.6 → "$12,345.60", -99.5 → "-$99.50"
 */
export function formatCost(amount: number): string {
  const negative = amount < 0;
  const abs = negative ? -amount : amount;

  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs);

  return negative ? `-$${formatted}` : `$${formatted}`;
}

/**
 * formatDuration formats a duration given in milliseconds into a human-readable string.
 * Examples: 500 → "500ms", 2500 → "2.5s", 90000 → "1m30s", 9000000 → "2h30m", 10800000 → "3h"
 */
export function formatDuration(ms: number): string {
  if (!isFinite(ms)) return '0ms';
  if (ms < 0) throw new RangeError(`Duration cannot be negative: ${ms}ms`);
  if (ms < 1000) {
    return `${Math.floor(ms)}ms`;
  }

  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const secs = Math.floor(totalSeconds) % 60;
    if (secs === 0) {
      return `${totalMinutes}m`;
    }
    return `${totalMinutes}m${secs}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h${mins}m`;
}

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

/**
 * formatBytes formats a byte count into a human-readable string using binary (1024-based) units.
 * Examples: 512 → "512 B", 1536 → "1.5 KB", 2097152 → "2.0 MB", 5368709120 → "5.0 GB"
 */
export function formatBytes(bytes: number): string {
  if (bytes >= TB) {
    return `${(bytes / TB).toFixed(1)} TB`;
  }
  if (bytes >= GB) {
    return `${(bytes / GB).toFixed(1)} GB`;
  }
  if (bytes >= MB) {
    return `${(bytes / MB).toFixed(1)} MB`;
  }
  if (bytes >= KB) {
    return `${(bytes / KB).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
