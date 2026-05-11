import stringWidth from 'string-width';

/**
 * Truncate a string to fit within maxWidth display columns,
 * appending '…' if truncated. Handles multi-byte Unicode characters correctly.
 */
export function truncateDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;

  const ellipsisWidth = stringWidth('…');
  if (maxWidth <= ellipsisWidth) return '…'.slice(0, maxWidth);

  let width = 0;
  let result = '';
  for (const char of Array.from(text)) {
    const charWidth = stringWidth(char);
    if (width + charWidth > maxWidth - ellipsisWidth) break;
    result += char;
    width += charWidth;
  }
  return `${result}…`;
}
