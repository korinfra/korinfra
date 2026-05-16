import React from 'react';
import { Box, Text, useInput } from 'ink';

import { colors, borders } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, PADDING_X, GAP_ROW } from '../ui/spacing.js';
import { stripAnsi } from '../ui/text.js';
import { TUI } from '../ui/tokens.js';

interface ConfirmApplyTagsProps {
  resourceCount: number;
  tags: Record<string, string>;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmApplyTags({ resourceCount, tags, onConfirm, onCancel }: ConfirmApplyTagsProps): React.JSX.Element {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') { onConfirm(); return; }
    if (input === 'n' || input === 'N' || key.escape) { onCancel(); return; }
  }, { isActive: true });

  const tagEntries = Object.entries(tags);
  const displayEntries = tagEntries.slice(0, 10);
  const overflow = tagEntries.length - displayEntries.length;

  return (
    <Box flexDirection="column" gap={GAP_ROW} alignItems="center">
      <Box
        borderStyle={borders.card}
        borderColor={colors.warning}
        paddingX={PADDING_X}
        flexDirection="column"
      >
        <Text bold color={colors.warning}>Apply tags?</Text>
        <Box marginTop={GAP_BETWEEN_SECTIONS} flexDirection="column">
          <Text>Write <Text bold>{tagEntries.length}</Text> tag{tagEntries.length !== 1 ? 's' : ''} to <Text bold>{resourceCount}</Text> resource{resourceCount !== 1 ? 's' : ''}?</Text>
          <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
            {displayEntries.map(([k, v]) => (
              <Text key={k} dimColor>  <Text color={colors.info}>{stripAnsi(k)}</Text>: {stripAnsi(v)}</Text>
            ))}
            {overflow > 0 && <Text dimColor>  + {overflow} more</Text>}
          </Box>
        </Box>
      </Box>
      <Box marginLeft={TUI.indent.content} gap={GAP_ROW}>
        <Text dimColor><Text color={colors.warning}>y</Text> yes, apply</Text>
        <Text dimColor><Text color={colors.warning}>n</Text> cancel</Text>
      </Box>
    </Box>
  );
}
