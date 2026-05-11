import React, { useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';

import { colors, icons, borders } from '../theme.js';
import type { InteractionHint } from './InteractionHints.js';
import { IH_QUIT, IH_BACK } from './InteractionHints.js';
import type { ActionHint, TuiAction } from '../actions.js';
import { actionKeyMatches } from '../actions.js';
import { GAP_BETWEEN_SECTIONS, GAP_ICON_TEXT, PADDING_X, GAP_ROW } from '../ui/spacing.js';
import { stringWidth } from '../ui/width.js';
import { TUI } from '../ui/tokens.js';
import { categorizeError } from '../utils/errorCategory.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';

interface ErrorBoxProps {
  message: string;
  title?: string;
  hint?: string | undefined;
  /** Recovery actions rendered INSIDE the error box border (EB-1). */
  actions?: ActionHint[];
  onAction?: ((action: TuiAction) => void) | undefined;
  onBack?: (() => void) | undefined;
  isActive?: boolean;
}

const MAX_ERROR_LINES = 8;

/**
 * Word-wrap at spaces with continuation indent.
 * Uses display width (stringWidth) instead of string length.
 * Hard-breaks long tokens at detail indent.
 */
function wordWrapLines(text: string, maxWidth: number): string[] {
  const out: string[] = [];
  const continuationIndent = ' '.repeat(TUI.indent.detail);

  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      out.push('');
      continue;
    }

    const words = rawLine.split(' ');
    let current = '';

    for (const word of words) {
      // If a word is longer than wrapWidth, split it by hard character break
      if (stringWidth(word) > maxWidth) {
        if (current.length > 0) {
          out.push(current);
          current = '';
        }
        // Hard-split the long word at wrapWidth
        for (let i = 0; i < word.length; i += maxWidth) {
          out.push(word.slice(i, i + maxWidth));
        }
        continue;
      }

      // First line has no indent, continuation lines use detail indent
      const indent = current.length === 0 ? '' : continuationIndent;
      const candidate = current.length === 0 ? word : current + ' ' + word;
      const candidateWithIndent = indent + candidate;
      const candidateWidth = stringWidth(candidateWithIndent);

      if (candidateWidth > maxWidth && current.length > 0) {
        // Current line is full, start a new one
        out.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }

    if (current.length > 0) out.push(current);
  }

  return out;
}

export function ErrorBox({ message, title = 'Error', hint, actions = [], onAction, onBack, isActive = true }: ErrorBoxProps): React.JSX.Element {
  const { exit } = useApp();
  const [expanded, setExpanded] = useState(false);
  const { stdout } = useStdout();
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const cols = stdout?.columns ?? 80;
  const wrapWidth = Math.max(
    TUI.width.narrow - 4,
    cols - TUI.border.horizontal - (TUI.padding?.boxX ?? 1) * 2 - TUI.indent.detail,
  );

  // Auto-populate hint from error categorization if not provided.
  // For validation and unknown categories categorizeError returns undefined — no
  // generic fallback hint is shown for self-describing or unclassified errors.
  const displayHint = hint ?? categorizeError(message).hint;

  useInput((input, key) => {
    const action = actions.find((candidate) => actionKeyMatches(input, key, candidate.key));
    if (action !== undefined) {
      if (action.disabled === true) return;
      onAction?.(action.action);
      return;
    }
    if (input === 'q') exit();
    if (input === 'e' && truncated) setExpanded((value) => !value);
    if ((input === 'b' || key.escape) && onBack !== undefined) onBack();
  }, { isActive: (isActive ?? true) && !helpOpen && !paletteOpen });

  const lines = wordWrapLines(message, wrapWidth);
  const truncated = lines.length > MAX_ERROR_LINES;
  const displayLines = expanded || !truncated ? lines : lines.slice(0, MAX_ERROR_LINES);
  const hiddenLineCount = truncated ? lines.length - MAX_ERROR_LINES : 0;

  // Build hint rows inside the box — split domain fixes from navigation
  const domainHints: InteractionHint[] = [];
  if (truncated) domainHints.push({ key: 'e', label: expanded ? 'collapse' : 'expand' });

  const navigationHints: InteractionHint[] = [];
  if (onBack !== undefined) navigationHints.push(IH_BACK);
  navigationHints.push(IH_QUIT);

  return (
    <Box
      borderStyle={borders.error}
      borderColor={colors.error}
      flexDirection="column"
      paddingX={PADDING_X}
      marginY={1}
    >
      <Box gap={GAP_ICON_TEXT}>
        <Text color={colors.error}>{icons.error}</Text>
        <Text bold color={colors.error}>
          {title}
        </Text>
      </Box>
      <Box marginLeft={TUI.indent.detail} flexDirection="column">
        {displayLines.map((line, index) => (
          <Text key={`${index}-${line}`} wrap="wrap">
            {line}
          </Text>
        ))}
        {!expanded && hiddenLineCount > 0 && (
          <Text dimColor>
            … ({hiddenLineCount} more lines, press <Text color={colors.warning}>e</Text> to expand)
          </Text>
        )}
      </Box>
      {displayHint !== undefined && (
        <Box marginLeft={TUI.indent.detail} marginTop={GAP_BETWEEN_SECTIONS}>
          <Text dimColor>
            <Text color={colors.brand}>{icons.arrow_right}</Text> {displayHint}
          </Text>
        </Box>
      )}

      {/* Render recovery actions inside box */}
      {isActive && actions.length > 0 && (
        <Box marginLeft={TUI.indent.detail} marginTop={GAP_BETWEEN_SECTIONS} flexDirection="column">
          <Box gap={GAP_ROW} flexWrap="wrap">
            {actions.map((action, i) => (
              <React.Fragment key={`${action.key}-${i}`}>
                {i > 0 && <Text dimColor>{icons.dot}</Text>}
                <Text dimColor>
                  <Text color={colors.warning}>{action.key}</Text> {action.label}
                </Text>
              </React.Fragment>
            ))}
          </Box>
        </Box>
      )}

      {/* Hint rows inside box — domain actions first, navigation second */}
      {isActive && domainHints.length > 0 && (
        <Box marginLeft={TUI.indent.detail} marginTop={GAP_BETWEEN_SECTIONS} gap={GAP_ROW} flexWrap="wrap">
          {domainHints.map((hint, i) => (
            <React.Fragment key={hint.key + hint.label}>
              {i > 0 && <Text dimColor>{icons.dot}</Text>}
              <Text dimColor>
                <Text color={colors.warning}>{hint.key}</Text> {hint.label}
              </Text>
            </React.Fragment>
          ))}
        </Box>
      )}
      {isActive && navigationHints.length > 0 && (
        <Box marginLeft={TUI.indent.detail} marginTop={GAP_BETWEEN_SECTIONS} gap={GAP_ROW} flexWrap="wrap">
          {navigationHints.map((hint, i) => (
            <React.Fragment key={hint.key + hint.label}>
              {i > 0 && <Text dimColor>{icons.dot}</Text>}
              <Text dimColor>
                <Text color={colors.warning}>{hint.key}</Text> {hint.label}
              </Text>
            </React.Fragment>
          ))}
        </Box>
      )}
    </Box>
  );
}
