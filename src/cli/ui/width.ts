/**
 * stringWidth wrapper.
 *
 * Uses display width instead of string length for all text alignment.
 * Uses the `string-width` package (already in package.json) which correctly
 * handles emoji, CJK, ANSI sequences, and combining characters.
 */

import stringWidthPkg from 'string-width';

export function getAvailableSafeWidth(termWidth: number, leftMargin = 0, rightMargin = 0): number {
  return Math.max(20, termWidth - leftMargin - rightMargin - 2);
}

/**
 * Returns the visual display width of a string (number of terminal columns).
 * Handles emoji, CJK wide characters, ANSI escape sequences, and combining chars.
 */
export const stringWidth: (str: string) => number = stringWidthPkg;

/**
 * Truncates a string to at most `maxWidth` display columns.
 * Appends `suffix` (default `'…'`) if truncation occurred.
 */
export function truncateWidth(text: string, maxWidth: number, suffix = '…'): string {
  if (maxWidth <= 0) return '';
  const tw = stringWidth(text);
  if (tw <= maxWidth) return text;
  const suffixWidth = stringWidth(suffix);
  const targetWidth = Math.max(0, maxWidth - suffixWidth);
  let width = 0;
  let truncated = '';
  for (const char of text) {
    const cw = stringWidth(char);
    if (width + cw > targetWidth) break;
    truncated += char;
    width += cw;
  }
  return `${truncated}${suffix}`;
}

/**
 * Pads a string on the right to exactly `targetWidth` display columns.
 * If the string is already wider, it is truncated with `truncateWidth`.
 */
export function padEndWidth(text: string, targetWidth: number, padChar = ' '): string {
  const tw = stringWidth(text);
  if (tw >= targetWidth) return tw > targetWidth ? truncateWidth(text, targetWidth) : text;
  return text + padChar.repeat(targetWidth - tw);
}

/**
 * Pads a string on the left to exactly `targetWidth` display columns.
 */
export function padStartWidth(text: string, targetWidth: number, padChar = ' '): string {
  const tw = stringWidth(text);
  if (tw >= targetWidth) return tw > targetWidth ? truncateWidth(text, targetWidth) : text;
  return padChar.repeat(targetWidth - tw) + text;
}

/**
 * Middle-truncates a string to fit within `head + tail + separator` display columns.
 * Preserves the start and end of the string — useful for ARNs, scan IDs,
 * resource IDs, and file paths where both ends carry meaning.
 *
 * @example middleTruncateWidth('arn:aws:iam::123456789012:role/my-very-long-role-name', { head: 8, tail: 8 })
 * // → 'arn:aws:…ole-name'
 */
export function middleTruncateWidth(
  text: string,
  opts: { head?: number; tail?: number; separator?: string } = {},
): string {
  const { head = 8, tail = 8, separator = '…' } = opts;
  const tw = stringWidth(text);
  const sepWidth = stringWidth(separator);
  const budget = head + tail + sepWidth;
  if (tw <= budget) return text;

  // Build head portion
  let headStr = '';
  let headW = 0;
  for (const char of text) {
    const cw = stringWidth(char);
    if (headW + cw > head) break;
    headStr += char;
    headW += cw;
  }

  // Build tail portion (from the end)
  let tailStr = '';
  let tailW = 0;
  const chars = [...text];
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i] ?? '';
    const cw = stringWidth(ch);
    if (tailW + cw > tail) break;
    tailStr = ch + tailStr;
    tailW += cw;
  }

  return `${headStr}${separator}${tailStr}`;
}
