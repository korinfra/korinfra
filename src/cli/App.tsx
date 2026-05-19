import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { spawnSync } from 'node:child_process';
import type { AgentProvider } from '../agent/types.js';
import { createAgentProvider } from '../agent/index.js';
import { getVersion } from '../utils/version.js';
import { levenshtein } from '../utils/string.js';
import type { TuiAction, TuiCommand } from './actions.js';
import { MainMenu } from './components/MainMenu.js';
import { ScanCommand } from './commands/scan.js';
import { CostsCommand } from './commands/costs.js';
import { ResourcesCommand } from './commands/resources.js';
import { RecommendCommand } from './commands/recommend.js';
import { FixCommand } from './commands/fix.js';
import { ReportCommand } from './commands/report.js';
import { HistoryCommand } from './commands/history.js';
import { TagsCommand } from './commands/tags.js';
import { SecurityCommand } from './commands/security.js';
import { CostImpactCommand } from './commands/cost-impact.js';
import { InitCommand } from './commands/init.js';
import { DoctorCommand } from './commands/doctor.js';
import { ConfigCommand } from './commands/config.js';
import { PricingCommand } from './commands/pricing.js';
import { McpCommand } from './commands/mcp.js';
import { ChangesCommand } from './commands/changes.js';
import { CommandPaletteOverlay } from './components/CommandPaletteOverlay.js';
import { ErrorBox } from './components/ErrorBox.js';
import { ThinkingSpinner } from './components/ThinkingSpinner.js';
import { AsciiHeader } from './components/AsciiHeader.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { QuitConfirm } from './components/QuitConfirm.js';
import { ScreenShell } from './components/ScreenShell.js';
import { CommandHeader } from './components/CommandHeader.js';
import { TerminalTooSmall } from './components/TerminalTooSmall.js';
import { InteractionHints, IH_QUIT, IH_HELP } from './components/InteractionHints.js';
import { useConfig } from './hooks/useConfig.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useResizeClear } from './hooks/useResizeClear.js';
import { InputModeContext } from './hooks/useInputMode.js';
import type { InputModeContextValue } from './hooks/useInputMode.js';
import { GlobalOverlayContext } from './hooks/useGlobalOverlay.js';
import type { GlobalOverlayContextValue } from './hooks/useGlobalOverlay.js';
import type { InputMode } from './ui/keys.js';
import { ActiveOpsContext } from './hooks/useActiveOps.js';
import type { ActiveOpsContextValue } from './hooks/useActiveOps.js';
import { InitialRunDoneContext } from './hooks/useInitialRunDone.js';
import type { InitialRunDoneContextValue } from './hooks/useInitialRunDone.js';
import { logger } from '../utils/logger.js';
import { colors, icons } from './theme.js';
import { TUI } from './ui/tokens.js';
import { KNOWN_COMMAND_IDS, COMMAND_REGISTRY } from './commandRegistry.js';
import { GAP_ROW } from './ui/spacing.js';

interface AppProps {
  /** CLI args — process.argv.slice(2) */
  args: string[];
  /** Optionally inject an agent provider (for testing or when already resolved). */
  provider?: AgentProvider | null;
}

type View =
  | { kind: 'menu' }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'scan'; args: string[] }
  | { kind: 'costs'; args: string[] }
  | { kind: 'resources'; args: string[] }
  | { kind: 'recommend'; args: string[] }
  | { kind: 'fix'; args: string[] }
  | { kind: 'report'; args: string[] }
  | { kind: 'history'; args: string[] }
  | { kind: 'tags'; args: string[] }
  | { kind: 'security'; args: string[] }
  | { kind: 'cost-impact'; args: string[] }
  | { kind: 'init'; args: string[] }
  | { kind: 'doctor'; args: string[] }
  | { kind: 'config'; args: string[] }
  | { kind: 'pricing'; args: string[] }
  | { kind: 'mcp'; args: string[] }
  | { kind: 'changes'; args: string[] }
  | { kind: 'unknown'; name: string }
  | { kind: 'prompt'; text: string };

type CommandViewKind = Extract<View['kind'], TuiCommand>;

