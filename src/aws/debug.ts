/**
 * Real-time per-operation debug logging for diagnosing slow or hung scans.
 * Enabled only when KORINFRA_DEBUG=1. Writes to ~/.korinfra/debug/.
 * Usage: KORINFRA_DEBUG=1 korinfra scan
 */
import { closeSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeOpenAppend, safeWriteFile } from '../utils/safe-fs.js';

export const DBG_DIR = join(homedir(), '.korinfra', 'debug');
const DBG_FILE = join(DBG_DIR, 'korinfra-debug.log');
export const TIMING_FILE = join(DBG_DIR, 'korinfra-timing.json');
const ENABLED = process.env['KORINFRA_DEBUG'] === '1';

let dbgFd: number | null = null;

function closeDbgFd(): void {
  if (dbgFd === null) return;
  try { closeSync(dbgFd); } catch { /* ignore */ }
  dbgFd = null;
}

function ensureDbgOpen(): void {
  if (dbgFd !== null) return;
  try {
    dbgFd = safeOpenAppend(DBG_FILE, { mode: 0o600, dirMode: 0o700 });
  } catch { /* non-fatal */ }
}

export function dbgInit(): void {
  if (!ENABLED) return;
  closeDbgFd();
  try {
    safeWriteFile(DBG_FILE, `=== scan start ${new Date().toISOString()} ===\n`, { mode: 0o600, dirMode: 0o700 });
    ensureDbgOpen();
  } catch { /* non-fatal */ }
}

export function dbg(msg: string): void {
  if (!ENABLED) return;
  if (dbgFd === null) ensureDbgOpen();
  if (dbgFd === null) return;
  try {
    writeSync(dbgFd, `[${new Date().toISOString().slice(11, 23)}] ${msg}\n`);
  } catch { /* non-fatal */ }
}
