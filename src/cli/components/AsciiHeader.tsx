import React from 'react';
import { Box, Text, useStdout } from 'ink';
import gradientString from 'gradient-string';

import { getVersion } from '../../utils/version.js';
import { colors, supportsUnicode, supportsGradient, brandGradient } from '../theme.js';
import { DOT_SEP } from '../ui/text.js';
import { GAP_BETWEEN_SECTIONS, GAP_ROW } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';

// ─── ASCII Art ──────────────────────────────────────────────────────────────
// Block-letter "KorInfra" — ~68 visual columns

const ASCII_LINES = [
  ' ██╗███╗   ██╗███████╗██████╗  █████╗ ██╗    ██╗██╗███████╗███████╗',
  ' ██║████╗  ██║██╔════╝██╔══██╗██╔══██╗██║    ██║██║██╔════╝██╔════╝',
  ' ██║██╔██╗ ██║█████╗  ██████╔╝███████║██║ █╗ ██║██║███████╗█████╗  ',
  ' ██║██║╚██╗██║██╔══╝  ██╔══██╗██╔══██║██║███╗██║██║╚════██║██╔══╝  ',
  ' ██║██║ ╚████║██║     ██║  ██║██║  ██║╚███╔███╔╝██║███████║███████╗',
  ' ╚═╝╚═╝  ╚═══╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝╚══════╝╚══════╝',
];

const ASCII_ART_VISUAL_WIDTH = 68;
const HEADER_MARGIN = 2;

const headerGradient = gradientString(brandGradient);

// ─── Hooks ──────────────────────────────────────────────────────────────────
// Animation hooks removed — header now renders statically

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Slice each line of ASCII art to `cols` visible characters, preserving multi-byte chars. */
function sliceArtColumns(lines: string[], cols: number): string[] {
  return lines.map((line) => {
    // Use Array.from to handle multi-byte Unicode (█, ╗, etc.)
    const chars = Array.from(line);
    return chars.slice(0, cols).join('');
  });
}

// ─── Row budget helper ───────────────────────────────────────────────────────

// ─── Component ──────────────────────────────────────────────────────────────

interface AsciiHeaderProps {
  /** Show compact version (no ASCII art). Useful for sub-commands. */
  compact?: boolean;
}

export function AsciiHeader({ compact = false }: AsciiHeaderProps): React.JSX.Element {
  const version = getVersion();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;

  // Clamp art to terminal width (leave 2 char margin)
  const maxCols = Math.max(0, Math.min(ASCII_ART_VISUAL_WIDTH, termWidth - HEADER_MARGIN));
  // Show full art only when rows >= fullMinRows (30) AND cols >= minCols (68)
  const showArt = supportsUnicode && maxCols >= TUI.header.minCols && !compact && termRows >= TUI.header.fullMinRows;

  const artWidth = Math.min(maxCols, ASCII_ART_VISUAL_WIDTH);
  const separatorWidth = Math.max(0, stdout?.columns ?? 80);

  if (!showArt) {
    // At width < 80, render single-line brand header
    if (termWidth < 80) {
      return (
        <Box marginBottom={GAP_BETWEEN_SECTIONS} gap={GAP_ROW}>
          <Text color={colors.brand} bold>{supportsUnicode ? '◆' : '*'}</Text>
          <Text bold>KorInfra</Text>
          <Text dimColor>v{version}</Text>
        </Box>
      );
    }
    return (
      <Box marginBottom={GAP_BETWEEN_SECTIONS} gap={GAP_ROW}>
        <Text color={colors.brand} bold>{supportsUnicode ? '▓▓▓' : '*'}</Text>
        <Text bold>KorInfra</Text>
        <Text dimColor>v{version}</Text>
        <Text dimColor>{supportsUnicode ? ' → ' : ' > '}AI-powered AWS FinOps</Text>
      </Box>
    );
  }

  // Full ASCII art with gradient (no reveal)
  const sliced = sliceArtColumns(ASCII_LINES, maxCols);
  const applyGradient = supportsGradient;
  const gradientBlock = sliced.length > 0
    ? applyGradient ? headerGradient.multiline(sliced.join('\n')) : sliced.join('\n')
    : '';

  // Center the meta text under the ASCII art
  const metaRaw = `v${version}${DOT_SEP}AI-powered AWS FinOps`;
  const metaPad = Math.max(0, Math.floor((artWidth - metaRaw.length) / 2));

  return (
    <Box flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
      {/* ASCII art with gradient — rendered immediately, full width */}
      {gradientBlock !== '' && <Text>{gradientBlock}</Text>}

      {/* Centered meta line — version + tagline, rendered immediately */}
      <Box>
        <Text>{' '.repeat(metaPad)}</Text>
        <Text color={colors.brand} bold>v{version}</Text>
        <Text dimColor>{DOT_SEP}</Text>
        <Text dimColor>AI-powered AWS FinOps</Text>
      </Box>

      {/* Decorative separator — full width, rendered immediately */}
      <Box>
        <Text dimColor>{'─'.repeat(separatorWidth)}</Text>
      </Box>
    </Box>
  );
}
