import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { GAP_ROW } from '../ui/spacing.js';

import { colors } from '../theme.js';
import { TUI } from '../ui/tokens.js';

/**
 * ThinkingSpinner shows elapsed time after 3s, long-running context
 * after 30s, and cancelHint only when the parent explicitly provides it.
 */
interface ThinkingSpinnerProps {
  label?: string;
  /** Optional cancel hint shown after the spinner. Only add when the parent handles the key. */
  cancelHint?: { key: string; label: string } | undefined;
  /**
   * Optional long-running message shown after 30s.
   * Defaults to a generic AWS/AI wait message.
   * Pass false to suppress.
   */
  longRunningMessage?: string | false;
}

const DEFAULT_LONG_RUNNING_MSG = 'Still working… larger accounts or slow network calls can take a while.';

export function ThinkingSpinner({ label, cancelHint, longRunningMessage }: ThinkingSpinnerProps): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const display = label ?? 'Processing…';
  const timeText = elapsed < 2 ? ''
    : elapsed >= 60 ? ` ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : ` ${elapsed}s`;

  // After 30s show long-running context on a second line
  const showLongRunning = elapsed >= 30 && longRunningMessage !== false;
  const longMsg = longRunningMessage !== undefined && longRunningMessage !== false
    ? longRunningMessage
    : DEFAULT_LONG_RUNNING_MSG;

  return (
    <Box flexDirection="column" marginLeft={TUI.indent.content}>
      <Box gap={GAP_ROW}>
        <Text color={colors.brand}>
          <Spinner type="dots" />
        </Text>
        <Text color={colors.brand}>{display}</Text>
        {timeText !== '' && <Text dimColor>{timeText}</Text>}
        {cancelHint !== undefined && (
          <Text dimColor><Text color={colors.warning}>{cancelHint.key}</Text> {cancelHint.label}</Text>
        )}
      </Box>
      {showLongRunning && (
        <Box marginLeft={TUI.indent.content}>
          <Text dimColor>{longMsg}</Text>
        </Box>
      )}
    </Box>
  );
}
