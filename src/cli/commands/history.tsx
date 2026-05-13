import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';

import type { AgentProvider } from '../../agent/types.js';
import { DirectPipeline } from '../components/DirectPipeline.js';
import { HybridPipeline } from '../components/HybridPipeline.js';
import type { PipelineContext, CommandResultView } from '../components/DirectPipeline.js';
import { ErrorBox } from '../components/ErrorBox.js';
import { CommandHeader } from '../components/CommandHeader.js';
import { CommandStateShell } from '../components/CommandStateShell.js';
import { ActionBar } from '../components/ActionBar.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { SkeletonRow } from '../components/SkeletonRow.js';
import { DataTable } from '../components/DataTable.js';
import type { ColumnDef } from '../components/DataTable.js';
import { getDb } from '../../storage/db.js';
import { listScans, deleteScan } from '../../storage/queries/scans.js';
import type { Scan } from '../../storage/queries/scans.js';
import { colors, icons, semanticColors } from '../theme.js';
import { InteractionHints, IH_QUIT, IH_BACK, IH_COMMAND, IH_HELP, IH_NAVIGATE } from '../components/InteractionHints.js';
import { GAP_BETWEEN_SECTIONS, GAP_ICON_TEXT, MARGIN_LEFT_RESULT, GAP_SECTION_WIDE, GAP_ROW } from '../ui/spacing.js';
import { DOT_SEP } from '../ui/text.js';
import { SectionTitle } from '../ui/typography.js';
import { EmptyState } from '../components/EmptyState.js';
import { getAnalysisPrompt } from '../../agent/prompts.js';
import { buildHistoryPipelineSteps, extractScanDetail, extractScanDiff } from '../pipelines/history.js';
import { buildHistoryAnalysisPrompt } from '../pipelines/analysis.js';
import type { ActionHint, TuiAction } from '../actions.js';
import { formatMoneyExact, formatTimestamp } from '../ui/format.js';
import { truncateWidth } from '../ui/width.js';
import { AiStatusBanner } from '../components/AiStatusBanner.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';

type HistorySubcommand = 'list' | 'show' | 'diff' | 'prune';

const VALID_SUBCOMMANDS = new Set(['list', 'show', 'diff', 'prune']);

const sanitize = (s: string): string => s.replace(/[\n\r]/g, '').trim().slice(0, 100);

function parseArgs(args: string[]): {
  subcommand: HistorySubcommand | null;
  invalidSubcommand: string | null;
  id1: string | null;
  id2: string | null;
} {
  if (args.includes('--prune')) {
    return { subcommand: 'prune', invalidSubcommand: null, id1: null, id2: null };
  }

  const positional = args.filter((a) => !a.startsWith('-'));

  const rawSub = positional[0] ?? 'list';
  if (!VALID_SUBCOMMANDS.has(rawSub)) {
    return { subcommand: null, invalidSubcommand: rawSub, id1: null, id2: null };
  }

  const subcommand = rawSub as HistorySubcommand;
  const id1 = positional[1] ? sanitize(positional[1]) : null;
  const id2 = positional[2] ? sanitize(positional[2]) : null;

  return { subcommand, invalidSubcommand: null, id1, id2 };
}

