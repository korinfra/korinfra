import { useEffect } from 'react';
import { useStdout } from 'ink';

/**
 * On terminal resize the Ink frame buffer can contain stale characters
 * outside the new viewport (double borders at 56 cols, etc.).
 *
 * Listens to stdout's `resize` event (and SIGWINCH on non-Windows) and emits
 * `\x1b[2J\x1b[H` (erase display + cursor home) after a 50 ms debounce so
 * Ink's next render lands on a clean canvas. useTerminalSize already triggers
 * a re-render on resize, so no key-based remount is needed.
 */
export function useResizeClear(): void {
  const { stdout } = useStdout();

  useEffect(() => {
    if (!stdout) return;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearScreen = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stdout.write('\x1b[2J\x1b[H');
      }, 50);
    };

    stdout.on('resize', clearScreen);

    if (process.platform !== 'win32') {
      process.on('SIGWINCH', clearScreen);
    }

    return () => {
      clearTimeout(timer);
      stdout.off('resize', clearScreen);
      if (process.platform !== 'win32') {
        process.off('SIGWINCH', clearScreen);
      }
    };
  }, [stdout]);
}
