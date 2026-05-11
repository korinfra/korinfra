import { createContext, useContext } from 'react';

import type { InputMode } from '../ui/keys.js';

export interface InputModeContextValue {
  inputMode: InputMode;
  setInputMode: (mode: InputMode) => void;
}

export const InputModeContext = createContext<InputModeContextValue>({
  inputMode: 'none',
  setInputMode: () => {},
});

/**
 * Hook for command screens to report their current text-input state.
 * Call `setInputMode('field')` when a local text input is focused and
 * `setInputMode('none')` when it blurs, so the app shell can gate the
 * command palette and help overlay correctly.
 */
export function useInputMode(): InputModeContextValue {
  return useContext(InputModeContext);
}
