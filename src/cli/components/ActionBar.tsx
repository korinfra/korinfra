import React, { useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import type { ActionHint, TuiAction } from '../actions.js';
import { actionKeyMatches } from '../actions.js';
import { colors } from '../theme.js';
import { tuiLog } from '../../utils/tui-log.js';
import { GAP_BEFORE_ACTIONS } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';
import { RESERVED_KEYS } from '../ui/keys.js';
import { glyphs } from '../ui/glyphs.js';
import { TERMINAL_WIDTHS } from '../ui/breakpoints.js';
import { DOT_SEP } from '../ui/text.js';

interface ActionBarProps {
  actions: ActionHint[];
  onAction?: ((action: TuiAction) => void) | undefined;
  onDisabledAction?: ((reason: string) => void) | undefined;
  isActive?: boolean;
  marginLeft?: number;
  /**
   * Optional section label shown before actions.
   * Renders as dim `─ label ─` line instead of bold title.
   */
  title?: string;
  /**
   * Screen identifier for dev-mode key-collision validation.
   * Only used in development / test environments — no-op in production.
   */
  screenId?: string | undefined;
  /**
   * When true, skip validateActionKeys entirely.
   * Use when a screen intentionally reuses a reserved key for a documented reason.
   */
  suppressKeyWarnings?: boolean;
  /**
   * Maximum number of visible actions before overflow count is shown.
   * Overrides the narrow-terminal cap on wide terminals.
   */
  maxVisible?: number;
  /**
   * When true, removes the top margin gap. Use when the caller has exactly 1 row
   * available and the margin would collapse the content to height=0.
   */
  noGap?: boolean;
}

// ─── Dev-only key validation ─────────────────────────────────────────────────

/**
 * Validates that action keys do not collide with each other on the same screen
 * and warns if two meanings are registered for the same key.
 *
 * Only active in development (NODE_ENV !== 'production') and test environments.
 * Safe to call from any component — throws in tests, logs in development.
 */
function validateActionKeys(
  screenId: string,
  actions: ActionHint[],
): void {
  const isDev =
    typeof process !== 'undefined' &&
    process.env['NODE_ENV'] !== 'production';

  if (!isDev) return;

  const seen = new Map<string, string>();

  for (const action of actions) {
    const normalized = action.key.toLowerCase();
    const existing = seen.get(normalized);

    if (existing !== undefined && existing !== action.label) {
      const msg =
        `[ActionBar] Key collision on screen "${screenId}": ` +
        `key "${action.key}" is bound to both "${existing}" and "${action.label}"`;
      // Throw in test environments so CI catches regressions
      if (process.env['NODE_ENV'] === 'test' || process.env['VITEST'] !== undefined) {
        throw new Error(msg);
      }
      tuiLog(msg);
      return;
    }

    seen.set(normalized, action.label);
  }

  // Warn when an action key shadows a globally reserved key with a different meaning.
  const reservedEntries = Object.entries(RESERVED_KEYS) as [string, { label: string; aliases: readonly string[] }][];

  for (const action of actions) {
    const normalized = action.key.toLowerCase();
    for (const [reservedName, keyDef] of reservedEntries) {
      const aliasMatch = keyDef.aliases.some((a) => a.toLowerCase() === normalized);
      if (
        aliasMatch &&
        !action.label.toLowerCase().includes(reservedName.toLowerCase())
      ) {
        const msg =
          `[ActionBar] Screen "${screenId}": key "${action.key}" is a reserved key ` +
          `(${reservedName}="${keyDef.label}") but is labeled "${action.label}"`;
        tuiLog(msg);
      }
    }
  }

  // Warn when a key is used that is not registered in RESERVED_KEYS at all.
  const allReservedValues = new Set(
    Object.values(RESERVED_KEYS).flatMap((k) => k.aliases.map((a) => a.toLowerCase())),
  );
  for (const action of actions) {
    if (action.key && !allReservedValues.has(action.key.toLowerCase())) {
      tuiLog(`[ActionBar] Screen "${screenId ?? 'unknown'}": key "${action.key}" is not in RESERVED_KEYS`);
    }
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ActionBar({
  actions: rawActions,
  onAction,
  onDisabledAction,
  isActive = true,
  marginLeft = TUI.indent.content,
  title,
  screenId,
  suppressKeyWarnings = false,
  maxVisible,
  noGap = false,
}: ActionBarProps): React.JSX.Element {
  // Dev-only validation — no-op in production, runs after render to avoid render-phase side effects
  useEffect(() => {
    if (screenId !== undefined && !suppressKeyWarnings) {
      validateActionKeys(screenId, rawActions);
    }
  }, [screenId, rawActions, suppressKeyWarnings]);

  // Dedup by key: keep first occurrence, warn in dev when a duplicate is dropped
  const seenKeys = new Set<string>();
  const actions = rawActions.filter((a) => {
    const k = a.key.toLowerCase();
    if (seenKeys.has(k)) {
      if (typeof process !== 'undefined' && process.env['NODE_ENV'] !== 'production') {
        tuiLog(`[ActionBar] Duplicate key "${a.key}" (label="${a.label}") dropped — keeping first occurrence`);
      }
      return false;
    }
    seenKeys.add(k);
    return true;
  });

  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  // Cap at 5 actions on comfortable (≤80) terminals; respect maxVisible prop on wide terminals
  const countCap = termWidth <= TERMINAL_WIDTHS.comfortable
    ? Math.min(5, maxVisible ?? 5)
    : (maxVisible ?? actions.length);
  const showDisabledReason = termWidth > TERMINAL_WIDTHS.comfortable;

  // Width-budget truncation: drop whole actions before truncating labels mid-word.
  // SEP_WIDTH = DOT_SEP-with-surrounding-spaces = 5 chars (no gap — gap uses cursor-forward which leaves old terminal content)
  const SEP_WIDTH = 5;
  const widthOf = (a: ActionHint): number => a.key.length + 1 + a.label.length;
  const widthBudget = Math.max(0, termWidth - marginLeft - 2);
  const fitted: ActionHint[] = [];
  let usedWidth = 0;
  for (const a of actions.slice(0, countCap)) {
    const w = widthOf(a) + (fitted.length > 0 ? SEP_WIDTH : 0);
    if (usedWidth + w > widthBudget) break;
    fitted.push(a);
    usedWidth += w;
  }
  // Reserve trailing overflow marker room if some actions dropped
  const dropped = actions.length - fitted.length;
  if (dropped > 0) {
    const overflowLabel = `+${dropped} more`;
    const markerWidth = SEP_WIDTH + overflowLabel.length;
    while (fitted.length > 0 && usedWidth + markerWidth > widthBudget) {
      const last = fitted.pop();
      if (!last) break;
      usedWidth -= widthOf(last) + (fitted.length > 0 ? SEP_WIDTH : 0);
    }
  }
  const visibleActions = fitted;
  const overflow = actions.length - visibleActions.length;

  useInput((input, key) => {
    // Check both visible and hidden actions so keyboard shortcuts still work
    const match = actions.find((candidate) => actionKeyMatches(input, key, candidate.key));
    if (match === undefined) return;
    if (match.disabled === true) {
      const reason = match.reason ?? 'action unavailable';
      onDisabledAction?.(reason);
      return;
    }
    onAction?.(match.action);
  }, { isActive: isActive && (onAction !== undefined || onDisabledAction !== undefined) && actions.length > 0 });

  return (
    <Box flexDirection="column" marginTop={noGap ? 0 : GAP_BEFORE_ACTIONS} marginLeft={marginLeft}>
      {title !== undefined && (
        <Text dimColor>{glyphs.sectionDividerChar} {title} {glyphs.sectionDividerChar}</Text>
      )}
      <Box flexWrap="nowrap" overflow="hidden">
        {visibleActions.map((action, index) => (
          <React.Fragment key={`${action.key}-${action.label}-${index}`}>
            {index > 0 && <Text dimColor> {DOT_SEP} </Text>}
            {action.disabled === true ? (
              <Text dimColor>
                <Text color={colors.muted}>{action.key}</Text>{' '}
                {action.label}
                {showDisabledReason && action.reason !== undefined ? ` (${action.reason})` : ''}
              </Text>
            ) : (
              <Text>
                <Text color={colors.warning} bold>{action.key}</Text> {action.label}
              </Text>
            )}
          </React.Fragment>
        ))}
        {overflow > 0 && (
          <>
            <Text dimColor> {DOT_SEP} </Text>
            <Text dimColor>+{overflow} more</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
