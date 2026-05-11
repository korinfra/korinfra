import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { TextInput } from '@inkjs/ui';
import fs from 'node:fs';
import path from 'node:path';
import { stringWidth, padEndWidth } from '../ui/width.js';

import { colors, icons, borders } from '../theme.js';
import { AsciiHeader } from './AsciiHeader.js';
import { TerminalTooSmall } from './TerminalTooSmall.js';
import { InteractionHints, IH_COMMAND, IH_HELP, IH_QUIT } from './InteractionHints.js';
import { CMD_DESCRIPTIONS, DOT_SEP } from '../ui/text.js';
import { GAP_BETWEEN_SECTIONS, GAP_AFTER_HEADER, GAP_BEFORE_ACTIONS, MARGIN_LEFT_CONTENT, PADDING_X, GAP_ROW } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';
import { useInputMode } from '../hooks/useInputMode.js';
import { truncateDisplayWidth } from '../utils/displayWidth.js';
import { getVersion } from '../../utils/version.js';

interface Command {
  value: string;
  label: string;
  description: string;
  /** Shorter description shown in <72 col narrow layout */
  descriptionNarrow?: string;
  group: 'analyze' | 'action' | 'setup';
  /** If true, this command is available even without full configuration */
  setupOnly?: boolean;
  /** If true, this command requires an AI provider and cannot run in rules-only mode */
  requiresAi?: boolean;
}

const COMMANDS: Command[] = [
  // Analyze
  { value: 'scan',      label: 'scan',      description: CMD_DESCRIPTIONS['scan'] ?? '',      descriptionNarrow: 'Scan AWS resources and costs',      group: 'analyze' },
  { value: 'costs',     label: 'costs',     description: CMD_DESCRIPTIONS['costs'] ?? '',     descriptionNarrow: 'Cost breakdown',                      group: 'analyze' },
  { value: 'resources', label: 'resources', description: CMD_DESCRIPTIONS['resources'] ?? '', descriptionNarrow: 'Browse AWS resources',                 group: 'analyze' },
  { value: 'security',  label: 'security',  description: CMD_DESCRIPTIONS['security'] ?? '',  descriptionNarrow: 'Terraform security rules',             group: 'analyze' },
  { value: 'history',   label: 'history',   description: CMD_DESCRIPTIONS['history'] ?? '',   descriptionNarrow: 'Scan history and diffs',               group: 'analyze' },
  { value: 'changes',  label: 'changes',  description: CMD_DESCRIPTIONS['changes'] ?? '',  descriptionNarrow: 'Audit AWS API activity',               group: 'analyze' },
  // Action
  { value: 'recommend', label: 'recommend', description: CMD_DESCRIPTIONS['recommend'] ?? '', descriptionNarrow: 'Optimization recommendations',         group: 'action' },
  { value: 'fix',       label: 'fix',       description: CMD_DESCRIPTIONS['fix'] ?? '',       descriptionNarrow: 'Apply a fix with AI',                  group: 'action', requiresAi: true },
  { value: 'report',    label: 'report',    description: CMD_DESCRIPTIONS['report'] ?? '',    descriptionNarrow: 'Save a scan report',                   group: 'action' },
  { value: 'tags',      label: 'tags',      description: CMD_DESCRIPTIONS['tags'] ?? '',      descriptionNarrow: 'Tag compliance audit',                 group: 'action' },
  { value: 'pricing',   label: 'pricing',   description: CMD_DESCRIPTIONS['pricing'] ?? '',   descriptionNarrow: 'Local pricing cache',                  group: 'action' },
  // Setup
  { value: 'init',      label: 'init',      description: CMD_DESCRIPTIONS['init'] ?? '',      group: 'setup', setupOnly: true },
  { value: 'doctor',    label: 'doctor',    description: CMD_DESCRIPTIONS['doctor'] ?? '',    group: 'setup', setupOnly: true },
  { value: 'config',    label: 'config',    description: CMD_DESCRIPTIONS['config'] ?? '',    group: 'setup', setupOnly: true },
  { value: 'mcp',       label: 'mcp',       description: CMD_DESCRIPTIONS['mcp'] ?? '',       group: 'setup', setupOnly: true },
];

const GROUP_LABELS: Record<string, string> = {
  analyze: 'Analyze',
  action:  'Actions',
  setup:   'Setup',
};

