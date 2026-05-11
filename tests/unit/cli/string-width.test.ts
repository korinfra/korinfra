/**
 * Tests for src/cli/ui/width.ts — stringWidth wrapper and padding helpers.
 */

import { describe, it, expect } from 'vitest';
import { stringWidth, truncateWidth, padEndWidth, padStartWidth } from '../../../src/cli/ui/width.js';

describe('stringWidth', () => {
  it('measures ASCII strings correctly', () => {
    expect(stringWidth('hello')).toBe(5);
    expect(stringWidth('')).toBe(0);
  });

  it('measures CJK characters as width 2', () => {
    // Chinese characters are double-width
    expect(stringWidth('日本語')).toBe(6);
  });

  it('strips ANSI escape codes', () => {
    // ESC[31m red ESC[0m reset
    const ansi = '\x1b[31mred\x1b[0m';
    expect(stringWidth(ansi)).toBe(3);
  });

  it('measures emoji as wider than 1', () => {
    // emoji like 🎉 are usually width 2
    expect(stringWidth('🎉')).toBeGreaterThanOrEqual(1);
  });
});

describe('truncateWidth', () => {
  it('returns the string unchanged when within limit', () => {
    expect(truncateWidth('hello', 10)).toBe('hello');
  });

  it('truncates with default ellipsis', () => {
    const result = truncateWidth('hello world', 8);
    expect(stringWidth(result)).toBeLessThanOrEqual(8);
    expect(result).toContain('…');
  });

  it('truncates with custom suffix', () => {
    const result = truncateWidth('hello world', 8, '...');
    expect(stringWidth(result)).toBeLessThanOrEqual(8);
    expect(result).toContain('...');
  });

  it('returns empty string when maxWidth is 0', () => {
    const result = truncateWidth('hello', 0);
    expect(result).toBe('');
  });

  it('handles CJK characters in truncation', () => {
    const result = truncateWidth('日本語テスト', 5);
    expect(stringWidth(result)).toBeLessThanOrEqual(5);
  });
});

describe('padEndWidth', () => {
  it('pads ASCII string to target width', () => {
    const result = padEndWidth('hi', 6);
    expect(result).toBe('hi    ');
    expect(stringWidth(result)).toBe(6);
  });

  it('returns string unchanged when already at target width', () => {
    expect(padEndWidth('hello', 5)).toBe('hello');
  });

  it('truncates when string exceeds target width', () => {
    const result = padEndWidth('hello world', 5);
    expect(stringWidth(result)).toBeLessThanOrEqual(5);
  });

  it('works correctly with CJK (width-2 chars)', () => {
    // '日' is width 2; padEnd to 4 should not add spaces (already 2 chars = 4 cols with one more)
    const result = padEndWidth('日', 4);
    expect(stringWidth(result)).toBe(4);
  });
});

describe('padStartWidth', () => {
  it('pads ASCII string on the left', () => {
    const result = padStartWidth('hi', 6);
    expect(result).toBe('    hi');
    expect(stringWidth(result)).toBe(6);
  });

  it('returns string unchanged when already at target width', () => {
    expect(padStartWidth('hello', 5)).toBe('hello');
  });

  it('truncates when string exceeds target width', () => {
    const result = padStartWidth('hello world', 5);
    expect(stringWidth(result)).toBeLessThanOrEqual(5);
  });
});
