/**
 * ScanDetailOverlay — §3.3 detail overlay for a scan recommendation.
 *
 * Shows WHAT / WHY / HOW in three columns.
 * Footer: `f` fix this · `Esc/b` close (owned by this component per §1.4).
 *
 * Rules:
 *   VRHYTHM_RULE — spacing via GAP_* constants only
 *   DOT_SEP_RULE — DOT_SEP from ui/text.js
 *   SEVERITY_LABELS_RULE — SEVERITY_LABELS from ui/text.ts
 *   ERR2-1 rule scope — this component owns its own footer hints
 */

import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import { colors, borders, semanticColors } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, GAP_BEFORE_ACTIONS, PADDING_X, GAP_ROW } from '../ui/spacing.js';
import { DOT_SEP, SEVERITY_LABELS } from '../ui/text.js';
import { truncateWidth } from '../ui/width.js';
import type { TuiAction } from '../actions.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScanDetailRec {
  id: string;
  title: string;
  description: string;
  impact: 'critical' | 'high' | 'medium' | 'low';
  risk: 'critical' | 'high' | 'medium' | 'low';
  estimatedSavingsUsd: number;
  resourceId?: string;
  type?: string;
  scenario?: string;
}

interface ScanDetailOverlayProps {
  rec: ScanDetailRec;
  onAction?: ((action: TuiAction) => void) | undefined;
  onClose: () => void;
  isActive?: boolean;
  /** When false, hides AI-specific footer/HOW text (no-AI mode). */
  hasAi?: boolean;
}

// ─── Column widths (§3.3 spec) ────────────────────────────────────────────────

