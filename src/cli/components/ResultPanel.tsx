import React, { useState, useEffect } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';

import { colors, icons, borders, scrollAboveLabel, scrollBelowLabel } from '../theme.js';
import { formatCost } from '../utils/format.js';
import { InteractionHints, buildInteractionHints } from './InteractionHints.js';
import { ActionBar } from './ActionBar.js';
import { EntityTable, isEntityTable } from './EntityTable.js';
import { useMouseScroll } from '../hooks/useMouseScroll.js';
import { useTuiViewportLayout } from '../hooks/useTuiViewportLayout.js';
import type { ActionHint, TuiAction } from '../actions.js';
import { actionKeyMatches } from '../actions.js';
import { DOT_SEP, MSG_NO_RESULT } from '../ui/text.js';
import { stringWidth } from '../ui/width.js';
import { GAP_BETWEEN_SECTIONS, PADDING_X, GAP_ROW } from '../ui/spacing.js';
import { TERMINAL_WIDTHS } from '../ui/breakpoints.js';
import { TUI } from '../ui/tokens.js';

interface ResultPanelProps {
  result: string;
  totalCostUsd?: number;
  numTurns?: number;
  durationMs?: number;
  onRunAgain?: (() => void) | undefined;
  onBack?: (() => void) | undefined;
  onAction?: ((action: TuiAction) => void) | undefined;
  /** When false, disables keyboard input (e.g. when a follow-up TextInput has focus). */
  isActive?: boolean;
  /** Custom title shown in the result header instead of "Complete". */
  title?: string | undefined;
  /**
   * Metadata string shown in the result header (e.g. "3 turns · 2.4s · $0.012").
   * When provided, replaces the default numTurns/durationMs/totalCostUsd display.
   */
  metadata?: string | undefined;
  /**
   * Custom empty-state actions shown when result is empty.
   * Defaults to: r run again . d doctor . Esc/b back
   */
  emptyActions?: ActionHint[];
  /** Custom message when result is empty. */
  emptyMessage?: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Markdown → Terminal ────────────────────────────────────────────────────

/**
 * Clean up inline text — remove zero-width joiners and variation selectors,
 * but preserve structure (newlines, indentation).
 *
 * Do NOT collapse all whitespace across the document. Only clean
 * inline control characters per line so code blocks, table spacing, and blank
 * lines survive.
 */
function cleanText(text: string): string {
  return text
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/[\u{200D}]/gu, '')
    // Collapse runs of SPACE/TAB on a single line (not newlines)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function cleanInlineText(text: string): string {
  return cleanText(text)
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/(^|\s)\*(?=\S)/g, '$1')
    .replace(/(?<=\S)\*(\s|$)/g, '$1');
}

/**
 * Fragment cleaner for inline rendering.
 *
 * Unlike cleanInlineText(), does NOT trim leading/trailing whitespace.
 * Trimming fragments causes adjacent styled tokens to lose the space
 * between them, producing artefacts like "gap:All" or "$12/moreveals".
 * Use this whenever text is a mid-expression slice, not a standalone line.
 */
function cleanInlineFragment(text: string): string {
  return text
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/[\u{200D}]/gu, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/(^|\s)\*(?=\S)/g, '$1')
    .replace(/(?<=\S)\*(\s|$)/g, '$1');
}

/** Check if a line is entirely **bold** (a pseudo-header). */
function isFullLineBold(line: string): { isBold: true; content: string } | { isBold: false } {
  const trimmed = line.trim();
  const m = trimmed.match(/^\*\*(.+)\*\*$/);
  if (m) return { isBold: true, content: m[1] ?? '' };
  return { isBold: false };
}

