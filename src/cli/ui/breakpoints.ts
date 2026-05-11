/**
 * Terminal width breakpoints (columns) — single source of truth.
 * Replaces NARROW_THRESHOLD / COMPACT_THRESHOLD from spacing.ts
 * and mirrors TUI.width from tokens.ts.
 *
 * narrow:    ≤56  — stacked rows, shortest labels
 * compact:   ≤72  — two-line rows, reduced metadata
 * comfortable: ≤80 — tables/charts with normal labels
 * chartWide: ≤90  — wide chart mode with axis
 * tableRegion: ≤92 — side-by-side region columns
 * tableId:  ≤110 — show long IDs/ARNs
 */
export const TERMINAL_WIDTHS = {
  narrow: 56,
  compact: 72,
  comfortable: 80,
  chartWide: 90,
  tableRegion: 92,
  tableId: 110,
} as const;

/**
 * Terminal height breakpoints (rows) — single source of truth.
 *
 * cramped:  <20  — hide sparklines, collapse cards
 * normal:   20–35 — standard layout
 * tall:     >35  — extra metadata, expanded details
 */
export const TERMINAL_HEIGHTS = {
  cramped: 20,
  normal: 35,
} as const;
