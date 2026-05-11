/**
 * Tests for src/cli/ui/terminal.ts — capability detection.
 *
 * Each test group stubs env/platform, resets the module cache, then
 * dynamically imports the real module so the frozen-at-load-time constants
 * are re-evaluated under controlled conditions.
 *
 * Pattern required because all exports are evaluated at import time:
 *   vi.stubEnv(...)            — set env before import
 *   vi.resetModules()          — clear module cache
 *   const { x } = await import('../../../src/cli/ui/terminal.js')
 *   expect(x).toBe(...)
 */

import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

// ─── Cleanup ──────────────────────────────────────────────────────────────────

let _origPlatform: PropertyDescriptor | undefined;
let _origIsTTY: PropertyDescriptor | undefined;

beforeEach(() => {
  _origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  _origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();

  // Restore process.platform
  if (_origPlatform) {
    Object.defineProperty(process, 'platform', _origPlatform);
  }
  // Restore process.stdout.isTTY
  if (_origIsTTY) {
    Object.defineProperty(process.stdout, 'isTTY', _origIsTTY);
  } else {
    // isTTY was not originally defined — delete our override
     
    delete (process.stdout as Record<string, unknown>)['isTTY'];
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stubPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, writable: true, configurable: true });
}

function stubIsTTY(value: boolean) {
  Object.defineProperty(process.stdout, 'isTTY', { value, writable: true, configurable: true });
}

async function loadTerminal() {
  vi.resetModules();
  return import('../../../src/cli/ui/terminal.js');
}

// ─── isWindows ────────────────────────────────────────────────────────────────

describe('isWindows', () => {
  it('is true on win32', async () => {
    stubPlatform('win32');
    const { isWindows } = await loadTerminal();
    expect(isWindows).toBe(true);
  });

  it('is false on linux', async () => {
    stubPlatform('linux');
    const { isWindows } = await loadTerminal();
    expect(isWindows).toBe(false);
  });

  it('is false on darwin', async () => {
    stubPlatform('darwin');
    const { isWindows } = await loadTerminal();
    expect(isWindows).toBe(false);
  });
});

// ─── isWsl ────────────────────────────────────────────────────────────────────

describe('isWsl — via WSLENV', () => {
  it('is true when WSLENV is set', async () => {
    stubPlatform('linux');
    vi.stubEnv('WSLENV', 'PATH/l');
    const { isWsl } = await loadTerminal();
    expect(isWsl).toBe(true);
  });

  it('is false when WSLENV is absent and /proc/version has no microsoft', async () => {
    stubPlatform('linux');
    // Ensure WSLENV is not set
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      readFileSync: (_path: string, _enc: string) => {
        if (_path === '/proc/version') return 'Linux version 5.15.0-generic #1 SMP';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    }));
    // delete WSLENV from env before importing
    const savedWslenv = process.env['WSLENV'];
    delete process.env['WSLENV'];
    try {
      const { isWsl } = await import('../../../src/cli/ui/terminal.js');
      expect(isWsl).toBe(false);
    } finally {
      if (savedWslenv !== undefined) process.env['WSLENV'] = savedWslenv;
    }
  });
});

describe('isWsl — via /proc/version', () => {
  it('is true when /proc/version contains "microsoft"', async () => {
    stubPlatform('linux');
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      readFileSync: (_path: string, _enc: string) => {
        if (_path === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    }));
    const savedWslenv = process.env['WSLENV'];
    delete process.env['WSLENV'];
    try {
      const { isWsl } = await import('../../../src/cli/ui/terminal.js');
      expect(isWsl).toBe(true);
    } finally {
      if (savedWslenv !== undefined) process.env['WSLENV'] = savedWslenv;
      vi.resetModules();
    }
  });

  it('is true when /proc/version contains "Microsoft" (case-insensitive)', async () => {
    stubPlatform('linux');
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      readFileSync: (_path: string, _enc: string) => {
        if (_path === '/proc/version') return 'Linux version 4.4.0-Microsoft #1-Microsoft';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    }));
    const savedWslenv = process.env['WSLENV'];
    delete process.env['WSLENV'];
    try {
      const { isWsl } = await import('../../../src/cli/ui/terminal.js');
      expect(isWsl).toBe(true);
    } finally {
      if (savedWslenv !== undefined) process.env['WSLENV'] = savedWslenv;
      vi.resetModules();
    }
  });
});

// ─── supportsColor ────────────────────────────────────────────────────────────

