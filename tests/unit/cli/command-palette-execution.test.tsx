import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import { CommandPaletteOverlay } from '../../../src/cli/components/CommandPaletteOverlay.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('CommandPaletteOverlay execution', () => {
  it('executes currently highlighted command on Enter', async () => {
    const onCommandLine = vi.fn();
    const onClose = vi.fn();

    const { stdin, unmount } = render(
      <CommandPaletteOverlay onCommandLine={onCommandLine} onClose={onClose} />,
    );

    await wait(80);
    stdin.write('\r');
    await wait(80);

    // First visible command in registry order is scan.
    expect(onCommandLine).toHaveBeenCalledWith('scan');
    expect(onClose).not.toHaveBeenCalled();

    unmount();
  });

  it('executes filtered command when query narrows the list', async () => {
    const onCommandLine = vi.fn();

    const { stdin, unmount } = render(
      <CommandPaletteOverlay onCommandLine={onCommandLine} onClose={() => {}} />,
    );

    await wait(80);
    stdin.write('costs');
    await wait(80);
    stdin.write('\r');
    await wait(80);

    expect(onCommandLine).toHaveBeenCalledWith('costs');

    unmount();
  });
});
