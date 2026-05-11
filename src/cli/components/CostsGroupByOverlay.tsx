/**
 * CostsGroupByOverlay — modal selector for grouping dimension.
 * Owned footer with NumericHints and navigation.
 */

import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import { colors, borders } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, PADDING_X, GAP_ROW } from '../ui/spacing.js';
import { DOT_SEP } from '../ui/text.js';

type GroupByValue = 'service' | 'region' | 'account' | 'tag';

interface CostsGroupByOverlayProps {
  current: GroupByValue;
  onApply: (value: GroupByValue) => void;
  onCancel: () => void;
}

const OPTIONS: Array<{ value: GroupByValue; label: string }> = [
  { value: 'service', label: 'service' },
  { value: 'region', label: 'region' },
  { value: 'account', label: 'account' },
  { value: 'tag', label: 'tag' },
];

export function CostsGroupByOverlay({
  current,
  onApply,
  onCancel,
}: CostsGroupByOverlayProps): React.JSX.Element {
  const { exit } = useApp();
  const [selected, setSelected] = useState<number>(
    OPTIONS.findIndex((opt) => opt.value === current),
  );

  useInput((input, key) => {
    // Numeric quick-select: 1-4
    if (input === '1' || input === '2' || input === '3' || input === '4') {
      const idx = Number(input) - 1;
      if (idx < OPTIONS.length) {
        const opt = OPTIONS[idx];
        if (opt) onApply(opt.value);
      }
      return;
    }

    // Navigation
    if (key.upArrow) {
      setSelected((s) => (s - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }
    if (key.downArrow) {
      setSelected((s) => (s + 1) % OPTIONS.length);
      return;
    }

    // Apply on Enter
    if (key.return) {
      const selOpt = OPTIONS[selected];
      if (selOpt) onApply(selOpt.value);
      return;
    }

    // Cancel on Esc or b
    if (key.escape || input === 'b') {
      onCancel();
      return;
    }

    // Quit
    if (input === 'q') {
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      {/* Centered overlay box */}
      <Box
        flexDirection="column"
        borderStyle={borders.card}
        borderColor={colors.brand}
        paddingX={PADDING_X}
        marginY={1}
      >
        <Box marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text bold>Group costs by</Text>
        </Box>

        {OPTIONS.map((opt, i) => {
          const isSelected = i === selected;
          const isCurrent = opt.value === current;
          const marker = isSelected ? '❯' : ' ';
          const indicator = isCurrent ? '(current)' : '';

          return (
            <Box key={opt.value}>
              <Text>
                {marker} <Text color={colors.warning}>{i + 1}</Text>
                {' '}
                {isSelected ? <Text bold>{opt.label}</Text> : opt.label}
                {isCurrent ? ` ${indicator}` : ''}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Overlay footer */}
      <Box marginTop={GAP_BETWEEN_SECTIONS} flexWrap="wrap" gap={GAP_ROW}>
        <Text dimColor>
          <Text color={colors.warning}>Enter</Text>
          {' apply'}
          {DOT_SEP}
          <Text color={colors.warning}>Esc</Text>
          {' / '}
          <Text color={colors.warning}>b</Text>
          {' cancel'}
          {DOT_SEP}
          <Text color={colors.warning}>↑↓</Text>
          {' navigate'}
          {DOT_SEP}
          <Text color={colors.warning}>1-4</Text>
          {' quick-select'}
          {DOT_SEP}
          <Text color={colors.warning}>q</Text>
          {' quit'}
        </Text>
      </Box>
    </Box>
  );
}
