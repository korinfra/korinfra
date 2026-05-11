/**
 * Shared utilities for AWS collectors.
 */

/**
 * Converts an AWS Tag array to a plain key-value map.
 * Shared across EC2, RDS, S3, and NAT collectors.
 */
export function tagsToMap(tags: Array<{ Key?: string | undefined; Value?: string | undefined }> | undefined): Record<string, string> {
  if (!tags || tags.length === 0) return {};
  const map: Record<string, string> = {};
  for (const t of tags) {
    if (t.Key && t.Value !== undefined) map[t.Key] = t.Value;
  }
  return map;
}

/**
 * Converts an AWS Tag array (lowercase key/value) to a plain key-value map.
 * Used by ECS collector which uses lowercase tag properties.
 */
export function tagsToMapLower(tags: Array<{ key?: string | undefined; value?: string | undefined }> | undefined): Record<string, string> {
  if (!tags || tags.length === 0) return {};
  const map: Record<string, string> = {};
  for (const t of tags) {
    if (t.key) map[t.key] = t.value ?? '';
  }
  return map;
}

