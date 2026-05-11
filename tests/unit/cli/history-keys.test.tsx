/**
 * HISTORY-3 / G-5: History list uses `p report selected`, not `r`.
 * `r` is reserved for run again / retry only.
 *
 * Also renders NavHints to verify r is absent from nav hint row.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';

// The RESERVED_KEYS contract
import { RESERVED_KEYS } from '../../../src/cli/ui/keys.js';

describe('History key contract (G-5 / HISTORY-3)', () => {
  it('RESERVED_KEYS.report primary alias is p', () => {
    expect(RESERVED_KEYS.report.aliases[0]).toBe('p');
  });

  it('RESERVED_KEYS.runAgain primary alias is r', () => {
    expect(RESERVED_KEYS.runAgain.aliases[0]).toBe('r');
  });

  it('report and runAgain are different keys', () => {
    expect(RESERVED_KEYS.report.aliases[0]).not.toBe(RESERVED_KEYS.runAgain.aliases[0]);
  });

  it('history list should use p for report (not r)', () => {
    const reportKey = RESERVED_KEYS.report.aliases[0];
    const runAgainKey = RESERVED_KEYS.runAgain.aliases[0];
    expect(reportKey).toBe('p');
    expect(runAgainKey).toBe('r');
  });
});

describe('InteractionHints X-1 rule: r not in nav hints', () => {
  it('buildInteractionHints does not include r', async () => {
    const { buildInteractionHints } = await import('../../../src/cli/components/InteractionHints.js');
    const hints = buildInteractionHints({ onBack: () => {} });
    // X-1: r (run again) must not appear in InteractionHints
    const rHint = hints.find((h) => h.key === 'r');
    expect(rHint).toBeUndefined();
  });

  it('InteractionHints renders without r key when given standard result hints', async () => {
    const { InteractionHints, buildInteractionHints } = await import('../../../src/cli/components/InteractionHints.js');

    const hints = buildInteractionHints({ onBack: () => {} });
    const { lastFrame, unmount } = render(
      React.createElement(InteractionHints, { hints }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = lastFrame() ?? '';

    // Should contain navigation keys
    expect(frame).toContain(':');
    expect(frame).toContain('q');
    expect(frame).toContain('back');

    // Should NOT contain r as run-again
    const lines = frame.split('\n');
    const hasRRunAgain = lines.some((l) => l.includes('r run again'));
    expect(hasRRunAgain).toBe(false);

    unmount();
  });

  it('p key triggers report (not r) — separate from run-again semantics', () => {
    // Validate the ActionHint contract: p = report, r = run-again
    const reportKey = RESERVED_KEYS.report.aliases[0];
    const runAgainKey = RESERVED_KEYS.runAgain.aliases[0];
    expect(reportKey).toBe('p');
    expect(runAgainKey).toBe('r');
    expect(reportKey).not.toBe(runAgainKey);
  });
});
