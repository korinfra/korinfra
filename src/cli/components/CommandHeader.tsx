import React from 'react';
import { Box, Text, useStdout } from 'ink';

import { colors, icons, semanticColors, supportsUnicode } from '../theme.js';
import { AsciiHeader } from './AsciiHeader.js';
import { GAP_AFTER_HEADER, MARGIN_LEFT_CONTENT, GAP_ROW } from '../ui/spacing.js';
import { MODE_LABELS } from '../ui/text.js';
import { truncateWidth } from '../ui/width.js';
import { TUI } from '../ui/tokens.js';

interface CommandHeaderProps {
  /** Command name, e.g. "scan" */
  command: string;
  /** Short description, e.g. "full infrastructure scan" */
  description: string;
  /** Optional scope/context line, e.g. "scan id abc123 · us-east-1 · 2 hours old" */
  scope?: string | undefined;
  /** Optional tags shown after description, e.g. ["us-east-1", "security"] */
  tags?: string[] | undefined;
  /** Optional flags shown in warning color, e.g. ["--dry-run"] */
  flags?: string[] | undefined;
  /**
   * 'hero' — show large ASCII art header when terminal is wide/tall enough.
   * 'compact' — always show compact text header.
   * Defaults to 'compact'.
   */
  variant?: 'hero' | 'compact';
  /**
   * Rendering mode shown as metadata.
   */
  mode?: 'rules-only' | 'ai-assisted' | 'agent' | 'local' | 'setup' | 'diagnostic' | undefined;
}

/**
 * Map mode to semantic color.
 */
function getModeColor(mode?: 'rules-only' | 'ai-assisted' | 'agent' | 'local' | 'setup' | 'diagnostic'): string | undefined {
  if (!mode) return undefined;
  if (mode === 'rules-only' || mode === 'local' || mode === 'diagnostic') {
    return semanticColors.mode['rulesOnly' as keyof typeof semanticColors.mode];
  }
  if (mode === 'setup') return colors.info;
  const modeKey = mode === 'ai-assisted' ? 'aiAssisted' : 'agent';
  return semanticColors.mode[modeKey as keyof typeof semanticColors.mode];
}

/** Max flags visible before truncating to +N more */
const MAX_VISIBLE_FLAGS = 2;

