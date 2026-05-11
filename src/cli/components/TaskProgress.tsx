/**
 * TaskProgress — multi-phase progress indicator for long-running operations.
 *
 * Renders a row of phases with status glyphs, the current substep, elapsed
 * time, retry info, AI provider cost estimate, and an optional cancel hint.
 *
 * Design rules:
 * - VRHYTHM_RULE: vertical spacing via constants from src/cli/ui/spacing.ts only
 * - Fixed 2-col glyph prefix per phase to avoid width jitter as labels animate
 * - Indeterminate mode: spinner instead of ProgressBar when estimatedMs is absent
 * - elapsedMs is a parent-owned prop — no internal timer/setInterval here
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';

import { semanticColors, colors } from '../theme.js';
import { glyphs } from '../ui/glyphs.js';
import { supportsUnicode } from '../ui/terminal.js';
import { GAP_BETWEEN_SECTIONS } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';
import { formatMoney } from '../ui/format.js';
import { DOT_SEP } from '../ui/text.js';
import { ProgressBar } from './ProgressBar.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Phase {
  id: string;
  label: string;
  status: 'completed' | 'current' | 'pending' | 'failed';
}

interface TaskProgressProps {
  phases: Phase[];
  /** Current substep label, e.g. "Collecting EC2 resources..." */
  currentStep?: string | undefined;
  /** Elapsed milliseconds — owned by the parent (no internal timer). */
  elapsedMs: number;
  /** When provided, renders a ProgressBar; absent → indeterminate spinner. */
  estimatedMs?: number;
  /** Retry/backoff message, e.g. "Retrying (429, backoff 2s)..." */
  retryMessage?: string;
  /** AI provider context shown below elapsed. */
  aiInfo?: {
    provider: string;
    estimatedCost?: number;
  };
  /** When provided, Esc is wired to cancel and a hint is shown. */
  onCancel?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** 2-column fixed-width status prefix per phase so rows don't shift. */
function phasePrefix(status: Phase['status']): string {
  switch (status) {
    case 'completed': return `${glyphs.checkmark} `;
    case 'current':   return `${glyphs.arrowRight} `;
    case 'failed':    return `${glyphs.cross} `;
    case 'pending':   return `${glyphs.pending} `;
  }
}

function phaseColor(status: Phase['status']): string | undefined {
  switch (status) {
    case 'completed': return semanticColors.status.pass;
    case 'current':   return colors.brand;
    case 'failed':    return colors.error;
    case 'pending':   return colors.muted;
  }
}

/** Format elapsed milliseconds as "Xs" or "Xm Ys". */
function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TaskProgress({
  phases,
  currentStep,
  elapsedMs,
  estimatedMs,
  retryMessage,
  aiInfo,
  onCancel,
}: TaskProgressProps): React.JSX.Element {
  // Wire Esc to cancel when the callback is provided.
  useInput((_input, key) => {
    if (key.escape && onCancel !== undefined) {
      onCancel();
    }
  }, { isActive: onCancel !== undefined });

  const elapsedSec = formatElapsed(elapsedMs);
  const isDeterminate = estimatedMs !== undefined && estimatedMs > 0;

  // Overall progress across all phases so the bar never resets at transitions.
  // Completed phases each contribute 1/N; current phase contributes its ratio.
  const progressPct = (() => {
    if (!isDeterminate || estimatedMs === undefined) return 0;
    const total = phases.length;
    if (total === 0) return Math.min(100, (elapsedMs / estimatedMs) * 100);
    const completedCount = phases.filter(p => p.status === 'completed').length;
    const currentRatio = Math.min(1, elapsedMs / estimatedMs);
    const hasCurrentPhase = phases.some(p => p.status === 'current');
    const numerator = completedCount + (hasCurrentPhase ? currentRatio : 0);
    return Math.min(100, (numerator / total) * 100);
  })();

  return (
    <Box flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>

      {/* Phase row: ✓ phase1  → phase2  ○ phase3 */}
      <Box gap={TUI.space.sm}>
        {phases.map((phase) => (
          <Box key={phase.id} gap={0}>
            <Text color={phaseColor(phase.status)} bold={phase.status === 'current'}>
              {phasePrefix(phase.status)}{phase.label}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Current substep */}
      {currentStep !== undefined && (
        <Box marginLeft={TUI.indent.content}>
          <Text dimColor>{supportsUnicode ? '\u2514\u2500 ' : '+- '}{currentStep}</Text>
        </Box>
      )}

      {/* Progress: bar when determinate, spinner when indeterminate */}
      {isDeterminate ? (
        <Box marginLeft={TUI.indent.content}>
          <ProgressBar value={progressPct} />
        </Box>
      ) : (
        <Box gap={TUI.space.xs} marginLeft={TUI.indent.content}>
          <Text color={colors.brand}>
            <Spinner type="dots" />
          </Text>
        </Box>
      )}

      {/* Elapsed time row */}
      <Box gap={TUI.space.xs} marginLeft={TUI.indent.content}>
        <Text dimColor>
          {'Elapsed: '}
          <Text>{elapsedSec}</Text>
          {isDeterminate && estimatedMs !== undefined && (
            <Text dimColor>{` / ~${formatElapsed(estimatedMs)} est.`}</Text>
          )}
        </Text>
      </Box>

      {/* Retry/backoff message */}
      {retryMessage !== undefined && (
        <Box marginLeft={TUI.indent.content}>
          <Text color={colors.warning}>
            {supportsUnicode ? '\u21BA' : '~'} {retryMessage}
          </Text>
        </Box>
      )}

      {/* AI provider info */}
      {aiInfo !== undefined && (
        <Box gap={TUI.space.xs} marginLeft={TUI.indent.content}>
          <Text dimColor>AI:</Text>
          <Text color={semanticColors.ai.running}>{aiInfo.provider}</Text>
          {aiInfo.estimatedCost !== undefined && (
            <Text dimColor>{`est. ${formatMoney(aiInfo.estimatedCost)}`}</Text>
          )}
        </Box>
      )}

      {/* Cancel hint — only when onCancel is wired */}
      {onCancel !== undefined && (
        <Box marginLeft={TUI.indent.content}>
          <Text dimColor>
            <Text color={colors.warning}>Esc</Text>
            {`${DOT_SEP}cancel`}
          </Text>
        </Box>
      )}

    </Box>
  );
}
