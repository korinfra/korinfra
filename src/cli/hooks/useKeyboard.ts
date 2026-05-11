/**
 * @deprecated Use `useTuiKeys` from `./useTuiKeys.js` instead.
 *
 * `useKeyboard` is too narrow — it only handles Escape, q, up, down, and
 * Enter. Replaced by `useTuiKeys` which supports the full navigation contract
 * (j/k, PageUp/PageDown, Tab, etc.) and a focus-owner model. This wrapper
 * will be removed once all call sites migrate.
 */

import { useTuiKeys } from './useTuiKeys.js';

interface KeyboardOptions {
  /** Called when Escape is pressed — typically abort the running agent. */
  onEscape?: () => void;
  /** Called when 'q' is pressed — quit the app. */
  onQuit?: () => void;
  /** Called when up-arrow is pressed. */
  onUp?: () => void;
  /** Called when down-arrow is pressed. */
  onDown?: () => void;
  /** Called when Enter is pressed. */
  onEnter?: () => void;
  /** When true, all key handling is suppressed. */
  isDisabled?: boolean;
  /** When true, pressing 'q' calls exit() even if onQuit is not provided. Defaults to false. */
  exitOnQ?: boolean;
}

/** @deprecated Use `useTuiKeys` instead. */
export function useKeyboard(options: KeyboardOptions = {}): void {
  const { onEscape, onQuit, onUp, onDown, onEnter, isDisabled = false, exitOnQ = false } = options;

  const bindings: Record<string, unknown> = {};
  if (onEscape !== undefined) bindings['back'] = onEscape;
  if (onQuit !== undefined) bindings['quit'] = onQuit;
  if (onUp !== undefined) bindings['up'] = onUp;
  if (onDown !== undefined) bindings['down'] = onDown;
  if (onEnter !== undefined) bindings['enter'] = onEnter;

  useTuiKeys({
    owner: 'global',
    isActive: !isDisabled,
    exitOnQ,
    bindings: bindings,
  });
}
