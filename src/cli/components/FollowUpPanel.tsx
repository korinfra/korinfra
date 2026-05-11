/**
 * FollowUpPanel — contextual follow-up input with conversation history.
 *
 * Key contract:
 * - f / Tab → activate input (when not yet active)
 * - Enter   → submit (only when input is non-empty and active)
 * - Esc     → blur input (when active), or onClose (when inactive)
 * - b       → onClose (always, when input is inactive)
 * - Ctrl+U  → clear input (force-remount TextInput via nonce key)
 * - Does NOT capture Tab for global navigation when input is inactive
 * - Does NOT capture q
 * - Filters raw terminal escape sequences (mouse event bytes) in onChange
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';

import { colors, icons } from '../theme.js';
import { formatCost } from '../utils/format.js';
import { GAP_BETWEEN_SECTIONS, GAP_BEFORE_ACTIONS, MARGIN_LEFT_CONTENT, GAP_ROW } from '../ui/spacing.js';
import { DOT_SEP, composeAiStatus } from '../ui/text.js';
import { useInputMode } from '../hooks/useInputMode.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FollowUpContext {
  /** Human-readable source label, e.g. "cost data" */
  source: string;
  scanId?: string | undefined;
  grouping?: string | undefined;
  filters?: string[];
  selectedResource?: string;
  /** Pre-formatted cache age string, e.g. "2m ago" */
  aiCacheAge?: string;
  /** Pre-formatted date range string, e.g. "last 30 days" */
  dateRange?: string | undefined;
}

export interface Turn {
  question: string;
  answer: string;
  timestamp?: number;
}

