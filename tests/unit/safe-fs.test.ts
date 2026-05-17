import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkNoSymlink, safeWriteFile, safeReadFile, safeOpenAppend } from '../../src/utils/safe-fs.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'korinfra-safefs-'));
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('checkNoSymlink', () => {
  it('returns silently when the path does not exist', () => {
    expect(() => checkNoSymlink(join(tmp, 'nope'))).not.toThrow();
  });

  it('returns silently for a regular file', () => {
    const p = join(tmp, 'plain.txt');
    writeFileSync(p, 'hi');
    expect(() => checkNoSymlink(p)).not.toThrow();
  });

  it('throws when the path is a symlink', () => {
    const target = join(tmp, 'target.txt');
    const link = join(tmp, 'link.txt');
    writeFileSync(target, 'real');
    symlinkSync(target, link);
    expect(() => checkNoSymlink(link)).toThrow(/symlink/i);
  });

  it('throws when the path is a dangling symlink', () => {
    const link = join(tmp, 'dangling.txt');
    symlinkSync(join(tmp, 'does-not-exist'), link);
    expect(() => checkNoSymlink(link)).toThrow(/symlink/i);
  });
});

describe('safeWriteFile', () => {
  it('writes content with the requested file mode', () => {
    const p = join(tmp, 'secret.txt');
    safeWriteFile(p, 'token', { mode: 0o600 });
    expect(readFileSync(p, 'utf8')).toBe('token');
    if (process.platform !== 'win32') {
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it('creates the parent directory with the requested mode', () => {
    const p = join(tmp, 'nested', 'sub', 'file.txt');
    safeWriteFile(p, 'data', { mode: 0o600, dirMode: 0o700 });
    if (process.platform !== 'win32') {
      expect(statSync(join(tmp, 'nested')).mode & 0o777).toBe(0o700);
    }
  });

  it('refuses to write through a pre-existing symlink', () => {
    const target = join(tmp, 'attacker-controlled.txt');
    const link = join(tmp, 'cache.json');
    writeFileSync(target, 'original');
    symlinkSync(target, link);
    expect(() => safeWriteFile(link, 'malicious', { mode: 0o600 })).toThrow(/symlink/i);
    expect(readFileSync(target, 'utf8')).toBe('original');
  });

  it('overwrites a pre-existing regular file', () => {
    const p = join(tmp, 'file.txt');
    writeFileSync(p, 'old');
    safeWriteFile(p, 'new', { mode: 0o600 });
    expect(readFileSync(p, 'utf8')).toBe('new');
  });

  it('tightens the mode of a pre-existing world-readable file', () => {
    if (process.platform === 'win32') return;
    const p = join(tmp, 'preexisting.txt');
    writeFileSync(p, 'old');
    chmodSync(p, 0o644); // not subject to umask, unlike { mode: 0o644 }
    expect(statSync(p).mode & 0o777).toBe(0o644);
    safeWriteFile(p, 'new', { mode: 0o600 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('refuses to write when the parent directory is a symlink', () => {
    if (process.platform === 'win32') return;
    const realDir = join(tmp, 'real-target');
    const linkDir = join(tmp, 'symlinked-parent');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, linkDir);
    expect(() => safeWriteFile(join(linkDir, 'file.txt'), 'x', { mode: 0o600 }))
      .toThrow(/symlinked directory/i);
  });
});

describe('safeReadFile', () => {
  it('reads UTF-8 content from a regular file', () => {
    const p = join(tmp, 'readme.txt');
    writeFileSync(p, 'hello', { mode: 0o600 });
    expect(safeReadFile(p)).toBe('hello');
  });

  it('throws ENOENT for a missing file', () => {
    expect(() => safeReadFile(join(tmp, 'absent.txt'))).toThrow(/ENOENT/);
  });

  it('refuses to follow a symlink', () => {
    const target = join(tmp, 'sneak.txt');
    const link = join(tmp, 'thresholds.yaml');
    writeFileSync(target, 'attacker-content');
    symlinkSync(target, link);
    expect(() => safeReadFile(link)).toThrow(/symlink/i);
  });

  it('accepts a file with mode equal to requireMode', () => {
    const p = join(tmp, 'token');
    writeFileSync(p, 'abc', { mode: 0o600 });
    expect(safeReadFile(p, { requireMode: 0o600 })).toBe('abc');
  });

  it('accepts a file with permissions stricter than requireMode', () => {
    const p = join(tmp, 'stricter');
    writeFileSync(p, 'abc', { mode: 0o400 });
    expect(safeReadFile(p, { requireMode: 0o600 })).toBe('abc');
  });

  it('refuses a world-readable file when requireMode is 0o600', () => {
    if (process.platform === 'win32') return; // file modes are not enforced on Windows
    const p = join(tmp, 'leaky');
    writeFileSync(p, 'abc');
    chmodSync(p, 0o644);
    expect(() => safeReadFile(p, { requireMode: 0o600 })).toThrow(/overly-permissive/);
  });

  it('propagates ENOENT through statSync when requireMode is set and the file is missing', () => {
    expect(() => safeReadFile(join(tmp, 'gone'), { requireMode: 0o600 })).toThrow(/ENOENT/);
  });
});

describe('safeOpenAppend', () => {
  it('opens a new file for append with the requested mode', () => {
    if (process.platform === 'win32') return;
    const p = join(tmp, 'log.txt');
    const fd = safeOpenAppend(p, { mode: 0o600, dirMode: 0o700 });
    closeSync(fd);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('refuses to open through a pre-existing symlink', () => {
    const target = join(tmp, 'evil.txt');
    const link = join(tmp, 'log.txt');
    writeFileSync(target, '');
    symlinkSync(target, link);
    expect(() => safeOpenAppend(link, { mode: 0o600 })).toThrow(/symlink/i);
  });

  it('creates the parent directory if missing', () => {
    const p = join(tmp, 'a', 'b', 'log.txt');
    const fd = safeOpenAppend(p, { mode: 0o600, dirMode: 0o700 });
    closeSync(fd);
    expect(statSync(p).isFile()).toBe(true);
  });

  it('leaves an existing regular file in place', () => {
    const p = join(tmp, 'log.txt');
    const dir = tmp;
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, 'pre-existing\n', { mode: 0o600 });
    const fd = safeOpenAppend(p, { mode: 0o600 });
    closeSync(fd);
    expect(readFileSync(p, 'utf8')).toBe('pre-existing\n');
  });

  it('tightens the mode of a pre-existing world-readable log file', () => {
    if (process.platform === 'win32') return;
    const p = join(tmp, 'preexisting.log');
    writeFileSync(p, 'header\n');
    chmodSync(p, 0o644);
    expect(statSync(p).mode & 0o777).toBe(0o644);
    const fd = safeOpenAppend(p, { mode: 0o600 });
    closeSync(fd);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
