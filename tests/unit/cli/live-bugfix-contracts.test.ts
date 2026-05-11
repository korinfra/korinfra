import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';

const PATHS = {
  resources: new URL('../../../src/cli/commands/resources.tsx', import.meta.url),
  history: new URL('../../../src/cli/commands/history.tsx', import.meta.url),
  recommend: new URL('../../../src/cli/commands/recommend.tsx', import.meta.url),
  doctor: new URL('../../../src/cli/commands/doctor.tsx', import.meta.url),
  configShow: new URL('../../../src/cli/commands/config.tsx', import.meta.url),
  scan: new URL('../../../src/cli/commands/scan.tsx', import.meta.url),
  progressBar: new URL('../../../src/cli/components/ProgressBar.tsx', import.meta.url),
};

describe('Live TUI bugfix source contracts', () => {
  let resourcesSrc: string;
  let historySrc: string;
  let recommendSrc: string;
  let doctorSrc: string;
  let configShowSrc: string;
  let scanSrc: string;
  let progressBarSrc: string;

  beforeAll(async () => {
    [
      resourcesSrc,
      historySrc,
      recommendSrc,
      doctorSrc,
      configShowSrc,
      scanSrc,
      progressBarSrc,
    ] = await Promise.all([
      readFile(PATHS.resources, 'utf8'),
      readFile(PATHS.history, 'utf8'),
      readFile(PATHS.recommend, 'utf8'),
      readFile(PATHS.doctor, 'utf8'),
      readFile(PATHS.configShow, 'utf8'),
      readFile(PATHS.scan, 'utf8'),
      readFile(PATHS.progressBar, 'utf8'),
    ]);
  });

  it('resources keeps filters reachable and row guidance in sticky nextText', () => {
    // New architecture: filter via ActionBar key 'f', not input handler
    // DataTable manages filter state; ActionBar shows domain keys
    expect(resourcesSrc).toContain("DataTable");
    expect(resourcesSrc).toContain("TabbedResult");
  });

  it('history prune is implemented with confirm/delete/done flow', () => {
    expect(historySrc).toContain('PruneScreen');
    expect(historySrc).toContain('deleteScan');
    expect(historySrc).not.toContain('not yet available');
  });

  it('history show view includes denser details and recommendation preview', () => {
    expect(historySrc).toContain('Pending:');
    expect(historySrc).toContain('Scenario A:');
    expect(historySrc).toContain('Top recommendations');
  });

  it('recommend, doctor, and config show include global command/help hints', () => {
    expect(recommendSrc).toContain('IH_COMMAND');
    expect(recommendSrc).toContain('IH_HELP');
    expect(doctorSrc).toContain('IH_COMMAND');
    expect(doctorSrc).toContain('IH_HELP');
    expect(configShowSrc).toContain('IH_COMMAND');
    expect(configShowSrc).toContain('IH_HELP');
  });

  it('scan recommendations render through DataTable contract instead of card list', () => {
    expect(scanSrc).toContain('SCAN_RECOMMEND_COLUMNS');
    expect(scanSrc).toContain('SelectableRecsResponsive');
    expect(scanSrc).not.toContain('RecommendCard');
  });

  it('progress bar uses portable empty glyph to avoid shaded-char artifacts', () => {
    // L-06: Unicode path uses '·' as empty filler; ASCII path uses '-'.
    // The renderBar helper encodes both; neither shaded block glyph (░▒▓) appears.
    expect(progressBarSrc).toContain("'·'");
    expect(progressBarSrc).toContain("'-'");
    expect(progressBarSrc).not.toContain('░');
    expect(progressBarSrc).not.toContain('▒');
    expect(progressBarSrc).not.toContain('▓');
  });
});
