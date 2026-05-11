/**
 * QuitConfirm — §17.3: confirmation overlay shown only when AI is actively
 * running. Centered "Abort?" box with message and ActionBar for y/n choice.
 *
 * When no AI op is active, the global `q` handler quits directly without
 * rendering this overlay.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';

import { colors, borders } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, PADDING_X, GAP_ROW } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';

interface QuitConfirmProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function QuitConfirm({ onConfirm, onCancel }: QuitConfirmProps): React.JSX.Element {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') { onConfirm(); return; }
    if (input === 'n' || input === 'N' || input === 'q' || key.escape) { onCancel(); return; }
  }, { isActive: true });

  return (
    <Box flexDirection="column" gap={GAP_ROW} alignItems="center">
      <Box
        borderStyle={borders.card}
        borderColor={colors.warning}
        paddingX={PADDING_X}
        flexDirection="column"
      >
        <Text bold color={colors.warning}>Abort?</Text>
        <Box marginTop={GAP_BETWEEN_SECTIONS}>
          <Text>AI analysis is running. Quit anyway?</Text>
        </Box>
      </Box>
      <Box marginLeft={TUI.indent.content} gap={GAP_ROW}>
        <Text dimColor>
          <Text color={colors.warning}>y</Text> yes, quit
        </Text>
        <Text dimColor>
          <Text color={colors.warning}>n</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}