function commandView(kind: TuiCommand, args: string[] = []): Extract<View, { kind: CommandViewKind }> {
  return { kind, args } as Extract<View, { kind: CommandViewKind }>;
}

function resolveInitialView(args: string[]): View {
  const cmd = args[0];
  const rest = args.slice(1);
  switch (cmd) {
    case 'scan':      return commandView('scan', rest);
    case 'costs':     return commandView('costs', rest);
    case 'resources': return commandView('resources', rest);
    case 'recommend': return commandView('recommend', rest);
    case 'fix':       return commandView('fix', rest);
    case 'report':    return commandView('report', rest);
    case 'history':   return commandView('history', rest);
    case 'tags':      return commandView('tags', rest);
    case 'security':  return commandView('security', rest);
    case 'cost-impact': return commandView('cost-impact', rest);
    case 'init':      return commandView('init', rest);
    case 'doctor':    return commandView('doctor', rest);
    case 'config':      return commandView('config', rest);
    case 'pricing':     return commandView('pricing', rest);
    case 'mcp':         return commandView('mcp', rest);
    case 'changes':     return commandView('changes', rest);
    case undefined:
      return { kind: 'menu' };
    default:
      if (cmd === '--help' || cmd === '-h') return { kind: 'help' };
      if (cmd === '--version' || cmd === '-v') return { kind: 'version' };
      if (cmd !== undefined && cmd !== '') return { kind: 'unknown', name: cmd };
      return { kind: 'menu' };
  }
}

const KNOWN_COMMANDS = KNOWN_COMMAND_IDS;

function suggestCommand(input: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const cmd of KNOWN_COMMANDS) {
    const d = levenshtein(input.toLowerCase(), cmd);
    if (d < bestDist && d <= 2) {
      bestDist = d;
      best = cmd;
    }
  }
  return best;
}

function splitCommandLine(commandLine: string): string[] {
  const normalized = commandLine.trim().replace(/^korinfra\s+/, '');
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }
  return tokens;
}

function viewFromCommandLine(commandLine: string): View {
  const [cmd, ...argv] = splitCommandLine(commandLine);
  if (cmd === undefined) return { kind: 'menu' };
  if (cmd === 'mcp') return commandView('mcp', argv);
  if (KNOWN_COMMANDS.includes(cmd)) return commandView(cmd as TuiCommand, argv);
  return { kind: 'unknown', name: cmd };
}

function isConfigIndependentView(view: View): boolean {
  return view.kind === 'version'
    || view.kind === 'help'
    || view.kind === 'init'
    || view.kind === 'doctor'
    || view.kind === 'pricing'
    || view.kind === 'mcp'
    || view.kind === 'unknown';
}

interface ShellActionResult {
  ok: boolean;
  method?: string | undefined;
  error?: Error | undefined;
}

