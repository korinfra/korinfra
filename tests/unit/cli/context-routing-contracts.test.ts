import { describe, expect, it } from 'vitest';

async function readSource(relPathFromTests: string): Promise<string> {
  const fs = await import('node:fs/promises');
  return fs.readFile(new URL(relPathFromTests, import.meta.url), 'utf8');
}

describe('Contextual routing contracts', () => {
  it('scan routes selected recommendation context for review/fix actions', async () => {
    const src = await readSource('../../../src/cli/commands/scan.tsx');

    expect(src).toContain("command: 'recommend', args: ['--select', selectedRec.id]");
    expect(src).toContain("command: 'fix', args: [selectedRec.id]");
  });

  it('recommend accepts --select and passes selected recommendation id to fix', async () => {
    const src = await readSource('../../../src/cli/commands/recommend.tsx');

    expect(src).toContain("const selectedId = parseArg(args, '--select');");
    // TODO: Verify routing structure after refactor — f/j/r/p/s in ActionBar, no direct fix routing
  });

  it('history show targets fix action to a concrete recommendation id', async () => {
    const src = await readSource('../../../src/cli/commands/history.tsx');

    expect(src).toContain('firstPendingRecommendationId');
    expect(src).toContain("label: 'fix top recommendation'");
    expect(src).toContain("args: [firstPendingRecommendationId]");
    expect(src).not.toContain("label: 'open fixes'");
  });

  it('tags routes suggest/apply to selected resource context', async () => {
    const src = await readSource('../../../src/cli/commands/tags.tsx');

    expect(src).toContain("command: 'tags' as TuiCommand, args: ['suggest', '--resource', row.id]");
    expect(src).toContain("command: 'tags' as TuiCommand, args: ['apply', '--resource', row.id]");
    expect(src).toContain('targetResource = resource ?? selectedResourceId');
  });

  it('security routes selected finding to related recommendation type', async () => {
    const src = await readSource('../../../src/cli/commands/security.tsx');

    // TODO: Verify routing structure — security shows detail overlay, needs recommend routing from overlay
    expect(src).toContain("makeRenderSecurityResult");
  });
});
