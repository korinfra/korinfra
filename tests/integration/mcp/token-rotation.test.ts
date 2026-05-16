/** Integration test for live token rotation against the real filesystem. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  persistTokenData,
  readPersistedTokenData,
  revokeToken,
  getTokenFilePath,
  getTokenFileMtimeMs,
} from '../../../src/mcp/token.js';

describe('token rotation — live disk integration', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env['HOME'];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'korinfra-token-test-'));
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
    else delete process.env['HOME'];
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes the file atomically with mode 0600 (no .tmp leftover)', () => {
    persistTokenData('a'.repeat(64), 1);

    const filePath = getTokenFilePath();
    expect(fs.existsSync(filePath)).toBe(true);

    // No .tmp leftover
    const dir = path.dirname(filePath);
    const entries = fs.readdirSync(dir);
    expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([]);

    if (process.platform !== 'win32') {
      const mode = fs.statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { token: string; version: number };
    expect(parsed).toEqual({ token: 'a'.repeat(64), version: 1 });
  });

  it('revokeToken bumps the version and the on-disk mtime', () => {
    const first = revokeToken();
    expect(first.version).toBe(1);

    // Force the prior mtime back by 2s so the next revoke's write is guaranteed
    // to produce a strictly different (newer) mtime, even on filesystems with
    // 1s mtime resolution.
    const filePath = getTokenFilePath();
    const past = new Date(Date.now() - 2000);
    fs.utimesSync(filePath, past, past);
    const mtimeAfterFirst = getTokenFileMtimeMs();

    const second = revokeToken();
    expect(second.version).toBe(2);
    expect(second.token).not.toBe(first.token);
    expect(getTokenFileMtimeMs()).toBeGreaterThan(mtimeAfterFirst);
  });

  it('readPersistedTokenData reflects the latest rotation immediately', () => {
    revokeToken();
    revokeToken();
    const third = revokeToken();
    const read = readPersistedTokenData();
    expect(read).toEqual({ token: third.token, version: 3 });
  });

  it('mtime advances on rotation → re-read picks up new token', () => {
    const initial = revokeToken();
    const filePath = getTokenFilePath();
    const past = new Date(Date.now() - 2000);
    fs.utimesSync(filePath, past, past);
    const initialMtime = getTokenFileMtimeMs();

    const rotated = revokeToken();
    expect(rotated.version).toBe(2);
    expect(getTokenFileMtimeMs()).toBeGreaterThan(initialMtime);

    const reloaded = readPersistedTokenData();
    expect(reloaded?.token).toBe(rotated.token);
    expect(reloaded?.token).not.toBe(initial.token);
  });

  it('returns mtime 0 when the file is missing (server keeps cached token)', () => {
    revokeToken();
    expect(getTokenFileMtimeMs()).toBeGreaterThan(0);
    fs.unlinkSync(getTokenFilePath());
    expect(getTokenFileMtimeMs()).toBe(0);
  });
});
