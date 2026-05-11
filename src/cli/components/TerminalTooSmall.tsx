import { Box, Text } from 'ink';

interface TerminalTooSmallProps {
  /** Minimum columns required */
  minWidth?: number;
  /** Minimum rows required */
  minHeight?: number;
  /** Current terminal columns (unused, accepted for API compat) */
  cols?: number;
  /** Current terminal rows (unused, accepted for API compat) */
  rows?: number;
}

/**
 * §17.4 Minimum terminal size guard: when terminal is below the minimum
 * required size, render a plain centered message. No border, no ActionBar,
 * nothing interactive.
 */
export function TerminalTooSmall({
  minWidth = 40,
  minHeight = 18,
  cols,
  rows,
}: TerminalTooSmallProps) {
  const current = cols !== undefined && rows !== undefined ? ` (${cols}×${rows})` : '';
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center">
      <Text>Terminal too small{current}.</Text>
      <Text>Please resize to at least {minWidth}×{minHeight}.</Text>
    </Box>
  );
}
