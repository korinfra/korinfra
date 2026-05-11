import { createContext, useContext } from 'react';

/**
 * Prevent commands from re-running their initial effect when they remount
 * due to overlay close (HelpOverlay, CommandPalette) or navigation back from
 * a child command (scan → Esc → doctor).
 *
 * The App component owns a Map at ref level. Each command records its completed
 * state keyed by a stable string (e.g. "doctor"). On remount, if the key is
 * present, the command skips the initial effect and shows its last result.
 *
 * Key format: use a stable string like `"doctor"` or `"scan"`.
 */

export interface InitialRunDoneContextValue {
  /** Returns true if this key has already completed at least one initial run. */
  hasRun: (key: string) => boolean;
  /** Mark a key as having completed its initial run. */
  markRan: (key: string) => void;
  /**
   * Clear a key (e.g. on explicit "run again").
   * After clear, the next mount will re-run the initial effect.
   */
  clearRun: (key: string) => void;
}

export const InitialRunDoneContext = createContext<InitialRunDoneContextValue>({
  hasRun: () => false,
  markRan: () => {},
  clearRun: () => {},
});

export function useInitialRunDone(): InitialRunDoneContextValue {
  return useContext(InitialRunDoneContext);
}
