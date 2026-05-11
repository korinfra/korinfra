import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const logPath = path.join(os.homedir(), '.korinfra', 'debug.log');
let logFd: number | null = null;

export function tuiLog(message: string): void {
  if (process.env['KORINFRA_TUI'] === '1') {
    try {
      if (logFd === null) {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        const openFlags = process.platform !== 'win32' ? 0o600 : undefined;
        logFd = openFlags !== undefined
          ? fs.openSync(logPath, 'a', openFlags)
          : fs.openSync(logPath, 'a');
      }
      fs.writeSync(logFd, `[${new Date().toISOString()}] ${message}\n`);
    } catch { /* silent */ }
  } else {
    process.stderr.write(message + '\n');
  }
}
