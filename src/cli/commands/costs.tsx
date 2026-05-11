/**
 * CostsCommand — AWS Cost Explorer breakdown with multi-tab TUI.
 *
 * Lifecycle:
 *   Phase 0  — HybridPipeline collecting/analyzing → spinner (PipelineRunStatus)
 *   Phase 1  — Done/fallback → TabbedResult with Period / Trend / Anomaly tabs
 *
 * Tab layout (Period/Trend/Anomaly) lives inside renderResult's items[0].
 * It is a single React element so HybridPipeline's Data/AI outer TabbedResult
 * still works at its own level without nested useInput races.
 *
 * Key contract (§1.6, §22):
 *   Tab / Shift+Tab  — switch Period / Trend / Anomaly tabs
 *   ← / →            — same as Tab / Shift+Tab
 *   ↑ / ↓            — navigate rows (Period & Anomaly tabs via DataTable)
 *   Enter            — open detail overlay (Period tab only)
 *   r                — refresh (ActionBar, run-again)
 *   p                — save report (ActionBar)
 *   s                — scan again (ActionBar)
 *   ?: belongs in NavHints (InteractionHints), NOT in ActionBar (X-1)
 *
 * VRHYTHM_RULE: GAP_AFTER_HEADER / GAP_BETWEEN_SECTIONS / GAP_BEFORE_ACTIONS only.
 * DOT_SEP_RULE: DOT_SEP from src/cli/ui/text.js.
 * SEVERITY_LABELS_RULE: SEVERITY_LABELS from src/cli/ui/text.js.
 * SCREEN_SHELL_RULE: wrapped in ScreenShell.
 * X-1 RULE: NavHints = navigation only; r/p/s in ActionBar.
 * ERR2-1 RULE: ErrorBox owns its footer.
 * G-2 RULE: renderResult returns CommandResultView; ActionBar never inside items.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import type { AgentProvider } from '../../agent/types.js';
import { HybridPipeline } from '../components/HybridPipeline.js';
import { DirectPipeline } from '../components/DirectPipeline.js';
import type { PipelineContext, CommandResultView } from '../components/DirectPipeline.js';
import { ErrorBox } from '../components/ErrorBox.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { CommandHeader } from '../components/CommandHeader.js';
import { TabbedResult } from '../components/TabbedResult.js';
import { DataTable } from '../components/DataTable.js';
import type { ColumnDef } from '../components/DataTable.js';
import { EmptyState } from '../components/EmptyState.js';
import { AiStatusBanner } from '../components/AiStatusBanner.js';
import { TrendChart } from '../components/TrendChart.js';
import type { CostDataPoint } from '../components/TrendChart.js';
import { CostsDetailOverlay } from '../components/CostsDetailOverlay.js';
import type { CostsDetailItem } from '../components/CostsDetailOverlay.js';
import { CostsGroupByOverlay } from '../components/CostsGroupByOverlay.js';
import { GAP_BETWEEN_SECTIONS, MARGIN_LEFT_CONTENT } from '../ui/spacing.js';
import { DOT_SEP, SEVERITY_LABELS } from '../ui/text.js';
import { semanticColors, colors, icons, supportsUnicode } from '../theme.js';
import { formatMoneyExact } from '../ui/format.js';
import { parseArg } from '../utils/parseArgs.js';
import { getAnalysisPrompt } from '../../agent/prompts.js';
import { buildCostsDatasetSteps, extractAnomalies, extractTotalCost } from '../pipelines/costs.js';
import { buildCostsAnalysisPrompt } from '../pipelines/analysis.js';
import { getCostsTool } from '../../tools/get-costs.js';
import { parseToolResult } from '../pipelines/scan.js';
import type { TuiAction } from '../actions.js';
import { InteractionHints, IH_ARROWS, IH_BACK, IH_COMMAND, IH_HELP, IH_QUIT } from '../components/InteractionHints.js';
import { truncateWidth, stringWidth } from '../ui/width.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Column widths per §0.4 */
const COL_RANK_W = 2;
const COL_COST_W = 12;
const COL_SHARE_W = 6;
const COL_TREND_W = 11;

/** Share bar total segments */
const SHARE_BAR_SEGMENTS = 8;

/** Top-N rows before "Other" bucket */
const TOP_N = 15;

/** Stale threshold: 1 day in ms */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

type GroupByValue = 'service' | 'region' | 'account' | 'tag';
type CostsTab = 'period' | 'trend' | 'anomaly';