function parseKeepLast(args: string[]): number {
  for (const a of args) {
    if (a.startsWith('--keep-last=')) {
      const n = Number(a.slice('--keep-last='.length));
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return 10;
}

function PruneScreen({
  args,
  onBack,
  onAction,
}: {
  args: string[];
  onBack?: (() => void) | undefined;
  onAction?: ((action: TuiAction) => void) | undefined;
}): React.JSX.Element {
  const { exit } = useApp();
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const keepLast = parseKeepLast(args);

  const [stage, setStage] = useState<'loading' | 'confirm' | 'deleting' | 'done' | 'empty'>('loading');
  const [scans, setScans] = useState<Scan[]>([]);
  const [deletedCount, setDeletedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const db = getDb();
      const all = listScans(db, 1000);
      setScans(all);
      if (all.length <= keepLast) {
        setStage('empty');
      } else {
        setStage('confirm');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage('empty');
    }
  }, [keepLast]);

  const toDelete = useMemo(
    () => scans.length > keepLast ? scans.slice(keepLast) : [],
    [scans, keepLast],
  );

  useInput((input, key) => {
    if (input === 'q') { exit(); return; }
    if (stage === 'confirm') {
      if (key.return) {
        setStage('deleting');
        return;
      }
      if (input === 'b' || key.escape) {
        if (onBack !== undefined) onBack();
        else exit();
      }
      return;
    }
    if (stage === 'done' || stage === 'empty') {
      if (input === 'b' || key.escape) {
        if (onBack !== undefined) onBack();
        else exit();
      }
    }
  }, { isActive: !helpOpen && !paletteOpen });

  useEffect(() => {
    if (stage !== 'deleting') return;
    try {
      const db = getDb();
      let count = 0;
      for (const scan of toDelete) {
        deleteScan(db, scan.id);
        count++;
      }
      setDeletedCount(count);
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage('done');
    }
  }, [stage, toDelete]);

  if (error !== null && stage !== 'done') {
    return (
      <ScreenShell
        header={<CommandHeader command="history" description="scan history" scope="prune" />}
      >
        <ErrorBox
          title="Could not prune scans"
          message={error}
          actions={[{ key: 'l', label: 'history list', action: { type: 'navigate' as const, command: 'history', args: ['list'] } }]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  if (stage === 'loading') {
    return (
      <ScreenShell
        header={<CommandHeader command="history" description="scan history" scope="prune" />}
        hints={<InteractionHints hints={[IH_QUIT]} />}
      >
        <Box marginLeft={MARGIN_LEFT_RESULT} marginTop={GAP_BETWEEN_SECTIONS}>
          <Text dimColor>Loading scans…</Text>
        </Box>
      </ScreenShell>
    );
  }

  if (stage === 'empty') {
    return (
      <ScreenShell
        header={<CommandHeader command="history" description="scan history" scope="prune" />}
        actions={
          <ActionBar
            actions={[{ key: 'l', label: 'history list', action: { type: 'navigate' as const, command: 'history', args: ['list'] } }]}
            onAction={onAction}
          />
        }
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
      >
        <Box marginLeft={MARGIN_LEFT_RESULT} marginTop={GAP_BETWEEN_SECTIONS}>
          <Text dimColor>Nothing to prune — fewer than {keepLast} scans in history.</Text>
        </Box>
      </ScreenShell>
    );
  }

  if (stage === 'confirm') {
    return (
      <ScreenShell
        header={<CommandHeader command="history" description="scan history" scope="prune" />}
        actions={
          <ActionBar
            actions={[
              { key: 'Enter', label: 'confirm prune', action: { type: 'run-again' as const } },
            ]}
            onAction={(action) => {
              if (action.type === 'run-again') {
                setStage('deleting');
                return;
              }
              onAction?.(action);
            }}
          />
        }
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
      >
        <Box marginLeft={MARGIN_LEFT_RESULT} marginTop={GAP_BETWEEN_SECTIONS} flexDirection="column" gap={GAP_ROW}>
          <Text>
            This will delete <Text bold color={colors.warning}>{toDelete.length}</Text> scan{toDelete.length === 1 ? '' : 's'} older than the last {keepLast}.
          </Text>
        </Box>
      </ScreenShell>
    );
  }

  if (stage === 'deleting') {
    return (
      <ScreenShell
        header={<CommandHeader command="history" description="scan history" scope="prune" />}
        hints={<InteractionHints hints={[IH_QUIT]} />}
      >
        <Box marginLeft={MARGIN_LEFT_RESULT} marginTop={GAP_BETWEEN_SECTIONS}>
          <Text dimColor>Deleting {toDelete.length} scan{toDelete.length === 1 ? '' : 's'}…</Text>
        </Box>
      </ScreenShell>
    );
  }

  // done
  return (
    <ScreenShell
      header={<CommandHeader command="history" description="scan history" scope="prune" />}
      actions={
        <ActionBar
          actions={[
            { key: 'l', label: 'history list', action: { type: 'navigate' as const, command: 'history', args: ['list'] } },
          ]}
          onAction={onAction}
        />
      }
      hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
    >
      <Box marginLeft={MARGIN_LEFT_RESULT} marginTop={GAP_BETWEEN_SECTIONS} gap={GAP_ICON_TEXT}>
        <Text color={colors.success}>{icons.checkmark}</Text>
        <Text>Deleted {deletedCount} scan{deletedCount === 1 ? '' : 's'}.</Text>
      </Box>
    </ScreenShell>
  );
}

/** Format duration between two ISO timestamps as "Xm Ys" or "Xs", or "—" if unavailable. */
function formatScanDuration(scan: { started_at?: unknown; completed_at?: unknown }): string {
  const startedAt = typeof scan.started_at === 'string' ? scan.started_at : '';
  const completedAt = typeof scan.completed_at === 'string' ? scan.completed_at : '';
  if (!completedAt || !startedAt) return '—';
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(completedAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return '—';
  const secs = Math.round((endMs - startMs) / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// Helper to create history columns with optional baseId for [base] label
function getHistoryColumns(baseId?: string | null): ColumnDef<Scan>[] {
  return [
    {
      key: 'started_at',
      label: 'Date',
      width: 19,
      priority: 1,
      renderCell: (v) => <Text dimColor>{formatTimestamp(String((v as string | number | null | undefined) ?? ''))}</Text>,
    },
    {
      key: 'total_resources',
      label: 'Resources',
      width: 10,
      priority: 2,
      renderCell: (value) => {
        const n = Number(value);
        return <Text color={n > 0 ? colors.info : undefined}>{String((value as string | number | null | undefined) ?? '0')}</Text>;
      },
    },
    {
      key: 'total_recommendations',
      label: 'Findings',
      width: 9,
      priority: 1,
      renderCell: (value) => {
        const n = Number(value);
        const color = n >= 50 ? semanticColors.severity.high
          : n >= 20 ? semanticColors.severity.medium
          : n >= 1 ? colors.warning
          : undefined;
        return <Text color={color}>{String((value as string | number | null | undefined) ?? '0')}</Text>;
      },
    },
    {
      key: 'started_at',
      label: 'Duration',
      width: baseId ? 18 : 9,
      priority: 3,
      renderCell: (_v, row) => {
        const duration = formatScanDuration(row);
        const isBase = baseId && row.id === baseId;
        if (isBase) {
          return <Text>{duration}<Text color={colors.brand}>  [base]</Text></Text>;
        }
        return <Text>{duration}</Text>;
      },
    },
  ];
}


function HistoryListScreen({
  onBack,
  onAction,
  onSetTrend,
  lastDiffTrend,
}: {
  onBack?: (() => void) | undefined;
  onAction?: ((action: TuiAction) => void) | undefined;
  onSetTrend?: ((trend: string | null) => void) | undefined;
  lastDiffTrend?: string | null;
}): React.JSX.Element {
  const { exit } = useApp();
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [compareBaseId, setCompareBaseId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const db = getDb();
      setScans(listScans(db, 50));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScans([]);
    }
  }, []);

  const total = scans?.length ?? 0;
  const selectedScan = scans?.[selectedIdx];
  const baseScan = compareBaseId === null ? null : scans?.find((scan) => scan.id === compareBaseId) ?? null;

  const triggerMarkOrDiff = (): void => {
    if (selectedScan === undefined) return;
    if (compareBaseId === null) {
      setCompareBaseId(selectedScan.id);
      return;
    }
    if (compareBaseId === selectedScan.id) {
      setCompareBaseId(null);
      return;
    }
    onAction?.({ type: 'navigate' as const, command: 'history', args: ['diff', compareBaseId, selectedScan.id] });
  };

  useInput((input, key) => {
    if (input === 'q') {
      exit();
      return;
    }
    if ((input === 'b' || key.escape) && compareBaseId !== null) {
      setCompareBaseId(null);
      return;
    }
    if ((input === 'b' || key.escape) && onBack !== undefined) {
      onSetTrend?.(null);
      onBack();
      return;
    }
    if (input === 'b' || key.escape) {
      onSetTrend?.(null);
      exit();
      return;
    }
    if (total === 0 || selectedScan === undefined) return;
    // Enter: view scan details, or if one base is marked, trigger diff with second scan
    if (key.return) {
      if (compareBaseId !== null && compareBaseId !== selectedScan.id) {
        onAction?.({ type: 'navigate' as const, command: 'history', args: ['diff', compareBaseId, selectedScan.id] });
        return;
      }
      onAction?.({ type: 'navigate' as const, command: 'history', args: ['show', selectedScan.id] });
      return;
    }
    // Space handler moved to ActionBar (actions array above)
  }, { isActive: !helpOpen && !paletteOpen });

  if (error !== null) {
    return (
      <CommandStateShell
        command="history"
        description="scan history"
        state="error"
        errorMessage={error}
        onBack={onBack}
      />
    );
  }
  if (scans === null) {
    return (
      <CommandStateShell
        command="history"
        description="scan history"
        state="loading"
        onBack={onBack}
        loadingChildren={
          <Box flexDirection="column" gap={0}>
            {[0, 1, 2].map(i => (
              <SkeletonRow key={i} columns={[12, 20, 8, 12, 6]} />
            ))}
          </Box>
        }
      />
    );
  }

  // Trend banner shown on return from diff (passed from parent component)
  const trendLine = lastDiffTrend ?? null;

  // List with header subtitle "last N scans"
  const domainActions = [
    { key: 'Space' as const, label: 'mark for diff', action: { type: 'mark' as const } },
    ...(selectedScan !== undefined ? ([
      {
        key: 'd' as const,
        label: 'diff',
        action: {
          type: 'navigate' as const,
          command: 'history' as const,
          args: compareBaseId !== null && compareBaseId !== selectedScan.id
            ? ['diff', compareBaseId, selectedScan.id]
            : ['diff', selectedScan.id],
        },
      },
    ] satisfies ActionHint[]) : []),
    { key: 'p' as const, label: 'report', action: { type: 'navigate' as const, command: 'report' as const, args: ['--format', 'html'] } },
  ] satisfies ActionHint[];

  return (
    <ScreenShell
      header={
        <CommandHeader
          command="history"
          description="scan history"
          variant="compact"
          scope={`last ${total} scans`}
        />
      }
      actions={total > 0 ? (
        <ActionBar
          actions={domainActions}
          onAction={(action) => {
            if (action.type === 'mark') {
              triggerMarkOrDiff();
              return;
            }
            if (action.type === 'run-again') {
              if (selectedScan === undefined) return;
              if (compareBaseId !== null && compareBaseId !== selectedScan.id) {
                onAction?.({ type: 'navigate' as const, command: 'history', args: ['diff', compareBaseId, selectedScan.id] });
                return;
              }
              onAction?.({ type: 'navigate' as const, command: 'history', args: ['show', selectedScan.id] });
              return;
            }
            onAction?.(action);
          }}
        />
      ) : undefined}
      hints={<InteractionHints hints={[IH_NAVIGATE, IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
    >
      {baseScan !== null && (
        <Box marginLeft={MARGIN_LEFT_RESULT} marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text dimColor>Base: {formatTimestamp(baseScan.started_at)} {DOT_SEP} Space on another row to diff</Text>
        </Box>
      )}
      {trendLine !== null && (
        <Box marginLeft={MARGIN_LEFT_RESULT} marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text dimColor>{trendLine}</Text>
        </Box>
      )}
      <DataTable
        columns={getHistoryColumns(compareBaseId)}
        rows={scans}
        selectedIndex={selectedIdx}
        onSelect={setSelectedIdx}
        getRowKey={(row) => row.id}
        chromeRows={14 + (baseScan !== null ? 2 : 0) + (trendLine !== null ? 2 : 0)}
      />
    </ScreenShell>
  );
}

export interface HistoryCommandProps {
  args: string[];
  provider: AgentProvider | null;
  onRunAgain?: () => void;
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
  aiConfigured?: boolean;
}

export function HistoryCommand({ args, provider, onRunAgain, onBack, onAction, aiConfigured = false }: HistoryCommandProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const { subcommand, invalidSubcommand, id1, id2 } = parseArgs(args);

  const [scanCount, setScanCount] = useState<number | null>(null);
  const [lastDiffTrend, setLastDiffTrend] = useState<string | null>(null);
  const [pipelineHasError, setPipelineHasError] = useState(false);

  useEffect(() => {
    if (subcommand !== null && subcommand !== 'list') { setScanCount(-1); return; }
    try {
      const db = getDb();
      const scans = listScans(db, 1);
      setScanCount(scans.length);
    } catch {
      setScanCount(-1);
    }
  }, [subcommand]);

  // Back navigation for the empty-history dead-end state — must be unconditional (hooks rule).
  useInput((_input, key) => {
    if (_input === 'q') exit();
    if (_input === 's') {
      onAction?.({ type: 'navigate' as const, command: 'scan' });
      return;
    }
    if ((key.escape || _input === 'b')) {
      if (onBack !== undefined) onBack();
      else exit();
    }
  }, { isActive: scanCount === 0 && !helpOpen && !paletteOpen });

  // Hooks must be called unconditionally — before any early returns.
  // Coerce subcommand to a pipeline-valid value (prune is handled as early return below).
  const pipelineSubcommand = (subcommand === 'list' || subcommand === 'show' || subcommand === 'diff') ? subcommand : 'list';
  const handleDetailBack = onBack;
  const pipelineSteps = useMemo(
    () => buildHistoryPipelineSteps({ subcommand: pipelineSubcommand, id1, id2 }),
    [pipelineSubcommand, id1, id2],
  );

  if (subcommand === 'prune') {
    return <PruneScreen args={args} onBack={onBack} onAction={onAction} />;
  }

  if (subcommand === null) {
    return (
      <ScreenShell
        header={<CommandHeader command="history" description="scan history" />}
      >
        <ErrorBox
          title="Invalid subcommand"
          message={`Unknown subcommand "${invalidSubcommand ?? ''}". Valid subcommands: list, show, diff, prune`}
          actions={[
            { key: 'l', label: 'show history list', action: { type: 'navigate' as const, command: 'history', args: ['list'] } },
            { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'scan' } },
          ]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  if (subcommand === 'show' && id1 === null) {
    return (
      <ScreenShell
        header={<CommandHeader command="history" description="scan history" />}
      >
        <ErrorBox
          title="Missing scan ID"
          message='"history show" requires a scan ID. Open the history list and choose a scan.'
          actions={[
            { key: 'l', label: 'history list', action: { type: 'navigate' as const, command: 'history', args: ['list'] } },
            { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'scan' } },
          ]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  if (subcommand === 'diff' && (id1 === null || id2 === null)) {
    return (
      <ScreenShell
        header={<CommandHeader command="history" description="scan history" />}
      >
        <ErrorBox
          title="Missing scan IDs"
          message='"history diff" requires two scan IDs. Open the history list and choose scans to compare.'
          actions={[
            { key: 'l', label: 'history list', action: { type: 'navigate' as const, command: 'history', args: ['list'] } },
            { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'scan' } },
          ]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  if (subcommand === 'diff' && id1 === id2) {
    return (
      <ScreenShell
        header={<CommandHeader command="history" description="scan history" />}
      >
        <ErrorBox
          title="Same scan IDs"
          message="Diff requires two different scan IDs."
          actions={[{ key: 'l', label: 'show history list', action: { type: 'navigate' as const, command: 'history', args: ['list'] } }]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  if (subcommand === 'list') {
    if (scanCount === null) {
      return (
        <CommandStateShell
          command="history"
          description="scan history"
          state="loading"
          onBack={onBack}
          loadingChildren={
            <Box flexDirection="column" gap={0}>
              {[0, 1, 2].map(i => (
                <SkeletonRow key={i} columns={[12, 20, 8, 12, 6]} />
              ))}
            </Box>
          }
        />
      );
    }
    if (scanCount === 0) {
      return (
        <ScreenShell
          header={<CommandHeader command="history" description="scan history" scope="no scan history" />}
          actions={
            <ActionBar
              actions={[{ key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'scan' } }]}
              onAction={onAction}
            />
          }
          hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
        >
          <EmptyState message="No scan history yet." hint="Run a scan to start tracking changes." />
        </ScreenShell>
      );
    }
    if (scanCount > 0) {
      return <HistoryListScreen onBack={onBack} onAction={onAction} onSetTrend={setLastDiffTrend} lastDiffTrend={lastDiffTrend} />;
    }
  }

  const subtitle: Record<Exclude<HistorySubcommand, 'prune'>, string> = {
    list: 'scan history',
    show: `scan ${id1?.slice(0, 10) ?? ''}`,
    diff: `diff: ${id1?.slice(0, 10) ?? ''} vs ${id2?.slice(0, 10) ?? ''}`,
  };

  // Detail render
  const renderScanDetail = (ctx: PipelineContext): CommandResultView => {
    const { scan, resources, costs, recommendations } = extractScanDetail(ctx);
    const scanId = String((scan['id'] as string | number | null | undefined) ?? '');
    const recommendationRows = recommendations as Array<Record<string, unknown>>;
    const pendingCount = recommendationRows.filter((rec) => {
      const status = String((rec['status'] as string | null | undefined) ?? 'draft').toLowerCase();
      return status === 'draft' || status === 'pending';
    }).length;
    const appliedCount = recommendationRows.filter((rec) => String((rec['status'] as string | null | undefined) ?? '').toLowerCase() === 'applied').length;
    const dismissedCount = recommendationRows.filter((rec) => String((rec['status'] as string | null | undefined) ?? '').toLowerCase() === 'dismissed').length;
    const scenarioA = Number(scan['scenario_a_count'] ?? 0);
    const scenarioB = Number(scan['scenario_b_count'] ?? 0);
    const scenarioC = Number(scan['scenario_c_count'] ?? 0);
    const duration = formatScanDuration(scan);
    const scanStatus = String((scan['status'] as string | null | undefined) ?? 'completed');
    const firstPendingRecommendationId = recommendationRows.find((rec) => {
      const status = rec['status'];
      return (status === undefined || (status as string) === 'draft') && typeof rec['id'] === 'string';
    })?.['id'] as string | undefined;
    const elements: React.JSX.Element[] = [
      <SectionTitle key="header">Scan {scanId.slice(0, 8)}</SectionTitle>,
      <Text key="date" dimColor>Date: {formatTimestamp(String((scan['started_at'] as string | null | undefined) ?? (scan['created_at'] as string | null | undefined) ?? ''))}</Text>,
      <Box key="meta" gap={GAP_SECTION_WIDE}>
        <Text dimColor>Status: <Text color={scanStatus === 'completed' ? colors.success : colors.warning}>{scanStatus}</Text></Text>
        <Text dimColor>Duration: <Text color={colors.info}>{duration}</Text></Text>
      </Box>,
      <Box key="stats" gap={GAP_SECTION_WIDE}>
        <Text dimColor>Resources: <Text color={colors.info}>{resources.length}</Text></Text>
        <Text dimColor>Cost entries: <Text color={semanticColors.cost.value}>{costs.length}</Text></Text>
        <Text dimColor>Recommendations: <Text color={recommendations.length > 0 ? colors.warning : colors.success}>{recommendations.length}</Text></Text>
      </Box>,
      <Box key="rec-stats" gap={GAP_SECTION_WIDE}>
        <Text>Pending: <Text color={pendingCount > 0 ? colors.warning : colors.success}>{pendingCount}</Text></Text>
        <Text>Applied: <Text color={colors.success}>{appliedCount}</Text></Text>
        <Text>Dismissed: {dismissedCount}</Text>
      </Box>,
    ];
    if (typeof scan['total_cost'] === 'number') {
      elements.push(
        <Text key="total-cost">Total monthly cost: <Text color={colors.brand} bold>{formatMoneyExact(scan['total_cost'])}</Text></Text>,
      );
    }
    if (scenarioA + scenarioB + scenarioC > 0) {
      elements.push(
        <Box key="scenarios" gap={GAP_SECTION_WIDE}>
          <Text dimColor>Scenario A: {scenarioA}</Text>
          <Text dimColor>Scenario B: {scenarioB}</Text>
          <Text dimColor>Scenario C: {scenarioC}</Text>
        </Box>,
      );
    }
    if (recommendationRows.length > 0) {
      elements.push(<SectionTitle key="top-rec-header" divider>Top recommendations</SectionTitle>);
      recommendationRows.filter((rec) => {
        const s = String((rec['status'] as string | null | undefined) ?? 'draft').toLowerCase();
        return s === 'draft' || s === 'pending';
      }).slice(0, 3).forEach((rec, idx) => {
        const title = truncateWidth(String((rec['title'] as string | null | undefined) ?? 'Untitled recommendation'), Math.max(20, termWidth - 12));
        const risk = String((rec['risk'] as string | null | undefined) ?? '').toLowerCase();
        const riskColor = risk === 'critical' ? semanticColors.severity.critical
          : risk === 'high' ? semanticColors.severity.high
          : risk === 'medium' ? semanticColors.severity.medium
          : risk === 'low' ? semanticColors.severity.low
          : undefined;
        elements.push(
          <Text key={`top-rec-${idx}`}>
            <Text color={riskColor ?? colors.muted}>{icons.bullet}</Text>
            {' '}<Text>{title}</Text>
            {risk !== '' && <Text dimColor>{' '}{icons.dot}{' '}risk <Text color={riskColor}>{risk}</Text></Text>}
          </Text>,
        );
      });
    }
    return {
      items: [
        <Box key="detail-content" flexDirection="column" marginLeft={MARGIN_LEFT_RESULT}>
          {elements}
        </Box>,
      ],
      actions: [
        { key: 'd', label: 'diff list', action: { type: 'navigate' as const, command: 'history' as const, args: ['list'] } },
        { key: 'p', label: 'report', action: { type: 'navigate' as const, command: 'report' as const, args: ['--scan', scanId, '--format', 'html', '--output', `reports/scan-${scanId.slice(0, 8)}.html`] } },
        { key: 'l', label: 'list', action: { type: 'navigate' as const, command: 'history' as const, args: ['list'] } },
        ...(firstPendingRecommendationId !== undefined && provider !== null
          ? [{ key: 'f', label: 'fix top recommendation', action: { type: 'navigate' as const, command: 'fix' as const, args: [firstPendingRecommendationId] } }]
          : []),
      ],
    };
  };

  // Diff render — Data section (HybridPipeline provides outer Data/AI tabs)
  const renderDiffData = (ctx: PipelineContext): React.JSX.Element => {
    const { resourceCountDelta, costDelta } = extractScanDiff(ctx);
    const costSign = costDelta >= 0 ? '+' : '';
    const costColor = costDelta > 0 ? colors.error : costDelta < 0 ? colors.success : undefined;
    const hasChanges = resourceCountDelta !== 0 || costDelta !== 0;
    const resourceColor = resourceCountDelta > 0 ? colors.success : resourceCountDelta < 0 ? colors.error : undefined;
    return (
      <Box flexDirection="column" gap={GAP_BETWEEN_SECTIONS}>
        {hasChanges ? (
          <Box gap={GAP_SECTION_WIDE}>
            <Text color={resourceColor}>{resourceCountDelta >= 0 ? '+' : ''}{resourceCountDelta} resources</Text>
            <Text color={costColor}>{costSign}{formatMoneyExact(Math.abs(costDelta))}/mo vs previous</Text>
          </Box>
        ) : (
          <Text dimColor>No changes detected.</Text>
        )}
        <SectionTitle divider>changes</SectionTitle>
        <Text dimColor>No per-resource diff available yet.</Text>
      </Box>
    );
  };

  const renderHistoryResult = (ctx: PipelineContext): CommandResultView => {
    if (subcommand === 'show') {
      return renderScanDetail(ctx);
    }

    if (subcommand === 'diff') {
      const diffData = extractScanDiff(ctx);
      const { scanB } = diffData;
      const scanBId = String((scanB['id'] as string | null | undefined) ?? '');
      const reportArgs = scanBId.length > 0
        ? ['--scan', scanBId, '--format', 'html', '--output', `reports/scan-${scanBId.slice(0, 8)}.html`]
        : ['--format', 'html', '--output', 'reports/latest-scan.html'];

      // Compute trend: % change in resources and costs vs previous scan
      const a = ctx.results.get('scan_a') as { resources?: unknown[]; costs?: Array<{ amount?: number }> } | undefined;
      const b = ctx.results.get('scan_b') as { resources?: unknown[]; costs?: Array<{ amount?: number }> } | undefined;
      const resourcesA = a?.resources?.length ?? 0;
      const resourcesB = b?.resources?.length ?? 0;
      const costA = (a?.costs ?? []).reduce((sum: number, c) => sum + (c.amount ?? 0), 0);
      const costB = (b?.costs ?? []).reduce((sum: number, c) => sum + (c.amount ?? 0), 0);
      const resourcePct = resourcesA > 0 ? Math.round((resourcesB - resourcesA) / resourcesA * 100) : 0;
      const costPct = costA > 0 ? Math.round((costB - costA) / costA * 100) : 0;
      const resourceSign = resourcePct >= 0 ? '+' : '';
      const costSign = costPct >= 0 ? '+' : '';
      const trendText = `Trend: resources ${resourceSign}${resourcePct}% ${DOT_SEP} costs ${costSign}${costPct}% vs previous scan`;
      setLastDiffTrend(trendText);

      // Render data inline; HybridPipeline provides Data/AI tabs
      return {
        items: [
          <Box key="diff-data" flexDirection="column">
            {renderDiffData(ctx)}
          </Box>,
        ],
        actions: [
          ...(provider !== null ? [{ key: 'r', label: 'refresh AI', action: { type: 'run-again' as const } }] : []),
          { key: 'p', label: 'report newer scan', action: { type: 'navigate' as const, command: 'report' as const, args: reportArgs } },
        ],
      };
    }

    return {
      items: [
        <EmptyState
          key="none"
          icon="○"
          message="Scan not found — the ID may be invalid or the scan was pruned."
          hint="Press l to return to the history list."
        />,
      ],
      actions: [
        { key: 'l', label: 'history list', action: { type: 'navigate' as const, command: 'history' as const, args: ['list'] } },
      ],
    };
  };

  // No-AI mode: pure DB reads
  if (provider === null) {
    return (
      <ScreenShell
        header={
          <CommandHeader
            command="history"
            description={subtitle[subcommand]}
            variant="compact"
          />
        }
        hints={pipelineHasError ? undefined : <InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
      >
        <AiStatusBanner provider={provider} aiConfigured={aiConfigured} />
        <DirectPipeline
          steps={pipelineSteps}
          renderResult={renderHistoryResult}
          onRunAgain={onRunAgain}
          onBack={handleDetailBack}
          onAction={onAction}
          onError={setPipelineHasError}
          overlayActive={helpOpen || paletteOpen}
        />
      </ScreenShell>
    );
  }

  // Hybrid mode — collect data locally, then 1 AI call for analysis.
  // For `show`, default to Data tab and defer AI until user switches to AI tab.
  const isShowSubcommand = subcommand === 'show';
  return (
    <ScreenShell
      header={
        <CommandHeader
          command="history"
          description={subtitle[subcommand]}
          variant="compact"
        />
      }
      hints={pipelineHasError ? undefined : <InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
    >
      <HybridPipeline
        steps={pipelineSteps}
        provider={provider}
        buildAnalysisPrompt={buildHistoryAnalysisPrompt}
        systemPrompt={getAnalysisPrompt('history')}
        renderResult={renderHistoryResult}
        renderFallback={renderHistoryResult}
        onRunAgain={onRunAgain}
        onBack={handleDetailBack}
        onAction={onAction}
        overlayActive={helpOpen || paletteOpen}
        deferAi={isShowSubcommand}
        cacheKey={isShowSubcommand && id1 !== null ? `history-show-${id1}` : undefined}
        onError={setPipelineHasError}
      />
    </ScreenShell>
  );
}
