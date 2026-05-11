import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';

const HISTORY_SOURCE_URL = new URL('../../../src/cli/commands/history.tsx', import.meta.url);

function requireSlice(src: string, from: string, to: string, label: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);

  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Could not extract ${label}. Missing anchors: "${from}" -> "${to}"`);
  }

  return src.slice(start, end);
}

function listInputHandler(src: string): string {
  const marker = 'if (total === 0 || selectedScan === undefined) return;';
  const markerIdx = src.indexOf(marker);
  if (markerIdx < 0) {
    throw new Error('Could not find list input guard marker in history.tsx');
  }

  const handlerStart = src.lastIndexOf('useInput((input, key) => {', markerIdx);
  const handlerEnd = src.indexOf('}, { isActive: !helpOpen && !paletteOpen });', markerIdx);

  if (handlerStart < 0 || handlerEnd <= handlerStart) {
    throw new Error('Could not extract list useInput handler in history.tsx');
  }

  return src.slice(handlerStart, handlerEnd);
}

describe('HistoryCommand key ownership contracts', () => {
  let src: string;

  beforeAll(async () => {
    src = await readFile(HISTORY_SOURCE_URL, 'utf8');
  });

  it('keeps Enter behavior in list-local input handler (Space moved to ActionBar)', () => {
    const handler = listInputHandler(src);

    expect(handler).toContain('if (key.return)');
    expect(handler).not.toContain("if (input === ' ')");
    expect(handler).not.toContain("if (input === 'p')");
    expect(handler).not.toContain("if (input === 's')");
  });

  it('registers Space/mark action in ActionBar (per §7.1)', () => {
    const domainActions = requireSlice(src, 'const domainActions = [', 'return (', 'domainActions block');

    expect(domainActions).toContain("key: 'Space'");
    expect(domainActions).toContain("label: 'mark for diff'");
  });

  it('does not register Enter in ActionBar domain actions (Space is domain action per §7.1)', () => {
    const domainActions = requireSlice(src, 'const domainActions = [', 'return (', 'domainActions block');

    expect(domainActions).not.toContain("key: 'Enter'");
    // Space IS now a domain action in ActionBar per §7.1
    expect(domainActions).toContain("key: 'Space'");
  });

  it('does not show inline Enter/Space hint in ActionBar title prop (moved to ActionBar/NavHints per spec)', () => {
    expect(src).not.toContain('Enter details{DOT_SEP}Space mark/compare');
  });

  it('uses diff wording on d action in history show view', () => {
    expect(src).toContain("{ key: 'd', label: 'diff list'");
  });

  it('keeps newer-scan report action wiring in diff view', () => {
    expect(src).toContain("label: 'report newer scan'");
    expect(src).toContain("'--scan', scanBId");
  });
});
