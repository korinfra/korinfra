import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

vi.mock('../../../src/cli/hooks/useConfig.js', () => ({
  useConfig: () => ({
    config: {
      ai: {
        provider: 'none',
        model: 'test',
        api_key_env: 'ANTHROPIC_API_KEY',
      },
    },
    error: null,
    isLoading: false,
    reload: vi.fn(),
  }),
}));

vi.mock('../../../src/cli/hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ cols: 120, rows: 40 }),
}));

import { App } from '../../../src/cli/App.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('App unknown command screen', () => {
  it('renders unknown command inside shell with suggestion', async () => {
    const { lastFrame, unmount } = render(
      <App args={['scna']} provider={null} />,
    );

    await wait(120);
    const frame = lastFrame() ?? '';

    expect(frame.toLowerCase()).toContain('unknown command');
    expect(frame).toContain('scna');
    expect(frame).toContain('Did you mean "scan"?');

    unmount();
  });
});
