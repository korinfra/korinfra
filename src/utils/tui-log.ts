import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { safeOpenAppend } from './safe-fs.js';

const logPath = path.join(os.homedir(), '.korinfra', 'debug.log');
let logFd: number | null = null;

export function tuiLog(message: string): void {
  if (process.env['KORINFRA_TUI'] === '1') {
    try {
      logFd ??= safeOpenAppend(logPath, { mode: 0o600, dirMode: 0o700 });
      fs.writeSync(logFd, `[${new Date().toISOString()}] ${message}\n`);
    } catch { /* silent */ }
  } else {
    process.stderr.write(message + '\n');
  }
}
