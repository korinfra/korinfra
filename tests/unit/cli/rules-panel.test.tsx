import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

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
    const categoryCount = new Set(ruleRegistry.map((r) => r.category)).size;
    expect(frame).toContain(`${categoryCount} categories`);
    // Footer hint pointing CI/CD users to the headless command
    expect(frame).toContain('korinfra rules list --json');
    // The component renders impact labels via SEVERITY_LABELS — verify at least one is shown
    expect(frame).toMatch(/\[(?:HIGH|MEDIUM|LOW)\]/);

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
