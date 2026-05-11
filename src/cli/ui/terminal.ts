/**
 * Terminal capability detection flags.
 *
 * Color support is kept separate from Unicode support.
 * Terminal capability detection must not assume a modern terminal.
 *
 * Explicit environment overrides:
 *   KORINFRA_ASCII=1       → force ASCII glyphs
 *   KORINFRA_UNICODE=0     → disable Unicode glyphs
 *   NO_COLOR=1              → disable color (standard: https://no-color.org)
 *   KORINFRA_NO_MOUSE=1    → disable mouse reporting
 *   CI=1 / TERM=dumb        → implies no animation, ASCII-safe
 */

import { readFileSync } from 'node:fs';

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const _platform = process.platform;
const _env = process.env;

/** True when running on Windows (not WSL). */
export const isWindows: boolean = _platform === 'win32';

/** True when running inside Windows Subsystem for Linux. */
export const isWsl: boolean = (() => {
  if (_env['WSLENV'] !== undefined) return true;
  const ver = readFileSyncSafe('/proc/version');
  return ver !== null && /microsoft/i.test(ver);
})();

/** True when NO_COLOR is set (https://no-color.org). */
export const supportsColor: boolean = _env['NO_COLOR'] === undefined && _env['TERM'] !== 'dumb';

/**
 * True when the terminal likely supports Unicode / UTF-8 output.
 * Explicitly opt out with KORINFRA_ASCII=1 or KORINFRA_UNICODE=0.
 */
export const supportsUnicode: boolean = (() => {
  if (_env['KORINFRA_ASCII'] === '1') return false;
  if (_env['KORINFRA_UNICODE'] === '0') return false;
  if (_env['TERM'] === 'dumb') return false;
  // Windows conhost (non-WT) is unreliable for box-drawing; WT sets WT_SESSION,
  // VS Code sets TERM_PROGRAM=vscode, ConEmu/Cmder set ConEmuANSI=ON.
  if (
    isWindows &&
    _env['WT_SESSION'] === undefined &&
    _env['TERM_PROGRAM'] === undefined &&
    _env['ConEmuANSI'] === undefined
  ) return false;
  // CI runners are often ASCII-safe but not guaranteed; respect env overrides above
  return true;
})();

/**
 * True when emoji rendering is likely supported.
 * Subset of Unicode support — requires a modern font + compositor.
 */
export const supportsEmoji: boolean = supportsUnicode && !isWindows && !isWsl;

/**
 * True when the terminal supports SGR mouse reporting.
 * Disabled by KORINFRA_NO_MOUSE=1, non-TTY, or dumb terminal.
 */
export const supportsMouse: boolean = (() => {
  if (_env['KORINFRA_NO_MOUSE'] === '1') return false;
  if (_env['TERM'] === 'dumb') return false;
  if (!process.stdout.isTTY) return false;
  return true;
})();

/** True when running in a CI environment. */
export const isCi: boolean =
  _env['CI'] === '1' ||
  _env['CI'] === 'true' ||
  _env['GITHUB_ACTIONS'] !== undefined ||
  _env['CIRCLECI'] !== undefined ||
  _env['TRAVIS'] !== undefined;

/** True when TERM=dumb or equivalent. */
export const isDumb: boolean = _env['TERM'] === 'dumb';

/** Convenience bundle of all terminal capability flags. */
export interface TerminalCapabilities {
  platform: NodeJS.Platform;
  isWindows: boolean;
  isWsl: boolean;
  supportsColor: boolean;
  supportsUnicode: boolean;
  supportsEmoji: boolean;
  supportsMouse: boolean;
  isCi: boolean;
  isDumb: boolean;
}

export const terminal: TerminalCapabilities = {
  platform: _platform,
  isWindows,
  isWsl,
  supportsColor,
  supportsUnicode,
  supportsEmoji,
  supportsMouse,
  isCi,
  isDumb,
};
