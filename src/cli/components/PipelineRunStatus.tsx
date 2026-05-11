import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

import { colors, icons } from '../theme.js';
import { ProgressBar } from './ProgressBar.js';
import { GAP_BETWEEN_SECTIONS, GAP_ROW, MARGIN_LEFT_RESULT } from '../ui/spacing.js';
import { joinDot } from '../ui/text.js';
import { TUI } from '../ui/tokens.js';

interface PipelineRunStatusProps {
  title: string;
  activeLabel: string;
  completed: number;
  total: number;
  unitLabel?: string;
  modeLabel?: string;
  /** When 'complete' or 'error', the spinner is replaced by a terminal-state badge. */
  status?: 'running' | 'complete' | 'error';
  /** Live per-service progress string, e.g. "EC2 ✓ 0.8s · RDS ✓ 0.6s · S3..." */
  subStatus?: string | undefined;
}

export function PipelineRunStatus({
  title,
  activeLabel,
  completed,
  total,
  unitLabel = 'steps',
  modeLabel,
  status = 'running',
  subStatus,
}: PipelineRunStatusProps): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0);
  const safeTotal = Math.max(1, total);
  const safeCompleted = Math.max(0, Math.min(completed, safeTotal));
  const percent = (safeCompleted / safeTotal) * 100;
  const elapsedText = elapsed < 2
    ? ''
    : elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
      : `${elapsed}s`;

  useEffect(() => {
    setElapsed(0);
    const timer = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [activeLabel]);

  return (
    <Box flexDirection="column" marginLeft={TUI.indent.page} marginBottom={GAP_BETWEEN_SECTIONS}>
      <ProgressBar
        value={percent}
        label={title}
        detail={`${safeCompleted}/${safeTotal} ${unitLabel}`}
      />
      <Box gap={GAP_ROW}>
        {status === 'running' ? (
          <Text color={colors.brand}>
            <Spinner type="dots" />
          </Text>
        ) : (
          <Text color={status === 'complete' ? colors.success : colors.error}>
            {status === 'complete' ? icons.checkmark : icons.cross}
          </Text>
        )}
        <Text color={status === 'running' ? colors.brand : status === 'complete' ? colors.success : colors.error}>
          {(() => {
            const metaText = joinDot(elapsedText, modeLabel ?? '');
            return metaText.length > 0 ? joinDot(activeLabel, metaText) : activeLabel;
          })()}
        </Text>
      </Box>
      {subStatus !== undefined && subStatus.length > 0 && (
        <Box marginLeft={MARGIN_LEFT_RESULT}>
          <Text dimColor>{subStatus}</Text>
        </Box>
      )}
    </Box>
  );
}
