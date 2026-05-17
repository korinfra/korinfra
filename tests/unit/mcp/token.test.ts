/**
 * Tests for src/mcp/token.ts — persistence, version counter, legacy migration, revocation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

import {
  getTokenFilePath,
  getTokenFileMtimeMs,
  isValidToken,
  readPersistedTokenData,
  persistTokenData,
  revokeToken,
  checkTokenFilePermissions,
} from '../../../src/mcp/token.js';

const VALID_TOKEN_64 = 'a'.repeat(64); // 64 hex-valid chars

describe('isValidToken', () => {
  it('accepts 32-char hex string', () => {
    expect(isValidToken('a'.repeat(32))).toBe(true);
  });
  it('accepts 64-char hex string', () => {
    expect(isValidToken(VALID_TOKEN_64)).toBe(true);
  });
  it('accepts base64 characters', () => {
    expect(isValidToken('AAAA+/==BBBB+/==CCCC+/==DDDD+/==')).toBe(true);
  });
  it('rejects tokens shorter than 32 chars', () => {
    expect(isValidToken('a'.repeat(31))).toBe(false);
  });
  it('rejects tokens with disallowed characters', () => {
    expect(isValidToken('!'.repeat(32))).toBe(false);
    expect(isValidToken('Z'.repeat(32))).toBe(false);
  });
});

describe('readPersistedTokenData', () => {
  let readSpy: ReturnType<typeof vi.spyOn>;
  let unlinkSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    readSpy = vi.spyOn(fs, 'readFileSync');
    unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
    writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    // Suppress filesystem side effects of the migration write in legacy-string path.
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads JSON format with version', () => {
    readSpy.mockReturnValue(JSON.stringify({ token: VALID_TOKEN_64, version: 3 }));
    const result = readPersistedTokenData();
    expect(result).toEqual({ token: VALID_TOKEN_64, version: 3 });
    expect(unlinkSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('migrates legacy plain-string token to JSON v1', () => {
    readSpy.mockReturnValue(VALID_TOKEN_64);
    const result = readPersistedTokenData();
    expect(result).toEqual({ token: VALID_TOKEN_64, version: 1 });
    expect(writeSpy).toHaveBeenCalledOnce();
    const writtenContent = String(writeSpy.mock.calls[0]?.[1]);
    const parsed = JSON.parse(writtenContent) as { token: string; version: number };
    expect(parsed).toEqual({ token: VALID_TOKEN_64, version: 1 });
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('still returns the token even if migration write fails (best-effort migration)', () => {
    readSpy.mockReturnValue(VALID_TOKEN_64);
    writeSpy.mockImplementation(() => { throw new Error('disk full'); });
    const result = readPersistedTokenData();
    expect(result).toEqual({ token: VALID_TOKEN_64, version: 1 });
  });

  it('returns null and deletes file on corrupt JSON', () => {
    readSpy.mockReturnValue('{not valid json');
    const result = readPersistedTokenData();
    expect(result).toBeNull();
    expect(unlinkSpy).toHaveBeenCalledWith(getTokenFilePath());
  });

  it('returns null and deletes file when token field is missing', () => {
    readSpy.mockReturnValue(JSON.stringify({ version: 1 }));
    const result = readPersistedTokenData();
    expect(result).toBeNull();
    expect(unlinkSpy).toHaveBeenCalled();
  });

  it('returns null and deletes file when version field is missing', () => {
    readSpy.mockReturnValue(JSON.stringify({ token: VALID_TOKEN_64 }));
    const result = readPersistedTokenData();
    expect(result).toBeNull();
    expect(unlinkSpy).toHaveBeenCalled();
  });

  it('returns null and deletes file when token is too short', () => {
    readSpy.mockReturnValue(JSON.stringify({ token: 'short', version: 1 }));
    const result = readPersistedTokenData();
    expect(result).toBeNull();
    expect(unlinkSpy).toHaveBeenCalled();
  });

  it('returns null and deletes file when version is zero', () => {
    readSpy.mockReturnValue(JSON.stringify({ token: VALID_TOKEN_64, version: 0 }));
    const result = readPersistedTokenData();
    expect(result).toBeNull();
    expect(unlinkSpy).toHaveBeenCalled();
  });

  it('returns null and deletes file when version is non-integer', () => {
    readSpy.mockReturnValue(JSON.stringify({ token: VALID_TOKEN_64, version: 1.5 }));
    const result = readPersistedTokenData();
    expect(result).toBeNull();
    expect(unlinkSpy).toHaveBeenCalled();
  });

  it('returns null and deletes file on legacy string with invalid format', () => {
    readSpy.mockReturnValue('not-a-valid-token');
    const result = readPersistedTokenData();
    expect(result).toBeNull();
    expect(unlinkSpy).toHaveBeenCalled();
  });

  it('returns null without throwing when file does not exist', () => {
    readSpy.mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(readPersistedTokenData()).toBeNull();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });
});

describe('persistTokenData (atomic write)', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSpy: ReturnType<typeof vi.spyOn>;
  let chmodSpy: ReturnType<typeof vi.spyOn>;
  let renameSpy: ReturnType<typeof vi.spyOn>;
  let unlinkSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    chmodSpy = vi.spyOn(fs, 'chmodSync').mockImplementation(() => undefined);
    renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);
    unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes to a sibling .tmp file then renames into place (atomic write)', () => {
    persistTokenData(VALID_TOKEN_64, 7);

    expect(mkdirSpy).toHaveBeenCalledWith(expect.any(String), { recursive: true, mode: 0o700 });

    // Write goes to a sibling .tmp-... path, NOT the final path.
    expect(writeSpy).toHaveBeenCalledOnce();
    const writtenPath = String(writeSpy.mock.calls[0]?.[0]);
    expect(writtenPath).toMatch(new RegExp(`^${getTokenFilePath()}\\.tmp-\\d+-\\d+-[0-9a-f]+$`));
    expect(writeSpy.mock.calls[0]?.[1]).toBe(JSON.stringify({ token: VALID_TOKEN_64, version: 7 }));
    expect(writeSpy.mock.calls[0]?.[2]).toEqual({ mode: 0o600, encoding: 'utf8' });

    // Rename targets the final path.
    expect(renameSpy).toHaveBeenCalledOnce();
    expect(renameSpy).toHaveBeenCalledWith(writtenPath, getTokenFilePath());

    if (process.platform !== 'win32') {
      expect(chmodSpy).toHaveBeenCalledWith(writtenPath, 0o600);
    }
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('cleans up the .tmp file when rename fails and re-throws', () => {
    renameSpy.mockImplementation(() => { throw new Error('EACCES: rename denied'); });
    expect(() => persistTokenData(VALID_TOKEN_64, 1)).toThrow(/rename denied/);
    expect(unlinkSpy).toHaveBeenCalledOnce();
    // The tmp file should be the one that was being renamed.
    const renamedTmpPath = String(renameSpy.mock.calls[0]?.[0]);
    expect(unlinkSpy).toHaveBeenCalledWith(renamedTmpPath);
  });

  it('cleans up and re-throws when the temp write itself fails', () => {
    writeSpy.mockImplementation(() => { throw new Error('ENOSPC: no space'); });
    expect(() => persistTokenData(VALID_TOKEN_64, 1)).toThrow(/no space/);
    expect(renameSpy).not.toHaveBeenCalled();
    // Cleanup is best-effort — unlink may still be called on the path even if
    // it was never created. Just confirm rename was skipped.
  });
});

describe('checkTokenFilePermissions', () => {
  let statSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let platformSpy: ReturnType<typeof vi.spyOn> | null = null;
  const originalPlatform = process.platform;

  beforeEach(() => {
    statSpy = vi.spyOn(fs, 'statSync');
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (platformSpy) {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      platformSpy = null;
    }
  });

  it('warns when token file is world-readable (mode 0644)', () => {
    if (process.platform === 'win32') return;
    statSpy.mockReturnValue({ mode: 0o100644 } as unknown as fs.Stats);
    checkTokenFilePermissions();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('mode 644 (expected 600)'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('chmod 600'));
  });

  it('warns when token file is group-readable (mode 0640)', () => {
    if (process.platform === 'win32') return;
    statSpy.mockReturnValue({ mode: 0o100640 } as unknown as fs.Stats);
    checkTokenFilePermissions();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('mode 640'));
  });

  it('stays silent when token file has correct 0600 mode', () => {
    if (process.platform === 'win32') return;
    statSpy.mockReturnValue({ mode: 0o100600 } as unknown as fs.Stats);
    checkTokenFilePermissions();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('stays silent when token file is missing', () => {
    if (process.platform === 'win32') return;
    statSpy.mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    checkTokenFilePermissions();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('skips entirely on win32 (mode bits are not meaningful)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    platformSpy = {} as ReturnType<typeof vi.spyOn>; // sentinel so afterEach restores
    checkTokenFilePermissions();
    expect(statSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('getTokenFileMtimeMs', () => {
  let statSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    statSpy = vi.spyOn(fs, 'statSync');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns mtimeMs when the file exists', () => {
    statSpy.mockReturnValue({ mtimeMs: 12_345_678 } as unknown as fs.Stats);
    expect(getTokenFileMtimeMs()).toBe(12_345_678);
  });

  it('returns 0 when the file does not exist', () => {
    statSpy.mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(getTokenFileMtimeMs()).toBe(0);
  });

  it('returns 0 on any other stat error (does not throw)', () => {
    statSpy.mockImplementation(() => { throw new Error('EACCES'); });
    expect(getTokenFileMtimeMs()).toBe(0);
  });
});

describe('revokeToken', () => {
  let readSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    readSpy = vi.spyOn(fs, 'readFileSync');
    writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts version at 1 when no prior token file exists', () => {
    readSpy.mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    const result = revokeToken();
    expect(result.version).toBe(1);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(writeSpy).toHaveBeenCalled();
    const writtenPayload = JSON.parse(String(writeSpy.mock.calls[0]?.[1])) as { token: string; version: number };
    expect(writtenPayload.version).toBe(1);
    expect(writtenPayload.token).toBe(result.token);
  });

  it('increments existing version by 1', () => {
    readSpy.mockReturnValue(JSON.stringify({ token: VALID_TOKEN_64, version: 5 }));
    const result = revokeToken();
    expect(result.version).toBe(6);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.token).not.toBe(VALID_TOKEN_64);
  });

  it('starts version at 2 when migrating from legacy plain-string', () => {
    // Legacy file → migration auto-bumps to v1 during readPersistedTokenData,
    // then revoke increments to v2.
    readSpy.mockReturnValue(VALID_TOKEN_64);
    const result = revokeToken();
    expect(result.version).toBe(2);
  });

  it('throws on persistence failure (CLI must surface error to user)', () => {
    readSpy.mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    writeSpy.mockImplementation(() => { throw new Error('EACCES: permission denied'); });
    expect(() => revokeToken()).toThrow(/permission denied/);
  });
});
