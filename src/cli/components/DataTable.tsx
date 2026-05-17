/**
 * DataTable — generic, responsive, keyboard-navigable data table.
 *
 * Features:
 *   - Priority-based column hiding (1=always, 2=hide on narrow, 3=hide on compact)
 *   - Fixed 1-row height per row (truncated, no wrap)
 *   - Selected row: '❯ ' prefix (icons.pointer) + colors.focus highlight
 *   - Row count + position display above table
 *   - Middle-ellipsis truncation for paths/ARNs
 *   - Sort indicator on column headers
 *   - Empty state with filter-aware message
 *   - Keyboard: ↑/↓/j/k to navigate
 *
 * Rules:
 *   - VRHYTHM_RULE: spacing from src/cli/ui/spacing.ts
 *   - DOT_SEP_RULE: import DOT_SEP, never inline the dot separator
 *   - No magic numbers — use TUI tokens and spacing constants
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import { colors, icons } from '../theme.js';
import { DOT_SEP, MSG_NO_RESULT, stripAnsi } from '../ui/text.js';
import { GAP_BETWEEN_SECTIONS, MARGIN_LEFT_CONTENT } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';
import { getAvailableSafeWidth, padEndWidth, truncateWidth, middleTruncateWidth } from '../ui/width.js';
import { useMouseScroll } from '../hooks/useMouseScroll.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ColumnDef<T = Record<string, unknown>> {
  key: string;
  label: string;
  /** Fixed character width. If omitted the column takes remaining space. */
  width?: number;
  minWidth?: number;
  /** Maximum character width for flex (no-width) columns. Caps expansion at wide terminals. */
  maxWidth?: number;
  /**
   * Visibility priority:
   *   1 — always visible
   *   2 — hidden when terminal width < TUI.width.narrow (56)
   *   3 — hidden when terminal width < TUI.width.compact (72)
   */
  priority: number;
  render?: (value: unknown, row: T) => string;
  /** Optional: return JSX element to override text color/style. If provided, render is ignored. */
  renderCell?: (value: unknown, row: T, width: number) => React.JSX.Element;
  /** Where to truncate if the cell value is too long. Default: 'end'. */
  truncate?: 'start' | 'middle' | 'end';
}

export interface SortState {
  column: string;
  direction: 'asc' | 'desc';
}

