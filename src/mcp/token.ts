/**
 * Persisted MCP auth token storage at ~/.korinfra/mcp-token.
 * Format: JSON `{ "token": "<≥32 hex or base64 chars>", "version": <int> }`.
 * Tokens we generate are 64-char hex; `isValidToken` also accepts base64 so
 * operator-supplied MCP_AUTH_TOKEN values can use the same validator.
 * Legacy plain-string files are migrated to JSON v1 on first read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface TokenData {
  token: string;
  version: number;
}

export function getTokenFilePath(): string {
  return path.join(os.homedir(), '.korinfra', 'mcp-token');
}

export function getTokenFileMtimeMs(): number {
  try {
    return fs.statSync(getTokenFilePath()).mtimeMs;
  } catch {
    return 0;
  }
}

export function checkTokenFilePermissions(): void {
  if (process.platform === 'win32') return;
  const filePath = getTokenFilePath();
  let mode: number;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch {
    return;
  }
  if (mode !== 0o600) {
    process.stderr.write(
      `[korinfra] WARNING: ${filePath} has mode ${mode.toString(8).padStart(3, '0')} (expected 600).\n` +
      `[korinfra]          Restore with: chmod 600 ${filePath}\n`,
    );
  }
}

export function isValidToken(token: string): boolean {
  if (token.length < 32) return false;
  return /^[0-9a-fA-F+/=]+$/.test(token);
}

function deleteFileSafely(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export function persistTokenData(token: string, version: number): void {
  const filePath = getTokenFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ token, version });

  // Write-then-rename so a concurrent reader never observes a partial file.
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, payload, { mode: 0o600, encoding: 'utf8' });
    if (process.platform !== 'win32') {
      fs.chmodSync(tmpPath, 0o600);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

export function readPersistedTokenData(): TokenData | null {
  const filePath = getTokenFilePath();
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }

  if (content.startsWith('{')) {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { token?: unknown }).token === 'string' &&
        typeof (parsed as { version?: unknown }).version === 'number'
      ) {
        const token = (parsed as { token: string }).token;
        const version = (parsed as { version: number }).version;
        if (isValidToken(token) && Number.isInteger(version) && version >= 1) {
          return { token, version };
        }
      }
    } catch { /* fallthrough → wipe */ }
    deleteFileSafely(filePath);
    return null;
  }

  // Legacy plain-string → migrate to JSON v1.
  if (isValidToken(content)) {
    try { persistTokenData(content, 1); } catch { /* migration is best-effort */ }
    return { token: content, version: 1 };
  }

  deleteFileSafely(filePath);
  return null;
}

/** Bumps the version and writes a fresh token. Throws on persistence failure. */
export function revokeToken(): TokenData {
  const existing = readPersistedTokenData();
  const newVersion = (existing?.version ?? 0) + 1;
  const newToken = randomBytes(32).toString('hex');
  persistTokenData(newToken, newVersion);
  return { token: newToken, version: newVersion };
}
