import { useInput } from 'ink';

import { useGlobalOverlay } from './useGlobalOverlay.js';

/**
 * Wraps `useInput` and automatically suppresses the handler while any global
 * overlay (help `?` or command palette `:`) is open.
 *
 * Pass `options.isActive = false` to also suppress for local conditions (e.g.
 * a nested overlay). The handler fires only when both the global overlays are
 * closed AND `options.isActive` is true (defaults to true).
 */
export function useOverlayAwareInput(
  handler: Parameters<typeof useInput>[0],
  options?: { isActive?: boolean },
): void {
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  useInput(handler, {
    ...options,
    isActive: !helpOpen && !paletteOpen && (options?.isActive ?? true),
  });
}
