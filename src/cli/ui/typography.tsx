/**
 * Semantic text role components for consistent visual hierarchy.
 *
 * Text roles defined in the TUI visual hierarchy contract:
 *   SectionTitle    content group label
 */

import React from 'react';
import { Text, useStdout } from 'ink';
import { colors } from '../theme.js';

interface ChildrenProps {
  children: React.ReactNode;
}

interface SectionTitleProps extends ChildrenProps {
  /** When true, render with leading dashes and trailing dashes filling to terminal width. */
  divider?: boolean;
}

/** Section group label inside scrollable content. */
export function SectionTitle({ children, divider = false }: SectionTitleProps) {
  if (!divider) {
    return <Text bold color={colors.muted}>{children}</Text>;
  }

  return <SectionDivider>{children}</SectionDivider>;
}

function SectionDivider({ children }: ChildrenProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const childrenStr = typeof children === 'string' ? children : String(children as string | number);
  const contentStr = `─── ${childrenStr} `;
  const maxWidth = Math.min(cols - 4, 72);
  const trailingDashes = '─'.repeat(Math.max(0, maxWidth - contentStr.length));
  return (
    <Text bold color={colors.muted}>
      {contentStr}{trailingDashes}
    </Text>
  );
}

