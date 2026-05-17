/**
 * EntityTable — selectable table for known entity shapes detected in
 * AI-generated markdown. Rendered by ResultPanel when table headers match a
 * known entity pattern (resource|type|monthly cost, resource|risk, etc.).
 *
 * Non-matching tables fall through to static markdown rendering.
 */

import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import stringWidth from 'string-width';

import { colors, icons } from '../theme.js';
import { GAP_ROW, MARGIN_LEFT_CONTENT } from '../ui/spacing.js';
import { TERMINAL_WIDTHS } from '../ui/breakpoints.js';
import { stripAnsi } from '../ui/text.js';
import { TUI } from '../ui/tokens.js';
import type { ActionHint, TuiAction } from '../actions.js';

interface EntityRow {
  cells: string[];
}

type EntityTableActionsFn = (headers: string[], row: string[]) => ActionHint[];

interface EntityTableProps {
  headers: string[];
  rows: EntityRow[];
  /** Optional function to generate actions for the selected row. */
  actions?: EntityTableActionsFn;
  /** Called when user takes an action on the selected row. Only invoked if actions prop is provided. */
  onAction?: ((action: TuiAction, selectedRow: EntityRow) => void) | undefined;
}

/** Entity shape patterns: require exact header set matching (audit lines 1136–1140). */
const INTERACTIVE_TABLE_SCHEMAS = [
  ['resource', 'monthly cost'],
  ['resource', 'risk'],
  ['name', 'region', 'state'],
];

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase();
}

export function isEntityTable(headers: string[]): boolean {
  const normalized = headers.map(normalizeHeader);
  return INTERACTIVE_TABLE_SCHEMAS.some((schema) => {
    if (normalized.length !== schema.length) return false;
    return normalized.every((h, i) => h === schema[i]);
  });
}

function fitCell(text: string, width: number): string {
  const tw = stringWidth(text);
  if (tw <= width) return text + ' '.repeat(width - tw);
  // truncate
  let result = '';
  let w = 0;
  for (const ch of Array.from(text)) {
    const cw = stringWidth(ch);
    if (w + cw > width - 1) break;
    result += ch;
    w += cw;
  }
  return result + '…';
}

export function EntityTable({ headers, rows, actions: actionsFn, onAction }: EntityTableProps): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  // Under 56 cols switch to stacked rows
  const stackedLayout = termWidth < TERMINAL_WIDTHS.narrow;

  // Interactive table only when actions prop is provided
  const isInteractive = actionsFn !== undefined && rows.length > 0;

  // Generate actions for the selected row if this is interactive
  const selectedRow = rows[selectedIndex];
  const selectedActions = isInteractive && selectedRow !== undefined ? actionsFn(headers, selectedRow.cells) : [];

  useInput((input, key) => {
    if (!isInteractive) return;
    if (key.upArrow) setSelectedIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelectedIndex((i) => Math.min(rows.length - 1, i + 1));
    // Jump to top/bottom
    if (key.home) setSelectedIndex(0);
    if (key.end) setSelectedIndex(Math.max(0, rows.length - 1));
    // Page up/down
    if (key.pageUp) setSelectedIndex((i) => Math.max(0, i - Math.max(1, 10 - 1)));
    if (key.pageDown) setSelectedIndex((i) => Math.min(rows.length - 1, i + Math.max(1, 10 - 1)));
    // Handle actions: match against action keys
    for (const action of selectedActions) {
      if (input === action.key || (action.key.includes('/') && key.return && action.key === 'Enter')) {
        if (action.disabled === true) return;
        if (selectedRow !== undefined) {
          onAction?.(action.action, selectedRow);
        }
        return;
      }
    }
  }, { isActive: isInteractive });

  // Stacked layout for narrow terminals (< 56 cols)
  if (stackedLayout) {
    return (
      <Box flexDirection="column" gap={GAP_ROW}>
        {rows.map((row, idx) => {
          const isSelected = idx === selectedIndex;
          return (
            <Box key={idx} flexDirection="column">
              <Box gap={0}>
                <Text color={isSelected ? colors.brand : colors.muted}>{isSelected ? icons.pointer : ' '}</Text>
                <Text> </Text>
                <Text bold={isSelected} color={isSelected ? colors.brand : undefined}>
                  {fitCell(stripAnsi(row.cells[0] ?? ''), Math.max(8, termWidth - TUI.table.selectionCol - 2))}
                </Text>
              </Box>
              {headers.slice(1).map((h, i) => {
                const cellVal = row.cells[i + 1];
                if (cellVal === undefined) return null;
                return (
                  <Box key={i} marginLeft={TUI.indent.detail}>
                    <Text dimColor>{h}: <Text color={isSelected ? colors.brand : undefined}>{stripAnsi(cellVal)}</Text></Text>
                  </Box>
                );
              })}
              {isSelected && isInteractive && selectedActions.length > 0 && (
                <Box marginLeft={TUI.indent.detail} gap={GAP_ROW} flexWrap="wrap">
                  {selectedActions.map((act, i) => (
                    <React.Fragment key={act.key}>
                      {i > 0 && <Text dimColor>{icons.dot}</Text>}
                      <Text dimColor><Text color={colors.warning}>{act.key}</Text> {act.label}</Text>
                    </React.Fragment>
                  ))}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    );
  }

  // Use available terminal width for column layout instead of fixed 60
  const colCount = headers.length;
  // Reserve selectionCol for pointer + gap
  const availableWidth = Math.max(20, termWidth - TUI.table.selectionCol);
  const colWidth = Math.max(12, Math.floor(availableWidth / colCount));

  return (
    <Box flexDirection="column">
      {/* Header row */}
      <Box gap={GAP_ROW}>
        <Text> </Text>
        {headers.map((h, i) => (
          <Box key={i} width={colWidth}>
            <Text bold dimColor>{fitCell(h, colWidth)}</Text>
          </Box>
        ))}
      </Box>

      {/* Data rows */}
      {rows.map((row, idx) => {
        const isSelected = idx === selectedIndex;
        return (
          <Box key={idx} flexDirection="column">
            <Box gap={GAP_ROW}>
              <Text color={isSelected ? colors.brand : undefined}>{isSelected ? icons.pointer : ' '}</Text>
              {row.cells.map((cell, ci) => (
                <Box key={ci} width={colWidth}>
                  <Text
                    bold={isSelected && ci === 0}
                    color={ci === 0 && isSelected ? colors.brand : undefined}
                    wrap="truncate-end"
                  >
                    {stripAnsi(cell)}
                  </Text>
                </Box>
              ))}
            </Box>
            {isSelected && isInteractive && selectedActions.length > 0 && (
              <Box marginLeft={MARGIN_LEFT_CONTENT} gap={GAP_ROW} flexWrap="wrap">
                {selectedActions.map((act, i) => (
                  <React.Fragment key={act.key}>
                    {i > 0 && <Text dimColor>{icons.dot}</Text>}
                    <Text dimColor><Text color={colors.warning}>{act.key}</Text> {act.label}</Text>
                  </React.Fragment>
                ))}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