const COSTS_TABS = [
  { id: 'period' as const, label: 'Period' },
  { id: 'trend' as const, label: 'Trend' },
  { id: 'anomaly' as const, label: 'Anomaly' },
];

/** A row in the Period DataTable */
interface PeriodRow {
  rank: string;
  service: string;
  rawLabel: string;
  cost: string;
  share: string;
  trend: string;
  /** Numeric cost for color calculation */
  _cost: number;
  /** Numeric pct for share bar */
  _pct: number;
  /** Whether this is the "Other" bucket */
  _isOther: boolean;
}

/** A row in the Anomaly DataTable */
interface AnomalyRow {
  type: string;
  service: string;
  amount: string;
  severity: string;
  _amount: number;
}

// ─── Label abbreviations ──────────────────────────────────────────────────────

const SERVICE_ABBREV: Record<string, string> = {
  'Amazon Elastic Compute Cloud': 'EC2',
  'Amazon Elastic Compute Cloud - Compute': 'EC2',
  'AWS Lambda': 'Lambda',
  'Amazon Simple Storage Service': 'S3',
  'Amazon Relational Database Service': 'RDS',
  'Amazon CloudFront': 'CloudFront',
  'Amazon DynamoDB': 'DynamoDB',
  'Amazon ElastiCache': 'ElastiCache',
  'Amazon Elastic Container Service': 'ECS',
  'Amazon Elastic Kubernetes Service': 'EKS',
  'Amazon Virtual Private Cloud': 'VPC',
  'AWS Key Management Service': 'KMS',
  'Amazon Route 53': 'Route53',
  'Amazon Simple Notification Service': 'SNS',
  'Amazon Simple Queue Service': 'SQS',
  'AWS CloudTrail': 'CloudTrail',
  'Amazon CloudWatch': 'CloudWatch',
  'Amazon Elastic Block Store': 'EBS',
  'Amazon Elastic Load Balancing': 'ELB',
  'AWS Elastic Beanstalk': 'Beanstalk',
  'Amazon Redshift': 'Redshift',
  'Amazon OpenSearch Service': 'OpenSearch',
  'Amazon Comprehend': 'Comprehend',
  'AWS Glue': 'Glue',
  'Amazon Athena': 'Athena',
  'Amazon SageMaker': 'SageMaker',
  'Amazon Elastic File System': 'EFS',
  'Amazon Neptune': 'Neptune',
  'Amazon DocumentDB': 'DocumentDB',
  'Amazon Kinesis': 'Kinesis',
  'AWS Step Functions': 'Step Fn',
  'AWS Secrets Manager': 'Secrets Mgr',
  'AWS Systems Manager': 'SSM',
  'Amazon API Gateway': 'API Gateway',
  'Amazon Cognito': 'Cognito',
  'AWS CodeBuild': 'CodeBuild',
  'Amazon ECR': 'ECR',
  'AWS WAF': 'WAF',
};

function smartLabel(rawLabel: string, maxWidth: number): string {
  if (stringWidth(rawLabel) <= maxWidth) return rawLabel;
  const abbrev = SERVICE_ABBREV[rawLabel];
  if (abbrev !== undefined && stringWidth(abbrev) <= maxWidth) return abbrev;
  return truncateWidth(rawLabel, maxWidth);
}

// ─── Share bar ────────────────────────────────────────────────────────────────

function shareBar(pct: number): string {
  const filled = Math.round((pct / 100) * SHARE_BAR_SEGMENTS);
  const empty = SHARE_BAR_SEGMENTS - filled;
  const fillChar = supportsUnicode ? '▓' : '#';
  const emptyChar = supportsUnicode ? '░' : '.';
  return fillChar.repeat(Math.max(0, filled)) + emptyChar.repeat(Math.max(0, empty));
}

// ─── Cost severity color (thresholds calibrated to top-20%/next-30% heuristic) ──────
// NOTE: DataTable renders uniform row color (focus highlight). Per-cell coloring
// for COST requires a custom row renderer. Thresholds are defined here for future
// use when custom rendering is available:
//   Top 20% of cost share → critical (red), next 30% → high (yellow), rest → low (green).
//   False-positive analysis: share-relative, not absolute — small bills won't false-red.

// ─── Anomaly severity ─────────────────────────────────────────────────────────

