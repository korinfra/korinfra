/**
 * CostsDetailOverlay — service breakdown detail panel.
 *
 * Shows on Enter from the Period tab row selection.
 * ← / → navigate between services without closing.
 * Footer: Esc/b close · q quit · ← → navigate
 *
 * VRHYTHM_RULE: spacing from src/cli/ui/spacing.ts only.
 * DOT_SEP_RULE: DOT_SEP from src/cli/ui/text.js.
 * SCREEN_SHELL_RULE: rendered inside a ScreenShell by the parent.
 */

import React from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';

import { colors, borders, semanticColors, supportsUnicode } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, GAP_ROW, PADDING_X } from '../ui/spacing.js';
import { DOT_SEP, stripAnsi } from '../ui/text.js';
import { formatMoneyExact } from '../ui/format.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CostsDetailItem {
  /** Service / product name */
  label: string;
  /** Raw (un-abbreviated) name */
  rawLabel: string;
  /** Current-period cost */
  value: number;
  /** Share of total cost (0–100) */
  pct: number;
  /** Rank in the cost breakdown list */
  rank: number;
  /** Total rows in the parent list — used for "Rank: N of M" display */
  totalRows: number;
  /** Period in days */
  cappedDays: number;
  /** Human-readable period label, e.g. "May 2026" or "last 30 days" */
  periodLabel: string;
  /** Average daily cost = value / cappedDays */
  dailyAvg: number;
  /** Share tier: 'high' | 'mid' | 'low' */
  trendLabel: string;
  /** Visual share bar string (e.g. "▓▓▓░░░░░") */
  sharebar: string;
}

interface CostsDetailOverlayProps {
  item: CostsDetailItem;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  hasNext?: boolean;
  hasPrev?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function trendColor(label: string): string {
  if (label === 'high') return semanticColors.severity.high ?? 'red';
  if (label === 'mid') return colors.warning ?? 'yellow';
  return colors.success ?? 'green';
}

function trendIcon(label: string): string {
  return label === 'low' ? '─' : '▲';
}

function barColor(pct: number): string {
  if (pct >= 20) return semanticColors.severity.high ?? 'red';
  if (pct >= 5) return colors.warning ?? 'yellow';
  return semanticColors.cost.value ?? 'yellow';
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CostsDetailOverlay({
  item,
  onClose,
  onNext,
  onPrev,
  hasNext = false,
  hasPrev = false,
}: CostsDetailOverlayProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const termWidth = stdout?.columns ?? 80;

  // Width: 50% of terminal, capped 55–100
  const overlayWidth = Math.max(55, Math.min(Math.floor(termWidth * 0.5), 100));

  useInput((input, key) => {
    if (input === 'q') exit();
    if (key.escape || input === 'b') { onClose(); return; }
    if (key.rightArrow && hasNext) { onNext?.(); return; }
    if (key.leftArrow && hasPrev) { onPrev?.(); return; }
  }, { isActive: !helpOpen && !paletteOpen });

  const LABEL_W = 'Monthly projection:  '.length;
  const lbl = (s: string): string => s.padEnd(LABEL_W);

  const projMonthly = item.dailyAvg * 30;
  const projAnnual = item.dailyAvg * 365;
  const fillChar = supportsUnicode ? '▓' : '#';
  const emptyChar = supportsUnicode ? '░' : '.';
  const filledCount = item.sharebar.split('').filter((c) => c === '▓' || c === '#').length;
  const emptyCount = item.sharebar.length - filledCount;

  return (
    <Box flexDirection="column" width={overlayWidth}>
      <Box
        borderStyle={borders.card}
        borderColor={colors.brand}
        flexDirection="column"
        paddingX={PADDING_X}
        width={overlayWidth}
      >
        {/* Header: service name + rank badge */}
        <Box gap={GAP_ROW} flexWrap="wrap">
          <Text color={colors.brand} bold>{stripAnsi(item.rawLabel)}</Text>
          <Text dimColor>#{item.rank} of {item.totalRows}</Text>
        </Box>

        {/* Metrics */}
        <Box marginTop={GAP_BETWEEN_SECTIONS} flexDirection="column" gap={GAP_ROW}>
          <Box gap={GAP_ROW}>
            <Text dimColor>{lbl('Period:')}</Text>
            <Text dimColor>{item.periodLabel}</Text>
          </Box>
          <Box gap={GAP_ROW}>
            <Text dimColor>{lbl('Total cost:')}</Text>
            <Text color={colors.cost}>{formatMoneyExact(item.value)}</Text>
          </Box>
          <Box gap={GAP_ROW}>
            <Text dimColor>{lbl('Daily average:')}</Text>
            <Text color={colors.cost}>{formatMoneyExact(item.dailyAvg)}<Text dimColor>/day</Text></Text>
          </Box>
          <Box gap={GAP_ROW}>
            <Text dimColor>{lbl('Monthly projection:')}</Text>
            <Text color={colors.cost}>{formatMoneyExact(projMonthly)}<Text dimColor>/mo  est.</Text></Text>
          </Box>
          <Box gap={GAP_ROW}>
            <Text dimColor>{lbl('Annual projection:')}</Text>
            <Text color={colors.cost}>{formatMoneyExact(projAnnual)}<Text dimColor>/yr  est.</Text></Text>
          </Box>
          <Box gap={GAP_ROW}>
            <Text dimColor>{lbl('Share of total:')}</Text>
            <Text>
              <Text>{item.pct.toFixed(1)}%{'  '}</Text>
              <Text color={barColor(item.pct)}>{fillChar.repeat(filledCount)}</Text>
              <Text dimColor>{emptyChar.repeat(emptyCount)}</Text>
            </Text>
          </Box>
          <Box gap={GAP_ROW}>
            <Text dimColor>{lbl('Cost tier:')}</Text>
            <Text color={trendColor(item.trendLabel)}>{trendIcon(item.trendLabel)} {item.trendLabel}</Text>
          </Box>
        </Box>

        {/* Footer hint */}
        <Box marginTop={GAP_BETWEEN_SECTIONS} gap={GAP_ROW}>
          <Text dimColor><Text color={colors.warning}>Esc/b</Text>{' close'}</Text>
          {(hasPrev || hasNext) && (
            <>
              <Text dimColor>{DOT_SEP}</Text>
              <Text dimColor>
                <Text color={colors.warning}>← →</Text>
                {' navigate'}
                {hasPrev && ` (${item.rank - 1} prev)`}
                {hasNext && ` (${item.totalRows - item.rank} next)`}
              </Text>
            </>
          )}
          <Text dimColor>{DOT_SEP}</Text>
          <Text dimColor><Text color={colors.warning}>q</Text>{' quit'}</Text>
        </Box>
      </Box>
    </Box>
  );
}