describe('supportsColor', () => {
  it('is true when NO_COLOR is not set and TERM is not dumb', async () => {
    stubPlatform('linux');
    vi.stubEnv('TERM', 'xterm-256color');
    // Ensure NO_COLOR absent
    delete process.env['NO_COLOR'];
    const { supportsColor } = await loadTerminal();
    expect(supportsColor).toBe(true);
  });

  it('is false when NO_COLOR is set', async () => {
    stubPlatform('linux');
    vi.stubEnv('NO_COLOR', '1');
    const { supportsColor } = await loadTerminal();
    expect(supportsColor).toBe(false);
  });

  it('is false when TERM=dumb', async () => {
    stubPlatform('linux');
    vi.stubEnv('TERM', 'dumb');
    delete process.env['NO_COLOR'];
    const { supportsColor } = await loadTerminal();
    expect(supportsColor).toBe(false);
  });
});

// ─── supportsUnicode ──────────────────────────────────────────────────────────

describe('supportsUnicode', () => {
  it('is false when KORINFRA_ASCII=1', async () => {
    stubPlatform('linux');
    vi.stubEnv('KORINFRA_ASCII', '1');
    const { supportsUnicode } = await loadTerminal();
    expect(supportsUnicode).toBe(false);
  });

  it('is false when KORINFRA_UNICODE=0', async () => {
    stubPlatform('linux');
    vi.stubEnv('KORINFRA_UNICODE', '0');
    const { supportsUnicode } = await loadTerminal();
    expect(supportsUnicode).toBe(false);
  });

  it('is false when TERM=dumb', async () => {
    stubPlatform('linux');
    vi.stubEnv('TERM', 'dumb');
    const { supportsUnicode } = await loadTerminal();
    expect(supportsUnicode).toBe(false);
  });

  it('is false on Windows without WT_SESSION or TERM_PROGRAM', async () => {
    stubPlatform('win32');
    delete process.env['WT_SESSION'];
    delete process.env['TERM_PROGRAM'];
    const { supportsUnicode } = await loadTerminal();
    expect(supportsUnicode).toBe(false);
  });

  it('is true on Windows when WT_SESSION is set', async () => {
    stubPlatform('win32');
    vi.stubEnv('WT_SESSION', 'some-session-id');
    const { supportsUnicode } = await loadTerminal();
    expect(supportsUnicode).toBe(true);
  });

  it('is true on Windows when TERM_PROGRAM is set', async () => {
    stubPlatform('win32');
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    delete process.env['WT_SESSION'];
    const { supportsUnicode } = await loadTerminal();
    expect(supportsUnicode).toBe(true);
  });

  it('is true on Linux with no restrictions', async () => {
    stubPlatform('linux');
    delete process.env['KORINFRA_ASCII'];
    delete process.env['KORINFRA_UNICODE'];
    vi.stubEnv('TERM', 'xterm-256color');
    const { supportsUnicode } = await loadTerminal();
    expect(supportsUnicode).toBe(true);
  });
});

// ─── supportsEmoji ────────────────────────────────────────────────────────────

describe('supportsEmoji', () => {
  it('is true on Linux with unicode support and no WSL', async () => {
    stubPlatform('linux');
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      readFileSync: (_path: string, _enc: string) => {
        if (_path === '/proc/version') return 'Linux version 6.8.0-generic #1 SMP';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    }));
    delete process.env['WSLENV'];
    delete process.env['KORINFRA_ASCII'];
    delete process.env['KORINFRA_UNICODE'];
    vi.stubEnv('TERM', 'xterm-256color');
    const { supportsEmoji } = await import('../../../src/cli/ui/terminal.js');
    expect(supportsEmoji).toBe(true);
  });

  it('is false on Windows', async () => {
    stubPlatform('win32');
    vi.stubEnv('WT_SESSION', 'some-session-id'); // unicode enabled, but still no emoji
    const { supportsEmoji } = await loadTerminal();
    expect(supportsEmoji).toBe(false);
  });

  it('is false on WSL (WSLENV set)', async () => {
    stubPlatform('linux');
    vi.stubEnv('WSLENV', 'PATH/l');
    const { supportsEmoji } = await loadTerminal();
    expect(supportsEmoji).toBe(false);
  });

  it('is false when unicode is disabled', async () => {
    stubPlatform('linux');
    delete process.env['WSLENV'];
    vi.stubEnv('KORINFRA_ASCII', '1');
    const { supportsEmoji } = await loadTerminal();
    expect(supportsEmoji).toBe(false);
  });
});

// ─── supportsMouse ────────────────────────────────────────────────────────────

describe('supportsMouse', () => {
  it('is true when TTY and no restrictions', async () => {
    stubPlatform('linux');
    stubIsTTY(true);
    delete process.env['KORINFRA_NO_MOUSE'];
    vi.stubEnv('TERM', 'xterm-256color');
    const { supportsMouse } = await loadTerminal();
    expect(supportsMouse).toBe(true);
  });

  it('is false when KORINFRA_NO_MOUSE=1', async () => {
    stubPlatform('linux');
    stubIsTTY(true);
    vi.stubEnv('KORINFRA_NO_MOUSE', '1');
    const { supportsMouse } = await loadTerminal();
    expect(supportsMouse).toBe(false);
  });

  it('is false when TERM=dumb', async () => {
    stubPlatform('linux');
    stubIsTTY(true);
    vi.stubEnv('TERM', 'dumb');
    const { supportsMouse } = await loadTerminal();
    expect(supportsMouse).toBe(false);
  });

  it('is false when not a TTY', async () => {
    stubPlatform('linux');
    stubIsTTY(false);
    delete process.env['KORINFRA_NO_MOUSE'];
    vi.stubEnv('TERM', 'xterm-256color');
    const { supportsMouse } = await loadTerminal();
    expect(supportsMouse).toBe(false);
  });
});

