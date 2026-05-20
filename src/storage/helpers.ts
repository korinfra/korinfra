/**
 * Shared helpers for storage query modules.
 */

export function safeParse(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw as string) as Record<string, unknown>; } catch { return null; }
}

export function safeParseArray<T>(raw: unknown): T[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw as string);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch { return null; }
}
