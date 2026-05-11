import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import { MainMenu } from '../../../src/cli/components/MainMenu.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TUI menu harness', () => {
  it('renders the setup-only menu and accepts Enter input', async () => {
    const onCommand = vi.fn();
    const onPrompt = vi.fn();

    const { lastFrame, stdin, unmount } = render(
      React.createElement(MainMenu, {
        isConfigured: false,
        onCommand,
        onPrompt,
      }),
    );

    await wait(250);
    expect(lastFrame()).toContain('Getting started');
    expect(lastFrame()).toContain('init');

    stdin.write('\r');
    await wait(50);

    expect(onCommand).toHaveBeenCalledWith('init');
    expect(onPrompt).not.toHaveBeenCalled();

    unmount();
  });
});
