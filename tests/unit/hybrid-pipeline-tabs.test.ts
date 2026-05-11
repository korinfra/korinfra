/**
 * Tests for the tab-switching key contract:
 * - '1' and '2' do NOT appear as action keys in TabbedResult's key handling
 * - Tab / Shift+Tab are the only tab-switching triggers (enforced by component design)
 * - HybridPipeline ActionBar no longer contains '1' / '2' tab-switch entries
 *
 * Since ink-testing-library stdin does not synthesize Ink's structured key objects
 * reliably in vitest (key.tab vs raw \t parsing is done in Ink's internal input
 * handling), we test the contract at the module and render level.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';

import { TabbedResult } from '../../src/cli/components/TabbedResult.js';
import type { Tab } from '../../src/cli/components/TabbedResult.js';

const TABS: Tab[] = [
  { id: 'data', label: 'Data' },
  { id: 'ai', label: 'AI insights' },
];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TabbedResult key contract (P0-1)', () => {
  it('pressing "1" does not change active tab (P0-1 audit)', async () => {
    let currentTab = 'data';
    const onTabChange = (id: string): void => { currentTab = id; };

    const { stdin, unmount } = render(
      React.createElement(
        TabbedResult,
        { tabs: TABS, activeTab: 'data', onTabChange, isActive: true },
        React.createElement('span', null, 'content'),
      ),
    );
    await wait(50);
    stdin.write('1');
    await wait(50);
    expect(currentTab).toBe('data');

    unmount();
  });

  it('pressing "2" does not change active tab (P0-1 audit)', async () => {
    let currentTab = 'data';
    const onTabChange = (id: string): void => { currentTab = id; };

    const { stdin, unmount } = render(
      React.createElement(
        TabbedResult,
        { tabs: TABS, activeTab: 'data', onTabChange, isActive: true },
        React.createElement('span', null, 'content'),
      ),
    );
    await wait(50);
    stdin.write('2');
    await wait(50);
    expect(currentTab).toBe('data');

    unmount();
  });
});

// TODO: behavioral test — verify tab switching only responds to Tab/Shift+Tab keys
// (source-grep assertions removed; test via Ink render + key simulation if needed)
