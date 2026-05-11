/**
 * TUI design tokens — single source of truth for all layout, spacing,
 * width breakpoints, row budgets, and truncation limits.
 *
 * Steps 2–11 of the TUI refactor import from here.
 * Do not import from spacing.ts or layout.ts directly in new code.
 *
 * spacing.ts and layout.ts continue to export their own constants
 * for backward compat with existing consumers — treat those as
 * migration scaffolding until a cleanup pass migrates all consumers here.
 */

export const TUI = {
  /** Unitless space scale (columns / rows). */
  space: { none: 0, xs: 1, sm: 2, md: 3, lg: 4 },

  /** Left-indent depths for content hierarchy. */
  indent: { page: 2, content: 2, detail: 4, nested: 6, footer: 2 },

  /** Horizontal / vertical padding inside bordered boxes. */
  padding: { boxX: 1, boxY: 0 },

  /** Row gaps between logical groups. */
  gap: { inline: 1, section: 1, sectionWide: 2, footer: 1 },

  /**
   * Width breakpoints (terminal columns).
   * narrow=56    stacked rows, shortest labels
   * compact=72   two-line rows, reduced metadata
   * comfortable=80  tables/charts with normal labels
   * chartWide=90  wide chart mode with axis
   * tableRegion=92  side-by-side region columns
   * tableId=110  show long IDs/ARNs
   */
  width: {
    narrow: 56,
    compact: 72,
    comfortable: 80,
    chartWide: 90,
    tableRegion: 92,
    tableId: 110,
  },

  /**
   * Chrome row budgets.
   * minContent=6  minimum scrollable rows before content is hidden
   * header=2      CommandHeader takes 2 rows
   * status=1      optional status/context row
   * actions=1     ActionBar row
   * hints=1       InteractionHints row
   */
  rows: { minContent: 6, header: 2, status: 1, actions: 1, hints: 1 },

  /**
   * Truncation limits (display columns).
   * Used with truncateWidth / middleTruncateWidth.
   */
  truncate: {
    small: 40,
    medium: 80,
    errorPreview: 200,
    toolValue: 28,
    toolResult: 180,
    toolError: 140,
  },

  /** Chart sizing constants. */
  chart: {
    compactRows: 10,
    tallRows: 22,
    minBarCols: 6,
    maxLegendRows: 5,
    maxHorizontalRows: 8,
    /** Max ratio of terminal width consumed by labels (0.32 = 32%). */
    labelMaxRatio: 0.32,
    /** Gutter cols between label, bar, and value in horizontal charts. */
    gutter: 4,
  },

  /** Table layout constants. */
  table: {
    /** Fixed width of selection/pointer column. */
    selectionCol: 2,
    minIdWidth: 8,
    minLabelWidth: 12,
  },

  /** Header sizing constants. */
  header: {
    artWidth: 68,
    minCols: 68,
    /** Minimum rows to show full ASCII art. */
    fullMinRows: 30,
    marginCols: 2,
  },

  /** Border chrome (horizontal: left+right border cols). */
  border: {
    horizontal: 2,
  },

  /** Divider sizing. */
  divider: {
    max: 80,
  },
} as const;

