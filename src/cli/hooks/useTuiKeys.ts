/**
 * useTuiKeys — focus-aware command router for TUI keyboard input.
 *
 * `useKeyboard` supports only Escape, q, up, down, Enter. Most screens also
 * need j/k, PageUp/PageDown, Home/End, Tab, and local action keys. This hook
 * is the replacement — `useKeyboard` becomes a thin deprecated wrapper.
 *
 * FocusOwner model:
 *   'global'   — app-level: help, palette, quit
 *   'table'    — navigable list / table
 *   'result'   — read-only result panel
 *   'tools'    — tool detail panel
 *   'followup' — text input for follow-up / ask AI
 *   'modal'    — overlay modal (help, palette, etc.)
 *
 * Parent screens should pass `owner` so the hook can be tagged for
 * future ownership arbitration. Currently `isActive` controls suppression.
 */

import { useApp, useInput } from 'ink';
import type { Key } from 'ink';
import type { FocusOwner } from '../ui/keys.js';

// ─── Binding map ─────────────────────────────────────────────────────────────

interface TuiKeyBindings {
  /** Up arrow or 'k'. */
  up?: () => void;
  /** Down arrow or 'j'. */
  down?: () => void;
  /** Left arrow. */
  left?: () => void;
  /** Right arrow. */
  right?: () => void;
  /** Page up. */
  pageUp?: () => void;
  /** Page down. */
  pageDown?: () => void;
  /** Home. */
  home?: () => void;
  /** End. */
  end?: () => void;
  /** Enter / return. */
  enter?: () => void;
  /** Escape or 'b'. */
  back?: () => void;
  /** 'q' — quits the app unless overridden. */
  quit?: () => void;
  /** Tab. */
  tab?: () => void;
  /** Space / mark. */
  space?: () => void;
  /** Any other single-character binding. Key is the character. */
  chars?: Record<string, () => void>;
}

interface UseTuiKeysOptions {
  /**
   * Semantic focus owner for this component. Used for future ownership
   * arbitration; currently informational only.
   */
  owner?: FocusOwner;
  /** Key bindings. Omitted bindings are ignored. */
  bindings: TuiKeyBindings;
  /**
   * When false, all key handling is suppressed. Defaults to true.
   */
  isActive?: boolean;
  /**
   * When true, pressing 'q' without a quit binding calls app exit().
   * Defaults to false.
   */
  exitOnQ?: boolean;
}

export function useTuiKeys({
  bindings,
  isActive = true,
  exitOnQ = false,
}: UseTuiKeysOptions): void {
  const { exit } = useApp();

  useInput(
    (input: string, key: Key) => {
      // Back / cancel
      if (key.escape || input === 'b') {
        if (bindings.back !== undefined) {
          bindings.back();
          return;
        }
      }

      // Quit
      if (input === 'q') {
        if (bindings.quit !== undefined) {
          bindings.quit();
          return;
        }
        if (exitOnQ) {
          exit();
          return;
        }
      }

      // Enter / return
      if (key.return && bindings.enter !== undefined) {
        bindings.enter();
        return;
      }

      // Tab
      if (key.tab && bindings.tab !== undefined) {
        bindings.tab();
        return;
      }

      // Arrows + vim keys
      if (key.upArrow && bindings.up !== undefined) {
        bindings.up();
        return;
      }
      if (key.downArrow && bindings.down !== undefined) {
        bindings.down();
        return;
      }
      if (key.leftArrow && bindings.left !== undefined) {
        bindings.left();
        return;
      }
      if (key.rightArrow && bindings.right !== undefined) {
        bindings.right();
        return;
      }

      // Page
      if (key.pageUp && bindings.pageUp !== undefined) {
        bindings.pageUp();
        return;
      }
      if (key.pageDown && bindings.pageDown !== undefined) {
        bindings.pageDown();
        return;
      }

      // Home / End — Ink 6 exposes key.home / key.end natively;
      // also accept ctrl+a / ctrl+e as fallbacks for terminals that don't send them.
      if (bindings.home !== undefined && (key.home || (key.ctrl && input === 'a'))) {
        bindings.home();
        return;
      }
      if (bindings.end !== undefined && (key.end || (key.ctrl && input === 'e'))) {
        bindings.end();
        return;
      }

      // Space / mark
      if (input === ' ' && bindings.space !== undefined) {
        bindings.space();
        return;
      }

      // Arbitrary single-char bindings
      if (bindings.chars !== undefined && input.length === 1) {
        const handler = bindings.chars[input];
        if (handler !== undefined) {
          handler();
          return;
        }
      }
    },
    { isActive },
  );
}
