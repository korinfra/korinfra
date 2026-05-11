import { describe, expect, it } from 'vitest';

import { actionKeyMatches } from '../../../src/cli/actions.js';

describe('actionKeyMatches', () => {
  it('matches composite Esc/b for both keyboard escape and b input', () => {
    expect(actionKeyMatches('', { escape: true }, 'Esc/b')).toBe(true);
    expect(actionKeyMatches('b', {}, 'Esc/b')).toBe(true);
  });

  it('matches Enter aliases (Enter/Return/⏎)', () => {
    expect(actionKeyMatches('', { return: true }, 'Enter')).toBe(true);
    expect(actionKeyMatches('', { return: true }, 'Return')).toBe(true);
    expect(actionKeyMatches('', { return: true }, '⏎')).toBe(true);
  });

  it('matches Space keyword to literal space input', () => {
    expect(actionKeyMatches(' ', {}, 'Space')).toBe(true);
    expect(actionKeyMatches('x', {}, 'Space')).toBe(false);
  });

  it('matches Shift+Tab and plain Tab separately', () => {
    expect(actionKeyMatches('', { tab: true, shift: true }, 'Shift+Tab')).toBe(true);
    expect(actionKeyMatches('', { tab: true, shift: false }, 'Shift+Tab')).toBe(false);
    expect(actionKeyMatches('', { tab: true, shift: false }, 'Tab')).toBe(true);
  });

  it('matches ctrl bindings and plain character bindings', () => {
    expect(actionKeyMatches('k', { ctrl: true }, 'Ctrl+k')).toBe(true);
    expect(actionKeyMatches('k', { ctrl: false }, 'Ctrl+k')).toBe(false);
    expect(actionKeyMatches('p', {}, 'p')).toBe(true);
  });
});
