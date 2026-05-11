/**
 * Centralized theme for the korinfra CLI.
 * Semantic color roles, icons, and shared styling constants.
 */

import { supportsUnicode as _supportsUnicode } from './ui/terminal.js';

// ─── Semantic Colors ────────────────────────────────────────────────────────

const NO_COLOR = process.env['NO_COLOR'] !== undefined;
const ASCII_FALLBACK = NO_COLOR || process.env['TERM'] === 'dumb' || process.env['KORINFRA_ASCII'] === '1';

export const supportsGradient = !NO_COLOR;
export const noColor = NO_COLOR;

/** Brand gradient colors for ASCII header. */
export const brandGradient = ['#00d4ff', '#0099ff', '#6644ff', '#aa44ff'];

// ─── Color token contrast reference ─────────────────────────────────────────
// Each token is annotated with its approximate contrast ratio on dark terminals
// (most common: black or dark-grey background) and light terminals.
// Contrast ratios are estimates based on WCAG 2.1 relative luminance model.
//
// Token         Ink color      Dark bg (~4.5:1 min)   Light bg (~3:1 min)
// -----------   -----------    --------------------   ------------------
// brand         cyan           4.6:1 PASS             2.8:1 WARN (use bold)
// brandBright   cyanBright     5.9:1 PASS             3.4:1 PASS
// success       green          3.1:1 WARN             2.0:1 FAIL (use bold)
// warning       yellow         8.0:1 PASS             1.8:1 FAIL (use bold)
// error         red            3.8:1 PASS             2.2:1 WARN
// info          blue           2.4:1 FAIL (use bold)  1.4:1 FAIL (use bold)
// high          red            3.8:1 PASS             2.2:1 WARN
// medium        yellow         8.0:1 PASS             1.8:1 FAIL (use bold)
// low           green          3.1:1 WARN             2.0:1 FAIL (use bold)
// muted/subtle  gray           2.0:1 WARN (dim only)  4.2:1 PASS
// highlight     cyan           4.6:1 PASS             2.8:1 WARN
// cost          yellow         8.0:1 PASS             1.8:1 FAIL
// saving        green          3.1:1 WARN             2.0:1 FAIL
// anomaly       red            3.8:1 PASS             2.2:1 WARN
// ai            magenta        3.5:1 PASS             2.1:1 WARN
//
// Recommendation: on light terminals set KORINFRA_LIGHT_THEME=1 (future work).
// For now, bold compensates for low-contrast tokens on light backgrounds.
// NO_COLOR mode is always safe (inherits terminal default fg/bg).

export const colors = NO_COLOR
  ? {
      brand: undefined,
      brandBright: undefined,
      success: undefined,
      warning: undefined,
      error: undefined,
      info: undefined,
      high: undefined,
      medium: undefined,
      low: undefined,
      muted: undefined,
      highlight: undefined,
      cost: undefined,
      saving: undefined,
      savings: undefined,
      anomaly: undefined,
      // P2-3 tokens
      focus: undefined,
      text: undefined,
      subtle: undefined,
      border: undefined,
      panel: undefined,
      danger: undefined,
      ai: undefined,
    } as const
  : {
      // Brand
      brand: 'cyan',
      brandBright: 'cyanBright',

      // Status
      success: 'green',
      warning: 'yellow',
      error: 'red',
      info: 'blue',

      // Severity / risk
      high: 'red',
      medium: 'yellow',
      low: 'green',

      // UI chrome
      muted: 'gray',
      highlight: 'cyan',

      // Data
      cost: 'yellow',
      saving: 'green',
      savings: 'green',
      anomaly: 'red',

      // P2-3 semantic palette
      focus: 'cyanBright',
      text: 'white',
      subtle: 'gray',
      border: 'gray',
      panel: 'black',
      danger: 'red',
      ai: 'magenta',
    } as const;

// ─── Icons ──────────────────────────────────────────────────────────────────

