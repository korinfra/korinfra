/**
 * PipelineStatusSummary — shared status summary component for DirectPipeline and HybridPipeline.
 *
 * From audit lines 973–1051: extract step completion progress into a compact row.
 * Shows one completion row. Detailed step traces should live in a separate
 * details surface, not in the primary completion line.
 *
 * Collapsed:
 *   ✓ Complete · 6.8s · 4 data steps · AI $0.03
 *
 * Expanded:
 *   Steps
 *   ✓ Load inventory · 1.2s
 *   ✓ Analyze costs · 2.8s
 *   ...
 */

import React from 'react';
import { Box, Text } from 'ink';

import { colors, icons } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, GAP_ICON_TEXT } from '../ui/spacing.js';
import { glyphs } from '../ui/glyphs.js';
import { TUI } from '../ui/tokens.js';

type StepStatus = 'pending' | 'running' | 'done' | 'error';

interface PipelineStep {
  label: string;
  status: StepStatus;
  durationMs?: number;
  detail?: string;
}

interface PipelineStatusSummaryProps {
  steps: PipelineStep[];
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  toggleKey?: string;
  totalDurationMs?: number;
  totalCostUsd?: number;
  showStepCount?: boolean;
  /** When true, only shows the summary line — hides individual step rows to save vertical space. */
  collapsed?: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function StepIcon({ status }: { status: StepStatus }): React.JSX.Element {
  if (status === 'done') return <Text color={colors.success}>{icons.checkmark}</Text>;
  if (status === 'error') return <Text color={colors.error}>{icons.error}</Text>;
  if (status === 'running') return <Text color={colors.brand}>{glyphs.running}</Text>;
  return <Text dimColor>{icons.pending}</Text>;
}

export function PipelineStatusSummary({
  steps,
  isExpanded = false,
  onToggleExpand,
  totalDurationMs,
  totalCostUsd,
  showStepCount = true,
  toggleKey = 'd',
  collapsed = false,
}: PipelineStatusSummaryProps): React.JSX.Element {
  const completedCount = steps.filter((s) => s.status === 'done').length;
  const errorCount = steps.filter((s) => s.status === 'error').length;
  const hasError = errorCount > 0;

  return (
    <Box flexDirection="column" marginLeft={TUI.indent.page} marginBottom={GAP_BETWEEN_SECTIONS}>
      {/* Summary line — collapsed mode */}
      <Box gap={GAP_ICON_TEXT}>
        <Text color={hasError ? colors.error : colors.success}>
          {hasError ? icons.error : icons.success}
        </Text>
        <Text dimColor>
          {hasError ? 'Error' : 'Complete'}
        </Text>
        {totalDurationMs !== undefined && (
          <>
            <Text dimColor>{icons.dot}</Text>
            <Text dimColor>{formatDuration(totalDurationMs)}</Text>
          </>
        )}
        {showStepCount && (
          <>
            <Text dimColor>{icons.dot}</Text>
            <Text dimColor>
              {completedCount} step{completedCount !== 1 ? 's' : ''} {completedCount < steps.length ? `of ${steps.length}` : ''}
            </Text>
          </>
        )}
        {totalCostUsd !== undefined && totalCostUsd > 0 && (
          <>
            <Text dimColor>{icons.dot}</Text>
            <Text dimColor>AI {formatCost(totalCostUsd)}</Text>
          </>
        )}
        {onToggleExpand !== undefined && (
          <>
            <Text dimColor>{icons.dot}</Text>
            <Text dimColor>
              <Text color={colors.warning}>{toggleKey}</Text> {isExpanded ? 'hide details' : 'details'}
            </Text>
          </>
        )}
      </Box>

      {/* Step list — hidden in collapsed mode to save vertical space */}
      {!collapsed && (
        <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
          {steps.map((step, idx) => (
            <Box key={idx} marginLeft={TUI.indent.page} gap={GAP_ICON_TEXT}>
              <StepIcon status={step.status} />
              <Text dimColor={step.status === 'pending'}>{step.label}</Text>
              {step.status === 'done' && step.durationMs !== undefined && (
                <Text dimColor>{icons.dot} {formatDuration(step.durationMs)}</Text>
              )}
              {step.detail !== undefined && step.detail.length > 0 && (
                <Text dimColor>{icons.dot} {step.detail}</Text>
              )}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