/** Renders **bold**, `code`, and $dollar amounts inline. */
function renderInlineMarkdown(text: string): React.JSX.Element {
  const parts: React.JSX.Element[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const codeMatch = remaining.match(/`([^`]+)`/);
    const dollarMatch = remaining.match(/\$[\d,]+(?:\.\d{1,2})?(?:\/mo|\/yr|\/h|[kKmM])?/);

    const boldIdx = boldMatch?.index ?? Infinity;
    const codeIdx = codeMatch?.index ?? Infinity;
    const dollarIdx = dollarMatch?.index ?? Infinity;

    const minIdx = Math.min(boldIdx, codeIdx, dollarIdx);
    if (minIdx === Infinity) {
      // Use fragment cleaner — remaining tail may have a leading space
      // (e.g., " reveals" after "$12/mo") that cleanInlineText would trim away.
      // Only trim if this is the very first (and only) fragment.
      const isFirst = parts.length === 0;
      parts.push(<Text key={key}>{isFirst ? cleanInlineText(remaining) : cleanInlineFragment(remaining)}</Text>);
      break;
    }

    if (boldIdx === minIdx && boldMatch) {
      if (boldIdx > 0) {
        // Use fragment cleaner — do not trim so surrounding spaces are kept
        parts.push(<Text key={key++}>{cleanInlineFragment(remaining.slice(0, boldIdx))}</Text>);
      }
      parts.push(<Text key={key++} bold>{cleanInlineText(boldMatch[1] ?? '')}</Text>);
      remaining = remaining.slice(boldIdx + boldMatch[0].length);
    } else if (codeIdx === minIdx && codeMatch) {
      if (codeIdx > 0) {
        // Use fragment cleaner — do not trim so surrounding spaces are kept
        parts.push(<Text key={key++}>{cleanInlineFragment(remaining.slice(0, codeIdx))}</Text>);
      }
      parts.push(<Text key={key++} color={colors.warning}>{cleanInlineText(codeMatch[1] ?? '')}</Text>);
      remaining = remaining.slice(codeIdx + codeMatch[0].length);
    } else if (dollarMatch) {
      if (dollarIdx > 0) {
        // Use fragment cleaner — do not trim so surrounding spaces are kept
        parts.push(<Text key={key++}>{cleanInlineFragment(remaining.slice(0, dollarIdx))}</Text>);
      }
      parts.push(<Text key={key++} bold color={colors.cost}>{dollarMatch[0]}</Text>);
      remaining = remaining.slice(dollarIdx + dollarMatch[0].length);
    }
  }

  return <>{parts}</>;
}

function renderSectionTitle(key: React.Key, text: string): React.JSX.Element {
  return (
    <Box key={key} marginTop={GAP_BETWEEN_SECTIONS}>
      <Text bold color={colors.brand}>{cleanInlineText(text)}</Text>
    </Box>
  );
}

function renderLabelledProse(line: string, key: React.Key): React.JSX.Element | null {
  const match = cleanText(line).match(/^([A-Za-z][A-Za-z0-9 /+&().-]{2,36}):\s+(.+)$/);
  if (match === null) return null;
  const [, label, value] = match;
  return (
    <Text key={key} wrap="wrap">
      <Text bold color={colors.brand}>{cleanInlineText(label ?? '')}:</Text>{' '}
      {renderInlineMarkdown(value ?? '')}
    </Text>
  );
}

function renderTableCellFallback(headers: string[], cells: string[], rowKey: string): React.JSX.Element {
  return (
    <Text key={rowKey} wrap="wrap">
      {cells.map((cell, index) => {
        const label = headers[index] ?? `Col ${index + 1}`;
        const text = `${label}: ${cleanText(cell)}`;
        return (
          <React.Fragment key={`${rowKey}-${index}`}>
            {index > 0 ? DOT_SEP : ''}
            {renderInlineMarkdown(text)}
          </React.Fragment>
        );
      })}
    </Text>
  );
}

/**
 * Stacked key/value card for a table row when the terminal is narrow.
 * Renders each cell as "  Header: value" on its own line.
 */
function renderTableRowStacked(headers: string[], cells: string[], rowKey: string): React.JSX.Element {
  return (
    <Box key={rowKey} flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
      {cells.map((cell, index) => {
        const label = headers[index] ?? `Col ${index + 1}`;
        return (
          <Box key={`${rowKey}-${index}`} marginLeft={TUI.indent.content} gap={GAP_ROW}>
            <Text dimColor>{label}:</Text>
            <Text wrap="wrap">{renderInlineMarkdown(cleanText(cell))}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

/** Convert markdown text to an array of Ink elements with proper visual hierarchy. */
export function renderMarkdown(text: string, terminalCols = 80, onAction?: (action: TuiAction) => void): React.JSX.Element[] {
  // Pre-process: strip variation selectors/zero-width joiners at doc level,
  // collapse 3+ consecutive blank lines to 2, but preserve all other whitespace.
  // Do NOT call cleanText() on the whole document — that collapses
  // meaningful indentation and blank lines inside code blocks and tables.
  const cleaned = text
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/[\u{200D}]/gu, '')
    .replace(/\n{3,}/g, '\n\n');
  const lines = cleaned.split('\n');
  const elements: React.JSX.Element[] = [];
  const dividerWidth = Math.max(8, Math.min(60, terminalCols - 6));

  let inCodeBlock = false;
  const pendingCodeLines: Array<{ idx: number; line: string }> = [];
  let prevWasBlank = false;
  let prevWasSectionTitle = false;
  let currentTableHeaders: string[] | null = null;
  // Track whether current table is an entity table
  let entityTableHeaders: string[] | null = null;
  const entityTableRows: Array<{ cells: string[] }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Code fence toggle
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        pendingCodeLines.length = 0;
        const lang = line.slice(3).trim();
        if (lang.length > 0) {
          elements.push(
            <Text key={`lang-${i}`} dimColor>{`  [${lang}]`}</Text>,
          );
        }
      } else {
        for (const { idx, line: codeLine } of pendingCodeLines) {
          elements.push(
            <Text key={idx} color={colors.warning} wrap="wrap">
              {'    '}{codeLine}
            </Text>,
          );
        }
        pendingCodeLines.length = 0;
        inCodeBlock = false;
      }
      prevWasBlank = false;
      continue;
    }

    if (inCodeBlock) {
      pendingCodeLines.push({ idx: i, line });
      continue;
    }

    // Blank lines — skip consecutive, just track
    if (line.trim().length === 0) {
      currentTableHeaders = null;
      if (!prevWasBlank && elements.length > 0) {
        elements.push(<Text key={`blank-${i}`}>{' '}</Text>);
      }
      prevWasBlank = true;
      prevWasSectionTitle = false;
      continue;
    }
    prevWasBlank = false;

    // ── Headers ──────────────────────────────────

    // # H1
    if (line.startsWith('# ')) {
      elements.push(renderSectionTitle(i, line.slice(2)));
      prevWasSectionTitle = true;
      continue;
    }
    // ## H2 — section header with divider
    if (line.startsWith('## ')) {
      elements.push(renderSectionTitle(i, line.slice(3)));
      prevWasSectionTitle = true;
      continue;
    }
    // ### H3
    if (line.startsWith('### ')) {
      elements.push(
        <Text key={i} bold>
          {cleanText(line.slice(4))}
        </Text>,
      );
      prevWasSectionTitle = true;
      continue;
    }
    // #### H4+
    if (line.startsWith('#### ') || line.startsWith('##### ')) {
      const depth = line.startsWith('##### ') ? 5 : 4;
      elements.push(
        <Text key={i} dimColor bold>
          {cleanText(line.slice(depth + 1))}
        </Text>,
      );
      prevWasSectionTitle = true;
      continue;
    }

    // Full-line **bold** → treat as sub-header
    const fullBold = isFullLineBold(line);
    if (fullBold.isBold) {
      elements.push(
        <Text key={i} bold color={colors.brand}>
          {cleanText(fullBold.content)}
        </Text>,
      );
      prevWasSectionTitle = true;
      continue;
    }

    // Markdown table row
    if (line.match(/^\|.+\|$/)) {
      if (line.match(/^\|[\s\-:|]+\|$/)) continue; // skip separator
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      const nextLine = lines[i + 1] ?? '';
      const isHeader = Boolean(nextLine.match(/^\|[\s\-:|]+\|$/));
      const availableWidth = terminalCols - 6;

      // Detect entity table headers and accumulate rows
      if (isHeader) {
        // Flush any pending entity table before starting a new one
        if (entityTableHeaders !== null && entityTableRows.length > 0) {
          const capturedHeaders = entityTableHeaders;
          const capturedRows = [...entityTableRows];
          const capturedOnAction = onAction;
          elements.push(
            <EntityTable
              key={`entity-tbl-flush-${i}`}
              headers={capturedHeaders}
              rows={capturedRows}
              onAction={capturedOnAction !== undefined ? (a, _r) => capturedOnAction(a) : undefined}
            />,
          );
          entityTableRows.length = 0;
        }
        if (isEntityTable(cells)) {
          entityTableHeaders = cells;
          currentTableHeaders = cells;
          continue;
        }
        entityTableHeaders = null;
        currentTableHeaders = cells;
      } else if (entityTableHeaders !== null) {
        // Accumulate entity rows
        entityTableRows.push({ cells });
        // Check if next line exits the table
        const afterNextLine = lines[i + 1] ?? '';
        const nextIsTableRow = afterNextLine.match(/^\|.+\|$/);
        if (!nextIsTableRow) {
          // Flush entity table
          const capturedHeaders = entityTableHeaders;
          const capturedRows = [...entityTableRows];
          const capturedOnAction = onAction;
          elements.push(
            <EntityTable
              key={`entity-tbl-${i}`}
              headers={capturedHeaders}
              rows={capturedRows}
              onAction={capturedOnAction !== undefined ? (a, _r) => capturedOnAction(a) : undefined}
            />,
          );
          entityTableRows.length = 0;
          entityTableHeaders = null;
        }
        continue;
      }

      // Proportional column widths: measure max content per column across nearby rows
      const nearbyRows: string[][] = [];
      for (let j = Math.max(0, i - 10); j < Math.min(lines.length, i + 20); j++) {
        const rl = lines[j] ?? '';
        if (rl.match(/^\|.+\|$/) && !rl.match(/^\|[\s\-:|]+\|$/)) {
          nearbyRows.push(rl.split('|').slice(1, -1).map((c) => c.trim()));
        }
      }
      const colCount = cells.length;
      const colMaxWidths = Array.from({ length: colCount }, (_, ci) =>
        Math.max(8, ...nearbyRows.map((r) => stringWidth(r[ci] ?? '') + 2)),
      );
      const totalNatural = colMaxWidths.reduce((s, w) => s + w, 0);
      const isTooWide = totalNatural > availableWidth || availableWidth < Math.min(60, colCount * 12);

      // On narrow terminals use stacked key/value card; otherwise inline fallback
      if (!isHeader && currentTableHeaders !== null && isTooWide) {
        if (terminalCols < TERMINAL_WIDTHS.compact) {
          elements.push(renderTableRowStacked(currentTableHeaders, cells, `tbl-${i}`));
        } else {
          elements.push(renderTableCellFallback(currentTableHeaders, cells, `tbl-${i}`));
        }
        continue;
      }

      const colWidths = colMaxWidths.map((w) =>
        Math.max(8, Math.min(Math.floor((w / totalNatural) * availableWidth), w)),
      );

      elements.push(
        <Box key={i} gap={GAP_ROW}>
          {cells.map((cell, ci) => (
            <Box key={ci} width={colWidths[ci]}>
              <Text
                wrap="truncate-end"
                bold={isHeader}
                color={ci === 0 && !isHeader ? colors.brand : undefined}
              >
                {renderInlineMarkdown(cleanText(cell))}
              </Text>
            </Box>
          ))}
        </Box>,
      );
      continue;
    }

    // Horizontal rule
    if (line.match(/^[-*_]{3,}$/)) {
      currentTableHeaders = null;
      if (!prevWasSectionTitle) {
        elements.push(<Text key={i} dimColor>{'─'.repeat(dividerWidth)}</Text>);
      }
      prevWasSectionTitle = false;
      continue;
    }

    // Bullet points
    if (line.match(/^\s*[-*]\s/)) {
      currentTableHeaders = null;
      const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      const trimmed = line.replace(/^\s*[-*]\s/, '');
      elements.push(
        <Box key={i} marginLeft={indent > 0 ? TUI.indent.content : 0} gap={GAP_ROW}>
          <Text color={colors.brand}>{icons.bullet}</Text>
          <Text wrap="wrap">{renderInlineMarkdown(trimmed)}</Text>
        </Box>,
      );
      prevWasSectionTitle = false;
      continue;
    }

    // Numbered list
    if (line.match(/^\s*\d+\.\s/)) {
      currentTableHeaders = null;
      const numbered = line.match(/^\s*(\d+)\.\s+(.+)$/);
      const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      elements.push(
        <Box key={i} marginLeft={indent > 0 ? TUI.indent.content : 0} gap={GAP_ROW}>
          <Text color={colors.brand}>{numbered?.[1] ?? ''}.</Text>
          <Text wrap="wrap">{renderInlineMarkdown(numbered?.[2] ?? line)}</Text>
        </Box>,
      );
      prevWasSectionTitle = false;
      continue;
    }

    // Regular text
    currentTableHeaders = null;
    elements.push(renderLabelledProse(line, i) ?? <Text key={i} wrap="wrap">{renderInlineMarkdown(line)}</Text>);
    prevWasSectionTitle = false;
  }

  // Unclosed code fence
  if (inCodeBlock && pendingCodeLines.length > 0) {
    for (const { idx, line: codeLine } of pendingCodeLines) {
      elements.push(
        <Text key={`unclosed-${idx}`} color={colors.warning} wrap="wrap">
          {'    '}{codeLine}
        </Text>,
      );
    }
  }

  return elements;
}

// ─── Component ──────────────────────────────────────────────────────────────

const DEFAULT_EMPTY_ACTIONS: ActionHint[] = [
  { key: 'r', label: 'run again', action: { type: 'run-again' as const } },
  { key: 'd', label: 'doctor', action: { type: 'navigate' as const, command: 'doctor' } },
];

export function ResultPanel({
  result,
  totalCostUsd,
  numTurns,
  durationMs,
  onRunAgain,
  onBack,
  onAction,
  isActive = true,
  title,
  metadata,
  emptyActions,
  emptyMessage,
}: ResultPanelProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Use viewport layout instead of fixed `rows - 6` offset
  const { contentRows } = useTuiViewportLayout({
    header: TUI.rows.header,
    status: TUI.rows.status,
    actions: TUI.rows.actions,
    hints: TUI.rows.hints,
  });
  const viewportHeight = Math.max(TUI.rows.minContent, contentRows);
  const [scrollOffset, setScrollOffset] = useState(0);
  const mdElements = renderMarkdown(result, stdout?.columns ?? 80, onAction);
  const isEmptyResult = result.trim().length === 0;

  // Empty actions (default + custom)
  const resolvedEmptyActions = emptyActions ?? DEFAULT_EMPTY_ACTIONS;

  // Reset scroll when result changes (e.g., follow-up query)
  useEffect(() => {
    setScrollOffset(0);
  }, [result]);

  const maxScroll = Math.max(0, mdElements.length - viewportHeight);
  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset < maxScroll;

  useInput((input, key) => {
    if (input === 'q') exit();
    if (isEmptyResult) {
      // Handle empty-state action keys
      const matched = resolvedEmptyActions.find((a) => actionKeyMatches(input, key, a.key));
      if (matched !== undefined) {
        if (matched.disabled === true) return;
        if (matched.action.type === 'run-again' && onRunAgain !== undefined) { onRunAgain(); return; }
        if (matched.action.type === 'back' && onBack !== undefined) { onBack(); return; }
        onAction?.(matched.action);
        return;
      }
    }
    // c to copy result text, o to open (delegate to caller via onAction)
    if (input === 'c' && !isEmptyResult) {
      onAction?.({ type: 'copy' as const, text: result });
      return;
    }
    if (input === 'r' && onRunAgain !== undefined) onRunAgain();
    if ((input === 'b' || key.escape) && onBack !== undefined) onBack();
    if (key.upArrow && canScrollUp) {
      setScrollOffset((o) => Math.max(0, o - 1));
    }
    if (key.downArrow && canScrollDown) {
      setScrollOffset((o) => Math.min(maxScroll, o + 1));
    }
    if (key.pageUp && canScrollUp) setScrollOffset(o => Math.max(0, o - viewportHeight));
    if (key.pageDown && canScrollDown) setScrollOffset(o => Math.min(maxScroll, o + viewportHeight));
  }, { isActive });

  useMouseScroll(
    () => { if (canScrollUp) setScrollOffset((o) => Math.max(0, o - 1)); },
    () => { if (canScrollDown) setScrollOffset((o) => Math.min(maxScroll, o + 1)); },
  );

  return (
    <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
      <Box borderStyle={borders.result} borderColor={colors.success} paddingX={PADDING_X} paddingBottom={1} flexDirection="column">
        <Box gap={GAP_ROW} marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text color={colors.success}>{icons.success}</Text>
          <Text bold color={colors.success}>
            {title ?? 'Complete'}
          </Text>
          {metadata !== undefined ? (
            <Text dimColor>{metadata}</Text>
          ) : (
            <>
              {durationMs !== undefined && (
                <Text dimColor>in {formatDuration(durationMs)}</Text>
              )}
              {numTurns !== undefined && (
                <>
                  <Text dimColor>{icons.dot}</Text>
                  <Text dimColor>{numTurns} turn{numTurns !== 1 ? 's' : ''}</Text>
                </>
              )}
              {totalCostUsd !== undefined && (
                <>
                  <Text dimColor>{icons.dot}</Text>
                  <Text dimColor>{formatCost(totalCostUsd)}</Text>
                </>
              )}
            </>
          )}
        </Box>
        <Box flexDirection="column">
          {isEmptyResult ? (
            <>
              <Text dimColor>{emptyMessage ?? MSG_NO_RESULT}</Text>
              {resolvedEmptyActions.length > 0 && (
                <ActionBar
                  actions={resolvedEmptyActions}
                  onAction={(a) => {
                    if (a.type === 'run-again' && onRunAgain !== undefined) { onRunAgain(); return; }
                    if (a.type === 'back' && onBack !== undefined) { onBack(); return; }
                    onAction?.(a);
                  }}
                  marginLeft={0}
                />
              )}
            </>
          ) : canScrollUp ? (
            <Text dimColor>{scrollAboveLabel(scrollOffset)}</Text>
          ) : null}
          {!isEmptyResult && mdElements.slice(scrollOffset, scrollOffset + viewportHeight)}
          {!isEmptyResult && canScrollDown && (
            <Text dimColor>{scrollBelowLabel(maxScroll - scrollOffset)}</Text>
          )}
        </Box>
      </Box>

      {!isEmptyResult && onAction !== undefined && (
        <ActionBar
          actions={[{ key: 'c', label: 'copy result', action: { type: 'copy' as const, text: result } }]}
          onAction={onAction}
          isActive={false}
        />
      )}

      <InteractionHints hints={buildInteractionHints({
        onBack,
        hasScroll: mdElements.length > viewportHeight,
        hasPages: mdElements.length > viewportHeight,
      })} />
    </Box>
  );
}
