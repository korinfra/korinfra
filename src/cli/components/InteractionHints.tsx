/**
 * InteractionHints — passive navigation controls split from ActionBar.
 *
 * ActionBar is for real actions (one key → one command).
 * InteractionHints is for passive navigation: up/down scroll, Tab focus,
 * b/Esc back, q quit, ? help.
 *
 * Footer layout contract:
 *   Actions: Enter details | f fix selected | p report
 *   Navigate: up/down scroll | Tab switch tab | : command | ? help | b back | q quit
 *
 * X-1 rule: no domain action keys (r, p, f, g, etc.) here.
 */

import React from 'react';
import { Box, Text, useStdout } from 'ink';

import { colors, icons } from '../theme.js';
import { GAP_BEFORE_ACTIONS, GAP_ROW } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';
import { TERMINAL_WIDTHS } from '../ui/breakpoints.js';

export interface InteractionHint {
  /** Key label shown to the user (e.g. "up/down", "Tab", "Shift+/"). */
  key: string;
  /** Short description (e.g. "scroll", "focus", "help"). */
  label: string;
}

interface InteractionHintsProps {
  hints: InteractionHint[];
  /** Optional row prefix label. Defaults to "Navigate". Set to false to suppress. */
  rowLabel?: string | false;
}

// ─── Common passive navigation hints ─────────────────────────────────────────

export const IH_NAVIGATE: InteractionHint = { key: '↑↓', label: 'scroll' };
/** For result screens: Esc/b both go back. */
export const IH_BACK: InteractionHint = { key: 'b', label: 'back' };
/** For running operations: Esc cancels. */
export const IH_CANCEL: InteractionHint = { key: 'Esc', label: 'cancel' };
export const IH_QUIT: InteractionHint = { key: 'q', label: 'quit' };
/** IH_HELP key matches RESERVED_KEYS.help.label — physical key is "?" (Shift+/ on most keyboards). */
export const IH_HELP: InteractionHint = { key: '?', label: 'help' };
export const IH_COMMAND: InteractionHint = { key: ':', label: 'command' };
export const IH_TAB: InteractionHint = { key: 'Tab', label: 'next field' };
export const IH_ARROWS: InteractionHint = { key: '←→', label: 'tabs' };
export const IH_TABS: InteractionHint = { key: 'Tab', label: 'tabs' };

/**
 * Build standard passive navigation hints for result screens.
 * Order: [scroll] [page] [: command] [? help] [b back] [q quit].
 */
export function buildInteractionHints(opts: {
  hasScroll?: boolean;
  hasPages?: boolean;
  hasTabs?: boolean;
  onBack?: (() => void) | undefined;
  extra?: InteractionHint[];
}): InteractionHint[] {
  const hints: InteractionHint[] = [];
  if (opts.extra !== undefined) hints.push(...opts.extra);
  if (opts.hasScroll === true) hints.push({ key: '↑↓', label: 'scroll' });
  if (opts.hasPages === true) hints.push({ key: 'PgUp/PgDn', label: 'page' });
  if (opts.hasTabs === true) hints.push({ key: 'Tab', label: 'switch tab' });
  hints.push(IH_COMMAND);
  hints.push(IH_HELP);
  if (opts.onBack !== undefined) hints.push(IH_BACK);
  hints.push(IH_QUIT);
  return hints;
}

/**
 * Keys that are never allowed in NavHints per X-1 rule.
 * Domain keys and Enter belong in ActionBar.
 */
const DOMAIN_KEY_BLOCKLIST = new Set(['r', 'enter', 's', 'p', 'f', 'd', 'o', 'c', 'g', '/', 'e', ' ', 'm', 'a', 'l', 'i', 'u', 'h', 'j', 't']);

/** Keys that are always shown even on narrow terminals (§1.7 minimal mode). */
const NARROW_ESSENTIAL_KEYS = new Set(['q', 'Esc', 'b', 'Esc/b', ':', '?']);

export function InteractionHints({ hints, rowLabel = false }: InteractionHintsProps): React.JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const isNarrow = cols <= TERMINAL_WIDTHS.narrow;

  // X-1: strip any domain keys that should not appear here (dev guard).
  const navOnlyHints = hints.filter((h) => !DOMAIN_KEY_BLOCKLIST.has(h.key.toLowerCase()));

  // On narrow terminals (≤56 cols) show only `b back  q quit`.
  const visibleHints = isNarrow
    ? navOnlyHints.filter((h) => NARROW_ESSENTIAL_KEYS.has(h.key))
    : navOnlyHints;

  return (
    <Box
      flexDirection="column"
      marginTop={GAP_BEFORE_ACTIONS}
      marginLeft={TUI.indent.content}
    >
      <Box gap={GAP_ROW} flexWrap="wrap">
        {!isNarrow && rowLabel !== false && rowLabel.length > 0 && (
          <Text dimColor>{rowLabel}:</Text>
        )}
        {visibleHints.map((hint, i) => (
          <React.Fragment key={hint.key + hint.label}>
            {i > 0 && <Text dimColor>{icons.dot}</Text>}
            <Text dimColor>
              <Text color={colors.warning}>{hint.key}</Text> {hint.label}
            </Text>
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
}