interface FollowUpPanelProps {
  context: FollowUpContext;
  onSubmit: (question: string) => void;
  onClose: () => void;
  /** Fired when the text input is focused or blurred — lets parents gate other key handlers. */
  onInputActiveChange?: (active: boolean) => void;
  /** If defined, display estimated cost per query. */
  estimatedCost?: number | undefined;
  /** Previous conversation turns to display above the input. */
  history?: Turn[];
  isLoading?: boolean;
  /** When true, an overlay is open above this panel — suppress Esc/b so the overlay closes first. */
  overlayActive?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildContextParts(ctx: FollowUpContext): string[] {
  const parts: string[] = [ctx.source];

  if (ctx.dateRange !== undefined && ctx.dateRange.length > 0) {
    parts.push(ctx.dateRange);
  }
  if (ctx.grouping !== undefined && ctx.grouping.length > 0) {
    parts.push(ctx.grouping);
  }
  if (ctx.filters !== undefined && ctx.filters.length > 0) {
    parts.push(...ctx.filters);
  }
  if (ctx.selectedResource !== undefined && ctx.selectedResource.length > 0) {
    parts.push(ctx.selectedResource);
  }
  if (ctx.aiCacheAge !== undefined && ctx.aiCacheAge.length > 0) {
    // Strip any leading "cached" token from aiCacheAge to prevent
    // "AI cached cached 2m ago" when caller passes "cached 2m ago".
    const bareAge = ctx.aiCacheAge.replace(/^cached\s*/i, '').trim();
    parts.push(bareAge ? `${composeAiStatus('cached')} ${bareAge}` : composeAiStatus('cached'));
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Strip raw terminal escape sequences (mouse event bytes, e.g. `[<64;92;6M`). */
function filterEscapeSequences(value: string): string {
  // Reject strings starting with ESC (\x1b) or the literal bracket sequences
  // that some terminals emit as mouse events (e.g. "[<64;92;6M").
  if (value.startsWith('\x1b') || /^\[</.test(value)) return '';
  // Strip any embedded ESC sequences
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '');
}

export function FollowUpPanel({
  context,
  onSubmit,
  onClose,
  onInputActiveChange,
  estimatedCost,
  history,
  isLoading = false,
  overlayActive = false,
}: FollowUpPanelProps): React.JSX.Element {
  const { setInputMode } = useInputMode();
  const [inputNonce, setInputNonce] = useState(0);
  // Input starts inactive; user must explicitly activate it
  const [isInputActive, setIsInputActive] = useState(false);

  // Only signal 'field' mode to the app shell when the input is actually active
  useEffect(() => {
    onInputActiveChange?.(isInputActive);
    if (isInputActive) {
      setInputMode('field');
      return () => { setInputMode('none'); };
    }
    return undefined;
  }, [isInputActive, setInputMode, onInputActiveChange]);

  // Key handling depends on whether the input is focused
  useInput((input, key) => {
    if (isInputActive) {
      // Esc blurs the input, does NOT navigate away
      if (key.escape) {
        setIsInputActive(false);
        return;
      }
      // Ctrl+U → clear (force-remount TextInput)
      if (key.ctrl && input === 'u') {
        setInputNonce((n) => n + 1);
        return;
      }
    } else {
      // Input is inactive — navigation keys work normally
      // Guard: if an overlay is open above us, let it consume Esc/b first
      if (!overlayActive && (key.escape || input === 'b')) {
        onClose();
        return;
      }
      // f activates the input (Tab is reserved for TabbedResult inner tab cycling)
      if (input === 'f') {
        setIsInputActive(true);
        return;
      }
    }
  }, { isActive: !isLoading });

  const contextParts = buildContextParts(context);
  const recentHistory = history !== undefined && history.length > 0
    ? history.slice(-3)
    : [];

  if (!isInputActive && recentHistory.length === 0) {
    return (
      <Box marginTop={GAP_BETWEEN_SECTIONS} marginLeft={MARGIN_LEFT_CONTENT} gap={GAP_ROW}>
        <Text dimColor>Press</Text>
        <Text color={colors.warning}>f</Text>
        <Text dimColor>for follow-up question</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS} marginLeft={MARGIN_LEFT_CONTENT}>
      {/* Header */}
      <Box gap={GAP_ROW} marginBottom={GAP_BETWEEN_SECTIONS}>
        <Text color={colors.brand}>{icons.pointer}</Text>
        <Text bold>Follow-up</Text>
      </Box>

      {/* Context line */}
      <Box marginBottom={GAP_BETWEEN_SECTIONS}>
        <Text dimColor>
          {'Context: '}
          {contextParts.join(DOT_SEP)}
        </Text>
      </Box>

      {/* Estimated cost */}
      {estimatedCost !== undefined && (
        <Box marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text dimColor>est. {formatCost(estimatedCost)} per query</Text>
        </Box>
      )}

      {/* Conversation history (last 3 turns) */}
      {recentHistory.length > 0 && (
        <Box flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
          {recentHistory.map((turn, idx) => (
            <Box key={idx} flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
              <Text dimColor><Text color={colors.warning}>Q:</Text> {turn.question}</Text>
              <Text dimColor><Text color={colors.brand}>A:</Text> {turn.answer}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Input */}
      {isLoading ? (
        <Box gap={GAP_ROW}>
          <Text color={colors.brand}>{icons.running}</Text>
          <Text dimColor>Thinking…</Text>
        </Box>
      ) : isInputActive ? (
        <TextInput
          key={inputNonce}
          placeholder="Ask a follow-up..."
          onChange={(value) => {
            // Strip raw terminal escape sequences before passing to state
            const filtered = filterEscapeSequences(value);
            if (filtered !== value) {
              // Force-remount to clear the corrupted input value
              setInputNonce((n) => n + 1);
            }
          }}
          onSubmit={(text) => {
            const clean = filterEscapeSequences(text);
            if (!clean.trim()) return;
            onSubmit(clean.trim());
          }}
        />
      ) : (
        <Box gap={GAP_ROW}>
          <Text dimColor>Press</Text>
          <Text color={colors.warning}>f</Text>
          <Text dimColor>to type a follow-up question</Text>
        </Box>
      )}

      {/* Key hints — only when input is active. When inactive, the inline prompt above
          ("Press f to type a follow-up question") already conveys the activation key,
          and ScreenShell's NavHints handle b/Esc. F50: no duplicate hint row. */}
      {isInputActive && (
        <Box marginTop={GAP_BEFORE_ACTIONS} gap={GAP_ROW}>
          <Text dimColor><Text color={colors.warning}>Enter</Text> send</Text>
          <Text dimColor>{DOT_SEP}</Text>
          <Text dimColor><Text color={colors.warning}>Esc</Text> unfocus</Text>
          <Text dimColor>{DOT_SEP}</Text>
          <Text dimColor><Text color={colors.warning}>Ctrl+U</Text> clear</Text>
        </Box>
      )}
    </Box>
  );
}