function computeColWidths(termWidth: number): { what: number; why: number; how: number; total: number } {
  const total = Math.max(50, termWidth - 4);
  // Subtract border (2) + paddingX (1 each side = 2) + inter-column gaps (2 gaps × 1 = 2)
  const innerContent = total - 2 - 2 * PADDING_X - 2;
  // Distribute: WHAT 28%, WHY 44%, HOW 28%
  const what = Math.floor(innerContent * 0.28);
  const how = Math.floor(innerContent * 0.28);
  const why = innerContent - what - how;
  return { what, why, how, total };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function severityColor(impact: ScanDetailRec['impact']): string | undefined {
  return semanticColors.severity[impact];
}

/**
 * Word-wrap `text` into lines of at most `maxCols` display columns.
 * Simple greedy algorithm — no hyphenation.
 */
function wrapText(text: string, maxCols: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const truncWord = truncateWidth(word, maxCols);
    if (current.length === 0) {
      current = truncWord;
    } else if ((current + ' ' + truncWord).length <= maxCols) {
      current += ' ' + truncWord;
    } else {
      lines.push(current);
      current = truncWord;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

// ─── Column component ──────────────────────────────────────────────────────

interface ColProps {
  heading: string;
  lines: string[];
  width: number;
  color?: string;
}

function DetailCol({ heading, lines, width, color }: ColProps): React.JSX.Element {
  return (
    <Box flexDirection="column" width={width} flexShrink={0} paddingRight={2}>
      <Text bold color={color ?? colors.highlight}>{truncateWidth(heading, width - 2)}</Text>
      <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
        {lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export function ScanDetailOverlay({
  rec,
  onAction,
  onClose,
  isActive = true,
  hasAi = true,
}: ScanDetailOverlayProps): React.JSX.Element {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termHeight = stdout?.rows ?? 24;
  const overlayBodyMaxRows = Math.max(4, termHeight - 10);
  const { what: colWhat, why: colWhy, how: colHow, total: overlayWidth } = computeColWidths(termWidth);

  useInput((input, key) => {
    if (!isActive) return;
    if (input === 'b' || key.escape) {
      onClose();
      return;
    }
    if (input === 'f') {
      const encoded = Buffer.from(JSON.stringify(rec)).toString('base64');
      onAction?.({ type: 'navigate', command: 'fix', args: [rec.id, `--inline-rec=${encoded}`] });
      return;
    }
  }, { isActive });

  const sevLabel = SEVERITY_LABELS[rec.impact];
  const sevColor = severityColor(rec.impact);
  const savings = rec.estimatedSavingsUsd > 0
    ? `~$${rec.estimatedSavingsUsd.toFixed(0)}/mo`
    : undefined;

  // WHAT column: title + resource info
  const whatLines = wrapText(rec.title, colWhat - 2);
  if (rec.resourceId !== undefined) {
    whatLines.push('');
    whatLines.push(...wrapText(`Resource: ${rec.resourceId}`, colWhat - 2));
  }
  if (rec.type !== undefined) {
    whatLines.push(...wrapText(`Type: ${rec.type}`, colWhat - 2));
  }
  if (rec.scenario !== undefined) {
    const scenarioLabel = rec.scenario === 'A'
      ? 'Not deployed (TF only)'
      : rec.scenario === 'B'
      ? 'Deployed (TF + AWS)'
      : rec.scenario === 'C'
      ? 'Unmanaged (AWS only)'
      : rec.scenario;
    whatLines.push(...wrapText(`Scenario: ${scenarioLabel}`, colWhat - 2));
  }

  // WHY column: description only (strip dedup alternatives appended by mergeAlternatives)
  const whyLines = wrapText(rec.description.split('\n\nAlternative:')[0] ?? '', colWhy - 2);

  // HOW column: generic remediation hint based on impact
  const howLines = buildHowLines(rec.impact, colHow - 2, hasAi);

  return (
    <Box flexDirection="column" width={overlayWidth}>
      <Box
        flexDirection="column"
        borderStyle={borders.card}
        borderColor={colors.highlight}
        paddingX={PADDING_X}
      >
        {/* Header row: severity badge + title + savings */}
        <Box gap={GAP_ROW} marginBottom={GAP_BETWEEN_SECTIONS} flexWrap="wrap">
          <Text bold color={sevColor}>[{sevLabel}]</Text>
          <Text bold>{truncateWidth(rec.title, overlayWidth - sevLabel.length - 6)}</Text>
          {savings !== undefined && (
            <Text color={colors.saving}>{savings}</Text>
          )}
        </Box>

        <Box flexDirection="row" gap={1} height={overlayBodyMaxRows} overflow="hidden">
          <DetailCol heading="WHAT" lines={whatLines.slice(0, overlayBodyMaxRows)} width={colWhat} />
          <DetailCol heading="WHY" lines={whyLines.slice(0, overlayBodyMaxRows)} width={colWhy} />
          <DetailCol heading="HOW" lines={howLines.slice(0, overlayBodyMaxRows)} width={colHow} />
        </Box>
      </Box>

      <Box marginTop={GAP_BEFORE_ACTIONS} gap={GAP_ROW} flexWrap="wrap">
        {hasAi && (
          <>
            <Text>
              <Text color={colors.warning} bold>f</Text> fix this
            </Text>
            <Text dimColor>{DOT_SEP}</Text>
          </>
        )}
        <Text dimColor>
          <Text color={colors.warning}>Esc/b</Text> close
        </Text>
        {savings !== undefined && (
          <>
            <Text dimColor>{DOT_SEP}</Text>
            <Text color={colors.saving}>{savings}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

// ─── HOW column content ────────────────────────────────────────────────────

function buildHowLines(impact: ScanDetailRec['impact'], maxWidth: number, hasAi: boolean = true): string[] {
  const hints: string[] = impact === 'critical'
    ? ['Immediate action required.', '', hasAi ? 'Review the fix workflow: press f to apply an AI-assisted patch.' : 'Review and address this issue manually.']
    : impact === 'high'
    ? ['Review and apply the recommended fix.', '', hasAi ? 'Press f to open the fix workflow.' : 'Address manually at the earliest opportunity.']
    : impact === 'medium'
    ? ['Schedule a fix for this issue.', '', hasAi ? 'Press f to apply an AI-generated fix.' : 'Address manually when convenient.']
    : ['Low priority.', '', 'Consider addressing when convenient.'];

  const result: string[] = [];
  for (const hint of hints) {
    if (hint === '') {
      result.push('');
    } else {
      result.push(...wrapText(hint, maxWidth));
    }
  }
  return result;
}
