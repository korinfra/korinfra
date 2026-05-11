import { Box, Text } from 'ink';
import { TUI } from '../ui/tokens.js';

interface EmptyStateProps {
  /** Short icon/emoji or ASCII art (e.g. '○', '–', '✓') */
  icon?: string;
  /** Primary message, e.g. "No findings" */
  message: string;
  /** Optional secondary hint, e.g. "Run a scan first" */
  hint?: string;
}

export function EmptyState({ icon = '○', message, hint }: EmptyStateProps) {
  return (
    <Box flexDirection="column" marginLeft={TUI.indent.content} gap={TUI.space.xs}>
      <Box gap={1}>
        <Text dimColor>{icon}</Text>
        <Text>{message}</Text>
      </Box>
      {hint && <Text dimColor>{hint}</Text>}
    </Box>
  );
}
