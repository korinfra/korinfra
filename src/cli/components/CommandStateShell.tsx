/**
 * CommandStateShell — state-aware wrapper around ScreenShell.
 *
 * Wraps ScreenShell and manages loading/error/empty/result states automatically,
 * eliminating duplication of headers and spinners across command screens.
 *
 * Commands pass state='loading|error|empty|result' instead of rendering their
 * own headers/spinners independently.
 *
 * From audit spec (lines 411–455):
 *   - state='loading' → render ScreenShell + ThinkingSpinner, InteractionHints
 *   - state='error' → render ScreenShell + ErrorBox(message, hint), InteractionHints
 *   - state='empty' → render ScreenShell + MSG_NO_RESULT text, InteractionHints
 *   - state='result' → render ScreenShell + children, ActionBar with passed actions
 */

import React from 'react';
import { Box, Text } from 'ink';

import { ScreenShell } from './ScreenShell.js';
import { CommandHeader } from './CommandHeader.js';
import { ThinkingSpinner } from './ThinkingSpinner.js';
import { ErrorBox } from './ErrorBox.js';
import { ActionBar } from './ActionBar.js';
import { InteractionHints, buildInteractionHints } from './InteractionHints.js';
import type { ActionHint, TuiAction } from '../actions.js';
import { GAP_BETWEEN_SECTIONS } from '../ui/spacing.js';
import { MSG_NO_RESULT } from '../ui/text.js';

interface CommandStateShellProps {
  /** Command name, e.g. "scan" */
  command: string;
  /** Short description */
  description: string;
  /** Optional mode badge */
  mode?: 'rules-only' | 'ai-assisted' | 'agent';
  /** Current state: loading, error, empty, or result */
  state: 'loading' | 'error' | 'empty' | 'result';
  /** Action hints shown in sticky ActionBar (only for state=result) */
  actions?: ActionHint[];
  /** Error message text (only for state=error) */
  errorMessage?: string;
  /** Error hint / suggestion (only for state=error) */
  errorHint?: string;
  /** Empty state message (only for state=empty) */
  emptyMessage?: string;
  /** Optional cancel function (for state=loading) */
  onCancel?: (() => void) | undefined;
  /** Action handler (for state=result) */
  onAction?: ((action: TuiAction) => void) | undefined;
  /** Back navigation handler */
  onBack?: (() => void) | undefined;
  /** Main content (only rendered when state=result) */
  children?: React.ReactNode;
  /** Optional error box actions */
  errorActions?: ActionHint[];
  /** Optional error box action handler */
  onErrorAction?: (action: TuiAction) => void;
  /** Render mode for header */
  variant?: 'hero' | 'compact';
  /** Screen identifier for dev-mode key-collision validation */
  screenId?: string;
  /** Skeleton rows to show under spinner during loading (only for state=loading) */
  loadingChildren?: React.ReactNode;
}

export function CommandStateShell({
  command,
  description,
  mode,
  state,
  actions = [],
  errorMessage = 'An error occurred',
  errorHint,
  emptyMessage = MSG_NO_RESULT,
  onCancel,
  onAction,
  onBack,
  children,
  errorActions = [],
  onErrorAction,
  variant = 'compact',
  screenId,
  loadingChildren,
}: CommandStateShellProps): React.JSX.Element {
  const header = (
    <CommandHeader
      command={command}
      description={description}
      mode={mode}
      variant={variant}
    />
  );

  // state='loading'
  // CS-1: ThinkingSpinner occupies 1–2 rows (base row + optional long-running message after 30s).
  // When computing contentRows for child components, subtract ~2 rows from available viewport.
  if (state === 'loading') {
    const cancelHint = onCancel !== undefined ? { key: 'c', label: 'cancel' } : undefined;
    const hints = buildInteractionHints({ onBack });

    return (
      <ScreenShell
        header={header}
        status={<ThinkingSpinner cancelHint={cancelHint} />}
        hints={<InteractionHints hints={hints} rowLabel="Navigate" />}
      >
        <Box flexDirection="column">
          {loadingChildren}
        </Box>
      </ScreenShell>
    );
  }

  // state='error'
  if (state === 'error') {
    return (
      <ScreenShell
        header={header}
      >
        <Box flexDirection="column">
          <ErrorBox
            message={errorMessage}
            hint={errorHint}
            actions={errorActions}
            onAction={onErrorAction}
            onBack={onBack}
            isActive={true}
          />
        </Box>
      </ScreenShell>
    );
  }

  // state='empty'
  if (state === 'empty') {
    const hints = buildInteractionHints({ onBack });

    return (
      <ScreenShell
        header={header}
        hints={<InteractionHints hints={hints} rowLabel="Navigate" />}
      >
        <Box flexDirection="column">
          <Box marginTop={GAP_BETWEEN_SECTIONS}>
            <Text dimColor>{emptyMessage}</Text>
          </Box>
        </Box>
      </ScreenShell>
    );
  }

  // state='result'
  const interactionHints = buildInteractionHints({ onBack });

  return (
    <ScreenShell
      header={header}
      actions={
        actions.length > 0 ? (
          <ActionBar
            actions={actions}
            onAction={onAction}
            screenId={screenId}
          />
        ) : undefined
      }
      hints={<InteractionHints hints={interactionHints} rowLabel="Navigate" />}
    >
      {children}
    </ScreenShell>
  );
}
