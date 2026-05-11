/**
 * AICostConfirm — gate component shown before an AI call when estimated
 * cost > ai.confirm_threshold_usd OR estimated time > ai.confirm_threshold_sec.
 *
 * Renders "⏎ run · ~$0.02 · ~15s". y/Enter runs; Esc cancels.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';

import { colors, icons } from '../theme.js';
import { MARGIN_LEFT_CONTENT, MARGIN_LEFT_RESULT, GAP_BETWEEN_SECTIONS, GAP_ROW } from '../ui/spacing.js';
import { DOT_SEP } from '../ui/text.js';

interface AICostEstimate {
  /** Estimated cost in USD. */
  costUsd: number;
  /** Estimated duration in seconds. */
  durationSec: number;
}

interface AICostConfirmProps {
  estimate: AICostEstimate;
  onConfirm: () => void;
  onCancel: () => void;
  /** When false, keyboard input is suppressed. */
  isActive?: boolean;
}

function formatEstCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  if (usd < 0.01) return `~$${usd.toFixed(3)}`;
  return `~$${usd.toFixed(2)}`;
}

function formatEstTime(sec: number): string {
  if (sec < 60) return `~${Math.round(sec)}s`;
  return `~${Math.floor(sec / 60)}m${sec % 60 > 0 ? ` ${Math.round(sec % 60)}s` : ''}`;
}

export function AICostConfirm({
  estimate,
  onConfirm,
  onCancel,
  isActive = true,
}: AICostConfirmProps): React.JSX.Element {
  useInput((input, key) => {
    if (input === 'y' || key.return) {
      onConfirm();
      return;
    }
    if (key.escape || input === 'n' || input === 'q') {
      onCancel();
      return;
    }
  }, { isActive });

  return (
    <Box
      marginLeft={MARGIN_LEFT_CONTENT}
      marginBottom={GAP_BETWEEN_SECTIONS}
      flexDirection="column"
      gap={0}
    >
      <Box gap={GAP_ROW}>
        <Text color={colors.info}>{icons.info}</Text>
        <Text bold>AI analysis</Text>
        <Text dimColor>{DOT_SEP}{formatEstCost(estimate.costUsd)}{DOT_SEP}{formatEstTime(estimate.durationSec)}</Text>
      </Box>
      <Box marginLeft={MARGIN_LEFT_RESULT}>
        <Text dimColor>
          <Text color={colors.warning}>y</Text>/Enter run{DOT_SEP}<Text color={colors.warning}>Esc</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}
