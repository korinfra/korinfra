/**
 * Shared stdio capture helper for tests.
 *
 * Replaces process.stdout.write and process.stderr.write with in-memory
 * buffers so test assertions can inspect what the CLI prints without
 * polluting the terminal or relying on spy call-argument arrays.
 *
 * Usage:
 *   const capture = createStdioCapture();
 *   beforeEach(() => capture.install());
 *   afterEach(() => capture.uninstall());
 *   // then read capture.stdout / capture.stderr in tests
 */

export interface StdioCapture {
  /** All text written to process.stdout since the last install() or reset(). */
  stdout: string;
  /** All text written to process.stderr since the last install() or reset(). */
  stderr: string;
  /** Clears the captured buffers without restoring the originals. */
  reset(): void;
  /** Saves the original write functions and installs capturing stubs. */
  install(): void;
  /** Restores the original write functions saved by install(). */
  uninstall(): void;
}

/** Returns a StdioCapture that replaces process.stdout/stderr.write for testing. */
export function createStdioCapture(): StdioCapture {
  let origStdoutWrite: typeof process.stdout.write | null = null;
  let origStderrWrite: typeof process.stderr.write | null = null;

  const capture: StdioCapture = {
    stdout: '',
    stderr: '',

    reset() {
      capture.stdout = '';
      capture.stderr = '';
    },

    install() {
      capture.stdout = '';
      capture.stderr = '';
      origStdoutWrite = process.stdout.write.bind(process.stdout);
      origStderrWrite = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((c: unknown) => {
        capture.stdout += String(c);
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((c: unknown) => {
        capture.stderr += String(c);
        return true;
      }) as typeof process.stderr.write;
    },

    uninstall() {
      if (origStdoutWrite !== null) {
        process.stdout.write = origStdoutWrite;
        origStdoutWrite = null;
      }
      if (origStderrWrite !== null) {
        process.stderr.write = origStderrWrite;
        origStderrWrite = null;
      }
    },
  };

  return capture;
}
