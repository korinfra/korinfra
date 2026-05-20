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

/**
 * Coerce an unknown value to a finite number. Strings are parseFloat'd; non-numeric
 * inputs return 0. Used when reading values from `Record<string, unknown>` shapes
 * (Terraform plan attributes, AWS SDK responses) under noUncheckedIndexedAccess.
 */
export function floatValue(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === 'string') {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Coerce an unknown value to a boolean. Only `true` and the string "true" are truthy. */
export function boolValue(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw === 'true';
  return false;
}