const GROUP_COLORS: Record<string, string | undefined> = {
  analyze: colors.brand,     // cyan
  action:  colors.warning,   // yellow
  setup:   colors.success,   // green
};

const promptHistory: string[] = [];
function addToHistory(q: string): void {
  const i = promptHistory.indexOf(q);
  if (i !== -1) promptHistory.splice(i, 1);
  promptHistory.unshift(q);
  if (promptHistory.length > 20) promptHistory.pop();
}

interface MainMenuProps {
  onCommand: (command: string) => void;
  onPrompt: (prompt: string) => void;
  onCommandLine?: (commandLine: string) => void;
  /** Whether the app has a valid configuration (AWS creds + AI key). */
  isConfigured?: boolean;
  /** Whether an AI provider is available. When false, AI-only commands appear dimmed. */
  hasAiProvider?: boolean;
  /** Called whenever the internal mode changes so the parent can track it. */
  onModeChange?: (mode: Mode) => void;
  /** Restore cursor to this index when returning from a command. */
  initialSelectedIndex?: number;
  /** Called when cursor moves so parent can persist the index. */
  onSelectedIndexChange?: (index: number) => void;
}

type Mode = 'select' | 'type';

// ─── Palette tip persistence ──────────────────────────────────────────────────
// Stored in <cwd>/.korinfra/state.json to avoid touching config schema.

function readSawPaletteTip(): boolean {
  try {
    const stateFile = path.join(process.cwd(), '.korinfra', 'state.json');
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed['sawPaletteTip'] === true;
  } catch {
    return false;
  }
}

function writeSawPaletteTip(): void {
  try {
    const dir = path.join(process.cwd(), '.korinfra');
    if (!fs.existsSync(dir)) return;
    const stateFile = path.join(dir, 'state.json');
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    } catch { /* file may not exist yet */ }
    fs.writeFileSync(stateFile, JSON.stringify({ ...existing, sawPaletteTip: true }, null, 2));
  } catch { /* skip silently */ }
}

// ─── Group header (wide layout, ≥72 cols) ────────────────────────────────────

function GroupHeader({ label, color, termWidth = 80 }: { label: string; color: string | undefined; termWidth?: number }): React.JSX.Element {
  const availableWidth = Math.max(16, termWidth - 1);
  const dashLength = Math.max(4, availableWidth - stringWidth(label) - 2);
  const dashes = '─'.repeat(dashLength);
  return (
    <Box gap={GAP_ROW}>
      <Text color={color} bold>{label}</Text>
      <Text color={color} dimColor>{dashes}</Text>
    </Box>
  );
}

// ─── Command item (wide layout) ───────────────────────────────────────────────

function CommandItem({
  cmd,
  isSelected,
  termWidth,
  groupColor,
  isDisabled,
  descriptionOverride,
}: {
  cmd: Command;
  isSelected: boolean;
  termWidth: number;
  groupColor?: string | undefined;
  isDisabled?: boolean;
  descriptionOverride?: string | undefined;
}): React.JSX.Element {
  const selColor = groupColor ?? colors.brand;
  const labelWidth = Math.max(10, Math.max(...COMMANDS.map(c => stringWidth(c.label)))) + 1;
  const POINTER_COL_WIDTH = 2;
  const GAP_COLS = 1;
  const MIN_DESC_WIDTH = 12;
  const POINTER_LABEL_RESERVED = POINTER_COL_WIDTH + labelWidth + GAP_COLS;
  const availableDescriptionWidth = Math.max(MIN_DESC_WIDTH, termWidth - POINTER_LABEL_RESERVED - GAP_COLS);
  const description = truncateDisplayWidth(descriptionOverride ?? cmd.description, availableDescriptionWidth);

  if (isDisabled) {
    return (
      <Box gap={GAP_ROW}>
        <Text color={colors.muted}>
          {isSelected ? ` ${icons.pointer}` : '  '}
        </Text>
        <Text dimColor>
          {padEndWidth(cmd.label, labelWidth)}
        </Text>
        <Text dimColor>
          {description}
        </Text>
      </Box>
    );
  }

  return (
    <Box gap={GAP_ROW}>
      <Text color={isSelected ? selColor : colors.muted}>
        {isSelected ? ` ${icons.pointer}` : '  '}
      </Text>
      <Text
        color={isSelected ? selColor : undefined}
        bold={isSelected}
        dimColor={!isSelected}
      >
        {padEndWidth(cmd.label, labelWidth)}
      </Text>
      <Text dimColor color={isSelected ? selColor : undefined}>
        {description}
      </Text>
    </Box>
  );
}

