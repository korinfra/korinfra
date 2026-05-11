/**
 * RecommendCommand — §8 cached cost and security recommendations.
 *
 * Lifecycle:
 *   §8.1 Result state: DataTable with SEV | TITLE | SAVINGS columns
 *   §8.1b Sort/filter state: shows status bar when ≥5 rows and non-default
 *   §8.2 Detail panel: below table (not overlay)
 *
 * Rules enforced:
 *   VRHYTHM_RULE  — GAP_AFTER_HEADER / GAP_BETWEEN_SECTIONS / GAP_BEFORE_ACTIONS only
 *   DOT_SEP_RULE  — DOT_SEP from ui/text.js
 *   SEVERITY_LABELS_RULE — SEVERITY_LABELS from ui/text.ts
 *   SCREEN_SHELL_RULE — wrapped in ScreenShell
 *   X-1 rule — NavHints = navigation only; f/j/r/p/s in ActionBar
 *   ERR2-1 rule — ErrorBox owns its footer
 *   G-2 rule — renderResult returns CommandResultView
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';

import type { AgentProvider } from '../../agent/types.js';
import { HybridPipeline } from '../components/HybridPipeline.js';
import { ErrorBox } from '../components/ErrorBox.js';
import { DataTable } from '../components/DataTable.js';
import type { ColumnDef } from '../components/DataTable.js';
import { CommandHeader } from '../components/CommandHeader.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { EmptyState } from '../components/EmptyState.js';
import { colors, icons, semanticColors, borders } from '../theme.js';
import { parseArg } from '../utils/parseArgs.js';
import { getDb } from '../../storage/db.js';
import { listPendingRecommendations, updateRecommendationStatus } from '../../storage/queries/recommendations.js';
import type { Recommendation as DbRecommendation } from '../../storage/queries/recommendations.js';
import { getAnalysisPrompt } from '../../agent/prompts.js';
import { InteractionHints, IH_QUIT, IH_BACK, IH_COMMAND, IH_HELP } from '../components/InteractionHints.js';
import { ActionBar } from '../components/ActionBar.js';
import { GAP_BETWEEN_SECTIONS, GAP_SECTION_WIDE, GAP_AFTER_HEADER, PADDING_X, GAP_ROW } from '../ui/spacing.js';
import { SEVERITY_LABELS, DOT_SEP } from '../ui/text.js';
import { buildScanPipelineSteps, extractRecommendations } from '../pipelines/scan.js';
import { buildRecommendAnalysisPrompt } from '../pipelines/analysis.js';
import type { PipelineContext, CommandResultView } from '../components/DirectPipeline.js';
import type { TuiAction } from '../actions.js';
import { formatMoney, formatMoneyPerMonth } from '../ui/format.js';
import { truncateWidth } from '../ui/width.js';
import { AiStatusBanner } from '../components/AiStatusBanner.js';
import { logger } from '../../utils/logger.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';
import { useToast } from '../hooks/useToast.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type RecommendStep = 'loading' | 'showing' | 'refreshing';
type SortMode = 'savings' | 'confidence' | 'severity';
type FilterMode = 'all' | 'high-severity' | 'requires-approval';

type RecCategory = 'cost' | 'security' | 'governance' | 'reliability';
type RecAutomation = 'safe-auto' | 'manual' | 'requires-approval';

interface RecRow {
  id: string;
  severity: string;
  resource: string;
  category: RecCategory;
  savings: string;
  confidence: string;
  automation: RecAutomation;
  // raw for detail panel
  title: string;
  description: string;
  risk: string;
  // raw numeric for sorting
  rawSavings: number;
  rawConfidence: number;
  rawSeverityOrder: number;
}

// ─── Derivation helpers ───────────────────────────────────────────────────────

function deriveCategory(type: string): RecCategory {
  const t = type.toLowerCase();
  if (t === 'governance' || t.startsWith('tag_') || t.startsWith('tag-') || t.startsWith('governance_')) return 'governance';
  if (t === 'reliability' || t.startsWith('reliability_') || t.startsWith('backup_') || t.startsWith('multi_az')) return 'reliability';
  if (t === 'security' || t.includes('-sec-') || t.startsWith('s3_public') || t.startsWith('iam_') || t.startsWith('sg_') || t.startsWith('kms_') || t.startsWith('cloudtrail_')) return 'security';
  return 'cost';
}

function deriveAutomation(rec: DbRecommendation): RecAutomation {
  if (rec.patch_content) return 'safe-auto';
  if (rec.file_path) return 'requires-approval';
  return 'manual';
}

function deriveSeverity(rec: DbRecommendation): string {
  const impact = rec.impact ?? 'medium';
  const validLevels = ['critical', 'high', 'medium', 'low'] as const;
  type SeverityKey = typeof validLevels[number];
  const level: SeverityKey = validLevels.includes(impact as SeverityKey) ? (impact as SeverityKey) : 'medium';
  return SEVERITY_LABELS[level];
}

function severityColor(label: string): string | undefined {
  if (label === SEVERITY_LABELS.critical) return semanticColors.severity.critical;
  if (label === SEVERITY_LABELS.high) return semanticColors.severity.high;
  if (label === SEVERITY_LABELS.medium) return semanticColors.severity.medium;
  if (label === SEVERITY_LABELS.low) return semanticColors.severity.low;
  return undefined;
}

const SEVERITY_ORDER: Record<string, number> = {
  [SEVERITY_LABELS.critical]: 0,
  [SEVERITY_LABELS.high]: 1,
  [SEVERITY_LABELS.medium]: 2,
  [SEVERITY_LABELS.low]: 3,
};

function dbRecToRow(r: DbRecommendation): RecRow {
  const rawSavings = r.estimated_savings ?? 0;
  const rawConfidence = r.confidence ?? 0;
  const savings = rawSavings > 0 ? formatMoneyPerMonth(rawSavings) : '—';
  const confidence = rawConfidence > 0 ? `${Math.round(rawConfidence * 100)}%` : '—';
  const sevLabel = deriveSeverity(r);
  return {
    id: r.id,
    severity: sevLabel,
    resource: r.resource_id ?? r.resource_type ?? '—',
    category: deriveCategory(r.type),
    savings,
    confidence,
    automation: deriveAutomation(r),
    title: r.title,
    description: r.description ?? '',
    risk: r.risk ?? 'low',
    rawSavings,
    rawConfidence,
    rawSeverityOrder: SEVERITY_ORDER[sevLabel] ?? 99,
  };
}

// ─── AI freshness label ───────────────────────────────────────────────────────

function aiAgeLabel(ageMs: number): { label: string; isStale: boolean } {
  const mins = Math.floor(ageMs / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  const isStale = days >= 7;
  if (mins < 1) return { label: 'just now', isStale: false };
  if (mins < 60) return { label: `${mins}m ago`, isStale };
  if (hours < 24) return { label: `${hours}h ago`, isStale };
  if (days < 7) return { label: `${days}d ago`, isStale };
  return { label: `${days}d ago`, isStale: true };
}

// ─── DataTable column defs — §8.1: SEV | TITLE | SAVINGS ─────────────────

const COLUMNS: ColumnDef<RecRow>[] = [
  {
    key: 'severity',
    label: 'SEV',
    width: 9,
    priority: 1,
    renderCell: (value) => {
      const v = String(value).toLowerCase();
      const color = v === 'critical' ? semanticColors.severity.critical
        : v === 'high' ? semanticColors.severity.high
        : v === 'medium' ? semanticColors.severity.medium
        : v === 'low' ? semanticColors.severity.low
        : undefined;
      return <Text color={color}>{String(value)}</Text>;
    },
  },
  {
    key: 'title',
    label: 'TITLE',
    priority: 1,
    truncate: 'end',
    maxWidth: 80,
    renderCell: (value, _row, width) => <Text>{truncateWidth(String(value), width)}</Text>,
  },
  {
    key: 'savings',
    label: 'SAVINGS',
    width: 12,
    priority: 1,
    renderCell: (value) => {
      const v = String(value);
      return <Text color={v !== '—' ? semanticColors.savings.value : undefined}>{v}</Text>;
    },
  },
];

// ─── Fallback (AI pipeline result) ───────────────────────────────────────────

function renderRecommendFallback(ctx: PipelineContext): CommandResultView {
  const recs = extractRecommendations(ctx);
  if (recs.length === 0) {
    return {
      items: [
        <Box key="empty" flexDirection="column" gap={GAP_ROW}>
          <Text dimColor>No pending recommendations.</Text>
          <Box gap={GAP_ROW}>
            {(['cost', 'security', 'governance', 'reliability'] as RecCategory[]).map((cat) => (
              <Text key={cat} dimColor>[{cat}]</Text>
            ))}
          </Box>
        </Box>,
      ],
      actions: [{ key: 'r', label: 'run again', action: { type: 'run-again' as const } }],
    };
  }
  const items: React.JSX.Element[] = [];
  const savings = recs.reduce((s, r) => s + (r.estimatedSavingsUsd ?? 0), 0);
  items.push(
    <Text key="count" bold>
      <Text color={colors.brand}>{recs.length}</Text>
      {' recommendation'}{recs.length !== 1 ? 's' : ''}
      {savings > 0 && <Text color={colors.saving}> {icons.dot} est. ${savings.toFixed(0)}/mo</Text>}
    </Text>,
  );
  for (const rec of recs) {
    const impact = rec.impact ?? 'medium';
    const validLevels = ['critical', 'high', 'medium', 'low'] as const;
    type SeverityKey = typeof validLevels[number];
    const level: SeverityKey = validLevels.includes(impact) ? (impact) : 'medium';
    const sevLabel = SEVERITY_LABELS[level];
    items.push(
      <Box key={rec.id} gap={GAP_ROW}>
        <Text color={severityColor(sevLabel)} bold>[{sevLabel}]</Text>
        <Text>{rec.title}</Text>
        {(rec.estimatedSavingsUsd ?? 0) > 0 && (
          <Text color={colors.saving}>{formatMoneyPerMonth(rec.estimatedSavingsUsd ?? 0)}</Text>
        )}
      </Box>,
    );
  }
  return {
    items,
    actions: [
      { key: 'r', label: 'run again', action: { type: 'run-again' as const } },
      { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'scan' } },
      { key: 'p', label: 'save report', action: { type: 'navigate' as const, command: 'report' } },
    ],
  };
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

interface DetailPanelProps {
  row: RecRow;
}

function DetailPanel({ row }: DetailPanelProps): React.JSX.Element {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const compactMeta = truncateWidth(
    `Savings: ${row.savings}${DOT_SEP}Confidence: ${row.confidence}${DOT_SEP}Automation: ${row.automation}`,
    Math.max(30, termWidth - 14),
  );

  // border(2) + paddingX(2) + marginLeft: inner content width
  const innerWidth = Math.max(30, termWidth - GAP_SECTION_WIDE - 6);
  const panelWidth = innerWidth + 4; // +4 to restore border+padding

  const metaLine = truncateWidth(
    `Severity: ${row.severity}${DOT_SEP}Risk: ${row.risk}${DOT_SEP}Category: ${row.category}`,
    innerWidth,
  );

  return (
    <Box
      flexDirection="column"
      marginTop={GAP_BETWEEN_SECTIONS}
      marginLeft={GAP_SECTION_WIDE}
      borderStyle={borders.card}
      borderColor={colors.border}
      paddingX={PADDING_X}
      width={panelWidth}
    >
      <Text bold color={colors.brand}>{row.title}</Text>
      <Box marginTop={GAP_BETWEEN_SECTIONS}>
        <Text dimColor>{metaLine}</Text>
      </Box>
      <Box>
        <Text dimColor>{compactMeta}</Text>
      </Box>
      {row.description && (
        <Box marginTop={GAP_BETWEEN_SECTIONS}>
          <Text dimColor wrap="wrap">{row.description}</Text>
        </Box>
      )}
    </Box>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface RecommendCommandProps {
  provider: AgentProvider | null;
  args?: string[];
  onRunAgain?: () => void;
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
  aiConfigured?: boolean;
  promptMaxResources?: number | undefined;
  promptMaxRecommendations?: number | undefined;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RecommendCommand({
  provider,
  args = [],
  onRunAgain,
  onBack,
  onAction,
  aiConfigured = false,
  promptMaxResources,
  promptMaxRecommendations,
}: RecommendCommandProps): React.JSX.Element {
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const { toasts, show: showToast } = useToast();
  const isRefresh = args.includes('--refresh');
  const type = parseArg(args, '--type');
  const selectedId = parseArg(args, '--select');
  const minSavingsStr = parseArg(args, '--min-savings');
  const rawMinSavings = parseFloat(minSavingsStr ?? '0');
  const minSavings = Number.isFinite(rawMinSavings) && rawMinSavings >= 0 ? rawMinSavings : 0;

  const [step, setStep] = useState<RecommendStep>('loading');
  const [rows, setRows] = useState<RecRow[]>([]);
  const [pipelineHasError, setPipelineHasError] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [dbAgeMs, setDbAgeMs] = useState<number>(0);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [sortMode, setSortMode] = useState<SortMode>('severity');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [detailOpen, setDetailOpen] = useState(false);

  const { exit } = useApp();

  const refreshSteps = useMemo(() => buildScanPipelineSteps({}), []);

  useEffect(() => {
    if (isRefresh) {
      setStep('refreshing');
      return;
    }
    try {
      const db = getDb();
      let pending = listPendingRecommendations(db, 50);
      if (type !== null) pending = pending.filter(r => r.type === type);
      if (minSavings > 0) pending = pending.filter(r => (r.estimated_savings ?? 0) >= minSavings);
      const mappedRows = pending.map(dbRecToRow);
      setRows(mappedRows);
      if (selectedId !== null) {
        const nextIdx = mappedRows.findIndex((row) => row.id === selectedId);
        if (nextIdx >= 0) setSelectedIdx(nextIdx);
      }
      const oldest = pending.reduce<number>((min, r) => {
        const ts = 'created_at' in r && (typeof r.created_at === 'string' || typeof r.created_at === 'number')
          ? r.created_at : undefined;
        if (!ts) return min;
        const ms = new Date(ts).getTime();
        return Number.isFinite(ms) ? Math.min(min, ms) : min;
      }, Date.now());
      setDbAgeMs(Date.now() - oldest);
      setStep('showing');
    } catch (err) {
      setDbError(err instanceof Error ? err.message : 'Could not read .korinfra/data.db');
      setStep('showing');
    }
  }, [isRefresh, minSavings, selectedId, type]);

  useInput((input, key) => {
    if (step !== 'showing') return;
    if (detailOpen) {
      if (input === 'b' || key.escape) {
        setDetailOpen(false);
        return;
      }
      if (input === 'q') exit();
      return;
    }
    if (input === 'q') exit();
    if ((input === 'b' || key.escape) && onBack !== undefined) onBack();
    if (key.return) {
      setDetailOpen(true);
      return;
    }
  }, { isActive: !helpOpen && !paletteOpen });


  // ── Filter + sort rows ────────────────────────────────────────────────────
  const displayRows = useMemo(() => {
    let filtered = rows;
    if (filterMode === 'high-severity') {
      filtered = rows.filter((r) => r.severity === SEVERITY_LABELS.critical || r.severity === SEVERITY_LABELS.high);
    } else if (filterMode === 'requires-approval') {
      filtered = rows.filter((r) => r.automation === 'requires-approval');
    }
    return [...filtered].sort((a, b) => {
      if (sortMode === 'savings') return b.rawSavings - a.rawSavings;
      if (sortMode === 'confidence') return b.rawConfidence - a.rawConfidence;
      return a.rawSeverityOrder - b.rawSeverityOrder;
    });
  }, [rows, sortMode, filterMode]);

  // ── AI freshness ──────────────────────────────────────────────────────────
  const { label: aiLabel, isStale } = aiAgeLabel(dbAgeMs);

  // ── Loading ───────────────────────────────────────────────────────────────
  if (step === 'loading') {
    return (
      <ScreenShell
        header={<CommandHeader command="recommend" description="AI-powered cost and security recommendations" />}
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
      >
        <Box marginLeft={GAP_SECTION_WIDE} marginTop={GAP_AFTER_HEADER}>
          <Text dimColor>Loading recommendations…</Text>
        </Box>
      </ScreenShell>
    );
  }

  // ── Showing ───────────────────────────────────────────────────────────────
  if (step === 'showing') {
    if (dbError !== null) {
      return (
        <ScreenShell
          header={<CommandHeader command="recommend" description="AI-powered cost and security recommendations" />}
        >
          <ErrorBox
            title="Could not load recommendations"
            message={dbError}
            actions={[
              { key: 'd', label: 'run doctor', action: { type: 'navigate' as const, command: 'doctor' } },
              { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'scan' } },
            ]}
            onAction={onAction}
            onBack={onBack}
          />
        </ScreenShell>
      );
    }

    if (rows.length === 0) {
      return (
        <ScreenShell
          header={<CommandHeader command="recommend" description="AI-powered cost and security recommendations" />}
          actions={
            <ActionBar
              actions={[
                { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'scan' } },
              ]}
              onAction={onAction}
              marginLeft={GAP_SECTION_WIDE}
            />
          }
          hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
        >
          <Box marginTop={GAP_AFTER_HEADER}>
            {rows.length > 0 ? (
              <EmptyState
                icon={icons.info ?? 'i'}
                message="No results for current filter."
                hint="Press f to clear filter."
              />
            ) : (
              <EmptyState
                icon={icons.info ?? 'i'}
                message="No recommendations."
                hint="Run a scan first."
              />
            )}
          </Box>
        </ScreenShell>
      );
    }

    const selectedRow = displayRows[selectedIdx] ?? displayRows[0];
    const isFilterOrSortNonDefault = sortMode !== 'severity' || filterMode !== 'all';
    const showStatusBar = isFilterOrSortNonDefault;

    const handleActionBarAction = (action: TuiAction): void => {
      if (action.type === 'filter-toggle') {
        setFilterMode((m) => m === 'all' ? 'high-severity' : m === 'high-severity' ? 'requires-approval' : 'all');
        return;
      }
      if (action.type === 'sort-toggle') {
        setSortMode((m) => m === 'savings' ? 'confidence' : m === 'confidence' ? 'severity' : 'savings');
        return;
      }
      if (action.type === 'dismiss') {
        const target = displayRows[selectedIdx];
        if (!target) return;
        try { updateRecommendationStatus(getDb(), target.id, 'dismissed'); } catch { /* non-fatal */ }
        setRows((prev) => prev.filter((r) => r.id !== target.id));
        setSelectedIdx((i) => Math.max(0, i - 1));
        showToast({ level: 'success', message: 'Dismissed' });
        return;
      }
      onAction?.(action);
    };

    // Header subtitle — "<count> recommendations" + age label if stale
    const headerScope = `${rows.length} recommendation${rows.length !== 1 ? 's' : ''}${isStale ? ` ${DOT_SEP} ${aiLabel} (stale)` : ''}`;

    return (
      <ScreenShell
        header={<CommandHeader command="recommend" description="recommendations" scope={headerScope} />}
        actions={
          <ActionBar
            actions={[
              { key: 'f', label: 'filter', action: { type: 'filter-toggle' as const } },
              { key: 'j', label: 'sort', action: { type: 'sort-toggle' as const } },
              ...(provider !== null ? [{ key: 'r', label: 'refresh AI', action: { type: 'run-again' as const } }] : []),
              { key: 'd', label: 'dismiss', action: { type: 'dismiss' as const } },
              { key: 'p', label: 'report', action: { type: 'navigate' as const, command: 'report' as const } },
              { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'scan' as const } },
            ]}
            onAction={handleActionBarAction}
            marginLeft={GAP_SECTION_WIDE}
            isActive={!detailOpen && !helpOpen && !paletteOpen}
          />
        }
        hints={
          <InteractionHints hints={detailOpen ? [
            IH_COMMAND,
            IH_HELP,
            IH_BACK,
            IH_QUIT,
          ] : [
            IH_COMMAND,
            IH_HELP,
            ...(onBack !== undefined ? [IH_BACK] : []),
            IH_QUIT,
          ]} />
        }
      >
        {/* §8.1b: Status bar (sort/filter) — shown when ≥5 rows AND non-default */}
        {showStatusBar && (
          <Box marginLeft={GAP_SECTION_WIDE} marginTop={GAP_AFTER_HEADER}>
            <Text dimColor>
              sort: <Text color={colors.brand}>{sortMode}</Text>{DOT_SEP}filter: <Text color={colors.brand}>{filterMode}</Text>
            </Text>
          </Box>
        )}

        {detailOpen && selectedRow !== undefined ? (
          <Box marginLeft={GAP_SECTION_WIDE} marginTop={showStatusBar ? GAP_BETWEEN_SECTIONS : GAP_AFTER_HEADER} flexDirection="column">
            <DetailPanel row={selectedRow} />
          </Box>
        ) : (
          <>
            <Box marginLeft={GAP_SECTION_WIDE} marginTop={showStatusBar ? GAP_BETWEEN_SECTIONS : GAP_AFTER_HEADER}>
              <DataTable<RecRow>
                columns={COLUMNS}
                rows={displayRows}
                selectedIndex={selectedIdx}
                onSelect={setSelectedIdx}
                getRowKey={(row) => row.id}
                chromeRows={showStatusBar ? 18 : 16}
              />
            </Box>
            <Box marginLeft={GAP_SECTION_WIDE} marginTop={GAP_BETWEEN_SECTIONS}>
              <Text dimColor>estimated total savings: ~{formatMoney(displayRows.reduce((s, r) => s + r.rawSavings, 0))}/mo</Text>
            </Box>
          </>
        )}

        {toasts[0] !== undefined && (
          <Box marginLeft={GAP_SECTION_WIDE} marginTop={GAP_BETWEEN_SECTIONS}>
            <Text color={toasts[0].level === 'success' ? semanticColors.status.pass : colors.warning}>
              {toasts[0].message}
            </Text>
          </Box>
        )}

      </ScreenShell>
    );
  }

  // ── Refreshing (AI mode) ──────────────────────────────────────────────────
  if (provider === null) {
    return (
      <ScreenShell header={<CommandHeader command="recommend" description="recommendations" />}>
        <AiStatusBanner provider={provider} aiConfigured={aiConfigured} />
        <ErrorBox
          title="AI required for --refresh"
          message="The recommend --refresh command requires an AI provider."
          hint="Configure an AI provider, or go back to cached recommendations."
          actions={[{ key: 'i', label: 'run init', action: { type: 'navigate' as const, command: 'init' } }]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  return (
    <ScreenShell
      header={<CommandHeader command="recommend" description="AI-powered cost and security recommendations" />}
      hints={pipelineHasError ? undefined : <InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
    >
      <HybridPipeline
        steps={refreshSteps}
        provider={provider}
        buildAnalysisPrompt={(ctx) => buildRecommendAnalysisPrompt(ctx, { promptMaxResources, promptMaxRecommendations })}
        systemPrompt={getAnalysisPrompt('recommend')}
        renderResult={renderRecommendFallback}
        renderFallback={renderRecommendFallback}
        onError={setPipelineHasError}
        onResult={() => {
          try {
            const db = getDb();
            let pending = listPendingRecommendations(db, 50);
            if (type !== null) pending = pending.filter(r => r.type === type);
            if (minSavings > 0) pending = pending.filter(r => (r.estimated_savings ?? 0) >= minSavings);
            setRows(pending.map(dbRecToRow));
          } catch (err) {
            logger.debug({ err }, '[recommend] Failed to reload recommendations after AI refresh');
          }
        }}
        onRunAgain={onRunAgain}
        onBack={onBack}
        onAction={onAction}
      />
    </ScreenShell>
  );
}
