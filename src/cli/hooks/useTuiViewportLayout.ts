/**
 * useTuiViewportLayout — shared viewport / layout helper.
 *
 * Each screen declares reserved rows instead of each result component
 * guessing fixed offsets like `rows - 6` or `rows - 8`.
 *
 * Region layout (top to bottom):
 *   CommandHeader   1–4 rows  (measured or estimated by compact rules)
 *   Status/Progress 0–6 rows
 *   Content         remaining rows — scroll owner
 *   ActionBar       0–2 rows
 *   NavHints        1–2 rows
 */

import { useStdout } from 'ink';

import { TERMINAL_WIDTHS } from '../ui/breakpoints.js';
import { TUI } from '../ui/tokens.js';

// ─── Region reservation contract ────────────────────────────────────────────


interface TuiRegionHeights {
  /** Rows reserved for CommandHeader / AsciiHeader. Default: 2. */
  header: number;
  /** Rows reserved for status / progress indicators. Default: 0. */
  status: number;
  /** Rows reserved for sticky ActionBar. Default: 2. */
  actions: number;
  /** Rows reserved for NavHints footer. Default: 2. */
  hints: number;
}

const DEFAULT_REGION_HEIGHTS: TuiRegionHeights = {
  header: TUI.rows.header,
  status: 0,
  actions: TUI.rows.actions,
  hints: TUI.rows.hints,
};

interface TuiViewportLayout {
  /** Total terminal rows reported by stdout. */
  totalRows: number;
  /** Total terminal columns reported by stdout. */
  totalCols: number;
  /** Rows available for the scrollable content region. */
  contentRows: number;
  /** Resolved heights for each region (after applying defaults). */
  regionHeights: TuiRegionHeights;
  /** Whether the terminal is considered narrow (< narrowBreakpoint). */
  isNarrow: boolean;
  /** Whether the terminal is considered compact (< compactBreakpoint). */
  isCompact: boolean;
  /** Whether the terminal is too small for comfortable content display. */
  isTerminalTooSmall: boolean;
}

const MIN_CONTENT_ROWS = TUI.rows.minContent;

/**
 * Returns measured viewport dimensions and computed content row count.
 *
 * @param reserved  Partial override for individual region heights.
 *                  Omitted regions use their defaults.
 */
export function useTuiViewportLayout(
  reserved: Partial<TuiRegionHeights> = {},
): TuiViewportLayout {
  const { stdout } = useStdout();

  const totalRows = stdout?.rows ?? 24;
  const totalCols = stdout?.columns ?? 80;

  const regionHeights: TuiRegionHeights = {
    header:  reserved.header  ?? DEFAULT_REGION_HEIGHTS.header,
    status:  reserved.status  ?? DEFAULT_REGION_HEIGHTS.status,
    actions: reserved.actions ?? DEFAULT_REGION_HEIGHTS.actions,
    hints:   reserved.hints   ?? DEFAULT_REGION_HEIGHTS.hints,
  };

  const reservedTotal =
    regionHeights.header +
    regionHeights.status +
    regionHeights.actions +
    regionHeights.hints;

  const rawContentRows = totalRows - reservedTotal;
  const contentRows = Math.max(MIN_CONTENT_ROWS, rawContentRows);

  // VL-2 / GA-7: compare against rawContentRows so this is true even after clamping
  const isTerminalTooSmall = rawContentRows < MIN_CONTENT_ROWS;

  return {
    totalRows,
    totalCols,
    contentRows,
    regionHeights,
    isNarrow: totalCols < TERMINAL_WIDTHS.narrow,
    isCompact: totalCols < TERMINAL_WIDTHS.compact,
    isTerminalTooSmall,
  };
}
