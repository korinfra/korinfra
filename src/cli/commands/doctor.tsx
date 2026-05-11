import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useInitialRunDone } from '../hooks/useInitialRunDone.js';

import { Box, Text, useApp, useInput, useStdout } from 'ink';


import { defaultStoragePath } from '../../config/paths.js';
import { buildChecks } from './doctor-checks.js';
import type { CheckResult } from './doctor-checks.js';
import { CommandHeader } from '../components/CommandHeader.js';
import { ActionBar } from '../components/ActionBar.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { TaskProgress } from '../components/TaskProgress.js';
import type { Phase } from '../components/TaskProgress.js';
import { ResultViewport, type ResultBlock } from '../components/ResultViewport.js';
import { colors, icons, noColor, semanticColors, borders } from '../theme.js';
import { InteractionHints, IH_QUIT, IH_CANCEL, IH_BACK, IH_COMMAND, IH_HELP, IH_NAVIGATE } from '../components/InteractionHints.js';
import { GAP_BETWEEN_SECTIONS, GAP_ICON_TEXT, GAP_SECTION_WIDE, PADDING_X } from '../ui/spacing.js';
import { BADGE_PASS, BADGE_FAIL, BADGE_WARN, DOT_SEP } from '../ui/text.js';
import { useTuiViewportLayout } from '../hooks/useTuiViewportLayout.js';
import type { ActionHint, TuiAction } from '../actions.js';
import { truncateWidth } from '../ui/width.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type CheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'warn';

interface Check {
  id: string;
  label: string;
  group: string;
  status: CheckStatus;
  detail?: string;
  /** Optional: specific command to fix this check when it fails. */
  fixCommand?: string;
}

// ─── Phase mapping ────────────────────────────────────────────────────────────

/** Map from group → TaskProgress phase id */
const GROUP_PHASE_MAP: Record<string, string> = {
  'aws-auth': 'aws-auth',
  'config': 'config',
  'ai': 'ai',
  'tools': 'tools',
};

/** Ordered phases for TaskProgress */
const DOCTOR_PHASES: { id: string; label: string }[] = [
  { id: 'config', label: 'config' },
  { id: 'aws-auth', label: 'AWS auth' },
  { id: 'ai', label: 'AI' },
  { id: 'tools', label: 'tools' },
];

