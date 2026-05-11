/**
 * ScreenShell — layout wrapper for command screens.
 *
 * Owns five explicit regions:
 *   header   — CommandHeader / AsciiHeader (1-4 rows)
 *   status   — status indicators, progress bars (0-6 rows)
 *   children — scrollable content region (flexGrow=1)
 *   actions  — sticky ActionBar (0-2 rows)
 *   hints    — NavHints / InteractionHints at the very bottom (1-2 rows)
 *
 * Ink's flexbox: content area has flexGrow=1 so it fills available space.
 * The shell is layout-only and carries no keyboard handlers.
 *
 * TuiRegion contract:
 *   type TuiRegion = 'header' | 'status' | 'content' | 'actions' | 'hints';
 */

import React from 'react';
import { Box, useStdout } from 'ink';

import { TerminalTooSmall } from './TerminalTooSmall.js';
import { GAP_AFTER_HEADER, GAP_BEFORE_ACTIONS } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';

interface ScreenShellProps {
  /** Header row(s): CommandHeader, AsciiHeader, etc. (region: header) */
  header?: React.ReactNode;
  /**
   * Status / progress region shown between header and scrollable content.
   * (region: status) — e.g. PipelineStatus, spinner rows, step progress.
   */
  status?: React.ReactNode;
  /** Main scrollable content (region: content). */
  children: React.ReactNode;
  /** Sticky action bar shown below content, always visible. (region: actions) */
  actions?: React.ReactNode;
  /** Navigation/interaction hints shown at the very bottom. (region: hints) */
  hints?: React.ReactNode;
  /**
   * §1.4: When true, overlay is active — ScreenShell hides its own actions and
   * hints regions. The overlay renders its own footer.
   */
  overlayActive?: boolean;
}

export function ScreenShell({
  header,
  status,
  children,
  actions,
  hints,
  overlayActive = false,
}: ScreenShellProps): React.JSX.Element {
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const termWidth = stdout?.columns ?? 80;

  // SS-1 / F54: Guard for terminal too small (both dimensions)
  const MIN_TERM_HEIGHT = 18;
  const MIN_TERM_WIDTH = 56;
  if (termHeight < MIN_TERM_HEIGHT || termWidth < MIN_TERM_WIDTH) {
    return (
      <TerminalTooSmall
        minHeight={MIN_TERM_HEIGHT}
        minWidth={MIN_TERM_WIDTH}
        cols={termWidth}
        rows={termHeight}
      />
    );
  }

  // When overlay is active, hide own footer — overlay owns it.
  const showFooter = !overlayActive;

  const headerBudget = header !== undefined ? TUI.rows.header + GAP_AFTER_HEADER : 0;
  const statusBudget = status !== undefined ? TUI.rows.status : 0;
  const actionsBudget = showFooter && actions !== undefined ? TUI.rows.actions + GAP_BEFORE_ACTIONS : 0;
  const hintsBudget = showFooter && hints !== undefined
    ? TUI.rows.hints + GAP_BEFORE_ACTIONS
    : 0;
  const safeHeight = Math.max(
    TUI.rows.minContent,
    termHeight - headerBudget - statusBudget - actionsBudget - hintsBudget - 2,
  );

  return (
    <Box flexDirection="column">
      {header !== undefined && header}
      {status !== undefined && status}
      <Box flexDirection="column" height={safeHeight} overflow="hidden">
        {children}
      </Box>
      <Box flexGrow={1} />
      {showFooter && actions !== undefined && actions}
      {showFooter && hints !== undefined && hints}
    </Box>
  );
}