export function CommandHeader({
  command,
  description,
  scope,
  tags = [],
  flags = [],
  variant = 'compact',
  mode,
}: CommandHeaderProps): React.JSX.Element {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termHeight = stdout?.rows ?? 24;

  // Hero collapses to compact automatically when terminal height < TUI.header.fullMinRows (30)
  const showHero = variant === 'hero' && termWidth >= TUI.width.compact && termHeight >= TUI.header.fullMinRows;

  // Truncate flags to MAX_VISIBLE_FLAGS + "+N more"
  const visibleFlags = flags.slice(0, MAX_VISIBLE_FLAGS);
  const hiddenFlagCount = flags.length - visibleFlags.length;

  // Compact two-line hierarchy — command name always wins on narrow
  if (!showHero && variant === 'hero') {
    return (
      <Box marginBottom={GAP_AFTER_HEADER} flexDirection="column">
        {/* Line 1: command name + mode badge */}
        <Box gap={GAP_ROW} flexWrap="wrap">
          <Text color={colors.brand} dimColor>korinfra</Text>
          <Text bold color={colors.brand}>{command}</Text>
          {mode !== undefined && (
            <Text color={getModeColor(mode)}>[{MODE_LABELS[mode]}]</Text>
          )}
        </Box>
        {/* Line 2: description + truncated flags */}
        {(description || visibleFlags.length > 0) && (
          <Box gap={GAP_ROW} flexWrap="wrap" marginLeft={TUI.indent.content}>
            {description && <Text dimColor>{description}</Text>}
            {visibleFlags.length > 0 && (
              <>
                <Text dimColor>{icons.dot}</Text>
                {visibleFlags.map((f, i) => (
                  <React.Fragment key={`flag-${i}`}>
                    {i > 0 && <Text dimColor>{icons.dot}</Text>}
                    <Text color={colors.warning}>{f}</Text>
                  </React.Fragment>
                ))}
                {hiddenFlagCount > 0 && (
                  <Text dimColor>+{hiddenFlagCount} more</Text>
                )}
              </>
            )}
          </Box>
        )}
      </Box>
    );
  }

  if (showHero) {
    return (
      <Box flexDirection="column" marginBottom={GAP_AFTER_HEADER}>
        <AsciiHeader />
        {/* Wide layout — command + mode badge on first line */}
        <Box gap={GAP_ROW} flexWrap="wrap">
          <Text bold color={colors.brand}>{command}</Text>
          {mode !== undefined && (
            <Text color={getModeColor(mode)}>[{MODE_LABELS[mode]}]</Text>
          )}
        </Box>
        <Box gap={GAP_ROW} flexWrap="wrap">
          <Text dimColor>{description}</Text>
        </Box>
        {(visibleFlags.length > 0 || tags.length > 0) && (
          <Box gap={GAP_ROW} flexWrap="wrap">
            {visibleFlags.length > 0 && (
              <>
                <Text dimColor>Flags:</Text>
                {visibleFlags.map((f, i) => (
                  <React.Fragment key={`flag-${i}`}>
                    {i > 0 && <Text dimColor>{icons.dot}</Text>}
                    <Text color={colors.warning}>{f}</Text>
                  </React.Fragment>
                ))}
                {hiddenFlagCount > 0 && (
                  <Text dimColor>+{hiddenFlagCount} more</Text>
                )}
              </>
            )}
            {tags.length > 0 && (
              <>
                {visibleFlags.length > 0 && <Text dimColor>{icons.dot}</Text>}
                <Text dimColor>Tags:</Text>
                {tags.slice(0, termWidth < TUI.width.compact ? 1 : 4).map((t, i) => (
                  <React.Fragment key={`tag-${i}`}>
                    {i > 0 && <Text dimColor>{icons.dot}</Text>}
                    <Text color={colors.info}>{t}</Text>
                  </React.Fragment>
                ))}
                {tags.length > (termWidth < TUI.width.compact ? 1 : 4) && (
                  <Text dimColor>+{tags.length - (termWidth < TUI.width.compact ? 1 : 4)} more</Text>
                )}
              </>
            )}
          </Box>
        )}
      </Box>
    );
  }

  // Compact header: two-line layout with brand chevron + colored separator.
  // Line 1: ❯ korinfra  command  [mode]
  // Line 2: description · scope · tags (if any)
  // Line 3: colored separator
  const MAX_HEADER_SEP_WIDTH = 220;
  const sepWidth = Math.min(
    Math.max(TUI.header.minCols, termWidth - MARGIN_LEFT_CONTENT - TUI.header.marginCols),
    termWidth - MARGIN_LEFT_CONTENT,
    MAX_HEADER_SEP_WIDTH,
  );
  const chevron = supportsUnicode ? '❯' : '>';
  const maxTags = Math.max(1, Math.min(tags.length, Math.floor((termWidth - 60) / 15)));
  const hasSubline = description.length > 0 || (scope !== undefined && scope.length > 0) || tags.length > 0;

  return (
    <Box flexDirection="column" marginBottom={GAP_AFTER_HEADER} marginLeft={MARGIN_LEFT_CONTENT}>
      {/* Line 1: chevron + korinfra + command + mode */}
      <Box gap={GAP_ROW} flexWrap="nowrap">
        <Text color={colors.brand}>{chevron}</Text>
        <Text dimColor>korinfra</Text>
        <Text bold color={colors.brand}>{command}</Text>
        {mode !== undefined && (
          <>
            <Text dimColor>{icons.dot}</Text>
            <Text color={getModeColor(mode)}>[{MODE_LABELS[mode]}]</Text>
          </>
        )}
      </Box>
      {/* Line 2: description · scope · tags */}
      {hasSubline && (
        <Box gap={GAP_ROW} flexWrap="nowrap" marginLeft={TUI.indent.page}>
          {description.length > 0 && <Text dimColor>{description}</Text>}
          {scope !== undefined && scope.length > 0 && (
            <>
              {description.length > 0 && <Text dimColor>{icons.dot}</Text>}
              <Text dimColor>{truncateWidth(scope, Math.max(10, termWidth - MARGIN_LEFT_CONTENT - 32))}</Text>
            </>
          )}
          {tags.slice(0, maxTags).map((t, i) => (
            <React.Fragment key={`tag-${i}`}>
              {(description.length > 0 || scope !== undefined || i > 0) && <Text dimColor>{icons.dot}</Text>}
              <Text color={colors.info}>{t}</Text>
            </React.Fragment>
          ))}
          {tags.length > maxTags && <Text dimColor>+{tags.length - maxTags} more</Text>}
        </Box>
      )}
      {/* Separator in brand color for visibility */}
      <Text color={colors.brand}>{icons.dash.repeat(sepWidth)}</Text>
    </Box>
  );
}
