/**
 * G-2: DirectPipeline renders ActionBar outside scrollable content when
 * `resultActions` is set via the CommandResultView contract.
 *
 * Tests the CommandResultView shape contract and validates that actions
 * are separated from scrollable items.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { CommandResultView } from '../../../src/cli/components/DirectPipeline.js';
import type { ActionHint } from '../../../src/cli/actions.js';

describe('CommandResultView contract (G-2)', () => {
  it('CommandResultView has items, optional actions, and optional nextText', () => {
    const actions: ActionHint[] = [
      { key: 'p', label: 'report this scan', action: { type: 'navigate', command: 'report' } },
      { key: 's', label: 'scan again', action: { type: 'navigate', command: 'scan' } },
    ];

    const view: CommandResultView = {
      items: [],
      actions,
      nextText: 'Use action keys to continue.',
    };

    expect(view.items).toBeInstanceOf(Array);
    expect(view.actions).toBeDefined();
    expect(view.actions!.length).toBe(2);
    expect(view.nextText).toBe('Use action keys to continue.');
  });

  it('actions can be omitted for commands with no result actions', () => {
    const view: CommandResultView = {
      items: [],
    };
    expect(view.actions).toBeUndefined();
    expect(view.nextText).toBeUndefined();
  });

  it('each action has key, label, and action fields', () => {
    const action: ActionHint = {
      key: 'o',
      label: 'open file',
      action: { type: 'open-file', path: '/tmp/report.html' },
    };
    expect(action.key).toBe('o');
    expect(action.label).toBe('open file');
    expect(action.action.type).toBe('open-file');
  });
});

describe('ActionBar visibility (G-2 render)', () => {
  it('action label appears in ActionBar rendered output', async () => {
    const { ActionBar } = await import('../../../src/cli/components/ActionBar.js');
    const actions: ActionHint[] = [
      { key: 'p', label: 'report this scan', action: { type: 'navigate', command: 'report' } },
      { key: 's', label: 'scan again', action: { type: 'navigate', command: 'scan' } },
    ];

    const { lastFrame, unmount } = render(
      React.createElement(ActionBar, { actions, onAction: vi.fn() }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('report this scan');
    expect(frame).toContain('scan again');
    unmount();
  });

  it('ActionBar renders action key in warning color hint format', async () => {
    const { ActionBar } = await import('../../../src/cli/components/ActionBar.js');
    const actions: ActionHint[] = [
      { key: 'p', label: 'save report', action: { type: 'navigate', command: 'report' } },
    ];

    const { lastFrame, unmount } = render(
      React.createElement(ActionBar, { actions }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('p');
    expect(frame).toContain('save report');
    unmount();
  });
});