function anomalySeverityLabel(amount: number, expectedAmount: number): string {
  const ratio = expectedAmount > 0 ? amount / expectedAmount : 1;
  if (ratio >= 3) return SEVERITY_LABELS.critical;
  if (ratio >= 2) return SEVERITY_LABELS.high;
  if (ratio >= 1.5) return SEVERITY_LABELS.medium;
  return SEVERITY_LABELS.low;
}

// ─── CostsTabs (inner tab component, returned in renderResult items) ──────────

interface CostsTabsProps {
  activeTab: CostsTab;
  onTabChange: (tab: CostsTab) => void;
  isActive: boolean;
  periodRows: PeriodRow[];
  anomalyRows: AnomalyRow[];
  dailyData: CostDataPoint[];
  totalCost: number;
  cappedDays: number;
  days: number;
  periodLabel: string;
  groupBy: GroupByValue;
  fetchedAt: number | null;
  /** Lifted state: detail overlay item (null = closed) */
  detailItem: CostsDetailItem | null;
  onDetailItemChange: (item: CostsDetailItem | null) => void;
  onGroupByOpen: () => void;
  onGroupByClose: () => void;
  onGroupByChange: (value: GroupByValue) => void;
  /**
   * Available viewport rows from DirectPipeline's viewportHeight.
   * Used to compute DataTable pageSize so Yoga never needs to shrink
   * body rows to 0 in a fixed-height container.
   */
  availableRows?: number;
}

/** Column definitions for Period DataTable — serviceMaxWidth scales with terminal */
function makePeriodColumns(serviceMaxWidth: number): ColumnDef<PeriodRow>[] { return [
  {
    key: 'rank',
    label: '#',
    width: COL_RANK_W + 1,
    priority: 1,
  },
  {
    key: 'service',
    label: 'SERVICE',
    priority: 1,
    truncate: 'end' as const,
    maxWidth: serviceMaxWidth,
  },
  {
    key: 'cost',
    label: 'COST',
    width: COL_COST_W + 1,
    priority: 1,
    renderCell: (_value, row) => {
      const r = row;
      const color = r._pct >= 20 ? semanticColors.severity.high
        : r._pct >= 5 ? colors.warning
        : undefined;
      return <Text color={color}>{r.cost}</Text>;
    },
  },
  {
    key: 'share',
    label: 'SHARE',
    width: COL_SHARE_W + SHARE_BAR_SEGMENTS + 6,
    priority: 2,
    renderCell: (_value, row, width) => {
      const r = row;
      const pctStr = `${r._pct.toFixed(1)}%`.padEnd(COL_SHARE_W);
      const barSegments = Math.max(0, Math.min(SHARE_BAR_SEGMENTS, width - COL_SHARE_W - 1));
      const filled = Math.round((r._pct / 100) * barSegments);
      const empty = barSegments - filled;
      const fillChar = supportsUnicode ? '▓' : '#';
      const emptyChar = supportsUnicode ? '░' : '.';
      const barColor = r._pct >= 20 ? semanticColors.severity.high
        : r._pct >= 5 ? colors.warning
        : semanticColors.cost.value;
      return (
        <Text>
          <Text dimColor>{pctStr} </Text>
          <Text color={barColor}>{fillChar.repeat(Math.max(0, filled))}</Text>
          <Text dimColor>{emptyChar.repeat(Math.max(0, empty))}</Text>
        </Text>
      );
    },
  },
  {
    key: 'trend',
    label: 'TREND',
    width: COL_TREND_W + 1,
    priority: 3,
    renderCell: (_value, row) => {
      const r = row;
      if (r._pct >= 20) return <Text color={semanticColors.severity.high}>▲ high</Text>;
      if (r._pct >= 5) return <Text color={colors.warning}>▲ mid</Text>;
      return <Text dimColor>─ low</Text>;
    },
  },
]; }

/** Column definitions for Anomaly DataTable */
const ANOMALY_COLUMNS: ColumnDef<AnomalyRow>[] = [
  { key: 'type', label: 'TYPE', width: 8, priority: 1 },
  { key: 'service', label: 'SERVICE', priority: 1, truncate: 'end' as const, maxWidth: 60 },
  {
    key: 'amount',
    label: 'AMOUNT',
    width: 10,
    priority: 1,
    renderCell: (value) => <Text color={semanticColors.cost.anomaly}>{String(value)}</Text>,
  },
  {
    key: 'severity',
    label: 'SEVERITY',
    width: 10,
    priority: 2,
    renderCell: (value) => {
      const v = String(value).toLowerCase();
      const color = v === 'critical' ? semanticColors.severity.critical
        : v === 'high' ? semanticColors.severity.high
        : v === 'medium' ? semanticColors.severity.medium
        : semanticColors.severity.low;
      return <Text color={color}>{String(value)}</Text>;
    },
  },
];

