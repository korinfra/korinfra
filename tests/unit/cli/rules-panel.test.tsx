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
  useTerminalSize: () => ({ cols: 140, rows: 200 }),
}));

import { RulesCommand } from '../../../src/cli/commands/rules.js';
import { ruleRegistry } from '../../../src/rules/registry.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('RulesCommand TUI panel', () => {
  it('renders the panel chrome and at least one rule entry', async () => {
    const onBack = vi.fn();
    const { lastFrame, unmount } = render(
      <RulesCommand args={[]} onBack={onBack} onAction={vi.fn()} />,
    );

    await wait(120);
    const frame = lastFrame() ?? '';

    // Header / chrome from CommandHeader
    expect(frame).toContain('rules');
    expect(frame).toContain('built-in cost optimization rules');
    // Summary in the scope line shows rule count and category count
    expect(frame).toContain(`${ruleRegistry.length} rules`);
    expect(frame).toContain('11 categories');
    // Footer hint pointing CI/CD users to the headless command
    expect(frame).toContain('korinfra rules list --json');
    // The component renders impact labels — verify at least one is shown
    expect(frame).toMatch(/\[(?:high|medium|low)\]/);

    unmount();
  });

  it('does not crash on an absent onBack handler', async () => {
    const { lastFrame, unmount } = render(
      <RulesCommand args={[]} onBack={undefined} onAction={vi.fn()} />,
    );

    await wait(120);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('rules');
    expect(frame).toContain('built-in cost optimization rules');

    unmount();
  });
});