export interface DataTableProps<T = Record<string, unknown>> {
  columns: ColumnDef<T>[];
  rows: T[];
  selectedIndex?: number;
  onSelect?: (index: number) => void;
  filterCount?: { total: number; visible: number };
  emptyState?: React.ReactNode;
  sortState?: SortState;
  /** Called when user wants to sort by a column. Sort key only — no keybind here. */
  onSort?: (column: string) => void;
  getRowKey?: (row: T, index: number) => string;
  /**
   * Number of rows to jump for PgUp/PgDn.
   * Defaults to 10 when not provided.
   */
  pageSize?: number;
  /** Estimated chrome rows above/below the table body. Default 8. Higher = fewer visible rows. */
  chromeRows?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Width of the selection pointer prefix ('❯ '). */
const POINTER_COL = TUI.table.selectionCol;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Truncates a cell value to `maxWidth` columns using the specified mode.
 * For `'middle'`, uses middleTruncateWidth — ideal for paths and ARNs.
 */
function truncateCell(text: string, maxWidth: number, mode: 'start' | 'middle' | 'end' = 'end'): string {
  if (maxWidth <= 0) return '';
  if (mode === 'middle') {
    const half = Math.floor((maxWidth - 1) / 2);
    return middleTruncateWidth(text, { head: half, tail: half });
  }
  if (mode === 'start') {
    // Truncate from the beginning: '…rest-of-text'
    // Reverse → end-truncate → reverse back to preserve tail characters.
    const reversed = [...text].reverse().join('');
    const truncated = truncateWidth(reversed, maxWidth, '…');
    return [...truncated].reverse().join('');
  }
  return truncateWidth(text, maxWidth);
}

/**
 * Fits a cell into exactly `width` terminal columns (pads or truncates).
 * Reserves 1 trailing column as inter-column gap so adjacent cells never
 * collide when a value fills its full column width.
 */
function fitCell(text: string, width: number, truncMode: 'start' | 'middle' | 'end' = 'end'): string {
  if (width <= 1) return padEndWidth(truncateCell(text, width, truncMode), width);
  const truncated = truncateCell(text, width - 1, truncMode);
  return padEndWidth(truncated, width);
}

/** Resolves a row cell value to a display string. Strips ANSI escapes from
 *  user-controlled values (AWS tag names, S3 bucket names, etc.) so they
 *  cannot rewrite the terminal when rendered. */
function getCellValue<T>(col: ColumnDef<T>, row: T): string {
  const raw = (row as Record<string, unknown>)[col.key];
  // renderCell returns JSX, but for string calculation use render fallback
  if (col.render !== undefined) {
    return stripAnsi(col.render(raw, row));
  }
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return stripAnsi(raw);
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return JSON.stringify(raw);
}

// ─── Main component ────────────────────────────────────────────────────────

/** Default page size for PgUp/PgDn when not provided by the caller. */
const DEFAULT_PAGE_SIZE = 10;

export function DataTable<T = Record<string, unknown>>({
  columns,
  rows,
  selectedIndex = -1,
  onSelect,
  filterCount,
  emptyState,
  sortState,
  onSort: _onSort,
  getRowKey,
  pageSize = DEFAULT_PAGE_SIZE,
  chromeRows,
}: DataTableProps<T>): React.JSX.Element {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termHeight = stdout?.rows ?? 24;

  // Viewported table body for large result sets.
  // When pageSize is explicitly provided, it caps the visible row count.
  const visibleBodyRows = useMemo(() => {
    const chrome = chromeRows ?? 14;
    const fromTerminal = Math.max(3, termHeight - chrome);
    return pageSize !== DEFAULT_PAGE_SIZE
      ? Math.max(3, Math.min(pageSize, fromTerminal))
      : fromTerminal;
  }, [termHeight, chromeRows, pageSize]);

  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    if (pageSize !== DEFAULT_PAGE_SIZE) {
      // Explicit pageSize: pageSize means DATA rows — advance viewport when selection exits window.
      const maxTop = Math.max(0, rows.length - pageSize);
      setScrollTop((prev) => {
        let next = Math.min(prev, maxTop);
        if (selectedIndex >= 0) {
          if (selectedIndex < next) next = selectedIndex;
          if (selectedIndex >= next + pageSize) next = selectedIndex - pageSize + 1;
        }
        return Math.max(0, Math.min(next, maxTop));
      });
    } else {
      // Terminal-height mode: account for top/bottom indicator slots.
      const maxTop = Math.max(0, rows.length - Math.max(1, visibleBodyRows - 1));
      setScrollTop((prev) => {
        let next = Math.min(prev, maxTop);
        if (selectedIndex >= 0) {
          if (selectedIndex < next) next = selectedIndex;
          const tSlot = next > 0 ? 1 : 0;
          const potEnd = Math.min(rows.length, next + Math.max(1, visibleBodyRows - tSlot));
          const bSlot = potEnd < rows.length ? 1 : 0;
          const effEnd = Math.min(rows.length, next + Math.max(1, visibleBodyRows - tSlot - bSlot));
          if (selectedIndex >= effEnd) next = selectedIndex - visibleBodyRows + 3;
        }
        return Math.max(0, Math.min(next, maxTop));
      });
    }
  }, [rows.length, selectedIndex, visibleBodyRows, pageSize]);

  // ── Keyboard navigation ──────────────────────────────────────────────────
  // Only active if onSelect is provided (i.e., table is interactive)
  useInput(
    (_input, key) => {
      if (onSelect === undefined) return;
      const jCount = key.downArrow ? 1 : ([..._input].every(c => c === 'j') ? _input.length : 0);
      const kCount = key.upArrow ? 1 : ([..._input].every(c => c === 'k') ? _input.length : 0);
      if (kCount > 0) {
        const cur = selectedIndex >= 0 ? selectedIndex : 0;
        onSelect(kCount === 1 ? (cur > 0 ? cur - 1 : rows.length - 1) : Math.max(0, cur - kCount));
      } else if (jCount > 0) {
        const cur = selectedIndex >= 0 ? selectedIndex : 0;
        onSelect(jCount === 1 ? (cur < rows.length - 1 ? cur + 1 : 0) : Math.min(rows.length - 1, cur + jCount));
      } else if (key.pageUp) {
        // PgUp — jump back by pageSize
        const cur = selectedIndex >= 0 ? selectedIndex : 0;
        onSelect(Math.max(0, cur - pageSize));
      } else if (key.pageDown) {
        // PgDn — jump forward by pageSize
        const cur = selectedIndex >= 0 ? selectedIndex : 0;
        onSelect(Math.min(rows.length - 1, cur + pageSize));
      } else if (key.end) {
        // End — jump to last row (also Shift+G vim-style)
        onSelect(rows.length - 1);
      } else if (key.home) {
        // Home — jump to first row
        onSelect(0);
      }
    },
    { isActive: rows.length > 0 && onSelect !== undefined },
  );

  useMouseScroll(
    () => {
      if (rows.length === 0 || onSelect === undefined) return;
      const cur = selectedIndex >= 0 ? selectedIndex : 0;
      onSelect(cur > 0 ? cur - 1 : 0);
    },
    () => {
      if (rows.length === 0 || onSelect === undefined) return;
      const cur = selectedIndex >= 0 ? selectedIndex : 0;
      onSelect(Math.min(rows.length - 1, cur + 1));
    },
    { isActive: rows.length > 0 && onSelect !== undefined, hasOverflow: rows.length > visibleBodyRows },
  );

  // ── Column visibility ────────────────────────────────────────────────────
  // Priority 3: hide when < compact (72), Priority 2: hide when < narrow (56)
  const visibleColumns = columns.filter((col) => {
    if (col.priority === 3 && termWidth < TUI.width.compact) return false;
    if (col.priority === 2 && termWidth < TUI.width.narrow) return false;
    return true;
  });

  // ── Column widths ─────────────────────────────────────────────────────────
  // Clamp all width calculations to safe terminal width so
  // cells never render past the right border.
  const safeWidth = getAvailableSafeWidth(termWidth, MARGIN_LEFT_CONTENT, 0);
  const maxTableWidth = Math.max(POINTER_COL + TUI.table.minLabelWidth, safeWidth - POINTER_COL);

  // Fixed-width columns reserve their space; flex columns share the remainder.
  // Cap each fixed column at its fair share so a wide fixed col can't push
  // flex columns into negative space.
  const maxFixedColWidth = Math.floor(maxTableWidth / Math.max(1, visibleColumns.length));
  const fixedTotal = visibleColumns
    .filter((c) => c.width !== undefined)
    .reduce((sum, c) => sum + Math.min(c.width ?? 0, maxFixedColWidth), 0);

  const flexCols = visibleColumns.filter((c) => c.width === undefined);

  // Available width after pointer and all fixed columns
  const availableForFlex = Math.max(0, safeWidth - POINTER_COL - fixedTotal);

  // Cap per-flex-column width so no single column exceeds its fair share.
  // Exception: when there is only one flex column, give it all remaining space.
  const maxFlexColWidth = Math.floor(safeWidth / Math.max(1, visibleColumns.length));
  // Distribute remaining width equally across flex columns (minimum minWidth)
  const flexColWidth =
    flexCols.length > 0
      ? flexCols.length === 1
        ? availableForFlex
        : Math.min(maxFlexColWidth, Math.floor(availableForFlex / flexCols.length))
      : 0;

  /** Resolved display width for a column. */
  function colWidth(col: ColumnDef<T>): number {
    if (col.width !== undefined) return Math.min(col.width, maxFixedColWidth);
    const resolved = col.maxWidth !== undefined ? Math.min(flexColWidth, col.maxWidth) : flexColWidth;
    if (col.minWidth !== undefined) return Math.max(col.minWidth, resolved);
    return Math.max(TUI.table.minLabelWidth, resolved);
  }

  // ── Sort indicator ───────────────────────────────────────────────────────
  function sortIndicator(col: ColumnDef<T>): string {
    if (sortState?.column !== col.key) return '';
    return sortState.direction === 'asc' ? ` ${icons.trend_up}` : ` ${icons.trend_down}`;
  }

  // ── Empty state ───────────────────────────────────────────────────────────
  if (rows.length === 0) {
    const isFiltered =
      filterCount !== undefined && filterCount.visible < filterCount.total;

    return (
      <Box marginTop={GAP_BETWEEN_SECTIONS} marginLeft={POINTER_COL}>
        {emptyState !== undefined ? (
          <>{emptyState}</>
        ) : (
          <Text dimColor>
            {isFiltered ? 'No results match current filters' : MSG_NO_RESULT}
          </Text>
        )}
      </Box>
    );
  }

  // ── Row count + position ─────────────────────────────────────────────────
  const isFiltered = filterCount !== undefined && filterCount.visible < filterCount.total;
  const visibleCount = filterCount !== undefined ? filterCount.visible : rows.length;
  const totalCount = filterCount !== undefined ? filterCount.total : rows.length;
  const rowPosition = selectedIndex + 1;
  const visibleStart = scrollTop;
  // When pageSize is explicit it means DATA rows — compute visibleEnd directly.
  // When derived from terminal height, subtract indicator slots from the budget.
  const topIndicatorSlot = visibleStart > 0 ? 1 : 0;
  const maxDataRows = pageSize !== DEFAULT_PAGE_SIZE
    ? pageSize
    : Math.max(1, visibleBodyRows - topIndicatorSlot - 1);
  const visibleEnd = Math.min(rows.length, visibleStart + maxDataRows);
  const visibleRows = rows.slice(visibleStart, visibleEnd);

  // Only show counter when useful — hide when all rows fit on screen and
  // no filter is active.
  const needsScroll = rows.length > visibleBodyRows;
  const showCounter = isFiltered || needsScroll;

  const countLine = showCounter
    ? isFiltered
      ? `${visibleCount} of ${totalCount}${needsScroll ? `${DOT_SEP}row ${rowPosition}` : ''}`
      : `${rows.length > visibleBodyRows ? `${visibleStart + 1}\u2013${visibleEnd} of ${rows.length}` : `row ${rowPosition}`}`
    : '';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      {/* Row count + position — conditional */}
      {showCounter && (
        <Box marginLeft={POINTER_COL} marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text dimColor>{countLine}</Text>
        </Box>
      )}

      {/* Header row */}
      <Box>
        {/* Pointer column placeholder */}
        <Text>{' '.repeat(POINTER_COL)}</Text>
        {visibleColumns.map((col, colIdx) => {
          const w = colWidth(col);
          const label = `${col.label}${sortIndicator(col)}`;
          return (
            <Text key={`${col.key}-${colIdx}`} bold color={colors.highlight}>
              {fitCell(label, w)}
            </Text>
          );
        })}
      </Box>

      {/* Separator — safe width minus card paddingX (1 each side = 2) to prevent line wrap */}
      <Box minHeight={1}>
        <Text dimColor>
          {'─'.repeat(Math.max(20, safeWidth - 2))}
        </Text>
      </Box>

      {/* Data rows — each exactly 1 terminal row */}
      {visibleStart > 0 && (
        <Box marginLeft={POINTER_COL}>
          <Text dimColor>↑ {visibleStart} above</Text>
        </Box>
      )}

      {visibleRows.map((row, relIdx) => {
        const idx = visibleStart + relIdx;
        const isSelected = onSelect !== undefined && idx === selectedIndex;
        const rowKey = getRowKey !== undefined ? getRowKey(row, idx) : String(idx);

        return (
          <Box key={rowKey}>
            {/* Selection pointer — omit glyph when output is piped or table not interactive */}
            <Text color={isSelected ? colors.focus : undefined}>
              {isSelected ? `${process.stdout.isTTY ? icons.pointer : '>'} ` : '  '}
            </Text>

            {/* Cells */}
            {visibleColumns.map((col, colIdx) => {
              const w = colWidth(col);
              const raw = (row as Record<string, unknown>)[col.key];

              // If renderCell is provided, use it to get JSX element
              if (col.renderCell !== undefined) {
                const cellElement = col.renderCell(raw, row, w);
                return (
                  <Box key={`${col.key}-${colIdx}`} width={w}>
                    <Text bold={isSelected} color={isSelected ? colors.focus : undefined}>
                      {cellElement}
                    </Text>
                  </Box>
                );
              }

              const cellText = getCellValue(col, row);
              const truncMode = col.truncate ?? 'end';
              const fitted = fitCell(cellText, w, truncMode);

              return (
                <Text
                  key={`${col.key}-${colIdx}`}
                  bold={isSelected}
                  color={isSelected ? colors.focus : undefined}
                >
                  {fitted}
                </Text>
              );
            })}
          </Box>
        );
      })}

      {visibleEnd < rows.length && (
        <Box marginLeft={POINTER_COL}>
          <Text dimColor>↓ {rows.length - visibleEnd} below</Text>
        </Box>
      )}
    </Box>
  );
}
