/**
 * G-3: Command palette is reachable from any non-editing screen.
 *
 * Tests the `isTextInputActive` predicate logic that gates the palette,
 * and renders NavHints to verify the `:` command hint appears.
 *
 * Finding 98: command-screen `InputMode` is now included in the predicate so
 * that `:` cannot fire while a command screen has a local text input focused.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';

// Re-implement the predicate from app.tsx to test it in isolation.
type MenuMode = 'select' | 'type' | 'command' | 'search';
type InputMode = 'none' | 'menu-search' | 'ask-ai' | 'command-palette' | 'field' | 'secret' | 'modal';
type ViewKind =
  | 'menu' | 'version' | 'help' | 'scan' | 'costs' | 'resources'
  | 'recommend' | 'fix' | 'report' | 'history' | 'tags' | 'security'
  | 'init' | 'doctor' | 'config' | 'pricing' | 'mcp-install'
  | 'unknown' | 'prompt';

function isTextInputActive(viewKind: ViewKind, menuMode: MenuMode, inputMode: InputMode): boolean {
  return viewKind === 'version' || viewKind === 'help' || menuMode !== 'select' || inputMode !== 'none';
}

describe('Command palette predicate (G-3)', () => {
  it('returns false for result screens with select mode and no inputMode — palette should be available', () => {
    const resultScreens: ViewKind[] = ['scan', 'costs', 'resources', 'report', 'history', 'recommend', 'doctor', 'pricing'];
    for (const kind of resultScreens) {
      expect(isTextInputActive(kind, 'select', 'none')).toBe(false);
    }
  });

  it('returns true for version and help views — palette blocked', () => {
    expect(isTextInputActive('version', 'select', 'none')).toBe(true);
    expect(isTextInputActive('help', 'select', 'none')).toBe(true);
  });

  it('returns true when menuMode is type/command/search — user is typing', () => {
    const typingModes: MenuMode[] = ['type', 'command', 'search'];
    for (const mode of typingModes) {
      expect(isTextInputActive('menu', mode, 'none')).toBe(true);
    }
  });

  it('returns false for menu in select mode — palette available from main menu', () => {
    expect(isTextInputActive('menu', 'select', 'none')).toBe(false);
  });

  it('returns true when inputMode is field — command screen has a local text input focused', () => {
    // Finding 98: `:` must not fire while a command-screen text input is active
    const commandScreens: ViewKind[] = ['scan', 'costs', 'config', 'report', 'init'];
    for (const kind of commandScreens) {
      expect(isTextInputActive(kind, 'select', 'field')).toBe(true);
    }
  });

  it('returns true when inputMode is modal — modal is open', () => {
    expect(isTextInputActive('scan', 'select', 'modal')).toBe(true);
  });

  it('palette eligibility: eligible when predicate is false and overlays closed', () => {
    const showPalette = false;
    const showHelp = false;
    const viewKind: ViewKind = 'scan';
    const menuMode: MenuMode = 'select';
    const inputMode: InputMode = 'none';

    const eligible = !showPalette && !showHelp && !isTextInputActive(viewKind, menuMode, inputMode);
    expect(eligible).toBe(true);
  });

  it('palette eligibility: not eligible when palette already open', () => {
    const showPalette = true;
    const viewKind: ViewKind = 'scan';
    const menuMode: MenuMode = 'select';
    const inputMode: InputMode = 'none';

    const eligible = !showPalette && !isTextInputActive(viewKind, menuMode, inputMode);
    expect(eligible).toBe(false);
  });

  it('palette eligibility: not eligible when command screen reports field inputMode', () => {
    const showPalette = false;
    const showHelp = false;
    const viewKind: ViewKind = 'config';
    const menuMode: MenuMode = 'select';
    const inputMode: InputMode = 'field';

    const eligible = !showPalette && !showHelp && !isTextInputActive(viewKind, menuMode, inputMode);
    expect(eligible).toBe(false);
  });
});

describe('InteractionHints renders : command hint (G-3 render)', () => {
  it('InteractionHints with : command hint renders the colon key', async () => {
    const { InteractionHints } = await import('../../../src/cli/components/InteractionHints.js');

    const { lastFrame, unmount } = render(
      React.createElement(InteractionHints, {
        hints: [
          { key: ':', label: 'command' },
          { key: 'q', label: 'quit' },
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain(':');
    expect(frame).toContain('command');
    expect(frame).toContain('q');
    expect(frame).toContain('quit');
    unmount();
  });

  it('buildInteractionHints always includes : command hint', async () => {
    const { buildInteractionHints } = await import('../../../src/cli/components/InteractionHints.js');
    const hints = buildInteractionHints({});
    const colonHint = hints.find((h) => h.key === ':');
    expect(colonHint).toBeDefined();
    expect(colonHint?.label).toBe('command');
  });

  it('buildInteractionHints uses ? for the help hint (matches RESERVED_KEYS.help.label)', async () => {
    const { buildInteractionHints } = await import('../../../src/cli/components/InteractionHints.js');
    const hints = buildInteractionHints({});
    const helpHint = hints.find((h) => h.label === 'help');
    expect(helpHint).toBeDefined();
    // Must display ? — matches RESERVED_KEYS.help.label and the global ? handler in app.tsx
    expect(helpHint?.key).toBe('?');
  });

  it('buildInteractionHints does NOT include r run again (X-1 rule)', async () => {
    const { buildInteractionHints } = await import('../../../src/cli/components/InteractionHints.js');
    const hints = buildInteractionHints({ onBack: () => {} });
    const runAgainHint = hints.find((h) => h.key === 'r');
    expect(runAgainHint).toBeUndefined();
  });
});
