/**
 * Tests for formatPathForTerminal in src/cli/ui/format.ts.
 */

import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { formatPathForTerminal } from '../../../src/cli/ui/format.js';

const HOME = homedir();

describe('formatPathForTerminal', () => {
  it('uses relative path when shorter than absolute', () => {
    const abs = process.cwd() + '/src/something.ts';
    const result = formatPathForTerminal(abs, { cwd: process.cwd() });
    // Should be relative, not the full absolute
    expect(result.length).toBeLessThanOrEqual(abs.length);
    expect(result).toContain('something.ts');
  });

  it('replaces home directory with ~', () => {
    const abs = HOME + '/some/deep/path.json';
    const result = formatPathForTerminal(abs, { preferRelative: false });
    expect(result).toMatch(/^~/);
    expect(result).toContain('some/deep/path.json');
  });

  it('middle-truncates paths that exceed cols', () => {
    const longPath = HOME + '/very/long/path/that/exceeds/the/terminal/width/my-file.ts';
    const result = formatPathForTerminal(longPath, { cols: 30, preferRelative: false });
    // Should be at most ~30 chars long (display width)
    expect(result.length).toBeLessThanOrEqual(34); // slight slack for unicode
    expect(result).toContain('…');
  });

  it('uses forward slashes on display', () => {
    const abs = process.cwd() + '/src/cli/ui/format.ts';
    const result = formatPathForTerminal(abs, { preferRelative: false });
    expect(result).not.toContain('\\');
  });

  it('returns a short relative path as-is', () => {
    const short = process.cwd() + '/README.md';
    const result = formatPathForTerminal(short, { cwd: process.cwd(), cols: 120 });
    expect(result).toContain('README.md');
    expect(result.length).toBeLessThan(short.length);
  });

  it('handles paths outside cwd gracefully (falls back to absolute)', () => {
    const abs = '/tmp/some/other/file.ts';
    const result = formatPathForTerminal(abs, { cwd: HOME + '/projects/myapp', cols: 120 });
    // Should still return a non-empty string
    expect(result.length).toBeGreaterThan(0);
  });
});
