import React, { useState, useEffect } from 'react';
import { Text, useStdout } from 'ink';

import { supportsUnicode } from '../ui/terminal.js';
import { stringWidth } from '../ui/width.js';

interface StreamTextProps {
  text: string;
  color?: string;
  dimColor?: boolean;
  isStreaming?: boolean;
  /** Maximum visual rows to show. Older rows are hidden with a count indicator. Defaults to 6. */
  lineLimit?: number;
  /** Maximum display width for wrapping. Defaults to terminal width. */
  maxWidth?: number;
}

export function StreamText({
  text,
  color,
  dimColor = false,
  isStreaming = false,
  lineLimit = 6,
  maxWidth,
}: StreamTextProps): React.JSX.Element {
  const { stdout } = useStdout();
  const termWidth = maxWidth ?? (stdout?.columns ?? 80);
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    if (!isStreaming) return;
    const t = setInterval(() => setCursorVisible(v => !v), 500);
    return () => clearInterval(t);
  }, [isStreaming]);

  // Reserve cursor width with trailing space when hidden to avoid line jitter
  const cursorChar = supportsUnicode ? '▋' : '|';
  const cursor = isStreaming ? (cursorVisible ? cursorChar : ' ') : '';

  // Wrap text into visual rows first
  const visualRows: string[] = [];
  const logicalLines = (text + cursor).split('\n');

  for (const line of logicalLines) {
    if (stringWidth(line) <= termWidth) {
      visualRows.push(line);
    } else {
      // Hard-wrap long line into multiple visual rows
      let remaining = line;
      while (remaining.length > 0) {
        let width = 0;
        let chunk = '';
        for (const char of remaining) {
          const charWidth = stringWidth(char);
          if (width + charWidth > termWidth && chunk.length > 0) {
            break;
          }
          chunk += char;
          width += charWidth;
        }
        visualRows.push(chunk);
        remaining = remaining.slice(chunk.length);
      }
    }
  }

  // Keep last lineLimit visual rows
  const hiddenCount = Math.max(0, visualRows.length - lineLimit);
  const visibleRows = visualRows.slice(hiddenCount);

  return (
    <>
      {hiddenCount > 0 && (
        <Text dimColor>... {hiddenCount} earlier row{hiddenCount !== 1 ? 's' : ''}</Text>
      )}
      <Text color={color} dimColor={dimColor} wrap="wrap">
        {visibleRows.join('\n')}
      </Text>
    </>
  );
}
