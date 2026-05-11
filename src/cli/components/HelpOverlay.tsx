/**
 * HelpOverlay — §17.1: global `?` help overlay.
 *
 * Centered box titled "Keyboard shortcuts" listing navigation keys only.
 * Screen-specific domain keys are shown in the ActionBar, not here.
 *
 * The overlay owns its own bottom hint (`Esc close`). The host ScreenShell
 * hides its own footer via `overlayActive` while this overlay is open.
 */

import React from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';

import { colors, borders } from '../theme.js';
import { GAP_BETWEEN_SECTIONS } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';

interface NavShortcut {
  key: string;
  label: string;
}

const NAV_SHORTCUTS: NavShortcut[] = [
  { key: '↑↓', label: 'navigate rows' },
  { key: 'PgUp/PgDn', label: 'jump 10 rows' },
  { key: 'Enter', label: 'select / open detail' },
  { key: 'Esc / b', label: 'back / close overlay' },
  { key: 'Tab', label: 'switch tab' },
  { key: ':', label: 'command palette' },
  { key: '?', label: 'this help' },
  { key: 'q', label: 'quit' },
];

const KEY_COL_WIDTH = Math.max(...NAV_SHORTCUTS.map((s) => s.key.length)) + 6;

interface HelpOverlayProps {
  /** Accepted for API compatibility; help content is screen-agnostic per §17.1. */
  command?: string;
  onClose: () => void;
}

export function HelpOverlay({ onClose }: HelpOverlayProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const boxWidth = Math.min(70, Math.max(40, termWidth - 8));

  useInput((input, key) => {
    if (input === '?') { onClose(); return; }
    if (key.escape || input === 'b') { onClose(); return; }
    if (input === 'q') { exit(); return; }
  }, { isActive: true });

  return (
    <Box flexDirection="column" alignItems="center">
      <Box
        borderStyle={borders.card}
        borderColor={colors.brand}
        paddingX={3}
        paddingY={1}
        flexDirection="column"
        width={boxWidth}
      >
        <Text bold color={colors.brand}>Keyboard shortcuts</Text>
        <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS} gap={GAP_BETWEEN_SECTIONS}>
          {NAV_SHORTCUTS.map((s) => (
            <Box key={s.key} flexDirection="row">
              <Box width={KEY_COL_WIDTH}>
                <Text color={colors.warning}>{s.key}</Text>
              </Box>
              <Text dimColor>{s.label}</Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={GAP_BETWEEN_SECTIONS}>
          <Text dimColor wrap="truncate">Screen-specific keys shown in the action bar.</Text>
        </Box>
      </Box>
      <Box marginLeft={TUI.indent.content}>
        <Text dimColor>
          <Text color={colors.warning}>Esc</Text> close
        </Text>
      </Box>
    </Box>
  );
}