function runShellAction(command: string, args: string[], input?: string): ShellActionResult {
  try {
    const result = spawnSync(command, args, {
      input,
      encoding: 'utf8',
      stdio: input === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore'],
      timeout: 3000,
      windowsHide: true,
    });
    if (result.error !== undefined) {
      return { ok: false, error: result.error };
    }
    if (result.status !== 0) {
      const msg = result.stderr || `${command} exited with status ${result.status}`;
      return { ok: false, error: new Error(msg) };
    }
    return { ok: true, method: command };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

function openPath(targetPath: string): ShellActionResult {
  if (process.platform === 'win32' && /[&|^<>";\n\r]/.test(targetPath)) {
    return { ok: false, error: new Error('Invalid characters in file path') };
  }

  const candidates: Array<[string, string[]]> = process.platform === 'win32'
    ? [['cmd', ['/c', 'start', '', targetPath]]]
    : process.platform === 'darwin'
      ? [['open', [targetPath]]]
      : [
          ['xdg-open', [targetPath]],
          ['gio', ['open', targetPath]],
          ['sensible-browser', [targetPath]],
        ];

  let lastError: Error | undefined;
  for (const [command, args] of candidates) {
    const result = runShellAction(command, args);
    if (result.ok) return result;
    lastError = result.error;
  }
  return { ok: false, error: lastError };
}

function copyText(text: string): ShellActionResult {
  const candidates: Array<[string, string[]]> = process.platform === 'win32'
    ? [
        ['clip', []],
        ['powershell.exe', ['-NoProfile', '-Command', 'Set-Clipboard']],
      ]
    : process.platform === 'darwin'
      ? [['pbcopy', []]]
      : [
          ['wl-copy', []],
          ['xclip', ['-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--input']],
        ];

  let lastError: Error | undefined;
  for (const [command, args] of candidates) {
    const result = runShellAction(command, args, text);
    if (result.ok) return result;
    lastError = result.error;
  }

  if (process.platform === 'linux') {
    return { ok: false, error: new Error('Clipboard unavailable. Install wl-clipboard, xclip, or xsel.') };
  }
  return { ok: false, error: lastError };
}

interface ActionStatus {
  kind: 'info' | 'error';
  message: string;
}

function ActionStatusBar({ status }: { status: ActionStatus }): React.JSX.Element {
  return (
    <Box marginLeft={TUI.indent.content}>
      <Text color={status.kind === 'error' ? colors.error : colors.info}>
        {status.kind === 'error' ? icons.error : icons.info} {status.message}
      </Text>
    </Box>
  );
}

/**
 * CommandPaletteOverlay with live target preview, did-you-mean
 * suggestions for unknown commands, and footer grammar consistent with
 * InteractionHints.
 */

function VersionView(): React.JSX.Element {
  const { exit } = useApp();
  useEffect(() => { exit(); }, [exit]);
  return <Text>{getVersion()}</Text>;
}

const HELP_GROUP_LABELS: Record<string, string> = {
  analyze: 'Analyze',
  action:  'Actions',
  setup:   'Setup',
};

function HelpView(): React.JSX.Element {
  const { exit } = useApp();
  useEffect(() => { exit(); }, [exit]);

  const visibleCmds = COMMAND_REGISTRY.filter((c) => !c.hidden);
  const groups = ['analyze', 'action', 'setup'] as const;

  return (
    <Box flexDirection="column" gap={GAP_ROW}>
      <Text bold>korinfra — AWS FinOps AI agent</Text>
      <Text dimColor>Usage: korinfra [command] [options]</Text>
      {groups.map((group) => {
        const cmds = visibleCmds.filter((c) => c.group === group);
        if (cmds.length === 0) return null;
        return (
          <Box key={group} flexDirection="column">
            <Text bold>{HELP_GROUP_LABELS[group]}</Text>
            {cmds.map((c) => (
              <Text key={c.id}>{'  '}{c.id.padEnd(12)}{c.description}</Text>
            ))}
          </Box>
        );
      })}
      <Box flexDirection="column">
        <Text bold>Options:</Text>
        <Text>  -h, --help     Show this help message</Text>
        <Text>  -v, --version  Show version number</Text>
        <Text>Run: korinfra &lt;command&gt; --help</Text>
      </Box>
    </Box>
  );
}

export function App({ args, provider = null }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { cols: termWidth, rows: termHeight } = useTerminalSize();
  // Clear stale frame buffer on terminal resize.
  useResizeClear();

  const { config, error: configError, isLoading, reload: reloadConfig } = useConfig();
  // True when ai.provider is configured (not 'none') — used to gate the AI unavailable banner.
  const aiConfigured = config?.ai?.provider !== undefined && config.ai.provider !== 'none';
  const [view, setView] = useState<View>(() => resolveInitialView(args));
  const [resolvedProvider, setResolvedProvider] = useState<AgentProvider | null>(provider);
  const [menuMode, setMenuMode] = useState<'select' | 'type' | 'command' | 'search'>('select');
  const [inputMode, setInputMode] = useState<InputMode>('none');
  // Persist main menu cursor position across navigation and resize
  const [menuSelectedIdx, setMenuSelectedIdx] = useState(0);
  // Increment on every return-to-menu so useInput re-registers in MainMenu
  const [menuMountKey, setMenuMountKey] = useState(0);
  const [, setBackStack] = useState<View[]>([]);
  // runAgainKey increments to remount command components when "Run again" is requested
  const [runAgainKey, setRunAgainKey] = useState(0);
  // fixTarget holds a recommendation ID when navigating from recommend → fix
  const [fixTarget, setFixTarget] = useState<string | null>(null);
  // Global command palette overlay
  const [showPalette, setShowPalette] = useState(false);
  // First char typed after ':' is queued here so palette can pre-fill it
  const [paletteInitialQuery, setPaletteInitialQuery] = useState('');
  // Global help overlay (?)
  const [showHelp, setShowHelp] = useState(false);
  // Action status toast (copy/open feedback)
  const [actionStatus, setActionStatus] = useState<ActionStatus | null>(null);
  const actionStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track in-flight operations to confirm quit
  const [activeOpsCount, setActiveOpsCount] = useState(0);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const activeOpsNextId = useRef(0);
  const activeOpsMap = useRef<Map<string, string>>(new Map());

  const registerOp = useCallback((name: string): string => {
    const id = String(activeOpsNextId.current++);
    activeOpsMap.current.set(id, name);
    setActiveOpsCount(activeOpsMap.current.size);
    return id;
  }, []);

  const unregisterOp = useCallback((id: string): void => {
    activeOpsMap.current.delete(id);
    setActiveOpsCount(activeOpsMap.current.size);
  }, []);

  const activeOpsContextValue: ActiveOpsContextValue = {
    count: activeOpsCount,
    registerOp,
    unregisterOp,
  };

  // Track commands that have completed their initial run so
  // remounts (help overlay close, back from scan) don't re-fire the effect.
  const initialRunDoneSet = useRef<Set<string>>(new Set());
  const initialRunDoneValue: InitialRunDoneContextValue = {
    hasRun: (key) => initialRunDoneSet.current.has(key),
    markRan: (key) => { initialRunDoneSet.current.add(key); },
    clearRun: (key) => { initialRunDoneSet.current.delete(key); },
  };

  const onRunAgain = (): void => setRunAgainKey((k) => k + 1);
  const navigate = (next: View, push = true): void => {
    setMenuMode('select');
    if (push) setBackStack((stack) => [...stack, view]);
    setView(next);
  };
  const goBack = (): void => {
    setMenuMode('select');
    setFixTarget(null);
    setBackStack((stack) => {
      const previous = stack.at(-1) ?? { kind: 'menu' };
      // Force MainMenu remount so useInput re-registers cleanly after command exit
      if (previous.kind === 'menu') setMenuMountKey((k) => k + 1);
      setView(previous);
      return stack.slice(0, -1);
    });
  };
  const goBackAndReload = (): void => { reloadConfig(); goBack(); };

  const showStatus = (status: ActionStatus): void => {
    if (actionStatusTimerRef.current !== null) clearTimeout(actionStatusTimerRef.current);
    setActionStatus(status);
    if (status.kind === 'info') {
      actionStatusTimerRef.current = setTimeout(() => setActionStatus(null), 3000);
    }
  };

  const handleAction = (action: TuiAction): void => {
    switch (action.type) {
      case 'navigate':
        if (action.command === 'fix' && view.kind === 'scan') {
          // Back from fix should land on recommend (loads from DB), not re-run scan
          setMenuMode('select');
          setBackStack((stack) => [...stack, commandView('recommend', [])]);
          setView(commandView('fix', action.args ?? []));
        } else {
          navigate(commandView(action.command, action.args ?? []));
        }
        break;
      case 'open-file': {
        const result = openPath(action.path);
        if (result.ok) {
          showStatus({ kind: 'info', message: 'Opened report.' });
        } else {
          const errMsg = result.error?.message ?? 'Unknown error';
          showStatus({ kind: 'error', message: `Could not open file. ${errMsg}` });
        }
        break;
      }
      case 'copy': {
        const result = copyText(action.text);
        if (result.ok) {
          showStatus({ kind: 'info', message: 'Copied to clipboard.' });
        } else {
          const errMsg = result.error?.message ?? 'Clipboard unavailable.';
          showStatus({ kind: 'error', message: errMsg });
        }
        break;
      }
      case 'back':
        goBack();
        break;
      case 'quit':
        exit();
        break;
      case 'run-again':
        onRunAgain();
        break;
      case 'open-filter':
      case 'copy-id':
      case 'apply-fix':
      case 'preview-dry-run':
      case 'mark':
      case 'filter-toggle':
      case 'sort-toggle':
      case 'dismiss':
        // These action types are handled by command-specific components
        break;
    }
  };

  useEffect(() => {
    if (provider !== null) {
      setResolvedProvider(provider);
      return;
    }

    if (config === null) {
      setResolvedProvider(null);
      return;
    }

    if (config.ai.provider === 'claude') {
      try {
        const p = createAgentProvider('claude', {
          model: config.ai.model,
          apiKeyEnv: config.ai.api_key_env,
          extendedThinking: config.ai.extended_thinking,
          thinkingBudget: config.ai.thinking_budget,
        });
        setResolvedProvider(p);
        // Provider initialized successfully
      } catch (err) {
        setResolvedProvider(null);
        logger.debug({ err }, 'AI provider initialization failed — running in rules-only mode');
      }
      return;
    }

    setResolvedProvider(null);
  }, [provider, config]);

  useInput((_input, key) => {
    if (key.ctrl && _input === 'l') process.stdout.write('\x1bc');
  }, { isActive: true });

  // Dismiss error status on any keypress
  useInput((_input, _key) => {
    if (actionStatus?.kind === 'error') setActionStatus(null);
  }, { isActive: actionStatus?.kind === 'error' });

  // Returns true when a text-input editing state is active and typing shortcuts must be suppressed.
  // 'menu' in type/search/command mode means the user is typing — palette must not intercept.
  // Also suppressed when a command screen has reported a non-none inputMode.
  const isTextInputActive = (v: View, mode: typeof menuMode, iMode: InputMode): boolean =>
    v.kind === 'version' || v.kind === 'help' || mode !== 'select' || iMode !== 'none';

  // Global ':' / Ctrl+K to open command palette from any non-editing screen.
  // Capture any trailing chars typed with ':' (e.g. ':d' from quick typing)
  // by collecting the full input and using everything after ':' as the initial query.
  const paletteEligible = !showPalette && !showHelp && !showQuitConfirm && !isTextInputActive(view, menuMode, inputMode);
  useInput((input, key) => {
    if (key.ctrl && input === 'k') {
      setPaletteInitialQuery('');
      setShowPalette(true);
      return;
    }
    if (input.startsWith(':')) {
      // Everything after ':' seeds the palette input so rapid typing doesn't get lost
      setPaletteInitialQuery(input.slice(1));
      setShowPalette(true);
    }
  }, { isActive: paletteEligible });

  // Global '?' (Shift+/) to open help overlay. Z-order: help > palette >
  // quit-confirm. If palette is open when `?` is pressed, close palette first
  // then open help.
  const helpEligible = !showHelp && !showQuitConfirm && !isTextInputActive(view, menuMode, inputMode);
  useInput((input) => {
    if (input !== '?') return;
    if (showPalette) {
      setShowPalette(false);
      setPaletteInitialQuery('');
    }
    setShowHelp(true);
  }, { isActive: helpEligible });

  // Global 'q' to quit — active in menu select mode and non-menu views (not while typing)
  // If ops are in flight, show a confirm dialog first.
  const quitEligible = !showPalette && !showHelp && !isTextInputActive(view, menuMode, inputMode) && !showQuitConfirm;
  useInput(
    (input) => {
      if (input !== 'q') return;
      if (activeOpsCount > 0) {
        setShowQuitConfirm(true);
      } else {
        exit();
      }
    },
    { isActive: quitEligible },
  );

  // QuitConfirm component owns its own y/n/Esc key handlers.

  // APP-1: Global guard on terminal size — must be after all hooks
  if (termWidth < 40 || termHeight < 18) {
    return <TerminalTooSmall minWidth={40} minHeight={18} cols={termWidth} rows={termHeight} />;
  }

  if (view.kind === 'version') {
    return <VersionView />;
  }

  if (view.kind === 'help') {
    return <HelpView />;
  }

  // Global help / palette / quit-confirm overlays are rendered inside
  // withStatus(). Host command stays mounted so its state and
  // in-flight operations are preserved when an overlay opens/closes.

  if (configError !== null) {
    if (isConfigIndependentView(view)) {
      // Fall through to the command-specific rendering below.
    } else if (view.kind === 'menu') {
      return (
        <MainMenu
          key={menuMountKey}
          isConfigured={false}
          hasAiProvider={resolvedProvider !== null}
          onModeChange={setMenuMode}
          initialSelectedIndex={menuSelectedIdx}
          onSelectedIndexChange={setMenuSelectedIdx}
          onCommand={(cmd) => {
            switch (cmd) {
              case 'init':      navigate(commandView('init', [])); break;
              case 'doctor':    navigate(commandView('doctor', [])); break;
              case 'config':    navigate(commandView('config', [])); break;
              case 'pricing':   navigate(commandView('pricing', [])); break;
              case 'mcp':       navigate(commandView('mcp', [])); break;
              default:          setView({ kind: 'unknown', name: cmd }); break;
            }
          }}
          onCommandLine={(line) => { navigate(viewFromCommandLine(line)); }}
          onPrompt={(text) => {
            setView({ kind: 'prompt', text });
          }}
        />
      );
    } else {
      // ErrorBox owns its own hints — no outer NavHints.
      return (
        <ScreenShell
          header={<CommandHeader command="config" description="configuration error" />}
        >
          <ErrorBox
            title="Configuration error"
            message={configError}
            hint="Initialize config or run diagnostics."
            actions={[
              { key: 'i', label: 'run init', action: { type: 'navigate' as const, command: 'init' } },
              { key: 'd', label: 'run doctor', action: { type: 'navigate' as const, command: 'doctor' } },
            ]}
            onAction={handleAction}
            onBack={goBackAndReload}
          />
        </ScreenShell>
      );
    }
  }

  if (isLoading) {
    if (isConfigIndependentView(view)) {
      // Allow config-independent views to render without waiting for the global config hook.
    } else {
      // Loading screen uses ScreenShell with proper hints
      return (
        <ScreenShell
          header={<AsciiHeader />}
          hints={<InteractionHints hints={[IH_HELP, IH_QUIT]} />}
        >
          <Box marginLeft={TUI.indent.content} flexDirection="column" gap={GAP_ROW}>
            <ThinkingSpinner label="Loading configuration" />
            <Text dimColor>Waiting for config and provider checks…</Text>
          </Box>
        </ScreenShell>
      );
    }
  }

  // Provider errors are no longer fatal — commands work in rules-only mode without AI.
  // Individual commands that require AI show their own error messages.

  const inputModeContextValue: InputModeContextValue = { inputMode, setInputMode };
  const globalOverlayContextValue: GlobalOverlayContextValue = {
    helpOpen: showHelp,
    paletteOpen: showPalette,
    quitConfirmOpen: showQuitConfirm,
  };

  // Compute helpCommand here so withStatus can reference it without duplication.
  const helpCommand = view.kind === 'menu' || view.kind === 'unknown' || view.kind === 'prompt'
    ? 'menu'
    : view.kind;

  const withStatus = (content: React.JSX.Element): React.JSX.Element => {
    const wrapped = (
      <Box flexDirection="column">
        {content}
        {actionStatus !== null && <ActionStatusBar status={actionStatus} />}
      </Box>
    );

    // Z-order: help > palette > quit-confirm. Whichever overlay is topmost
    // fully captures input; the host stays mounted underneath via
    // display="none" so command-screen state (in-flight ops, scroll) survives.
    // Only one overlay is rendered at a time.
    let overlayNode: React.JSX.Element | null = null;
    if (showHelp) {
      overlayNode = (
        <>
          {actionStatus !== null && <ActionStatusBar status={actionStatus} />}
          <HelpOverlay command={helpCommand} onClose={() => setShowHelp(false)} />
        </>
      );
    } else if (showPalette) {
      overlayNode = (
        <>
          {actionStatus !== null && <ActionStatusBar status={actionStatus} />}
          <CommandPaletteOverlay
            initialQuery={paletteInitialQuery}
            onCommandLine={(line) => {
              // Auto-close on navigation (§17.2).
              setShowPalette(false);
              setPaletteInitialQuery('');
              navigate(viewFromCommandLine(line));
            }}
            onClose={() => { setShowPalette(false); setPaletteInitialQuery(''); }}
          />
        </>
      );
    } else if (showQuitConfirm) {
      overlayNode = (
        <>
          {actionStatus !== null && <ActionStatusBar status={actionStatus} />}
          <QuitConfirm
            onConfirm={() => exit()}
            onCancel={() => setShowQuitConfirm(false)}
          />
        </>
      );
    }

    // Keep host mounted (display="none") while overlay is visible so
    // host useEffects do NOT re-fire on close. The host's position in the tree
    // is stable across all branches — this is load-bearing for state retention.
    const withOverlays = (
      <Box flexDirection="column">
        {overlayNode}
        <Box display={overlayNode !== null ? 'none' : 'flex'}>{wrapped}</Box>
      </Box>
    );

    return (
      <GlobalOverlayContext.Provider value={globalOverlayContextValue}>
        <ActiveOpsContext.Provider value={activeOpsContextValue}>
          <InitialRunDoneContext.Provider value={initialRunDoneValue}>
            <InputModeContext.Provider value={inputModeContextValue}>
              {withOverlays}
            </InputModeContext.Provider>
          </InitialRunDoneContext.Provider>
        </ActiveOpsContext.Provider>
      </GlobalOverlayContext.Provider>
    );
  };

  if (view.kind === 'menu') {
    return withStatus(
      <MainMenu
        key={menuMountKey}
        isConfigured={config !== null}
        hasAiProvider={resolvedProvider !== null}
        onModeChange={setMenuMode}
        initialSelectedIndex={menuSelectedIdx}
        onSelectedIndexChange={setMenuSelectedIdx}
        onCommand={(cmd) => {
          switch (cmd) {
            case 'scan':      navigate(commandView('scan', []));      break;
            case 'costs':     navigate(commandView('costs', []));     break;
            case 'resources': navigate(commandView('resources', [])); break;
            case 'recommend': navigate(commandView('recommend', [])); break;
            case 'fix':       navigate(commandView('fix', []));       break;
            case 'report':    navigate(commandView('report', []));    break;
            case 'history':   navigate(commandView('history', []));   break;
            case 'tags':      navigate(commandView('tags', []));      break;
            case 'security':  navigate(commandView('security', []));  break;
            case 'cost-impact': navigate(commandView('cost-impact', [])); break;
            case 'init':      navigate(commandView('init', []));      break;
            case 'doctor':    navigate(commandView('doctor', []));    break;
            case 'config':    navigate(commandView('config', []));    break;
            case 'pricing':   navigate(commandView('pricing', []));   break;
            case 'mcp':       navigate(commandView('mcp', [])); break;
            default:          setView({ kind: 'unknown', name: cmd }); break;
          }
        }}
        onCommandLine={(line) => { navigate(viewFromCommandLine(line)); }}
        onPrompt={(text) => {
          setView({ kind: 'prompt', text });
        }}
      />,
    );
  }

  if (view.kind === 'scan') {
    return withStatus(
      <ScanCommand
        key={runAgainKey}
        provider={resolvedProvider}
        args={view.args}
        onRunAgain={onRunAgain}
        onBack={goBack}
        onAction={handleAction}
        aiConfigured={aiConfigured}
      />,
    );
  }

  if (view.kind === 'costs') {
    return withStatus(
      <CostsCommand
        key={runAgainKey}
        provider={resolvedProvider}
        args={view.args}
        onRunAgain={onRunAgain}
        onBack={goBack}
        onAction={handleAction}
        aiConfigured={aiConfigured}
      />,
    );
  }

  if (view.kind === 'resources') {
    return withStatus(
      <ResourcesCommand
        key={runAgainKey}
        provider={resolvedProvider}
        args={view.args}
        onRunAgain={onRunAgain}
        onBack={goBack}
        onAction={handleAction}
        promptMaxResources={config?.ai.prompt_max_resources}
        promptMaxRecommendations={config?.ai.prompt_max_recommendations}
      />,
    );
  }

  if (view.kind === 'recommend') {
    return withStatus(
      <RecommendCommand
        key={runAgainKey}
        provider={resolvedProvider}
        args={view.args}
        onRunAgain={onRunAgain}
        onBack={goBack}
        onAction={handleAction}
        aiConfigured={aiConfigured}
        promptMaxResources={config?.ai.prompt_max_resources}
        promptMaxRecommendations={config?.ai.prompt_max_recommendations}
      />,
    );
  }

  if (view.kind === 'fix') {
    const fixArgs = fixTarget ? [fixTarget, ...view.args] : view.args;
    return withStatus(
      <FixCommand
        key={runAgainKey}
        provider={resolvedProvider}
        args={fixArgs}
        onRunAgain={onRunAgain}
        onBack={() => { setFixTarget(null); goBack(); }}
        onAction={handleAction}
        aiConfigured={aiConfigured}
      />,
    );
  }

  if (view.kind === 'report') {
    return withStatus(
      <ReportCommand
        key={runAgainKey}
        provider={resolvedProvider}
        args={view.args}
        onRunAgain={onRunAgain}
        onBack={goBack}
        onAction={handleAction}
      />,
    );
  }

  if (view.kind === 'history') {
    return withStatus(
      <HistoryCommand
        key={runAgainKey}
        provider={resolvedProvider}
        args={view.args}
        onRunAgain={onRunAgain}
        onBack={goBack}
        onAction={handleAction}
        aiConfigured={aiConfigured}
      />,
    );
  }

  if (view.kind === 'tags') {
    return withStatus(
      <TagsCommand
        key={runAgainKey}
        provider={resolvedProvider}
        args={view.args}
        onRunAgain={onRunAgain}
        onBack={goBack}
        onAction={handleAction}
        aiConfigured={aiConfigured}
      />,
    );
  }

  if (view.kind === 'security') {
    return withStatus(
      <SecurityCommand
        key={runAgainKey}
        provider={resolvedProvider}
        args={view.args}
        onRunAgain={onRunAgain}
        onBack={goBack}
        onAction={handleAction}
        aiConfigured={aiConfigured}
      />,
    );
  }

  if (view.kind === 'cost-impact') {
    return withStatus(
      <CostImpactCommand
        key={runAgainKey}
        args={view.args}
        onRunAgain={onRunAgain}
        onBack={goBack}
        onAction={handleAction}
      />,
    );
  }

  if (view.kind === 'init') {
    return withStatus(<InitCommand args={view.args} onBack={goBackAndReload} onAction={handleAction} />);
  }

  if (view.kind === 'doctor') {
    return withStatus(<DoctorCommand args={view.args} onBack={goBack} onAction={handleAction} />);
  }

  if (view.kind === 'config') {
    return withStatus(<ConfigCommand args={view.args} onBack={goBack} onAction={handleAction} />);
  }

  if (view.kind === 'pricing') {
    return withStatus(<PricingCommand args={view.args} onBack={goBack} onAction={handleAction} />);
  }

  if (view.kind === 'mcp') {
    return withStatus(<McpCommand args={view.args} onBack={goBack} onAction={handleAction} />);
  }

  if (view.kind === 'changes') {
    return withStatus(<ChangesCommand args={view.args} onBack={goBack} onAction={handleAction} />);
  }

  if (view.kind === 'prompt') {
    return withStatus(
      <ScanCommand
        key={`prompt-${runAgainKey}`}
        provider={resolvedProvider}
        args={['--prompt', view.text]}
        onRunAgain={onRunAgain}
        onBack={goBack}
        onAction={handleAction}
        allowFollowUp={true}
      />,
    );
  }

  // Unknown command — make the suggested command actionable
  const unknownName = view.kind === 'unknown' ? view.name : '';
  const suggestion = suggestCommand(unknownName);
  const suggestionLine = suggestion
    ? `Did you mean "${suggestion}"?`
    : 'Available commands: scan, costs, resources, security, cost-impact, recommend, fix, report, tags, history, init, doctor, config, pricing, mcp.';
  const unknownActions = suggestion !== null
    ? [{ key: 'Enter', label: `run ${suggestion}`, action: { type: 'navigate' as const, command: suggestion as TuiCommand } }]
    : [];
  return withStatus(
    <ScreenShell
      header={<CommandHeader command={unknownName || 'unknown'} description="unknown command" />}
    >
      <ErrorBox
        title={`Unknown command: ${unknownName}`}
        message={suggestionLine}
        hint="Run `korinfra --help` for the full command list."
        actions={unknownActions}
        onAction={handleAction}
        onBack={goBack}
      />
    </ScreenShell>,
  );
}
