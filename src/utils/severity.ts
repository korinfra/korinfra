/**
 * Canonical severity ordering for sort comparisons.
 * Lower number = higher severity.
 */
export const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
