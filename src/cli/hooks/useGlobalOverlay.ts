import { createContext, useContext } from 'react';

export interface GlobalOverlayContextValue {
  /** True when the global help overlay (`?`) is currently visible. */
  helpOpen: boolean;
  /** True when the command palette (`:`) is currently visible. */
  paletteOpen: boolean;
  /** True when the quit-confirm overlay (`q` while AI running) is visible. */
  quitConfirmOpen: boolean;
}

export const GlobalOverlayContext = createContext<GlobalOverlayContextValue>({
  helpOpen: false,
  paletteOpen: false,
  quitConfirmOpen: false,
});

/**
 * Returns whether a global overlay (help `?` or command palette `:`) is
 * currently visible. Command screens use this to suppress their own Esc
 * handlers while a global overlay owns keyboard input.
 */
export function useGlobalOverlay(): GlobalOverlayContextValue {
  return useContext(GlobalOverlayContext);
}
