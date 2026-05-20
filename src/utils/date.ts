/** Format a Date as YYYY-MM-DD (ISO date portion only). */
export function formatDateISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}