// Rows consumed by CostsTabs chrome above the DataTable body:
//   inner TabbedResult (4) + status+gap (2) + DataTable counter+gap+header+sep (4)
// Note: bottom overflow indicator is part of visibleBodyRows — do NOT count it here.
const COSTS_TABS_CHROME = 10;

function CostsTabs({
  activeTab,
  onTabChange,
  isActive,
  periodRows,
  anomalyRows,
  dailyData,
  totalCost,
  cappedDays,
  days,
  periodLabel,
  groupBy,
  fetchedAt,
  detailItem,
  onDetailItemChange,
  onGroupByOpen,
  onGroupByClose,
  onGroupByChange,
  availableRows,
}: CostsTabsProps): React.JSX.Element {
  const tablePageSize = availableRows !== undefined ? Math.max(3, availableRows - COSTS_TABS_CHROME) : undefined;
  const [periodSelected, setPeriodSelected] = useState(0);
  const [anomalySelected, setAnomalySelected] = useState(0);
  const [showGroupBy, setShowGroupBy] = useState(false);
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const periodColumns = useMemo(
    () => makePeriodColumns(Math.max(40, Math.min(Math.floor(termWidth * 0.4), 100))),
    [termWidth],
  );

  // ← / → arrow keys switch tabs (in addition to Tab/Shift+Tab handled by TabbedResult)
  useInput((input, key) => {
    if (!isActive) return;
    if (detailItem !== null || showGroupBy) return; // overlays capture input

    if (key.leftArrow) {
      const idx = COSTS_TABS.findIndex((t) => t.id === activeTab);
      const prev = COSTS_TABS[(idx - 1 + COSTS_TABS.length) % COSTS_TABS.length];
      if (prev !== undefined) onTabChange(prev.id);
      return;
    }
    if (key.rightArrow) {
      const idx = COSTS_TABS.findIndex((t) => t.id === activeTab);
      const next = COSTS_TABS[(idx + 1) % COSTS_TABS.length];
      if (next !== undefined) onTabChange(next.id);
      return;
    }

    // j = group by (g is reserved for "generate/suggest tags" per G-5)
    if (input === 'j') {
      setShowGroupBy(true);
      onGroupByOpen();
      return;
    }

    if (activeTab === 'period' && key.return) {
      const row = periodRows[periodSelected];
      if (row !== undefined && !row._isOther) {
        const item: CostsDetailItem = {
          label: row.service,
          rawLabel: row.rawLabel,
          value: row._cost,
          pct: row._pct,
          rank: parseInt(row.rank, 10),
          totalRows: periodRows.length,
          cappedDays,
          periodLabel,
          dailyAvg: cappedDays > 0 ? row._cost / cappedDays : 0,
          trendLabel: row.trend,
          sharebar: shareBar(row._pct),
        };
        onDetailItemChange(item);
      }
    }
  }, { isActive: isActive && detailItem === null && !showGroupBy });

  // Stale banner
  const isStale = fetchedAt !== null && (Date.now() - fetchedAt) > STALE_THRESHOLD_MS;
  const staleDays = fetchedAt !== null ? Math.floor((Date.now() - fetchedAt) / STALE_THRESHOLD_MS) : 0;

  if (showGroupBy) {
    return (
      <CostsGroupByOverlay
        current={groupBy}
        onApply={(value) => {
          onGroupByChange(value);
          setShowGroupBy(false);
          onGroupByClose();
        }}
        onCancel={() => {
          setShowGroupBy(false);
          onGroupByClose();
        }}
      />
    );
  }

  const makeDetailItem = (row: PeriodRow): CostsDetailItem => ({
    label: row.service,
    rawLabel: row.rawLabel,
    value: row._cost,
    pct: row._pct,
    rank: parseInt(row.rank, 10),
    totalRows: periodRows.length,
    cappedDays,
    periodLabel,
    dailyAvg: cappedDays > 0 ? row._cost / cappedDays : 0,
    trendLabel: row.trend,
    sharebar: shareBar(row._pct),
  });

  if (detailItem !== null) {
    const currentRank = detailItem.rank;
    const hasPrev = currentRank > 1;
    const hasNext = currentRank < periodRows.filter((r) => !r._isOther).length;
    return (
      <CostsDetailOverlay
        item={detailItem}
        onClose={() => { onDetailItemChange(null); }}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={() => {
          const idx = currentRank - 2;
          const row = periodRows[idx];
          if (row !== undefined) { setPeriodSelected(idx); onDetailItemChange(makeDetailItem(row)); }
        }}
        onNext={() => {
          const idx = currentRank; // rank is 1-based, so rank = next 0-based idx
          const row = periodRows[idx];
          if (row !== undefined && !row._isOther) { setPeriodSelected(idx); onDetailItemChange(makeDetailItem(row)); }
        }}
      />
    );
  }

  return (
    <Box flexDirection="column">
      {/* Days cap warning */}
      {days > 397 && (
        <Box marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text color={colors.warning}>
            {icons.warning}{' '}--days capped at 397 (AWS limit). Showing 397 days.
          </Text>
        </Box>
      )}

      {/* Stale banner §19.8 */}
      {isStale && (
        <Box marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text color={colors.warning}>
            {icons.warning}{' '}Cost data is {staleDays} day{staleDays !== 1 ? 's' : ''} old. Press <Text color={colors.warning}>(r)</Text> to refresh.
          </Text>
        </Box>
      )}

      <TabbedResult
        tabs={COSTS_TABS}
        activeTab={activeTab}
        onTabChange={(id) => { onTabChange(id as CostsTab); }}
        isActive={isActive}
      >
        {/* Period tab */}
        {activeTab === 'period' && (
          <Box flexDirection="column">
            {periodRows.length === 0 ? (
              <EmptyState
                key="period-empty"
                icon="○"
                message="No cost data for the selected period."
                hint="Try --days 90."
              />
            ) : (
              <>
                {/* Status line */}
                <Box marginBottom={GAP_BETWEEN_SECTIONS}>
                  <Text dimColor wrap="truncate">
                    {`Cost by ${groupBy}`}
                    {DOT_SEP}
                    {periodLabel}
                    {DOT_SEP}
                    {`total `}
                    <Text color={semanticColors.cost.value}>{formatMoneyExact(totalCost)}</Text>
                    {DOT_SEP}
                    {'source Cost Explorer'}
                  </Text>
                </Box>
                <DataTable<PeriodRow>
                  columns={periodColumns}
                  rows={periodRows}
                  selectedIndex={periodSelected}
                  onSelect={setPeriodSelected}
                  getRowKey={(row) => `${row.rank}-${row.rawLabel}`}
                  chromeRows={14}
                  {...(tablePageSize !== undefined ? { pageSize: tablePageSize } : {})}
                />
              </>
            )}
          </Box>
        )}

        {/* Trend tab */}
        {activeTab === 'trend' && (
          <Box flexDirection="column">
            {dailyData.length < 2 ? (
              <EmptyState
                key="trend-empty"
                icon="○"
                message="Not enough daily cost data for trend analysis."
                hint="Run a scan to populate cost history."
              />
            ) : (
              <TrendChart data={dailyData} forecastDays={30} />
            )}
          </Box>
        )}

        {/* Anomaly tab */}
        {activeTab === 'anomaly' && (
          <Box flexDirection="column">
            {anomalyRows.length === 0 ? (
              <Box marginTop={GAP_BETWEEN_SECTIONS} marginLeft={MARGIN_LEFT_CONTENT}>
                <Text dimColor>No cost anomalies detected in the selected period.</Text>
              </Box>
            ) : (
              <DataTable<AnomalyRow>
                columns={ANOMALY_COLUMNS}
                rows={anomalyRows}
                selectedIndex={anomalySelected}
                onSelect={setAnomalySelected}
                getRowKey={(row) => `${row.service}-${row.amount}`}
                chromeRows={14}
                {...(tablePageSize !== undefined ? { pageSize: tablePageSize } : {})}
              />
            )}
          </Box>
        )}
      </TabbedResult>
    </Box>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface CostsCommandProps {
  provider: AgentProvider | null;
  args?: string[];
  onRunAgain?: () => void;
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
  aiConfigured?: boolean;
}

// ─── Command component ────────────────────────────────────────────────────────

export function CostsCommand({
  provider,
  args = [],
  onRunAgain,
  onBack,
  onAction,
  aiConfigured = false,
}: CostsCommandProps): React.JSX.Element {
  // ── Parse args ──────────────────────────────────────────────────────────────
  const rawDaysStr = parseArg(args, '--days');
  const rawDays = rawDaysStr !== null ? Number(rawDaysStr) : NaN;
  const MAX_DAYS = 397;
  const hasExplicitDays = Number.isInteger(rawDays) && rawDays > 0;

  // Default: current calendar month. Explicit --days N: rolling window.
  const todayIso = new Date().toISOString().slice(0, 10);
  const monthStartIso = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  })();
  const periodStart = hasExplicitDays
    ? (() => { const d = new Date(); d.setDate(d.getDate() - Math.min(rawDays, MAX_DAYS)); return d.toISOString().slice(0, 10); })()
    : monthStartIso;
  const periodEnd = todayIso;
  const cappedDays = Math.max(1, Math.round((new Date(periodEnd).getTime() - new Date(periodStart).getTime()) / 86400000));
  const days = cappedDays;

  const periodLabel = hasExplicitDays
    ? `last ${cappedDays} days`
    : new Date(periodStart + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const VALID_GROUPS: GroupByValue[] = ['service', 'region', 'account', 'tag'];
  const rawGroup = parseArg(args, '--group-by') ?? 'service';
  const isValidGroup = (VALID_GROUPS as string[]).includes(rawGroup);
  const initialGroupBy = (isValidGroup ? rawGroup : 'service') as GroupByValue;
  const [groupBy, setGroupBy] = useState<GroupByValue>(initialGroupBy);

  // ── Tab state ────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<CostsTab>('period');
  const [detailItem, setDetailItem] = useState<CostsDetailItem | null>(null);
  const [groupByActive, setGroupByActive] = useState(false);
  const [pipelineHasError, setPipelineHasError] = useState(false);
  const detailActive = detailItem !== null;
  const { helpOpen, paletteOpen } = useGlobalOverlay();

  // ── Grouped cost data (layer 2 — switches instantly via pre-populated cache) ─
  type GroupedCacheEntry = { data: { costs?: Array<{ service?: string; region?: string; account?: string; tag?: string; amount?: number }>; totalCost?: number } | null; fetchedAt: number };
  const groupedCostCache = useRef<Map<string, GroupedCacheEntry>>(new Map());
  const [groupedData, setGroupedData] = useState<GroupedCacheEntry['data']>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [groupedLoading, setGroupedLoading] = useState(false);

  // Pre-fetch all groupBy variants in background so switching is instant
  const ALL_GROUPS: GroupByValue[] = ['service', 'region', 'account', 'tag'];
  useEffect(() => {
    let cancelled = false;
    for (const g of ALL_GROUPS) {
      const cacheKey = `${periodStart}-${periodEnd}-${g}`;
      if (groupedCostCache.current.has(cacheKey)) continue;
      void (async () => {
        try {
          const result = await getCostsTool.handler({ startDate: periodStart, endDate: periodEnd, granularity: 'MONTHLY', groupBy: g.toUpperCase() });
          if (cancelled) return;
          const parsed = parseToolResult(result) as GroupedCacheEntry['data'];
          const now = Date.now();
          groupedCostCache.current.set(cacheKey, { data: parsed, fetchedAt: now });
          // If this groupBy is currently active, update visible state
          if (g === groupBy) { setGroupedData(parsed); setFetchedAt(now); setGroupedLoading(false); }
        } catch { /* non-fatal — groupBy stays empty */ }
      })();
    }
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodStart, periodEnd]);

  // Switch active groupBy from cache (instant if pre-fetch completed, loading if still in flight)
  useEffect(() => {
    const cacheKey = `${periodStart}-${periodEnd}-${groupBy}`;
    const cached = groupedCostCache.current.get(cacheKey);
    if (cached !== undefined) {
      setGroupedData(cached.data);
      setFetchedAt(cached.fetchedAt);
      setGroupedLoading(false);
      return;
    }
    setGroupedLoading(true);
  }, [periodStart, periodEnd, groupBy]);

  // ── Pipeline steps ───────────────────────────────────────────────────────────
  const pipelineSteps = useMemo(
    () => buildCostsDatasetSteps({ startDate: periodStart, endDate: periodEnd }),
    [periodStart, periodEnd],
  );

  const datasetFingerprint = `costs-dataset-${periodStart}-${periodEnd}`;
  const viewFingerprint = `costs-view-${periodStart}-${periodEnd}-${groupBy}`;

  // ── Build period rows from grouped data ──────────────────────────────────────
  const periodRows: PeriodRow[] = useMemo(() => {
    const costs = groupedData?.costs ?? [];
    if (costs.length === 0) return [];

    const totalVal = groupedData?.totalCost !== undefined && groupedData.totalCost > 0
      ? groupedData.totalCost
      : costs.reduce((s, c) => s + (typeof c.amount === 'number' ? c.amount : 0), 0);

    const mapped = costs.map((c) => ({
      rawLabel: String(c.service ?? c.region ?? c.account ?? c.tag ?? 'unknown'),
      amount: typeof c.amount === 'number' ? c.amount : 0,
    }));

    // Deduplicate: sum amounts for same service label
    const deduped = new Map<string, number>();
    for (const c of mapped) {
      deduped.set(c.rawLabel, (deduped.get(c.rawLabel) ?? 0) + c.amount);
    }
    const sorted = [...deduped.entries()]
      .map(([rawLabel, amount]) => ({ rawLabel, amount }))
      .filter((c) => c.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    const visible = sorted.slice(0, TOP_N);
    const hidden = sorted.slice(TOP_N);

    const rows: PeriodRow[] = visible.map((c, i) => {
      const pct = totalVal > 0 ? (c.amount / totalVal) * 100 : 0;
      const pctStr = `${pct.toFixed(1)}%`;
      const barStr = shareBar(pct);
      return {
        rank: String(i + 1).padStart(2),
        service: smartLabel(c.rawLabel, 40),
        rawLabel: c.rawLabel,
        cost: formatMoneyExact(c.amount),
        share: `${pctStr.padEnd(COL_SHARE_W)} ${barStr}`,
        trend: pct >= 20 ? 'high' : pct >= 5 ? 'mid' : 'low',
        _cost: c.amount,
        _pct: pct,
        _isOther: false,
      };
    });

    if (hidden.length > 0) {
      const otherAmount = hidden.reduce((s, c) => s + c.amount, 0);
      const otherPct = totalVal > 0 ? (otherAmount / totalVal) * 100 : 0;
      const pctStr = `${otherPct.toFixed(1)}%`;
      rows.push({
        rank: String(rows.length + 1).padStart(2),
        service: `Other (${hidden.length})`,
        rawLabel: `Other (${hidden.length})`,
        cost: formatMoneyExact(otherAmount),
        share: `${pctStr.padEnd(COL_SHARE_W)} ${shareBar(otherPct)}`,
        trend: otherPct >= 20 ? 'high' : otherPct >= 5 ? 'mid' : 'low',
        _cost: otherAmount,
        _pct: otherPct,
        _isOther: true,
      });
    }

    return rows;
  }, [groupedData]);

  // ── renderResult: builds CommandResultView from pipeline context ─────────────
  const renderResultFn = useMemo(() => {
    return (ctx: PipelineContext): CommandResultView => {
      const { anomalies } = extractAnomalies(ctx);
      const totalCost = extractTotalCost({ results: new Map([...ctx.results, ['grouped_costs', groupedData]]) });

      // Daily cost data for Trend tab
      const dailyResult = ctx.results.get('daily_costs') as {
        costs?: Array<{ date?: string; amount?: number; service?: string }>;
      } | undefined;
      const dailyData: CostDataPoint[] = (dailyResult?.costs ?? [])
        .filter((c) => typeof c.date === 'string' && typeof c.amount === 'number' && c.amount > 0)
        .map((c) => ({ date: String(c.date), amount: Number(c.amount) }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // Anomaly rows
      const anomalyRows: AnomalyRow[] = anomalies.map((a) => {
        const sevLabel = anomalySeverityLabel(a.amount, a.expected);
        return {
          type: 'Spike',
          service: smartLabel(a.service, 18),
          amount: formatMoneyExact(a.amount),
          severity: sevLabel,
          _amount: a.amount,
        };
      });

      // The tabs component is the single item in the items array
      const tabsElement = (
        <CostsTabs
          key="costs-tabs"
          activeTab={activeTab}
          onTabChange={setActiveTab}
          isActive={!detailActive && !helpOpen && !paletteOpen}
          periodRows={periodRows}
          anomalyRows={anomalyRows}
          dailyData={dailyData}
          totalCost={totalCost}
          cappedDays={cappedDays}
          days={days}
          periodLabel={periodLabel}
          groupBy={groupBy}
          fetchedAt={fetchedAt}
          detailItem={detailItem}
          onDetailItemChange={setDetailItem}
          onGroupByOpen={() => { setGroupByActive(true); }}
          onGroupByClose={() => { setGroupByActive(false); }}
          onGroupByChange={setGroupBy}
          {...(ctx.viewportHeight !== undefined ? { availableRows: ctx.viewportHeight } : {})}
        />
      );

      return {
        items: [tabsElement],
        actions: [
          ...(provider !== null ? [{
            key: 'r',
            label: 'refresh AI',
            action: { type: 'run-again' as const },
          }] : []),
          {
            key: 'j',
            label: 'group by',
            action: { type: 'sort-toggle' as const },
          },
          {
            key: 's',
            label: 'scan',
            action: { type: 'navigate' as const, command: 'scan' as const },
          },
          {
            key: 'p',
            label: 'report',
            action: {
              type: 'navigate' as const,
              command: 'report' as const,
              args: ['--format', 'html', '--output', 'reports/costs.html'],
            },
          },
        ],
      };
    };
  }, [activeTab, detailActive, detailItem, periodRows, fetchedAt, groupedData, cappedDays, groupBy, days, periodLabel, provider, helpOpen, paletteOpen]);

  // fallback (no-AI mode)
  const fallbackFn = useMemo(() => renderResultFn, [renderResultFn]);

  // ── Validation ───────────────────────────────────────────────────────────────
  if (rawDaysStr !== null && (!Number.isInteger(rawDays) || rawDays <= 0)) {
    return (
      <ScreenShell
        header={<CommandHeader command="costs" description="cost breakdown" />}
      >
        <ErrorBox
          title="Invalid --days value"
          message={`"${rawDaysStr}" is not a valid number of days.`}
          hint="Use a positive integer such as --days 90 for a rolling window"
          actions={[
            {
              key: 'd',
              label: 'use current month',
              action: { type: 'navigate' as const, command: 'costs', args: [] },
            },
          ]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  if (!isValidGroup) {
    return (
      <ScreenShell
        header={<CommandHeader command="costs" description="cost breakdown" />}
      >
        <ErrorBox
          title="Invalid --group-by value"
          message={`"${rawGroup}" is not a valid grouping.`}
          hint={`Valid values: ${VALID_GROUPS.join(', ')}`}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  // ── Action handler ───────────────────────────────────────────────────────────
  const handleAction = (action: TuiAction): void => {
    if (action.type === 'run-again') {
      onRunAgain?.();
      return;
    }
    onAction?.(action);
  };

  // ── No-AI mode ───────────────────────────────────────────────────────────────
  if (provider === null) {
    return (
      <ScreenShell
        header={
          <CommandHeader
            command="costs"
            description="cost breakdown"
            tags={[periodLabel, `by ${groupBy}`]}
            variant="compact"
            mode="local"
          />
        }
        hints={!pipelineHasError ? <InteractionHints hints={[IH_ARROWS, IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} /> : undefined}
      >
        <AiStatusBanner provider={provider} aiConfigured={aiConfigured} />
        <DirectPipeline
          steps={pipelineSteps}
          renderResult={fallbackFn}
          onRunAgain={onRunAgain}
          onBack={onBack}
          onAction={handleAction}
          onError={setPipelineHasError}
          overlayActive={detailActive || groupByActive || helpOpen || paletteOpen}
        />
      </ScreenShell>
    );
  }

  // ── Hybrid mode ──────────────────────────────────────────────────────────────
  return (
    <ScreenShell
      header={
        <CommandHeader
          command="costs"
          description="cost breakdown"
          scope={`${process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1'}${DOT_SEP}${process.env['AWS_PROFILE'] ?? 'default'}`}
          tags={[periodLabel, `by ${groupBy}`, ...(groupedLoading ? ['loading…'] : [])]}
          variant="compact"
        />
      }
      hints={!pipelineHasError ? <InteractionHints hints={[IH_ARROWS, IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} /> : undefined}
    >
      <HybridPipeline
        steps={pipelineSteps}
        provider={provider}
        buildAnalysisPrompt={buildCostsAnalysisPrompt}
        systemPrompt={getAnalysisPrompt('costs')}
        renderResult={renderResultFn}
        renderFallback={fallbackFn}
        onRunAgain={onRunAgain}
        onBack={onBack}
        onAction={handleAction}
        allowFollowUp
        followUpContextSource="cost data"
        datasetFingerprint={datasetFingerprint}
        viewFingerprint={viewFingerprint}
        overlayActive={detailActive || groupByActive || helpOpen || paletteOpen}
        onError={setPipelineHasError}
      />
    </ScreenShell>
  );
}
