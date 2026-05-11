/**
 * Centralized glyph map.
 *
 * All glyphs live here, not scattered through components.
 * Glyph fallback is independent from NO_COLOR.
 *
 * Unicode mode is controlled by supportsUnicode from terminal.ts.
 * Color mode is controlled by NO_COLOR / supportsColor independently.
 */

import { supportsUnicode } from './terminal.js';

interface GlyphVariant {
  unicode: string;
  ascii: string;
}

const glyphDefs = {
  // Status
  success: { unicode: '✔', ascii: '+' },
  error: { unicode: '✖', ascii: 'x' },
  warning: { unicode: '▲', ascii: '!' },
  info: { unicode: '●', ascii: 'i' },
  pending: { unicode: '○', ascii: 'o' },
  running: { unicode: '◌', ascii: '~' },

  // Navigation
  pointer: { unicode: '❯', ascii: '>' },
  dot: { unicode: '·', ascii: '.' },
  separator: { unicode: '│', ascii: '|' },
  dash: { unicode: '─', ascii: '-' },

  // Brand
  logo: { unicode: '◆', ascii: '*' },

  // Groups
  analyze: { unicode: '⬡', ascii: 'A' },
  action: { unicode: '⬢', ascii: '#' },
  setup: { unicode: '◇', ascii: 'S' },

  // Data
  trendUp: { unicode: '↑', ascii: '^' },
  trendDown: { unicode: '↓', ascii: 'v' },
  bullet: { unicode: '•', ascii: '-' },
  arrowRight: { unicode: '→', ascii: '->' },
  checkmark: { unicode: '✔', ascii: '+' },
  cross: { unicode: '✖', ascii: 'x' },

  // Extras
  ellipsis: { unicode: '…', ascii: '...' },
  enter: { unicode: '↵', ascii: 'Enter' },
  barFull: { unicode: '█', ascii: '#' },
  barEmpty: { unicode: '░', ascii: '-' },
  sectionDividerChar: { unicode: '─', ascii: '-' },

  // Chart axis
  axis: { unicode: '┤', ascii: '|' },
  axisTick: { unicode: '│', ascii: '|' },
  axisCorner: { unicode: '└', ascii: '+' },
  axisH: { unicode: '─', ascii: '-' },
  highMarker: { unicode: '^', ascii: '^' },

  // Additional glyphs
  barEmptyDense: { unicode: '▒', ascii: '#' },
  pointerFallback: { unicode: '>', ascii: '>' },
} satisfies Record<string, GlyphVariant>;

type GlyphName = keyof typeof glyphDefs;

/**
 * Returns the correct glyph string for the current terminal capability.
 * Use `supportsUnicode` from terminal.ts to determine the variant.
 */
function resolveGlyph(def: GlyphVariant): string {
  return supportsUnicode ? def.unicode : def.ascii;
}

/** Fully resolved glyph map for the current terminal. */
export const glyphs: Record<GlyphName, string> = Object.fromEntries(
  Object.entries(glyphDefs).map(([key, val]) => [key, resolveGlyph(val)]),
) as Record<GlyphName, string>;

