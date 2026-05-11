import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * Reactive terminal size hook.
 *
 * `useStdout()` returns a snapshot — `stdout.columns` and `stdout.rows` do NOT
 * trigger a re-render when the terminal is resized. This hook subscribes to the
 * `resize` event on stdout so the component re-renders whenever dimensions change.
 *
 * Falls back to 80×24 when stdout is unavailable (non-TTY / piped output).
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();

  const [size, setSize] = useState<TerminalSize>(() => ({
    cols: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));

  useEffect(() => {
    if (!stdout) return;

    // Read current values immediately in case they changed between render and effect
    setSize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });

    const handleResize = (): void => {
      setSize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    };

    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
    };
  }, [stdout]);

  return size;
}
