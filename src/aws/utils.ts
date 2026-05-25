/**
 * Shared utilities for AWS collectors.
 */

/** Build command options with optional AbortSignal. */
export function buildCmdOptions(signal?: AbortSignal): Record<string, unknown> {
  return signal ? { abortSignal: signal } : {};
}

/** Extract next token if it's a non-empty string. */
export function extractNextToken(token: string | undefined): string | undefined {
  return typeof token === 'string' && token.trim() !== '' ? token : undefined;
}

/** Validate account ID is a non-empty string. */
export function isValidAccountId(accountId: string | undefined): accountId is string {
  return typeof accountId === 'string' && accountId.length > 0;
}

/**
 * Convert tag array to record using field names.
 * @internal
 */
function tagsToRecord<T extends Record<string, string | undefined>>(
  tags: T[] | undefined,
  keyField: keyof T,
  valueField: keyof T,
): Record<string, string> {
  if (!tags || tags.length === 0) return {};
  const map: Record<string, string> = {};
  for (const t of tags) {
    const k = t[keyField];
    const v = t[valueField];
    if (k && v !== null && v !== undefined) map[k] = v;
  }
  return map;
}

/**
 * Converts an AWS Tag array to a plain key-value map.
 * Shared across EC2, RDS, S3, and NAT collectors.
 */
export function tagsToMap(tags: Array<{ Key?: string | undefined; Value?: string | undefined }> | undefined): Record<string, string> {
  return tagsToRecord(tags as Array<Record<string, string | undefined>>, 'Key', 'Value');
}

/**
 * Converts an AWS Tag array (lowercase key/value) to a plain key-value map.
 * Used by ECS collector which uses lowercase tag properties.
 */
export function tagsToMapLower(tags: Array<{ key?: string | undefined; value?: string | undefined }> | undefined): Record<string, string> {
  return tagsToRecord(tags as Array<Record<string, string | undefined>>, 'key', 'value');
}
