/**
 * Safely coerce unknown values to strings, handling null/undefined/objects.
 * Used to fix @typescript-eslint/no-base-to-string violations.
 */
export function asStr(value: unknown, defaultValue = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return defaultValue;
  // For objects, arrays, etc., return default instead of [object Object]
  return defaultValue;
}