function buildTaskPhases(checks: Check[], done: boolean, cancelled: boolean): Phase[] {
  return DOCTOR_PHASES.map((p) => {
    const groupChecks = checks.filter((c) => GROUP_PHASE_MAP[c.group] === p.id);
    if (groupChecks.length === 0) return { id: p.id, label: p.label, status: 'pending' as const };
    const hasRunning = groupChecks.some((c) => c.status === 'running');
    const hasFail = groupChecks.some((c) => c.status === 'fail');
    const allDone = groupChecks.every((c) => c.status === 'pass' || c.status === 'fail' || c.status === 'warn');
    if (hasRunning) return { id: p.id, label: p.label, status: 'current' as const };
    if (allDone && (done || cancelled)) {
      return { id: p.id, label: p.label, status: hasFail ? 'failed' as const : 'completed' as const };
    }
    if (allDone) return { id: p.id, label: p.label, status: 'completed' as const };
    return { id: p.id, label: p.label, status: 'pending' as const };
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface DoctorCommandProps {
  args: string[];
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
}

export function DoctorCommand({ onBack, onAction }: DoctorCommandProps): React.JSX.Element {
  const { exit } = useApp();
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const { stdout } = useStdout();
  const storagePath = defaultStoragePath();
  const checkDefs = useMemo(() => buildChecks(storagePath), [storagePath]);

  // Skip re-running checks when remounting after help-overlay close
  // or navigating back from scan. The App-level set persists across mounts.
  const { hasRun, markRan } = useInitialRunDone();
  // Capture at mount time; stable for the lifetime of this instance.
  const skipInitialRunRef = useRef(hasRun('doctor'));
  // When remounting after a completed run, start in done=true state so the UI
  // shows previous results immediately (all pass) rather than a blank pending screen.
  const initialDone = skipInitialRunRef.current;

  const [checks, setChecks] = useState<Check[]>(() =>
    checkDefs.map((c) => ({
      id: c.id,
      label: c.label,
      group: c.group,
      // On remount show pass state from previous run rather than blank pending.
      status: initialDone ? ('pass') : ('pending'),
      ...(c.fixHint !== undefined ? { fixCommand: c.fixHint } : {}),
    })),
  );
  const [done, setDone] = useState(initialDone);
  const [cancelled, setCancelled] = useState(false);
  const [runKey] = useState(0);
  const [selectedCheckIdx, setSelectedCheckIdx] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startTimeRef = useRef<number>(Date.now());
  const runControllerRef = useRef<AbortController | null>(null);
  // Elapsed timer — update every second while running
  useEffect(() => {
    if (done || cancelled) return;
    startTimeRef.current = Date.now();
    setElapsedMs(0);
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current);
    }, 1000);
    return () => clearInterval(interval);
  }, [runKey, done, cancelled]);


  useInput((input, key) => {
    if (input === 'q') exit();
    if (key.upArrow) {
      setSelectedCheckIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedCheckIdx((i) => Math.min(checks.length - 1, i + 1));
      return;
    }
    // Enter on a failed check navigates to appropriate fix action
    if (key.return && done) {
      const check = checks[selectedCheckIdx];
      if (check?.status === 'fail') {
        if (check.id === 'config' || check.id === 'ai-key') {
          onAction?.({ type: 'navigate' as const, command: 'init' });
        } else if (check.id === 'aws-creds' || check.id === 'aws-sdk' || check.id === 'network') {
          onAction?.({ type: 'navigate' as const, command: 'config', args: ['show'] });
        } else if (check.id === 'sqlite') {
          onAction?.({ type: 'navigate' as const, command: 'doctor' });
        }
      }
      return;
    }
    if (input === 'b' || key.escape) {
      if (!done && !cancelled) {
        runControllerRef.current?.abort();
        setCancelled(true);
        return;
      }
      if (onBack !== undefined) onBack();
    }
  }, { isActive: !helpOpen && !paletteOpen });

  useEffect(() => {
    // If this is a remount (e.g. after HelpOverlay close or
    // navigating back from scan), skip re-running checks. Only the explicit
    // "run again" path (which calls clearRun + increments runKey) should re-run.
    if (skipInitialRunRef.current) {
      // Clear the skip flag so the next explicit re-run works normally.
      skipInitialRunRef.current = false;
      return;
    }

    const controller = new AbortController();
    runControllerRef.current = controller;
    let cancelledLocal = false;
    const defs = checkDefs;

    setDone(false);
    setCancelled(false);
    setChecks(defs.map((c) => ({ id: c.id, label: c.label, group: c.group, status: 'pending', ...(c.fixHint !== undefined ? { fixCommand: c.fixHint } : {}) })));

    // Dependency map: checks that depend on other checks
    const dependencies: Record<string, string[]> = {
      'aws-sdk': ['aws-creds'],   // connectivity depends on credentials
      'network': ['aws-creds'],    // network check depends on credentials
    };
    const failedIds = new Set<string>();

    async function runSequential(): Promise<void> {
      for (const def of defs) {
        if (cancelledLocal || controller.signal.aborted) return;

        // Check if any dependency failed — skip if so
        const deps = dependencies[def.id] ?? [];
        const failedDep = deps.find((d) => failedIds.has(d));
        if (failedDep) {
          const depLabel = defs.find((d) => d.id === failedDep)?.label ?? failedDep;
          setChecks((prev) =>
            prev.map((c) =>
              c.id === def.id
                ? { ...c, status: 'warn', detail: `Skipped: requires ${depLabel} (failed above)` }
                : c,
            ),
          );
          continue;
        }

        // Mark as running
        setChecks((prev) =>
          prev.map((c) => (c.id === def.id ? { ...c, status: 'running' } : c)),
        );

        let result: CheckResult;
        try {
          result = await def.run(controller.signal);
        } catch (err) {
          result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }

        if (cancelledLocal || controller.signal.aborted || result.aborted) return;

        if (!result.ok && !result.optional) {
          failedIds.add(def.id);
        }

        setChecks((prev) =>
          prev.map((c) =>
            c.id === def.id
              ? {
                  ...c,
                  status: result.ok ? 'pass' : result.optional ? 'warn' : 'fail',
                  ...(result.detail !== undefined ? { detail: result.detail } : {}),
                }
              : c,
          ),
        );
      }

      if (!cancelledLocal && !controller.signal.aborted) {
        setDone(true);
        markRan('doctor');
      }
    }

    void runSequential();

    return () => {
      cancelledLocal = true;
      controller.abort();
      if (runControllerRef.current === controller) {
        runControllerRef.current = null;
      }
    };
  }, [storagePath, runKey, checkDefs, markRan]);

  const failed = checks.filter((c) => c.status === 'fail').length;
  const failedConfig = checks.some((c) => c.id === 'config' && c.status === 'fail');
  const failedAi = checks.some((c) => c.id === 'ai-key' && c.status === 'fail');
  const failedAws = checks.some((c) => c.group === 'aws-auth' && c.status === 'fail');
  // All-pass → `s scan now` only. Failures → `i run init again` only.
  const doneActions: ActionHint[] = failed === 0
    ? [
        { key: 's', label: 'scan now', action: { type: 'navigate' as const, command: 'scan' } },
        { key: 'i', label: 'init', action: { type: 'navigate' as const, command: 'init' as const } },
        { key: 'p', label: 'pricing', action: { type: 'navigate' as const, command: 'pricing' as const } },
      ]
    : [
        { key: 'Enter', label: 'run fix', action: { type: 'run-again' as const } },
        { key: 'i', label: 'run init again', action: { type: 'navigate' as const, command: 'init' as const } },
        { key: 's', label: 'scan', action: { type: 'navigate' as const, command: 'scan' } },
        { key: 'p', label: 'pricing', action: { type: 'navigate' as const, command: 'pricing' as const } },
      ];

  // Summary line — `<N> error — <fix hint>.`
  let summaryFixHint: string;
  if (failedAws) summaryFixHint = 'fix credentials to use scan and costs';
  else if (failedConfig) summaryFixHint = 'create a config file';
  else if (failedAi) summaryFixHint = 'configure AI key';
  else summaryFixHint = 'see next steps';
  const summaryLine = failed === 0
    ? 'All checks passed.'
    : `${failed} ${failed === 1 ? 'error' : 'errors'} — ${summaryFixHint}.`;

  // Group checks for display
  const groups = [...new Set(checkDefs.map((c) => c.group))];
  const viewportLayout = useTuiViewportLayout({ status: !done && !cancelled ? 1 : 0 });
  // Compute viewport rows dynamically to leave room for summary + next-steps card.
  const REQUIRED_GROUPS_SET = new Set(['aws-auth', 'config']);
  const failedRequiredWithFix = (done || cancelled)
    ? checks.filter((c) => c.status === 'fail' && REQUIRED_GROUPS_SET.has(c.group) && c.fixCommand !== undefined)
    : [];
  const nextStepsCardRows = failedRequiredWithFix.length > 0
    ? 3 + failedRequiredWithFix.length  // borders(2) + title(1) + N rows
    : 0;
  const checkViewportRows = (done || cancelled)
    ? Math.max(4, viewportLayout.contentRows - 13 - nextStepsCardRows)
    : Math.max(4, viewportLayout.contentRows - 10);
  const termWidth = stdout?.columns ?? 80;
  const detailMaxWidth = Math.max(24, termWidth - (GAP_SECTION_WIDE + 8));
  // Cap label width to prevent row wraps that confuse ResultViewport's
  // single-row block accounting (manifests as "Networknectivity" at 60 cols).
  // Reserve room for indent + pointer + status icon + (optional) badge + (optional) "(optional)" tag.
  const labelMaxWidth = Math.max(16, termWidth - (GAP_SECTION_WIDE + 19));
  const groupLabelMaxWidth = Math.max(12, termWidth - (GAP_SECTION_WIDE + 4));

  // Running step for substep label in TaskProgress
  const runningCheck = checks.find((c) => c.status === 'running');
  // Always pass a string (never undefined) so TaskProgress always renders the substep
  // row, keeping its height fixed at 4 rows during running. If the row were conditional,
  // it would disappear between checks, shifting the viewport by 1 row and leaving stale
  // chars in the terminal that Ink's diff never overwrites.
  const currentStep = runningCheck !== undefined ? runningCheck.label : '';
  const taskPhases = buildTaskPhases(checks, done, cancelled);

  // Separate required from optional checks for visual grouping
  const isOptionalCheck = (id: string): boolean => {
    return checkDefs.find((d) => d.id === id)?.optional === true;
  };


  // Create ResultBlocks for checks — required checks first, then separator, then optional
  const checkBlocks: ResultBlock[] = [];
  const requiredGroups = groups.filter((g) => !checkDefs.filter((c) => c.group === g).every((c) => c.optional === true));
  const optionalGroups = groups.filter((g) => checkDefs.filter((c) => c.group === g).every((c) => c.optional === true));

  function addGroupBlocks(group: string): void {
    const groupChecks = checks.filter((c) => c.group === group);
    if (groupChecks.length === 0) return;
    const groupLabel = group === 'aws-auth' ? 'AWS' : group === 'config' ? 'Configuration' : group === 'ai' ? 'AI' : 'Tools';

    // Group heading must be its own line — use a single row box directly
    // so ResultViewport does not allow inline continuation from adjacent blocks.
    // Reserve 2 rows: 1 for the heading + 1 for the leading margin so the
    // viewport's row accounting matches what Ink actually paints (prevents the
    // "• Configurationint reachable" overlap and "•  I✔" AI collision).
    checkBlocks.push({
      key: `group-${group}`,
      rows: 2,
      element: (
        <Box
          flexDirection="row"
          gap={GAP_BETWEEN_SECTIONS}
          marginTop={GAP_BETWEEN_SECTIONS}
          marginLeft={GAP_SECTION_WIDE}
          overflow="hidden"
        >
          <Text dimColor>•</Text>
          <Text dimColor bold>{truncateWidth(groupLabel, groupLabelMaxWidth)}</Text>
        </Box>
      ),
    });

    for (const check of groupChecks) {
      const absIdx = checks.findIndex((c) => c.id === check.id);
      const isSelected = done && absIdx === selectedCheckIdx;
      const isOptionalWarn = check.status === 'warn' && !(check.detail?.includes('Skipped') === true);
      // Always rows=2: label row + detail row. Keeping row count stable means Ink
      // Gate detail on done/cancelled so block height stays fixed at 2 rows during
      // running — each check completing would otherwise flip blank→text, shifting
      // all subsequent block positions and leaving stale chars Ink can't overwrite.
      const detailText = (done || cancelled) && check.status !== 'running' && check.detail
        ? check.detail
        : null;

      checkBlocks.push({
        key: check.id,
        rows: 2,
        element: (
          <Box key={check.id} flexDirection="column" overflow="hidden">
            <Box gap={GAP_BETWEEN_SECTIONS} marginLeft={GAP_SECTION_WIDE} overflow="hidden">
              {/* Fixed-width pointer box (always 2 cols) prevents stale chars on selection toggle. */}
              <Box width={2}>
                <Text color={isSelected ? colors.brand : undefined}>{isSelected ? icons.pointer : ''}</Text>
              </Box>
              <Box width={2}>
                <Text color={check.status === 'pass' ? semanticColors.status.pass : check.status === 'fail' ? semanticColors.status.fail : colors.muted}>
                  {check.status === 'pass' ? icons.checkmark : check.status === 'fail' ? icons.cross : check.status === 'warn' ? '–' : icons.pending}
                </Text>
              </Box>
              {noColor && (
                <Text>
                  {check.status === 'pass' ? BADGE_PASS : check.status === 'fail' ? BADGE_FAIL : check.status === 'warn' ? BADGE_WARN : ''}
                </Text>
              )}
              <Text color={isSelected ? colors.brand : check.status === 'pass' ? undefined : check.status === 'fail' ? semanticColors.status.fail : check.status === 'warn' ? colors.muted : colors.muted} dimColor={check.status === 'warn'}>
                {truncateWidth(check.label, labelMaxWidth)}
              </Text>
              {/* DR-1: always show (optional) badge for optional checks */}
              {(isOptionalCheck(check.id) || isOptionalWarn) && (
                <Text dimColor>(optional)</Text>
              )}
            </Box>
            {/* Detail row — height={1} on the outer Box forces exactly 1 terminal row
                regardless of whether there is content. Ink's yoga layout allocates the
                row unconditionally, so the virtual buffer always matches the terminal. */}
            <Box height={1} marginLeft={GAP_SECTION_WIDE + 4}>
              {detailText !== null && (
                check.status === 'warn' && detailText.includes('Skipped') ? (
                  <Text dimColor>{truncateWidth(detailText, detailMaxWidth)}</Text>
                ) : check.status === 'fail' ? (
                  <Text color={semanticColors.status.fail} dimColor>{truncateWidth(detailText, detailMaxWidth)}</Text>
                ) : (
                  <Text dimColor>{truncateWidth(detailText, detailMaxWidth)}</Text>
                )
              )}
            </Box>
          </Box>
        ),
      });
    }
  }

  // Required section header
  if (requiredGroups.length > 0) {
    checkBlocks.push({
      key: 'required-header',
      rows: 1,
      element: (
        <Box marginLeft={GAP_SECTION_WIDE}>
          <Text dimColor bold>Required</Text>
        </Box>
      ),
    });
  }
  for (const group of requiredGroups) {
    addGroupBlocks(group);
  }

  if (optionalGroups.length > 0) {
    // Separator + Optional section header
    checkBlocks.push({
      key: 'optional-sep',
      rows: 2,
      element: (
        <Box marginLeft={GAP_SECTION_WIDE} marginTop={GAP_BETWEEN_SECTIONS}>
          <Text dimColor bold>Optional</Text>
        </Box>
      ),
    });
    for (const group of optionalGroups) {
      addGroupBlocks(group);
    }
  }

  return (
    <ScreenShell
      header={
        <CommandHeader
          command="doctor"
          variant="compact"
          description="environment check"
          scope={`${process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1'}${DOT_SEP}${process.env['AWS_PROFILE'] ?? 'default'}`}
        />
      }
      actions={
        (done || cancelled) ? (
          <ActionBar
            actions={doneActions}
            onAction={(action) => {
              onAction?.(action);
            }}
          />
        ) : undefined
      }
      hints={
        <InteractionHints hints={
          // running: q quit (+ cancel)
          // all-pass: q quit
          // failures: ↑↓ navigate checks · Enter run fix · : command · ? help · q quit
          !done && !cancelled
            ? [IH_CANCEL, IH_QUIT]
            : failed === 0
              ? [
                  IH_COMMAND,
                  IH_HELP,
                  ...(onBack !== undefined ? [IH_BACK] : []),
                  IH_QUIT,
                ]
              : [
                  IH_NAVIGATE,
                  IH_COMMAND,
                  IH_HELP,
                  ...(onBack !== undefined ? [IH_BACK] : []),
                  IH_QUIT,
                ]
        } />
      }
    >
      {/* Summary line — `All checks passed.` or `<N> error — <fix>.` */}
      {(done || cancelled) && (
        <>
          <Box marginLeft={GAP_SECTION_WIDE} marginTop={GAP_BETWEEN_SECTIONS} gap={GAP_ICON_TEXT}>
            <Text color={failed === 0 ? semanticColors.status.pass : semanticColors.status.fail}>
              {failed === 0 ? icons.success : icons.error}
            </Text>
            <Text color={failed === 0 ? semanticColors.status.pass : semanticColors.status.fail}>
              {summaryLine}
            </Text>
          </Box>
              {/* 3 spacers — keep viewport at the same terminal row in both running and done
              states so Ink's incremental diff never needs to reconcile a positional shift.
              <Box height={1}/> forces yoga to allocate exactly 1 row (unlike <Text> </Text>
              which outputs 0 terminal rows and would desync the virtual buffer). */}
          <Box height={1} />
          <Box height={1} />
          <Box height={1} />
        </>
      )}

      {/* TaskProgress while running */}
      {!done && !cancelled && (
        <Box marginLeft={GAP_SECTION_WIDE} marginBottom={GAP_BETWEEN_SECTIONS}>
          <TaskProgress
            phases={taskPhases}
            currentStep={currentStep}
            elapsedMs={elapsedMs}
          />
        </Box>
      )}

      {/* Scrollable checks */}
      <Box marginTop={GAP_BETWEEN_SECTIONS}>
        <ResultViewport blocks={checkBlocks} viewportRows={checkViewportRows} isActive={done} />
      </Box>

      {/* Next-steps card — failed required checks with fix commands */}
      {(done || cancelled) && (() => {
        const REQUIRED_GROUPS = new Set(['aws-auth', 'config']);
        const failedRequired = checks.filter(
          (c) => c.status === 'fail' && REQUIRED_GROUPS.has(c.group) && c.fixCommand !== undefined,
        );
        if (failedRequired.length === 0) return null;
        return (
          <Box
            marginLeft={GAP_SECTION_WIDE}
            flexDirection="column"
            borderStyle={borders.card}
            borderColor={colors.warning}
            paddingX={PADDING_X}
            marginTop={GAP_BETWEEN_SECTIONS}
          >
            <Text bold color={colors.warning}>Next steps</Text>
            {failedRequired.map((c) => (
              <Text key={c.id} dimColor>
                <Text>{c.label}: </Text>
                <Text color={colors.brand}>{c.fixCommand}</Text>
              </Text>
            ))}
          </Box>
        );
      })()}

    </ScreenShell>
  );
}
