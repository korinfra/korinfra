/**
 * McpCommand — §16 MCP install/status wizard.
 *
 * Lifecycle:
 *   §16.1 IDE select (1/4)   — multi-select list with state badges, Space toggles.
 *   §16.2 Scope select (2/4) — User-global vs Project-local (adds .vscode/mcp.json).
 *   §16.3 Review     (3/4)   — SafeWriteReview over per-IDE JSON diffs.
 *   §16.4 Done       (4/4)   — per-IDE success rows + restart hint.
 *   §16.5 Status subcommand  — read-only status per IDE + ActionBar `u uninstall`.
 *
 * Rules enforced:
 *   SCREEN_SHELL_RULE — all screens wrapped in ScreenShell
 *   VRHYTHM_RULE      — only GAP_AFTER_HEADER / GAP_BETWEEN_SECTIONS / GAP_BEFORE_ACTIONS
 *   DOT_SEP_RULE      — DOT_SEP from ui/text.js
 *   X-1 rule          — NavHints = navigation only; `u` in ActionBar
 *   ERR2-1 rule       — ErrorBox owns its footer
 *   G-2 rule          — review/done return CommandResultView-style content
 */

import React, { useMemo, useState } from 'react';

import { Box, Text, useApp, useInput } from 'ink';

import { ErrorBox } from '../components/ErrorBox.js';
import { CommandHeader } from '../components/CommandHeader.js';
import { ActionBar } from '../components/ActionBar.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { SafeWriteReview } from '../components/SafeWriteReview.js';
import type { TuiAction } from '../actions.js';
import { colors, icons } from '../theme.js';
import {
  InteractionHints,
  IH_QUIT,
  IH_BACK,
  IH_COMMAND,
  IH_HELP,
} from '../components/InteractionHints.js';
import {
  GAP_BETWEEN_SECTIONS,
  GAP_ICON_TEXT,
  GAP_ROW,
  GAP_SECTION_WIDE,
} from '../ui/spacing.js';
import { DOT_SEP } from '../ui/text.js';
import { formatPathForTerminal } from '../ui/format.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';
import {
  resolveIdeTargets,
  installIntoConfig,
  uninstallFromConfig,
} from './mcp-install-core.js';
import type {
  IdeInstallState,
  InstallResult,
  InstallScope,
} from './mcp-install-core.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'ide' | 'scope' | 'review' | 'done';

interface SelectableIde {
  id: string;
  label: string;
  manual: boolean;
}

const IDE_ROWS: SelectableIde[] = [
  { id: 'vscode',    label: 'VS Code',  manual: false },
  { id: 'cursor',    label: 'Cursor',   manual: false },
  { id: 'jetbrains', label: 'JetBrains', manual: false },
  { id: 'other',     label: 'Other  (manual config)', manual: true },
];

// ─── State-badge helper ───────────────────────────────────────────────────────

function IdeStateBadge({ state }: { state: IdeInstallState }): React.JSX.Element {
  switch (state) {
    case 'installed':
      return <Text color={colors.success} dimColor>[installed]</Text>;
    case 'differs':
      return <Text color={colors.warning}>[outdated config]</Text>;
    case 'not-installed':
      return <Text dimColor>[not installed]</Text>;
  }
}

// ─── Subcomponent: Install wizard ─────────────────────────────────────────────

