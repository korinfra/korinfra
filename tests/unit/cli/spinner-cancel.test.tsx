/**
 * TS-1: ThinkingSpinner renders no `q cancel` by default.
 * The cancelHint prop must be explicitly provided.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';

import { ThinkingSpinner } from '../../../src/cli/components/ThinkingSpinner.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ThinkingSpinner (TS-1)', () => {
  it('renders label without cancel hint by default', async () => {
    const { lastFrame, unmount } = render(
      React.createElement(ThinkingSpinner, { label: 'Loading recommendations' }),
    );
    await wait(100);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Loading recommendations');
    // Default: no cancel hint
    expect(frame).not.toContain('q cancel');
    unmount();
  });

  it('renders explicit cancelHint when provided', async () => {
    const { lastFrame, unmount } = render(
      React.createElement(ThinkingSpinner, {
        label: 'Running agent',
        cancelHint: { key: 'Esc', label: 'cancel' },
      }),
    );
    await wait(100);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Running agent');
    expect(frame).toContain('Esc');
    expect(frame).toContain('cancel');
    unmount();
  });
});
