/**
 * Maps a caught error (or error message) to a short, actionable hint
 * for display beneath the error in ErrorBox.
 */

type ErrorCategory =
  | 'auth'
  | 'network'
  | 'timeout'
  | 'notFound'
  | 'permission'
  | 'rateLimit'
  | 'parse'
  | 'database'
  | 'validation'
  | 'unknown';

/** Human-readable hints keyed by error category. */
const ERROR_HINTS: Record<ErrorCategory, string | undefined> = {
  auth: 'Check your AWS credentials (aws configure or AWS_PROFILE env var).',
  network: 'Check your network connection and AWS endpoint reachability.',
  timeout: 'The request timed out. Try again or increase timeout in config.',
  notFound: 'Resource not found. It may have been deleted or never existed.',
  permission: 'Insufficient AWS permissions. Check IAM policy for this action.',
  rateLimit: 'AWS rate limit hit. korinfra will retry automatically.',
  parse: 'Could not parse the response. File a bug with the raw output.',
  database: 'Database error. Try running korinfra again or check storage permissions.',
  /**
   * Validation errors are clear and self-describing — no generic fallback hint.
   * The call site should pass an explicit `hint` prop if additional guidance is needed.
   */
  validation: undefined,
  /** Unknown errors are genuine JS exceptions — show the generic fallback hint. */
  unknown: 'An unexpected error occurred. Check logs for more details.',
};

/**
 * Categorize an error by inspecting its message and name.
 * Returns the category string and the corresponding hint (may be undefined for
 * self-describing errors like validation errors or unrecognised exceptions).
 */
export function categorizeError(err: unknown): { category: ErrorCategory; hint: string | undefined } {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const name = err instanceof Error ? (err.name ?? '').toLowerCase() : '';

  let category: ErrorCategory = 'unknown';

  // ── Validation errors (checked first — highest specificity) ─────────────────
  // These messages are written by our own code and are already clear to the user.
  // Any generic hint would be noise or, worse, misleading (e.g. parse hint for
  // "Unknown format json, csv, html" which contains the word "json").
  if (
    msg.startsWith('unknown ') ||
    msg.startsWith('invalid ') ||
    msg.includes('not found') ||
    msg.includes('not available') ||
    msg.includes('not set') ||
    msg.includes('valid values:') ||
    msg.includes('valid formats:') ||
    msg.includes('valid subcommands:') ||
    msg.includes('requires a key') ||
    msg.includes('usage error') ||
    msg.includes('requires a value') ||
    msg.includes('requires two') ||
    msg.includes('requires at least') ||
    msg.includes('ai provider') ||
    msg.includes('configure an ai')
  ) {
    category = 'validation';
  } else if (
    msg.includes('credentials') ||
    msg.includes('no credentials') ||
    msg.includes('credentialsprovider') ||
    name.includes('credentialserror')
  ) {
    category = 'auth';
  } else if (
    msg.includes('throttl') ||
    msg.includes('rate exceeded') ||
    msg.includes('toomanyrequests') ||
    msg.includes('requestlimitexceeded')
  ) {
    category = 'rateLimit';
  } else if (
    msg.includes('accessdenied') ||
    msg.includes('unauthorized') ||
    msg.includes('not authorized') ||
    msg.includes('forbidden')
  ) {
    category = 'permission';
  } else if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('timed out')) {
    category = 'timeout';
  } else if (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('network') ||
    msg.includes('socket')
  ) {
    category = 'network';
  } else if (
    msg.includes('notfound') ||
    msg.includes('nosuchbucket') ||
    msg.includes('nosuchkey') ||
    msg.includes('does not exist')
  ) {
    category = 'notFound';
  } else if (msg.includes('parse') || msg.includes('json') || msg.includes('invalid response')) {
    category = 'parse';
  } else if (
    msg.includes('unique constraint') ||
    msg.includes('constraint failed') ||
    msg.includes('sqlite') ||
    msg.includes('disk i/o error') ||
    msg.includes('database is locked')
  ) {
    category = 'database';
  }

  return { category, hint: ERROR_HINTS[category] };
}
