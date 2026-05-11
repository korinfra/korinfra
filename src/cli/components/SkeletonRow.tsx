import React from 'react';
import { Box, Text } from 'ink';

interface SkeletonRowProps {
  /** Column widths in characters */
  columns: number[];
  /** Gap between columns */
  gap?: number;
}

/**
 * Placeholder row shown while data loads.
 * Renders dim ─ chars at specified column widths — sets spatial
 * expectations before data arrives (reduces perceived latency).
 */
export function SkeletonRow({ columns, gap = 2 }: SkeletonRowProps): React.JSX.Element {
  return (
    <Box gap={gap}>
      {columns.map((width, i) => (
        <Text key={i} dimColor>{'─'.repeat(width)}</Text>
      ))}
    </Box>
  );
}
