import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writekorinfraConfig } from '../../../src/cli/commands/init-core.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'korinfra-init-'));
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * Opens `p` and returns the mode plus the content read from the same fd, so
 * the two observations cannot disagree if the file is swapped at the path.
 * Mirrors the openSync+fstatSync+readFileSync(fd) pattern used in safeReadFile.
 */
function inspectFile(p: string): { mode: number; content: string } {
  const fd = openSync(p, 'r');
  try {
    return {
      mode: fstatSync(fd).mode & 0o777,
      content: readFileSync(fd, 'utf8'),
    };
  } finally {
    closeSync(fd);
  }
}

describe('writekorinfraConfig — file safety on the .env secret', () => {
  it('writes .korinfra/.env with mode 0o600 when an API key is provided', async () => {
    if (process.platform === 'win32') return;
    await writekorinfraConfig({
      profile: 'default',
      aiProvider: 'anthropic',
      aiKey: 'sk-ant-api-test-1234567890abcdef',
      cwd: tmp,
    });
    const { mode, content } = inspectFile(join(tmp, '.korinfra', '.env'));
    expect(mode).toBe(0o600);
    expect(content).toContain('ANTHROPIC_API_KEY=');
  });

  it('creates .korinfra/ with mode 0o700 so the .env secret is not exposed', async () => {
    if (process.platform === 'win32') return;
    await writekorinfraConfig({
      profile: 'default',
      aiProvider: 'anthropic',
      aiKey: 'sk-ant-api-test-1234567890abcdef',
      cwd: tmp,
    });
    const fd = openSync(join(tmp, '.korinfra'), 'r');
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o700);
    } finally {
      closeSync(fd);
    }
  });

  it('tightens a pre-existing world-readable .env down to 0o600', async () => {
    if (process.platform === 'win32') return;
    // Simulate a previously-leaky .env left from an older run.
    const korinfraDir = join(tmp, '.korinfra');
    mkdirSync(korinfraDir, { recursive: true });
    const envPath = join(korinfraDir, '.env');
    writeFileSync(envPath, '# old\n');
    chmodSync(envPath, 0o644); // not subject to umask

    await writekorinfraConfig({
      profile: 'default',
      aiProvider: 'anthropic',
      aiKey: 'sk-ant-api-test-1234567890abcdef',
      cwd: tmp,
    });
    expect(inspectFile(join(korinfraDir, '.env')).mode).toBe(0o600);
  });

  it('refuses to write through a pre-existing symlink at .korinfra/.env', async () => {
    if (process.platform === 'win32') return;
    const korinfraDir = join(tmp, '.korinfra');
    mkdirSync(korinfraDir, { recursive: true });
    const decoyTarget = join(tmp, 'attacker-readable.txt');
    writeFileSync(decoyTarget, 'original');
    chmodSync(decoyTarget, 0o644);
    symlinkSync(decoyTarget, join(korinfraDir, '.env'));

    await expect(
      writekorinfraConfig({
        profile: 'default',
        aiProvider: 'anthropic',
        aiKey: 'sk-ant-api-test-1234567890abcdef',
        cwd: tmp,
      }),
    ).rejects.toThrow(/symlink/i);

    // The attacker-controlled file at the symlink target must be untouched.
    expect(readFileSync(decoyTarget, 'utf8')).toBe('original');
  });
});