function McpInstallWizard({
  onBack,
  onAction,
}: {
  onBack?: (() => void) | undefined;
  onAction?: ((action: TuiAction) => void) | undefined;
}): React.JSX.Element {
  const { exit } = useApp();
  const { helpOpen, paletteOpen } = useGlobalOverlay();

  const [step, setStep] = useState<Step>('ide');
  const [scope, setScope] = useState<InstallScope>('user');
  const [ideIdx, setIdeIdx] = useState(0);
  const [scopeIdx, setScopeIdx] = useState(0);
  const [results, setResults] = useState<InstallResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Targets are re-resolved whenever scope changes (VS Code path depends on scope).
  const allTargets = useMemo(() => resolveIdeTargets(undefined, scope), [scope]);

  // Map IDE_ROWS → IdeTarget (or undefined for "Other").
  const rowTargets = useMemo(
    () => IDE_ROWS.map((row) => ({ row, target: allTargets.find((t) => t.id === row.id) })),
    [allTargets],
  );

  // Default: all non-manual IDEs selected.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(IDE_ROWS.filter((r) => !r.manual).map((r) => r.id)),
  );
  const selectedTargets = allTargets.filter((t) => checkedIds.has(t.id));
  const selectionValid = selectedTargets.length > 0;

  useInput(
    (input, key) => {
      if (input === 'q') { exit(); return; }

      if (step === 'ide') {
        if (input === 'b' || key.escape) { if (onBack !== undefined) onBack(); else exit(); return; }
        if (key.upArrow) { setIdeIdx((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setIdeIdx((i) => Math.min(IDE_ROWS.length - 1, i + 1)); return; }
        if (input === ' ') {
          const row = IDE_ROWS[ideIdx];
          if (row && !row.manual) {
            setCheckedIds((prev) => {
              const next = new Set(prev);
              if (next.has(row.id)) next.delete(row.id);
              else next.add(row.id);
              return next;
            });
          }
          return;
        }
        if (key.return) {
          if (selectionValid) setStep('scope');
          return;
        }
        return;
      }

      if (step === 'scope') {
        if (input === 'b' || key.escape) { setStep('ide'); return; }
        if (key.upArrow) { setScopeIdx((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setScopeIdx((i) => Math.min(1, i + 1)); return; }
        if (key.return) {
          setScope(scopeIdx === 0 ? 'user' : 'project');
          setStep('review');
          return;
        }
        return;
      }

      if (step === 'done') {
        if (input === 'b' || key.escape) { if (onBack !== undefined) onBack(); else exit(); return; }
      }
    },
    { isActive: error === null && step !== 'review' && !helpOpen && !paletteOpen },
  );

  // Run install after SafeWriteReview confirmation.
  const handleInstallConfirm = (): void => {
    try {
      const installResults = selectedTargets.map((t) => installIntoConfig(t));
      setResults(installResults);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error !== null) {
    return (
      <ScreenShell header={<CommandHeader command="mcp" description="install MCP server" mode="setup" />}>
        <ErrorBox message={error} onBack={onBack} />
      </ScreenShell>
    );
  }

  // ─── Step 1/4: IDE select ───────────────────────────────────────────────────
  if (step === 'ide') {
    return (
      <ScreenShell
        header={<CommandHeader command="mcp" description="install MCP server (1 of 4)" mode="setup" />}
        actions={
          <ActionBar
            screenId="mcp.ide"
            actions={[
              { key: 'Space', label: 'toggle', action: { type: 'run-again' as const } },
              { key: 'Enter', label: 'confirm', action: { type: 'run-again' as const } },
            ]}
            onAction={onAction}
            marginLeft={GAP_SECTION_WIDE}
          />
        }
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
      >
        <Box flexDirection="column" gap={GAP_BETWEEN_SECTIONS}>
          <Box marginLeft={GAP_SECTION_WIDE}>
            <Text dimColor>Select IDEs to install (Space to toggle, Enter to confirm)</Text>
          </Box>
          <Box flexDirection="column" marginLeft={GAP_SECTION_WIDE}>
            {IDE_ROWS.map((row, i) => {
              const target = rowTargets[i]?.target;
              const checked = checkedIds.has(row.id);
              const isCursor = i === ideIdx;
              return (
                <Box key={row.id} gap={GAP_ROW}>
                  <Text color={isCursor ? colors.brand : undefined}>{isCursor ? icons.pointer : ' '}</Text>
                  <Text color={row.manual ? colors.muted : (checked ? colors.success : colors.muted)}>
                    {row.manual ? '   ' : (checked ? '[x]' : '[ ]')}
                  </Text>
                  <Text bold={isCursor} color={isCursor ? colors.brand : undefined}>{row.label}</Text>
                  {target !== undefined && <IdeStateBadge state={target.installState} />}
                </Box>
              );
            })}
          </Box>
        </Box>
      </ScreenShell>
    );
  }

  // ─── Step 2/4: Scope select ─────────────────────────────────────────────────
  if (step === 'scope') {
    const scopeRows: Array<{ id: InstallScope; label: string; hint: string }> = [
      { id: 'user',    label: 'User',    hint: 'available in all projects' },
      { id: 'project', label: 'Project', hint: `this project only  ${DOT_SEP}  adds .vscode/mcp.json` },
    ];

    return (
      <ScreenShell
        header={<CommandHeader command="mcp" description="install MCP server (2 of 4)" mode="setup" />}
        actions={
          <ActionBar
            screenId="mcp.scope"
            actions={[
              { key: 'Enter', label: 'confirm', action: { type: 'run-again' as const } },
            ]}
            onAction={onAction}
            marginLeft={GAP_SECTION_WIDE}
          />
        }
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
      >
        <Box flexDirection="column" gap={GAP_BETWEEN_SECTIONS}>
          <Box marginLeft={GAP_SECTION_WIDE}>
            <Text dimColor>Installation scope</Text>
          </Box>
          <Box flexDirection="column" marginLeft={GAP_SECTION_WIDE}>
            {scopeRows.map((row, i) => {
              const isCursor = i === scopeIdx;
              return (
                <Box key={row.id} gap={GAP_ROW}>
                  <Text color={isCursor ? colors.brand : undefined}>{isCursor ? icons.pointer : ' '}</Text>
                  <Text bold={isCursor} color={isCursor ? colors.brand : undefined}>{row.label}</Text>
                  <Text dimColor>{row.hint}</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      </ScreenShell>
    );
  }

  // ─── Step 3/4: Review ───────────────────────────────────────────────────────
  if (step === 'review') {
    const willChange = selectedTargets.map((t) => ({
      description: `Add korinfra MCP server to ${t.label}`,
      detail: t.configPath,
    }));

    return (
      <ScreenShell
        header={<CommandHeader command="mcp" description="install MCP server (3 of 4)" mode="setup" />}
      >
        <SafeWriteReview
          willChange={willChange}
          willNotChange={['Existing IDE settings and preferences']}
          dataUsed={['korinfra binary path', `${scope}-scope config files`]}
          safety={{
            dryRunAvailable: false,
            requiresAwsWrite: false,
            createsPrOnly: false,
            rollback: selectedTargets.some((t) => t.exists)
              ? `Backup saved to ${selectedTargets
                  .filter((t) => t.exists)
                  .map((t) => formatPathForTerminal(t.configPath) + '.bak')
                  .join(', ')} — restore to undo`
              : `Remove the "korinfra" key from ${selectedTargets
                  .map((t) => formatPathForTerminal(t.configPath))
                  .join(', ')}`,
          }}
          onConfirm={handleInstallConfirm}
          onBack={() => setStep('scope')}
          compact
        />
      </ScreenShell>
    );
  }

  // ─── Step 4/4: Done ─────────────────────────────────────────────────────────
  const successful = (results ?? []).filter((r) => r.action === 'installed' || r.action === 'updated');
  const restartLabels = successful.map((r) => r.label).join(', ');

  return (
    <ScreenShell
      header={<CommandHeader command="mcp" description="installed" mode="setup" />}
      hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
    >
      <Box flexDirection="column" gap={GAP_BETWEEN_SECTIONS}>
        {(results ?? []).map((r) => {
          const ok = r.action === 'installed' || r.action === 'updated';
          return (
            <Box key={r.id} gap={GAP_ICON_TEXT}>
              <Text color={ok ? colors.success : colors.error}>{ok ? icons.checkmark : icons.cross}</Text>
              {ok ? (
                <Text>
                  MCP server installed for <Text color={colors.brand}>{r.label}</Text>  <Text dimColor>({scope} scope)</Text>
                </Text>
              ) : (
                <Text color={colors.error}>
                  {r.label}: {r.detail ?? 'error'}
                </Text>
              )}
            </Box>
          );
        })}
        {successful.length > 0 && (
          <Text dimColor>
            Restart {restartLabels} — then open MCP servers panel to verify.
          </Text>
        )}
      </Box>
    </ScreenShell>
  );
}

// ─── Subcommand: status ───────────────────────────────────────────────────────

function McpStatus({
  onBack,
  onAction,
}: {
  onBack?: (() => void) | undefined;
  onAction?: ((action: TuiAction) => void) | undefined;
}): React.JSX.Element {
  const { exit } = useApp();
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const [results, setResults] = useState<InstallResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusedIdx, setFocusedIdx] = useState(0);

  const targets = useMemo(() => resolveIdeTargets(), []);
  const focusedInstalledTarget = targets.find((t, i) => i === focusedIdx && t.installState !== 'not-installed');

  useInput(
    (input, key) => {
      if (input === 'q') { exit(); return; }
      if (input === 'b' || key.escape) { if (onBack !== undefined) onBack(); else exit(); return; }
      if (key.upArrow) { setFocusedIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setFocusedIdx((i) => Math.min(targets.length - 1, i + 1)); return; }
      if (input === 'u' && focusedInstalledTarget && results === null) {
        try {
          const r = uninstallFromConfig(focusedInstalledTarget);
          setResults([r]);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    { isActive: error === null && !helpOpen && !paletteOpen },
  );

  if (error !== null) {
    return (
      <ScreenShell header={<CommandHeader command="mcp" description="status" mode="setup" />}>
        <ErrorBox message={error} onBack={onBack} />
      </ScreenShell>
    );
  }

  const actions = results === null && focusedInstalledTarget
    ? [
        {
          key: 'u',
          label: `uninstall ${focusedInstalledTarget.label}`,
          action: { type: 'navigate' as const, command: 'mcp' as const, args: ['status'] },
        },
      ]
    : [];

  return (
    <ScreenShell
      header={<CommandHeader command="mcp" description={results === null ? 'status' : 'uninstalled'} mode="setup" />}
      actions={
        actions.length > 0 ? (
          <ActionBar screenId="mcp.status" actions={actions} onAction={onAction} marginLeft={GAP_SECTION_WIDE} />
        ) : undefined
      }
      hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
    >
      <Box flexDirection="column" gap={GAP_BETWEEN_SECTIONS}>
        {results === null ? (
          targets.map((t, i) => {
            const installed = t.installState !== 'not-installed';
            const isFocused = i === focusedIdx;
            return (
              <Box key={t.id} gap={GAP_ROW}>
                <Text color={isFocused ? colors.brand : undefined}>{isFocused ? icons.pointer : ' '}</Text>
                <Text bold color={isFocused ? colors.brand : undefined}>{t.label}:</Text>
                {installed ? (
                  <>
                    <Text color={colors.success}>{icons.checkmark}</Text>
                    <Text color={colors.success}>installed</Text>
                    <Text dimColor>({t.scope} scope)</Text>
                    <Text dimColor>{formatPathForTerminal(t.configPath)}</Text>
                  </>
                ) : (
                  <>
                    <Text dimColor>–</Text>
                    <Text dimColor>not installed</Text>
                  </>
                )}
              </Box>
            );
          })
        ) : (
          results.map((r) => {
            const ok = r.action === 'removed';
            return (
              <Box key={r.id} gap={GAP_ICON_TEXT}>
                <Text color={ok ? colors.success : colors.warning}>{ok ? icons.checkmark : icons.pending}</Text>
                <Text bold>{r.label}</Text>
                <Text dimColor>{formatPathForTerminal(r.configPath)}</Text>
                <Text dimColor>{r.action}{r.detail !== undefined ? `: ${r.detail}` : ''}</Text>
              </Box>
            );
          })
        )}
      </Box>
    </ScreenShell>
  );
}

// ─── Entry-point ─────────────────────────────────────────────────────────────

interface McpCommandProps {
  args: string[];
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
}

export function McpCommand({ args, onBack, onAction }: McpCommandProps): React.JSX.Element {
  const sub = args[0] ?? 'install';

  if (sub === 'status') {
    return <McpStatus onBack={onBack} onAction={onAction} />;
  }

  if (sub === 'install' || sub === 'uninstall') {
    return <McpInstallWizard onBack={onBack} onAction={onAction} />;
  }

  return (
    <ScreenShell header={<CommandHeader command="mcp" description="unknown subcommand" mode="setup" />}>
      <ErrorBox
        title="Unknown subcommand"
        message={`Unknown subcommand: "${sub}". Available: install, status.`}
        actions={[
          { key: 'i', label: 'install', action: { type: 'navigate' as const, command: 'mcp', args: ['install'] } },
          { key: 's', label: 'status',  action: { type: 'navigate' as const, command: 'mcp', args: ['status'] } },
        ]}
        onAction={onAction}
        onBack={onBack}
      />
    </ScreenShell>
  );
}
