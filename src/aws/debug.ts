/**
 * Real-time per-operation debug logging for diagnosing slow or hung scans.
 *
 * Enabled only when KORINFRA_DEBUG=1 is set. When active, writes two files
 * to ~/.korinfra/debug/:
 *
 *   korinfra-debug.log   — timestamped trace of every AWS API call (tail live):
 *     macOS/Linux:  tail -f ~/.korinfra/debug/korinfra-debug.log
 *     Windows:      Get-Content ~/.korinfra/debug/korinfra-debug.log -Wait -Tail 40
 *
 *   korinfra-timing.json — per-service summary sorted by slowest service,
 *                           written after the scan completes.
 *
 * Usage: KORINFRA_DEBUG=1 korinfra scan
 */
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DBG_DIR = join(homedir(), '.korinfra', 'debug');
const DBG_FILE = join(DBG_DIR, 'korinfra-debug.log');
export const TIMING_FILE = join(DBG_DIR, 'korinfra-timing.json');
const ENABLED = process.env['KORINFRA_DEBUG'] === '1';

export function dbgInit(): void {
  if (!ENABLED) return;
  try {
    mkdirSync(DBG_DIR, { recursive: true });
    writeFileSync(DBG_FILE, `=== scan start ${new Date().toISOString()} ===\n`);
  } catch { /* non-fatal */ }
}

export function dbg(msg: string): void {
  if (!ENABLED) return;
  try {
    appendFileSync(DBG_FILE, `[${new Date().toISOString().slice(11, 23)}] ${msg}\n`);
  } catch { /* non-fatal */ }
}
