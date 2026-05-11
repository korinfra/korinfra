/**
 * SP-1 / GA-5: Whitespace preservation tests for ResultPanel inline rendering.
 *
 * These tests verify that spaces between styled fragments (bold, code, dollar
 * amounts) are not collapsed or trimmed, which would cause tokens to run
 * together ("gap:All", "$12/moreveals", "buckets(Environment)").
 *
 * Strategy: test the exported renderMarkdown() function by rendering its output
 * with ink-testing-library and asserting on lastFrame() substrings.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { renderMarkdown } from '../../../src/cli/components/ResultPanel.js';

/**
 * Render a markdown string and return the terminal frame output.
 * We wrap the elements in a Box with a fixed width to get predictable output.
 */
function renderMd(markdown: string, cols = 80): string {
  const elements = renderMarkdown(markdown, cols);
  const { lastFrame, unmount } = render(
    React.createElement(Box, { flexDirection: 'column' }, ...elements),
  );
  // Allow one tick for Ink to flush
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

describe('ResultPanel whitespace preservation (SP-1)', () => {
  it('preserves space after colon in "gap: All" (not "gap:All")', () => {
    const frame = renderMd('gap: **All**');
    expect(frame).toContain('gap: All');
    expect(frame).not.toMatch(/gap:All/);
  });

  it('preserves space before opening paren "buckets (Environment)"', () => {
    const frame = renderMd('buckets (**Environment**)');
    expect(frame).toContain('buckets (Environment)');
    expect(frame).not.toMatch(/buckets\(Environment/);
  });

  it('preserves space after dollar amount "$12/mo reveals" (not "$12/moreveals")', () => {
    const frame = renderMd('~$12/mo reveals');
    expect(frame).toContain('$12/mo');
    expect(frame).toContain('reveals');
    expect(frame).not.toMatch(/\$12\/moreveals/);
  });

  it('renders bold inline text with surrounding spaces intact', () => {
    const frame = renderMd('The **label**: value here');
    expect(frame).toContain('label');
    expect(frame).toContain(': value here');
    expect(frame).not.toMatch(/label:value/);
  });

  it('handles multiple styled tokens with spaces between them', () => {
    const frame = renderMd('Cost is $5/mo and $10/yr annually');
    expect(frame).toContain('$5/mo');
    expect(frame).toContain('and');
    expect(frame).toContain('$10/yr');
    // Tokens must not run together
    expect(frame).not.toMatch(/\$5\/moand/);
    expect(frame).not.toMatch(/and\$10/);
  });

  it('renders bullet list items with inline bold', () => {
    const frame = renderMd('- **key**: value');
    expect(frame).toContain('key');
    expect(frame).toContain(': value');
  });

  it('renders numbered list with inline dollar amount', () => {
    const frame = renderMd('1. Save $50/mo by resizing');
    expect(frame).toContain('$50/mo');
    expect(frame).toContain('by resizing');
    expect(frame).not.toMatch(/\$50\/moby/);
  });

  it('preserves space before styled fragment at start of text (leading space)', () => {
    // " reveals" after a dollar match — the leading space must survive
    const frame = renderMd('Cost $12/mo reveals savings');
    expect(frame).toContain('$12/mo');
    expect(frame).toContain('reveals');
    expect(frame).not.toMatch(/\$12\/moreveals/);
  });
});
