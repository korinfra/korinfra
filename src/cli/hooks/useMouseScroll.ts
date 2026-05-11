/**
 * useMouseScroll — enable SGR mouse scroll reporting per mounted, active scroll owner.
 *
 * Mouse mode is opt-in per scroll owner with reference counting.
 * Mouse mode is enabled only when:
 *   - at least one scroll owner is mounted and active (ref count > 0)
 *   - content actually overflows (hasOverflow=true)
 *   - terminal capability allows it (supportsMouse)
 *
 * Ref-counting ensures nested or sibling scrollable regions don't race to
 * enable/disable the escape sequences.
 */

import { useEffect } from 'react';
import { supportsMouse } from '../ui/terminal.js';

const ENABLE_MOUSE  = '\x1b[?1000h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1006l';

/** Module-level ref count — shared across all hook instances in the process. */
let _mouseRefCount = 0;

function enableMouse(): void {
  _mouseRefCount++;
  if (_mouseRefCount === 1) {
    process.stdout.write(ENABLE_MOUSE);
  }
}

function disableMouse(): void {
  _mouseRefCount = Math.max(0, _mouseRefCount - 1);
  if (_mouseRefCount === 0) {
    process.stdout.write(DISABLE_MOUSE);
  }
}

interface UseMouseScrollOptions {
  /** Whether this scroll owner is currently active / focused. Default true. */
  isActive?: boolean;
  /**
   * Whether the content actually overflows (i.e. there's something to scroll).
   * Mouse mode is only enabled when this is true.
   * Default true (legacy behaviour — callers that know overflow should pass it explicitly).
   */
  hasOverflow?: boolean;
}

export function useMouseScroll(
  onScrollUp: () => void,
  onScrollDown: () => void,
  isActiveOrOptions: boolean | UseMouseScrollOptions = true,
): void {
  // Accept both the legacy boolean form and the new options object
  const { isActive = true, hasOverflow = true } =
    typeof isActiveOrOptions === 'boolean'
      ? { isActive: isActiveOrOptions, hasOverflow: true }
      : isActiveOrOptions;

  const shouldEnable = isActive && hasOverflow && supportsMouse;

  useEffect(() => {
    if (!shouldEnable) return;

    enableMouse();

    function handler(data: Buffer): void {
      const str = data.toString('binary');

      // SGR extended mouse: ESC[<Cb;Cx;CyM  (button 64 = wheel up, 65 = wheel down)
      // eslint-disable-next-line no-control-regex
      const sgrMatch = /\x1b\[<(\d+);(\d+);(\d+)M/.exec(str);
      if (sgrMatch) {
        const btn = parseInt(sgrMatch[1] ?? '', 10);
        if (btn === 64) onScrollUp();
        if (btn === 65) onScrollDown();
        return;
      }

      // X10 mouse: ESC[M + 3 raw bytes (button byte − 32)
      const idx = str.indexOf('\x1b[M');
      if (idx !== -1 && str.length >= idx + 6) {
        const btn = str.charCodeAt(idx + 3) - 32;
        if (btn === 64) onScrollUp();
        if (btn === 65) onScrollDown();
      }
    }

    process.stdin.on('data', handler);

    return () => {
      disableMouse();
      process.stdin.off('data', handler);
    };
  }, [shouldEnable, onScrollUp, onScrollDown]);
}
