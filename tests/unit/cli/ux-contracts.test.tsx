import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';

import { CommandHeader } from '../../../src/cli/components/CommandHeader.js';
import { EmptyState } from '../../../src/cli/components/EmptyState.js';
import { MainMenu } from '../../../src/cli/components/MainMenu.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

describe('TUI UX contracts', () => {
  it('compact command header keeps a single info row plus divider without mode badge noise', async () => {
    const { lastFrame, unmount } = render(
      <CommandHeader
        command="resources"
        description="browse AWS resources"
        scope="8 resources"
        mode="ai-assisted"
      />,
    );

    await wait(50);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('korinfra');
    expect(frame).toContain('resources');
    expect(frame).toContain('────');
    expect(frame).not.toContain('[AI assisted]');
    unmount();
  });

  it('empty state no longer renders inline action text', async () => {
    const { lastFrame, unmount } = render(
      <EmptyState
        message="No recommendations."
        hint="Run a scan first."
        action={{ key: 's', label: 'scan again' }}
      />,
    );

    await wait(50);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No recommendations.');
    expect(frame).toContain('Run a scan first.');
    expect(frame).not.toContain('scan again');
    unmount();
  });

  it('main menu keeps AI-only commands visually clean when AI is unavailable', async () => {
    const { lastFrame, unmount } = render(
      <MainMenu
        isConfigured={true}
        hasAiProvider={false}
        onCommand={() => {}}
        onPrompt={() => {}}
      />,
    );

    await wait(250);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('fix');
    expect(frame).not.toContain('[ai required]');
    expect(frame).not.toContain('needs AI');
    unmount();
  });

  it('resources browser does not render ad-hoc inline detail hints below the tab content', () => {
    const root = resolve(import.meta.dirname, '../../../');
    const src = readFileSync(resolve(root, 'src/cli/commands/resources.tsx'), 'utf8');

    expect(src).not.toContain('Enter details');
    expect(src).not.toContain('switch tab');
  });

  it('history list keeps the spec table shape without a separate scan id column', () => {
    const root = resolve(import.meta.dirname, '../../../');
    const src = readFileSync(resolve(root, 'src/cli/commands/history.tsx'), 'utf8');

    expect(src).not.toContain("label: 'Scan ID'");
    expect(src).toContain("label: 'Date'");
    expect(src).toContain("label: 'Resources'");
    expect(src).toContain("label: 'Findings'");
    expect(src).toContain("label: 'Duration'");
  });

  it('tags suggest screen lets the overlay own the footer instead of duplicating parent hints', () => {
    const root = resolve(import.meta.dirname, '../../../');
    const src = readFileSync(resolve(root, 'src/cli/commands/tags.tsx'), 'utf8');

    expect(src).toContain('header={<CommandHeader command="tags suggest" description={headerSubtitle.suggest} scope={resource} />}');
    expect(src).toContain('overlayActive');
  });

  it('pricing region picker no longer advertises generic navigate hints in its overlay footer', () => {
    const root = resolve(import.meta.dirname, '../../../');
    const src = readFileSync(resolve(root, 'src/cli/commands/pricing.tsx'), 'utf8');

    expect(src).toContain("label: 'download selected'");
    expect(src).toContain("label: 'toggle'");
    expect(src).not.toContain('IH_NAVIGATE');
  });
});