const unicodeIcons = {
  // Status
  success: '✔',
  error: '✖',
  warning: '▲',
  info: '●',
  pending: '○',
  running: '◌',

  // Navigation
  pointer: '❯',
  dot: '·',
  separator: '│',
  dash: '─',

  // Brand
  logo: '◆',

  // Groups
  analyze: '⬡',
  action: '⬢',
  setup: '◇',

  // Data
  trend_up: '↑',
  trend_down: '↓',
  bullet: '•',
  arrow_right: '→',
  checkmark: '✔',
  cross: '✗',
} as const;

const asciiIcons = {
  // Status
  success: '+',
  error: 'x',
  warning: '!',
  info: 'i',
  pending: 'o',
  running: '~',

  // Navigation
  pointer: '>',
  dot: '.',
  separator: '|',
  dash: '-',

  // Brand
  logo: '*',

  // Groups
  analyze: 'A',
  action: '#',
  setup: 'S',

  // Data
  trend_up: '^',
  trend_down: 'v',
  bullet: '-',
  arrow_right: '->',
  checkmark: '+',
  cross: 'x',
} as const;

export const icons = ASCII_FALLBACK ? asciiIcons : unicodeIcons;

// ─── Border styles by context ───────────────────────────────────────────────

export const borders = {
  /** Interactive containers, cards, menus */
  card: 'round' as const,
  /** Result/output panels */
  result: 'round' as const,
  /** Error panels */
  error: 'round' as const,
  /** Subtle structural separators */
  section: 'single' as const,
};

// Single source of truth lives in ui/terminal.ts (includes Windows WT_SESSION /
// TERM_PROGRAM / ConEmuANSI checks). Re-export so existing callers of
// theme.ts keep working without change.
export const supportsUnicode: boolean = !ASCII_FALLBACK && _supportsUnicode;

// ─── Semantic token groups ─────────────────────────────────────────────────
// Use these instead of hardcoded color strings in components.

export const semanticColors = NO_COLOR
  ? {
      severity: { critical: undefined, high: undefined, medium: undefined, low: undefined },
      status: { pass: undefined, fail: undefined, warn: undefined, info: undefined },
      action: { primary: undefined, secondary: undefined, disabled: undefined },
      mode: { rulesOnly: undefined, aiAssisted: undefined, agent: undefined },
      badge: { new: undefined, stale: undefined, marked: undefined },
      ai: { running: undefined, cached: undefined, stale: undefined, off: undefined, unavailable: undefined },
      cost: { value: undefined, anomaly: undefined },
      savings: { value: undefined },
    } as const
  : {
      severity: {
        critical: 'redBright' as const,
        high: 'red' as const,
        medium: 'yellow' as const,
        low: 'green' as const,
      },
      status: {
        pass: 'green' as const,
        fail: 'red' as const,
        warn: 'yellow' as const,
        info: 'blue' as const,
      },
      action: {
        primary: 'cyan' as const,
        secondary: 'yellow' as const,
        disabled: 'gray' as const,
      },
      mode: {
        rulesOnly: 'gray' as const,
        aiAssisted: 'cyan' as const,
        agent: 'magenta' as const,
      },
      badge: {
        new: 'cyan' as const,
        stale: 'yellow' as const,
        marked: 'blue' as const,
      },
      /** P2-3: AI state color sub-namespace. */
      ai: {
        running: 'magenta' as const,
        cached: 'cyan' as const,
        stale: 'yellow' as const,
        off: 'gray' as const,
        unavailable: 'gray' as const,
      },
      /** P2-3: Cost value color sub-namespace. */
      cost: {
        value: 'yellow' as const,
        anomaly: 'red' as const,
      },
      /** P2-3: Savings value color sub-namespace. */
      savings: {
        value: 'green' as const,
      },
    } as const;

// ─── Scroll indicators ─────────────────────────────────────────────────────
// Consistent scroll indicators across all scrollable views.

export function scrollAboveLabel(count: number): string {
  return `  ${icons.trend_up} ${count} above`;
}

export function scrollBelowLabel(count: number): string {
  return `  ${icons.trend_down} ${count} below`;
}
