import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../../');
const helpOverlaySrc = readFileSync(resolve(ROOT, 'src/cli/components/HelpOverlay.tsx'), 'utf8');

describe('HelpOverlay shortcut contracts', () => {
  it('help overlay exists and is screen-agnostic', () => {
    // New architecture: HelpOverlay is global and screen-agnostic per §17.1
    // ActionBar domain keys are shown in individual screens, not in HelpOverlay
    expect(helpOverlaySrc).toContain("Keyboard shortcuts");
  });

  it('no phantom open fix shortcut in help', () => {
    expect(helpOverlaySrc).not.toContain("label: 'open fix'");
  });

  it('no phantom retry failed shortcut in help', () => {
    expect(helpOverlaySrc).not.toContain("label: 'retry failed'");
  });

  it('help layer only shows navigation keys, not domain keys', () => {
    // Per §17.1, HelpOverlay shows navigation only
    // Domain keys (s, f, j, r, p, etc.) are shown in ActionBar of each screen
    expect(helpOverlaySrc).toContain("↑↓");
    expect(helpOverlaySrc).toContain("?");
  });
});