// ─── isCi ─────────────────────────────────────────────────────────────────────

describe('isCi', () => {
  it('is true when CI=1', async () => {
    stubPlatform('linux');
    vi.stubEnv('CI', '1');
    const { isCi } = await loadTerminal();
    expect(isCi).toBe(true);
  });

  it('is true when CI=true', async () => {
    stubPlatform('linux');
    vi.stubEnv('CI', 'true');
    const { isCi } = await loadTerminal();
    expect(isCi).toBe(true);
  });

  it('is true when GITHUB_ACTIONS is set', async () => {
    stubPlatform('linux');
    delete process.env['CI'];
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const { isCi } = await loadTerminal();
    expect(isCi).toBe(true);
  });

  it('is true when CIRCLECI is set', async () => {
    stubPlatform('linux');
    delete process.env['CI'];
    vi.stubEnv('CIRCLECI', 'true');
    const { isCi } = await loadTerminal();
    expect(isCi).toBe(true);
  });

  it('is true when TRAVIS is set', async () => {
    stubPlatform('linux');
    delete process.env['CI'];
    vi.stubEnv('TRAVIS', 'true');
    const { isCi } = await loadTerminal();
    expect(isCi).toBe(true);
  });

  it('is false when no CI env is set', async () => {
    stubPlatform('linux');
    delete process.env['CI'];
    delete process.env['GITHUB_ACTIONS'];
    delete process.env['CIRCLECI'];
    delete process.env['TRAVIS'];
    const { isCi } = await loadTerminal();
    expect(isCi).toBe(false);
  });
});

// ─── isDumb ───────────────────────────────────────────────────────────────────

describe('isDumb', () => {
  it('is true when TERM=dumb', async () => {
    stubPlatform('linux');
    vi.stubEnv('TERM', 'dumb');
    const { isDumb } = await loadTerminal();
    expect(isDumb).toBe(true);
  });

  it('is false when TERM is not dumb', async () => {
    stubPlatform('linux');
    vi.stubEnv('TERM', 'xterm-256color');
    const { isDumb } = await loadTerminal();
    expect(isDumb).toBe(false);
  });
});

// ─── terminal bundle ──────────────────────────────────────────────────────────

describe('terminal bundle', () => {
  it('contains all expected keys', async () => {
    stubPlatform('linux');
    const { terminal } = await loadTerminal();
    expect(terminal).toHaveProperty('platform');
    expect(terminal).toHaveProperty('isWindows');
    expect(terminal).toHaveProperty('isWsl');
    expect(terminal).toHaveProperty('supportsColor');
    expect(terminal).toHaveProperty('supportsUnicode');
    expect(terminal).toHaveProperty('supportsEmoji');
    expect(terminal).toHaveProperty('supportsMouse');
    expect(terminal).toHaveProperty('isCi');
    expect(terminal).toHaveProperty('isDumb');
  });

  it('bundle values match individual exports', async () => {
    stubPlatform('linux');
    stubIsTTY(true);
    vi.stubEnv('TERM', 'xterm-256color');
    delete process.env['NO_COLOR'];
    delete process.env['WSLENV'];
    delete process.env['KORINFRA_ASCII'];
    delete process.env['KORINFRA_UNICODE'];
    delete process.env['KORINFRA_NO_MOUSE'];
    delete process.env['CI'];
    delete process.env['GITHUB_ACTIONS'];
    delete process.env['CIRCLECI'];
    delete process.env['TRAVIS'];
    const mod = await loadTerminal();
    expect(mod.terminal.isWindows).toBe(mod.isWindows);
    expect(mod.terminal.isWsl).toBe(mod.isWsl);
    expect(mod.terminal.supportsColor).toBe(mod.supportsColor);
    expect(mod.terminal.supportsUnicode).toBe(mod.supportsUnicode);
    expect(mod.terminal.supportsEmoji).toBe(mod.supportsEmoji);
    expect(mod.terminal.supportsMouse).toBe(mod.supportsMouse);
    expect(mod.terminal.isCi).toBe(mod.isCi);
    expect(mod.terminal.isDumb).toBe(mod.isDumb);
  });

  it('platform field reflects current platform', async () => {
    stubPlatform('darwin');
    const { terminal } = await loadTerminal();
    expect(terminal.platform).toBe('darwin');
  });
});
