/**
 * Centralized user-facing strings and labels.
 * All reusable text lives here so screens cannot drift.
 *
 * DOT_SEP rule: always import DOT_SEP from here — never inline ' · '.
 * SEVERITY_LABELS rule: use SEVERITY_LABELS for [CRITICAL]/[HIGH]/etc. badges.
 */

// ─── Separator ────────────────────────────────────────────────────────────────
export const DOT_SEP = ' · ';

// ─── Section title ────────────────────────────────────────────────────────────
export const TITLE_COMMAND = 'Command';

// ─── Severity labels ─────────────────────────────────────────────────────────
export const SEVERITY_LABELS = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
} as const;

// ─── Status badges ────────────────────────────────────────────────────────────
export const BADGE_PASS = '[PASS]';
export const BADGE_FAIL = '[FAIL]';
export const BADGE_WARN = '[WARN]';

// ─── Mode badges ──────────────────────────────────────────────────────────────

// ─── Command descriptions (MM-5) ─────────────────────────────────────────────
export const CMD_DESCRIPTIONS: Record<string, string> = {
  scan: 'Scan AWS resources, costs, security, and recommendations',
  costs: 'Cost Explorer breakdown for the selected period',
  resources: 'Browse scanned AWS resources and costs',
  security: 'Check Terraform for risky IAM, S3, and security group rules',
  history: 'Browse scans, compare changes, and generate scan reports',
  changes: 'Audit recent AWS API activity from CloudTrail',
  recommend: 'Review cached or freshly generated optimizations',
  fix: 'Apply one recommendation with an AI patch workflow',
  report: 'Save a report for latest or selected scan',
  tags: 'Audit required tags and plan tag fixes',
  pricing: 'Inspect or refresh the local AWS pricing cache',
  init: 'Initialize korinfra config',
  doctor: 'Diagnose environment',
  config: 'View or edit configuration',
  mcp: 'Install MCP server for IDE integration',
};

// ─── Mode labels ──────────────────────────────────────────────────────────────
export const MODE_LABELS: Record<
  | 'rules-only'
  | 'ai-assisted'
  | 'agent'
  | 'local'
  | 'offline'
  | 'diagnostic'
  | 'setup'
  | 'rules-scan'
  | 'ai-running'
  | 'ai-cached'
  | 'ai-stale'
  | 'ai-off'
  | 'ai-unavailable',
  string
> = {
  'rules-only': 'rules-only',
  'ai-assisted': 'AI-assisted',
  'agent': 'agent',
  'local': 'local',
  'offline': 'offline',
  'diagnostic': 'diagnostic',
  'setup': 'setup',
  'rules-scan': 'rules-scan',
  'ai-running': 'AI running',
  'ai-cached': 'AI cached',
  'ai-stale': 'AI stale',
  'ai-off': 'AI off',
  'ai-unavailable': 'AI unavailable',
};

// ─── Placeholders ─────────────────────────────────────────────────────────────
export const PALETTE_PLACEHOLDER = 'e.g. report --scan <id> --format html';

// ─── AI status composer ───────────────────────────────────────────────────────

/**
 * Compose a single AI status string with exactly one `AI` token.
 *
 * Prevents "AI AI running" / "AI AI cached" from concatenation at call sites
 * that previously built the string by joining a mode label (already containing "AI")
 * with an additional "AI" prefix. All such call sites must use this helper.
 *
 * Returns one of: `AI running`, `AI cached`, `AI off`, `AI complete`, `AI failed`
 */
export function composeAiStatus(mode: 'running' | 'cached' | 'off' | 'complete' | 'failed'): string {
  switch (mode) {
    case 'running': return 'AI running';
    case 'cached': return 'AI cached';
    case 'off': return 'AI off';
    case 'complete': return 'AI complete';
    case 'failed': return 'AI failed';
  }
}

// ─── Join helpers ─────────────────────────────────────────────────────────────

/**
 * Join parts with DOT_SEP. Filters out empty strings so callers don't need to
 * guard: `joinDot(a, b, c)` → `' a · b · c '` with no trailing/double separators.
 */
export function joinDot(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join(DOT_SEP);
}

// ─── Common messages ─────────────────────────────────────────────────────────
export const MSG_NO_RESULT = 'No result was returned.';
