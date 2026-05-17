/**
 * SecurityDetailOverlay — §6.3 detail overlay for a security finding.
 *
 * Shows rule name + severity badge, WHAT / WHY / HOW sections, and affected
 * resources. Footer: `Esc/b close` (owned by this component — ERR2-1 scope).
 * No ActionBar inside this overlay.
 *
 * Rules:
 *   VRHYTHM_RULE  — spacing via GAP_* constants only
 *   DOT_SEP_RULE  — DOT_SEP from ui/text.js
 *   SEVERITY_LABELS_RULE — SEVERITY_LABELS from ui/text.ts
 *   ERR2-1        — this component owns its own footer hints
 */

import React from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';

import { colors, borders, semanticColors } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, GAP_BEFORE_ACTIONS, PADDING_X, GAP_ROW } from '../ui/spacing.js';
import { DOT_SEP, SEVERITY_LABELS, stripAnsi } from '../ui/text.js';
import { truncateWidth } from '../ui/width.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SecurityFindingDetail {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  rule: string;
  resource: string;
  description: string;
  remediation: string;
  filePath?: string | null;
}

interface SecurityDetailOverlayProps {
  finding: SecurityFindingDetail;
  onClose: () => void;
  isActive?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Main component ────────────────────────────────────────────────────────────

export function SecurityDetailOverlay({
  finding,
  onClose,
  isActive = true,
}: SecurityDetailOverlayProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  useInput((input, key) => {
    if (!isActive) return;
    if (input === 'q') { exit(); return; }
    if (input === 'b' || key.escape) { onClose(); return; }
  }, { isActive });

  const sevLabel = SEVERITY_LABELS[finding.severity];
  const sevColor = semanticColors.severity[finding.severity] ?? undefined;

  // Column widths (adapt to narrow terminals)
  // Box overhead = border(2) + paddingX(1*2=2) = 4; cols+gaps need `available` chars
  const available = Math.min(termWidth - 8, 88);
  const colWhere = Math.floor(available * 0.28);
  const colWhat  = Math.floor(available * 0.36);
  const colFix   = available - colWhere - colWhat - 2; // -2 for the 2 inter-column gaps

  // WHERE: resource id + file path (if available). The resource ID comes from
  // AWS (ARN / instance ID / bucket name) and may contain ANSI escape codes
  // that would otherwise rewrite the terminal.
  const safeResource = stripAnsi(finding.resource);
  const whereText = finding.filePath
    ? `${safeResource} in ${finding.filePath}`
    : safeResource;
  const whereLines = wrapText(whereText, colWhere - 2);

  // WHAT: finding description (the rule description)
  const whatLines = finding.description.length > 0
    ? wrapText(finding.description, colWhat - 2)
    : ['No description available.'];

  // FIX: remediation steps
  const remText = finding.remediation.length > 0
    ? finding.remediation
    : 'Review the rule documentation and apply the recommended remediation.';
  const fixLines = wrapText(remText, colFix - 2);

  const overlayWidth = Math.min(available + 4, termWidth - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle={borders.card}
      borderColor={colors.highlight}
      paddingX={PADDING_X}
      width={overlayWidth}
    >
      {/* Header: severity badge + rule name */}
      <Box gap={GAP_ROW} marginBottom={GAP_BETWEEN_SECTIONS}>
        <Text bold color={sevColor}>[{sevLabel}]</Text>
        <Text bold>{truncateWidth(finding.rule, overlayWidth - sevLabel.length - 8)}</Text>
      </Box>

      {/* Three-column body: WHERE / WHAT / FIX */}
      <Box flexDirection="row" gap={1}>
        {/* WHERE */}
        <Box flexDirection="column" width={colWhere} flexShrink={0} paddingRight={1}>
          <Text bold color={colors.highlight}>WHERE</Text>
          <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
            {whereLines.map((line, i) => (
              <Text key={i} dimColor>{line}</Text>
            ))}
          </Box>
        </Box>

        {/* WHAT */}
        <Box flexDirection="column" width={colWhat} flexShrink={0} paddingRight={1}>
          <Text bold color={colors.highlight}>WHAT</Text>
          <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
            {whatLines.map((line, i) => (
              <Text key={i} dimColor>{line}</Text>
            ))}
          </Box>
        </Box>

        {/* FIX */}
        <Box flexDirection="column" width={colFix} flexShrink={0}>
          <Text bold color={colors.highlight}>FIX</Text>
          <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
            {fixLines.map((line, i) => (
              <Text key={i} dimColor>{line}</Text>
            ))}
          </Box>
        </Box>
      </Box>

      {/* Footer hints — owned by this overlay, ERR2-1 */}
      <Box marginTop={GAP_BEFORE_ACTIONS} gap={GAP_ROW} flexWrap="wrap">
        <Text dimColor>
          <Text color={colors.warning}>Esc/b</Text>{' close'}
        </Text>
        <Text dimColor>{DOT_SEP}</Text>
        <Text dimColor>
          <Text color={colors.warning}>q</Text>{' quit'}
        </Text>
      </Box>
    </Box>
  );
}