// ─── Narrow Setup row: init · doctor · config · mcp ──────────────────────────

function NarrowSetupRow(): React.JSX.Element {
  const setupCmds = COMMANDS.filter((c) => c.group === 'setup');
  return (
    <Box gap={GAP_ROW} marginLeft={TUI.indent.page}>
      {setupCmds.map((cmd, i) => (
        <React.Fragment key={cmd.value}>
          {i > 0 && <Text dimColor>{DOT_SEP}</Text>}
          <Text dimColor>{cmd.label}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

// ─── Narrow command item (< 72 cols) ─────────────────────────────────────────

function NarrowCommandItem({
  cmd,
  isSelected,
  termWidth,
  groupColor,
  isDisabled,
}: {
  cmd: Command;
  isSelected: boolean;
  termWidth: number;
  groupColor?: string | undefined;
  isDisabled?: boolean;
}): React.JSX.Element {
  const selColor = groupColor ?? colors.brand;
  const labelWidth = 10;
  const MIN_DESC_WIDTH = 8;
  const availableDescriptionWidth = Math.max(MIN_DESC_WIDTH, termWidth - labelWidth - 4);
  const desc = truncateDisplayWidth(cmd.descriptionNarrow ?? cmd.description, availableDescriptionWidth);

  if (isDisabled) {
    return (
      <Box gap={GAP_ROW}>
        <Text color={colors.muted}>{'  '}</Text>
        <Text dimColor>{padEndWidth(cmd.label, labelWidth)}</Text>
        <Text dimColor>{desc}</Text>
      </Box>
    );
  }

  return (
    <Box gap={GAP_ROW}>
      <Text color={isSelected ? selColor : colors.muted}>
        {isSelected ? ` ${icons.pointer}` : '  '}
      </Text>
      <Text color={isSelected ? selColor : undefined} bold={isSelected} dimColor={!isSelected}>
        {padEndWidth(cmd.label, labelWidth)}
      </Text>
      <Text dimColor color={isSelected ? selColor : undefined}>{desc}</Text>
    </Box>
  );
}

const MAX_CONTENT_WIDTH = 160;

// ─── Main component ───────────────────────────────────────────────────────────

export function MainMenu({ onCommand, onPrompt, isConfigured = true, hasAiProvider = true, onModeChange, initialSelectedIndex = 0, onSelectedIndexChange }: MainMenuProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('select');
  const [selectedIdx, setSelectedIdx] = useState(initialSelectedIndex);

  useEffect(() => {
    onSelectedIndexChange?.(selectedIdx);
  }, [selectedIdx, onSelectedIndexChange]);

  const [disabledFlash, setDisabledFlash] = useState<string | null>(null);

  // One-time palette tip
  const [showPaletteTip, setShowPaletteTip] = useState(() => !readSawPaletteTip());
  const paletteTipDismissed = useRef(false);

  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termHeight = stdout?.rows ?? 24;

  const isNarrow = termWidth < 72;
  const version = getVersion();

  const { setInputMode } = useInputMode();

  const selectableCommands = isConfigured ? COMMANDS : COMMANDS.filter((c) => c.setupOnly === true);
  const actualSelectableCount = selectableCommands.length;

  useEffect(() => {
    if (actualSelectableCount > 0 && selectedIdx >= actualSelectableCount) {
      setSelectedIdx(actualSelectableCount - 1);
    }
  }, [actualSelectableCount, selectedIdx]);

  useEffect(() => {
    if (disabledFlash === null) return;
    const timer = setTimeout(() => setDisabledFlash(null), 2000);
    return () => clearTimeout(timer);
  }, [disabledFlash]);

  // Signal active text input so app shell gates palette / help overlay
  useEffect(() => {
    if (mode === 'type') {
      setInputMode('field');
    } else {
      setInputMode('none');
    }
    return () => { setInputMode('none'); };
  }, [mode, setInputMode]);

  // Dismiss palette tip on first keypress
  useInput(() => {
    if (showPaletteTip && !paletteTipDismissed.current) {
      paletteTipDismissed.current = true;
      setShowPaletteTip(false);
      writeSawPaletteTip();
    }
  }, { isActive: mode === 'select' });

  useInput((input, key) => {
    // In type mode: Ctrl+1/2/3 for history recall
    if (mode === 'type') {
      if (key.ctrl && (input === '1' || input === '2' || input === '3')) {
        const hIdx = parseInt(input, 10) - 1;
        if (hIdx >= 0 && hIdx < promptHistory.slice(0, 3).length) {
          const q = promptHistory[hIdx];
          if (!q) return;
          addToHistory(q);
          onPrompt(q);
          return;
        }
      }
      if (key.escape) {
        setMode('select');
        onModeChange?.('select');
      }
      return;
    }

    // select mode
    if (mode === 'select') {
      if (actualSelectableCount === 0) return;

      const goUp = key.upArrow;
      const goDown = key.downArrow;

      if (goUp) {
        setSelectedIdx((prev) => (prev > 0 ? prev - 1 : actualSelectableCount - 1));
      } else if (goDown) {
        setSelectedIdx((prev) => (prev < actualSelectableCount - 1 ? prev + 1 : 0));
      } else if (key.return) {
        if (selectedIdx < selectableCommands.length) {
          const selectedCommand = selectableCommands[selectedIdx];
          if (selectedCommand !== undefined) {
            if (!hasAiProvider && selectedCommand.requiresAi === true) {
              setDisabledFlash(`${selectedCommand.label} requires AI. Run init to configure.`);
              return;
            }
            onCommand(selectedCommand.value);
          }
        }
      } else if (input === '/') {
        // '/' opens ask AI — handled in select mode directly
        if (!hasAiProvider) {
          setDisabledFlash(`ask AI unavailable${DOT_SEP}run init to configure AI`);
        } else {
          setMode('type');
          onModeChange?.('type');
        }
      }
    }
  });

  if (termWidth < 40 || termHeight < 18) {
    return <TerminalTooSmall minWidth={40} minHeight={18} cols={termWidth} rows={termHeight} />;
  }

  // ─── Ask AI (type) mode ───────────────────────────────────────────────────

  if (mode === 'type') {
    const typeContentWidth = Math.min(termWidth, MAX_CONTENT_WIDTH);
    return (
      <Box flexDirection="column" gap={GAP_BETWEEN_SECTIONS}>
        <AsciiHeader />
        {promptHistory.length > 0 && (
          <Box flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
            <Text dimColor bold>Recent questions</Text>
            {promptHistory.slice(0, 3).map((entry, i) => (
              <Box key={i} gap={GAP_ROW} marginLeft={TUI.indent.content}>
                <Text dimColor><Text color={colors.warning}>Ctrl+{i + 1}</Text></Text>
                <Text dimColor>{entry.slice(0, 60)}{entry.length > 60 ? '…' : ''}</Text>
              </Box>
            ))}
          </Box>
        )}
        <Box
          borderStyle={borders.card}
          borderColor={colors.brand}
          paddingX={PADDING_X}
          flexDirection="column"
          width={typeContentWidth}
        >
          <Text bold color={colors.brand}>Ask AI</Text>
          <Text dimColor>Ask about your AWS resources, costs, or risks.</Text>
          <Box marginTop={GAP_AFTER_HEADER}>
            <Text color={colors.brand}>{icons.pointer} </Text>
            <TextInput
              placeholder="e.g. which EC2 instances are underutilized?"
              onSubmit={(value) => {
                if (value.trim()) {
                  addToHistory(value.trim());
                  onPrompt(value.trim());
                } else {
                  setMode('select');
                  onModeChange?.('select');
                }
              }}
            />
          </Box>
        </Box>
        <Box marginLeft={TUI.indent.content}>
          <Text dimColor>
            <Text color={colors.warning}>Enter</Text> to submit{DOT_SEP}<Text color={colors.warning}>Esc</Text> to cancel{promptHistory.length > 0 ? <>{DOT_SEP}<Text color={colors.warning}>Ctrl+1-3</Text> history</> : null}
          </Text>
        </Box>
      </Box>
    );
  }

  // ─── Select mode — narrow layout (<72 cols) ───────────────────────────────

  if (isNarrow) {
    const separatorWidth = Math.max(4, termWidth - 2);
    return (
      <Box flexDirection="column">
        {/* Compact text header */}
        <Box flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
          <Box gap={GAP_ROW} marginLeft={MARGIN_LEFT_CONTENT}>
            <Text dimColor>korinfra</Text>
            <Text bold>v{version}</Text>
          </Box>
          <Box marginLeft={MARGIN_LEFT_CONTENT}>
            <Text dimColor>AI-powered AWS FinOps</Text>
          </Box>
          <Box marginLeft={MARGIN_LEFT_CONTENT}>
            <Text dimColor>{'─'.repeat(separatorWidth)}</Text>
          </Box>
        </Box>

        {/* Analyze group */}
        {(() => {
          const groupCmds = COMMANDS.filter((c) => c.group === 'analyze');
          if (!isConfigured) {
            return (
              <Box key="analyze" flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
                <Box marginLeft={MARGIN_LEFT_CONTENT}>
                  <Text color={GROUP_COLORS['analyze']} bold>Analyze</Text>
                </Box>
                <Box marginLeft={TUI.indent.page}>
                  <Text dimColor>Locked — run init first</Text>
                </Box>
              </Box>
            );
          }
          const selectedCommand = selectableCommands[selectedIdx];
          return (
            <Box key="analyze" flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
              <Box marginLeft={MARGIN_LEFT_CONTENT}>
                <Text color={GROUP_COLORS['analyze']} bold>Analyze</Text>
              </Box>
              {groupCmds.map((cmd) => {
                const isSelected = selectedCommand?.value === cmd.value;
                return (
                  <NarrowCommandItem
                    key={cmd.value}
                    cmd={cmd}
                    isSelected={isSelected}
                    termWidth={termWidth}
                    groupColor={GROUP_COLORS['analyze']}
                  />
                );
              })}
            </Box>
          );
        })()}

        {/* Actions group */}
        {(() => {
          const groupCmds = COMMANDS.filter((c) => c.group === 'action');
          if (!isConfigured) {
            return (
              <Box key="action" flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
                <Box marginLeft={MARGIN_LEFT_CONTENT}>
                  <Text color={GROUP_COLORS['action']} bold>Actions</Text>
                </Box>
                <Box marginLeft={TUI.indent.page}>
                  <Text dimColor>Locked — run init first</Text>
                </Box>
              </Box>
            );
          }
          const selectedCommand = selectableCommands[selectedIdx];
          return (
            <Box key="action" flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
              <Box marginLeft={MARGIN_LEFT_CONTENT}>
                <Text color={GROUP_COLORS['action']} bold>Actions</Text>
              </Box>
              {groupCmds.map((cmd) => {
                const isDisabledByAi = !hasAiProvider && cmd.requiresAi === true;
                const isSelected = selectedCommand?.value === cmd.value;
                return (
                  <NarrowCommandItem
                    key={cmd.value}
                    cmd={cmd}
                    isSelected={isSelected}
                    termWidth={termWidth}
                    groupColor={GROUP_COLORS['action']}
                    isDisabled={isDisabledByAi}
                  />
                );
              })}
            </Box>
          );
        })()}

        {/* Setup group — collapses to single dot-sep line in narrow layout */}
        <Box flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
          <Box marginLeft={MARGIN_LEFT_CONTENT}>
            <Text color={GROUP_COLORS['setup']} bold>Setup</Text>
          </Box>
          <NarrowSetupRow />
        </Box>

        {/* Disabled flash */}
        {disabledFlash !== null && (
          <Box marginLeft={TUI.indent.content}>
            <Text color={colors.warning}>{icons.warning} {disabledFlash}</Text>
          </Box>
        )}

        {/* NavHints only: :  command  ·  ?  help  ·  q  quit */}
        <InteractionHints hints={[IH_COMMAND, IH_HELP, IH_QUIT]} />
      </Box>
    );
  }

  // ─── Select mode — wide layout (≥72 cols) ────────────────────────────────

  const visibleGroups = (['analyze', 'action', 'setup'] as const);
  const selectedCommand = selectableCommands[selectedIdx];

  const showLogo = termHeight >= 32;
  const contentWidth = Math.min(termWidth, MAX_CONTENT_WIDTH);

  return (
    <Box flexDirection="column">
      {showLogo && <AsciiHeader />}

      {/* One-time palette tip — dismissed on first keypress */}
      {showPaletteTip && (
        <Box marginLeft={MARGIN_LEFT_CONTENT} marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text dimColor>tip: press <Text color={colors.warning}>:</Text> for command palette</Text>
        </Box>
      )}

      {/* Command groups — constrained to MAX_CONTENT_WIDTH at very wide terminals */}
      <Box flexDirection="column" gap={0} width={contentWidth}>
        {visibleGroups.map((group) => {
          const allGroupCmds = COMMANDS.filter((c) => c.group === group);
          const groupColor = GROUP_COLORS[group];
          const groupLabel = (!isConfigured && group === 'setup') ? 'Getting started' : (GROUP_LABELS[group] ?? group);

          // Collapse locked groups when unconfigured
          const isLockedGroup = !isConfigured && group !== 'setup';
          if (isLockedGroup) {
            return (
              <Box key={group} flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
                <Box marginLeft={MARGIN_LEFT_CONTENT}>
                  <GroupHeader label={groupLabel} color={groupColor} termWidth={contentWidth} />
                </Box>
                <Box marginLeft={TUI.indent.page}>
                  <Text dimColor>Locked until setup {icons.dot} run init first</Text>
                </Box>
              </Box>
            );
          }

          if (group === 'setup') {
            const initCmd = allGroupCmds.find((c) => c.value === 'init');
            const doctorCmd = allGroupCmds.find((c) => c.value === 'doctor');
            const configCmd = allGroupCmds.find((c) => c.value === 'config');
            const mcpCmd = allGroupCmds.find((c) => c.value === 'mcp');
            const renderItem = (cmd: Command | undefined): React.JSX.Element | null => {
              if (cmd === undefined) return null;
              const isSelected = selectedCommand?.value === cmd.value;
              return (
                <CommandItem
                  key={cmd.value}
                  cmd={cmd}
                  isSelected={isSelected}
                  termWidth={contentWidth}
                  groupColor={groupColor}
                />
              );
            };
            return (
              <Box key={group} flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
                <Box marginLeft={MARGIN_LEFT_CONTENT}>
                  <GroupHeader label={groupLabel} color={groupColor} termWidth={contentWidth} />
                </Box>
                {renderItem(initCmd)}
                {renderItem(doctorCmd)}
                {renderItem(configCmd)}
                {renderItem(mcpCmd)}
              </Box>
            );
          }

          return (
            <Box key={group} flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
              <Box marginLeft={MARGIN_LEFT_CONTENT}>
                <GroupHeader label={groupLabel} color={groupColor} termWidth={contentWidth} />
              </Box>
              {allGroupCmds.map((cmd) => {
                const isDisabledByAi = !hasAiProvider && cmd.requiresAi === true;
                const isLockedByConfig = !isConfigured && !cmd.setupOnly;
                const isSelected = selectedCommand?.value === cmd.value && !isLockedByConfig;
                return (
                  <CommandItem
                    key={cmd.value}
                    cmd={cmd}
                    isSelected={isSelected}
                    termWidth={contentWidth}
                    groupColor={isLockedByConfig ? colors.muted : groupColor}
                    isDisabled={isDisabledByAi || isLockedByConfig}
                    descriptionOverride={isLockedByConfig ? cmd.description : undefined}
                  />
                );
              })}
            </Box>
          );
        })}
      </Box>

      {/* Disabled flash */}
      {disabledFlash !== null && (
        <Box marginLeft={TUI.indent.content}>
          <Text color={colors.warning}>{icons.warning} {disabledFlash}</Text>
        </Box>
      )}

      <Box marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_BEFORE_ACTIONS}>
        {hasAiProvider && isConfigured ? (
          <Text>
            <Text color={colors.warning} bold>/</Text>
            {' '}
            <Text>ask AI</Text>
          </Text>
        ) : !isConfigured ? (
          <Text dimColor>/ ask AI  (run init first)</Text>
        ) : (
          <Text dimColor>/ ask AI  (AI disabled — set ai.provider in config)</Text>
        )}
      </Box>
      <InteractionHints hints={[IH_COMMAND, IH_HELP, IH_QUIT]} rowLabel={false} />
    </Box>
  );
}
