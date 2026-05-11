import { spawnSync } from 'node:child_process';

export interface ClipboardResult {
  ok: boolean;
  error?: Error | undefined;
}

export function copyToClipboard(text: string): ClipboardResult {
  const candidates: Array<[string, string[]]> = process.platform === 'win32'
    ? [
        ['clip', []],
        ['powershell.exe', ['-NoProfile', '-Command', 'Set-Clipboard']],
      ]
    : process.platform === 'darwin'
      ? [['pbcopy', []]]
      : [
          ['wl-copy', []],
          ['xclip', ['-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--input']],
        ];

  let lastError: Error | undefined;
  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, {
      input: text,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 3000,
      windowsHide: true,
    });
    if (result.error === undefined && result.status === 0) return { ok: true };
    lastError = result.error ?? new Error(`${command} exited with status ${result.status ?? '?'}`);
  }

  if (process.platform === 'linux') {
    return { ok: false, error: new Error('Clipboard unavailable. Install wl-clipboard, xclip, or xsel.') };
  }
  return { ok: false, error: lastError };
}
