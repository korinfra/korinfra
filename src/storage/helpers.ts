/**
 * Shared helpers for storage query modules.
 */

export function safeParse(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw as string);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch { return null; }
}

export function safeParseArray<T>(raw: unknown): T[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw as string);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch { return null; }
}
