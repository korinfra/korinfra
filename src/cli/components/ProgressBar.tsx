import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useStdout } from 'ink';
import { GAP_ROW } from '../ui/spacing.js';

import { TUI } from '../ui/tokens.js';
import { colors, supportsUnicode } from '../theme.js';
import { DOT_SEP } from '../ui/text.js';
import { stringWidth } from '../ui/width.js';

export interface ProgressBarProps {
  value: number; // 0–100
  label?: string;
  width?: number;
  /** Detail string shown after percentage, e.g. "4/8 services". */
  detail?: string;
  /** Terminal columns for responsive layout. Defaults to terminal width or 80. */
  columns?: number;
}

// Sub-block characters for 8-level fractional fill (Unicode only).
// Index 0 = empty (space), index 8 = full block.
const SUB_BLOCKS = ' ▏▎▍▌▋▊▉█';

/**
 * Render a progress bar string with 8-level sub-character precision.
 * Falls back to plain '#'/'.' on non-Unicode terminals.
 */
function renderBar(progress: number, barWidth: number, unicode: boolean): { filled: string; partial: string; empty: string } {
  if (!unicode) {
    const f = Math.round((progress / 100) * barWidth);
    return { filled: '#'.repeat(f), partial: '', empty: '-'.repeat(barWidth - f) };
  }
  const ratio = Math.max(0, Math.min(100, progress)) / 100;
  const totalEighths = ratio * barWidth * 8;
  const fullChars = Math.floor(totalEighths / 8);
  const partialEighths = Math.floor(totalEighths % 8);
  const emptyChars = barWidth - fullChars - (partialEighths > 0 ? 1 : 0);
  return {
    filled: '█'.repeat(fullChars),
    partial: partialEighths > 0 ? (SUB_BLOCKS[partialEighths] ?? '') : '',
    empty: '·'.repeat(Math.max(0, emptyChars)),
  };
}

export function ProgressBar({ value, label, width, detail, columns }: ProgressBarProps): React.JSX.Element {
  const { stdout } = useStdout();
  const termWidth = columns ?? stdout?.columns ?? 80;
  const target = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;

  // Smooth interpolation toward target — ease-out exponential decay.
  // displayProgress trails target by ~300ms at 16ms intervals (factor 0.15).
  const [displayProgress, setDisplayProgress] = useState(target);
  const displayRef = useRef(target);

  useEffect(() => {
    // Snap on first mount or extreme jumps (>80pp) — smaller jumps animate.
    if (Math.abs(displayRef.current - target) > 80) {
      displayRef.current = target;
      setDisplayProgress(target);
      return;
    }

    const id = setInterval(() => {
      const current = displayRef.current;
      const diff = target - current;
      if (Math.abs(diff) < 0.1) {
        displayRef.current = target;
        setDisplayProgress(target);
        clearInterval(id);
        return;
      }
      const next = current + diff * 0.10;
      displayRef.current = next;
      setDisplayProgress(next);
    }, 16);

    return () => { clearInterval(id); };
  }, [target]);

  const clamped = displayProgress;
  const pct = `${Math.round(target)}%`; // percentage label always shows real value

  // Below TUI.width.narrow (56), collapse to text-only
  if (termWidth < TUI.width.narrow) {
    const parts: string[] = [];
    if (label !== undefined) parts.push(label);
    parts.push(pct);
    if (detail !== undefined) parts.push(detail);
    return (
      <Box gap={GAP_ROW}>
        <Text dimColor>{parts.join(DOT_SEP)}</Text>
      </Box>
    );
  }

  // Wide: show visual bar with computed width
  const labelWidth = label ? stringWidth(label) + 1 : 0;
  const percentWidth = stringWidth('100%') + 1; // 5 cols
  const detailWidth = detail ? stringWidth(detail) + 1 : 0;
  const padding = 3; // gaps between elements
  const barWidth = Math.max(4, width ?? Math.max(10, termWidth - labelWidth - percentWidth - detailWidth - padding));

  const barColor = target === 100 ? colors.success : target >= 60 ? colors.brand : colors.warning;
  const unicode = supportsUnicode;
  const { filled, partial, empty } = renderBar(clamped, barWidth, unicode);

  return (
    <Box gap={GAP_ROW}>
      {label !== undefined && <Text dimColor>{label}</Text>}
      <Box gap={0}>
        <Text color={barColor}>{filled}{partial}</Text>
        <Text color={colors.muted}>{empty}</Text>
      </Box>
      <Text dimColor>{pct}</Text>
      {detail !== undefined && <Text dimColor>{detail}</Text>}
    </Box>
  );
}
