/**
 * Resources command — §5 tabbed resource browser.
 *
 * §5.1 Running: HybridPipeline spinner phase
 * §5.2 Result: TabbedResult with EC2 / RDS / S3 tabs, each a DataTable
 * §5.3 Detail overlay: Enter on row → ResourceDetailOverlay
 * §5.4 Empty state per tab
 * §5.5 Error: ErrorBox (owned footer)
 * §5.6 Stale banner if collectedAt > 1 day old
 *
 * Rules enforced:
 *   VRHYTHM_RULE  — GAP_AFTER_HEADER / GAP_BETWEEN_SECTIONS / GAP_BEFORE_ACTIONS only
 *   DOT_SEP_RULE  — DOT_SEP from ui/text.js
 *   SCREEN_SHELL_RULE — wrapped in ScreenShell
 *   X-1 rule — NavHints = navigation only; r p s ? in ActionBar
 *   ERR2-1 rule — ErrorBox owns its footer
 *   G-2 rule — renderResult / renderFallback return CommandResultView
 *   G-5 key contract — r=run again, p=report, s=scan, ?=help
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { copyToClipboard as copyTextToClipboard } from '../utils/clipboard.js';

import type { AgentProvider } from '../../agent/types.js';
import { DirectPipeline } from '../components/DirectPipeline.js';
import { HybridPipeline } from '../components/HybridPipeline.js';
import type { PipelineContext, CommandResultView } from '../components/DirectPipeline.js';
import type { TuiAction } from '../actions.js';
import { CommandHeader } from '../components/CommandHeader.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { TabbedResult } from '../components/TabbedResult.js';
import { DataTable } from '../components/DataTable.js';
import type { ColumnDef } from '../components/DataTable.js';
import { EmptyState } from '../components/EmptyState.js';
import { ResourceDetailOverlay } from '../components/ResourceDetailOverlay.js';
import type { ResourceDetailItem } from '../components/ResourceDetailOverlay.js';
import { ResourceFilterOverlay, type ResourceFilterState } from '../components/ResourceFilterOverlay.js';
import { InteractionHints, IH_TABS, IH_BACK, IH_COMMAND, IH_HELP, IH_QUIT } from '../components/InteractionHints.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';
import { useToast } from '../hooks/useToast.js';
import { parseArg } from '../utils/parseArgs.js';
import { buildResourcesPipelineSteps, extractResourceRows } from '../pipelines/resources.js';
import { buildResourcesAnalysisPrompt } from '../pipelines/analysis.js';
import { getAnalysisPrompt } from '../../agent/prompts.js';
import { GAP_BETWEEN_SECTIONS } from '../ui/spacing.js';
import { DOT_SEP } from '../ui/text.js';
import { colors, icons, semanticColors } from '../theme.js';
import { truncateWidth } from '../ui/width.js';
import { formatCost } from '../utils/format.js';

// ─── Resource row type ────────────────────────────────────────────────────────

type ResourceRow = ReturnType<typeof extractResourceRows>[number];

// ─── Tab IDs ──────────────────────────────────────────────────────────────────

type TabId = 'ec2' | 'rds' | 's3';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'ec2', label: 'EC2' },
  { id: 'rds', label: 'RDS' },
  { id: 's3', label: 'S3' },
];

// ─── Type predicates ─────────────────────────────────────────────────────────

function isEc2(r: ResourceRow): boolean {
  return r.type === 'ec2_instance';
}

function isRds(r: ResourceRow): boolean {
  return r.type === 'rds_instance' || r.type === 'rds_cluster_instance';
}

function isS3(r: ResourceRow): boolean {
  return r.type === 's3_bucket';
}

// ─── Cost display ─────────────────────────────────────────────────────────────

function costText(row: ResourceRow): string {
  if (row.monthlyCostUsd === undefined) return '—';
  if (row.monthlyCostUsd === 0) return 'no spend';
  const prefix = row.monthlyCostSource === 'cost_explorer' ? '' : '~';
  return `${prefix}${formatCost(row.monthlyCostUsd)}`;
}

// ─── Column definitions (§5.2.1–5.2.3) ───────────────────────────────────────

const EC2_COLUMNS: ColumnDef<ResourceRow>[] = [
  { key: 'id',           label: 'INSTANCE ID', priority: 1, truncate: 'end', maxWidth: 45 },
  {
    key: 'state',
    label: 'STATE',
    priority: 3,
    width: 8,
    truncate: 'end',
    renderCell: (value, _row, width) => {
      const v = String(value).toLowerCase();
      const color = v === 'running' ? semanticColors.status.pass
        : v === 'stopped' || v === 'terminated' ? semanticColors.status.fail
        : v === 'pending' || v === 'stopping' ? semanticColors.status.warn
        : undefined;
      return <Text color={color}>{truncateWidth(String(value), width)}</Text>;
    },
  },
  { key: 'instanceType', label: 'TYPE',        priority: 2, width: 12, truncate: 'end' },
  {
    key: 'monthlyCostUsd',
    label: 'COST/mo',
    priority: 1,
    width: 10,
    truncate: 'end',
    renderCell: (_v, row) => {
      const t = costText(row);
      return <Text color={t !== '—' ? semanticColors.cost.value : undefined}>{t}</Text>;
    },
  },
];

const RDS_COLUMNS: ColumnDef<ResourceRow>[] = [
  { key: 'name',   label: 'DB NAME', priority: 1, truncate: 'end', maxWidth: 40 },
  {
    key: 'engine',
    label: 'ENGINE',
    priority: 2,
    width: 10,
    truncate: 'end',
    renderCell: (_v, row, width) => {
      const v = row.engine ?? '—';
      return <Text color={v !== '—' ? colors.info : undefined}>{truncateWidth(v, width)}</Text>;
    },
  },
  {
    key: 'state',
    label: 'STATUS',
    priority: 3,
    width: 10,
    truncate: 'end',
    renderCell: (value, _row, width) => {
      const v = String(value).toLowerCase();
      const color = v === 'available' || v === 'running' ? semanticColors.status.pass
        : v === 'stopped' || v === 'deleting' || v === 'failed' ? semanticColors.status.fail
        : v === 'creating' || v === 'modifying' || v === 'rebooting' ? semanticColors.status.warn
        : undefined;
      return <Text color={color}>{truncateWidth(String(value), width)}</Text>;
    },
  },
  {
    key: 'monthlyCostUsd',
    label: 'COST/mo',
    priority: 1,
    width: 10,
    truncate: 'end',
    renderCell: (_v, row) => {
      const t = costText(row);
      return <Text color={t !== '—' ? semanticColors.cost.value : undefined}>{t}</Text>;
    },
  },
];

const S3_COLUMNS: ColumnDef<ResourceRow>[] = [
  { key: 'name',   label: 'BUCKET NAME', priority: 1, truncate: 'end', maxWidth: 60 },
  { key: 'region', label: 'REGION',      priority: 2, width: 15, truncate: 'end' },
  {
    key: 'sizeGb',
    label: 'SIZE (GB)',
    priority: 2,
    width: 11,
    truncate: 'end',
    renderCell: (_v, row) => {
      const v = row.sizeGb !== undefined ? row.sizeGb.toFixed(1) : '—';
      return <Text color={row.sizeGb !== undefined ? colors.info : undefined}>{v}</Text>;
    },
  },
  {
    key: 'monthlyCostUsd',
    label: 'COST/mo',
    priority: 1,
    width: 10,
    truncate: 'end',
    renderCell: (_v, row) => {
      const t = costText(row);
      return <Text color={t !== '—' ? semanticColors.cost.value : undefined}>{t}</Text>;
    },
  },
];

// ─── Stale banner ─────────────────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function staleDaysFromRows(rows: ResourceRow[]): number | null {
  // Find the oldest collectedAt across all rows
  let oldest: Date | null = null;
  for (const r of rows) {
    if (r.collectedAt === undefined) continue;
    try {
      const d = new Date(r.collectedAt);
      if (!isNaN(d.getTime()) && (oldest === null || d < oldest)) {
        oldest = d;
      }
    } catch { /* skip */ }
  }
  if (oldest === null) return null;
  const ageMs = Date.now() - oldest.getTime();
  if (ageMs < ONE_DAY_MS) return null;
  return Math.floor(ageMs / ONE_DAY_MS);
}

function StaleBanner({ days }: { days: number }): React.JSX.Element {
  return (
    <Box gap={1} marginBottom={GAP_BETWEEN_SECTIONS}>
      <Text color={colors.warning}>{icons.warning}</Text>
      <Text color={colors.warning}>
        Resource list is {days} {days === 1 ? 'day' : 'days'} old. Press (r) to refresh.
      </Text>
    </Box>
  );
}

// ─── Per-tab row state ─────────────────────────────────────────────────────────

interface TabRowState {
  selectedIndex: number;
}

// ─── Tabbed resource browser (inner component) ───────────────────────────────

interface TabbedBrowserProps {
  allRows: ResourceRow[];
  isActive?: boolean;
  onDetailOpen?: (() => void) | undefined;
  onDetailClose?: (() => void) | undefined;
  onFilterOpen?: (() => void) | undefined;
  onFilterClose?: (() => void) | undefined;
  copyRequestToken?: number | undefined;
  filterOpenToken?: number | undefined;
}

function TabbedResourceBrowser({ allRows, isActive = true, onDetailOpen, onDetailClose, onFilterOpen, onFilterClose, copyRequestToken, filterOpenToken }: TabbedBrowserProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('ec2');
  const [tabState, setTabState] = useState<Record<TabId, TabRowState>>({
    ec2: { selectedIndex: 0 },
    rds: { selectedIndex: 0 },
    s3:  { selectedIndex: 0 },
  });
  const [detailResource, setDetailResource] = useState<ResourceDetailItem | null>(null);
  const [filterOverlayOpen, setFilterOverlayOpen] = useState(false);
  const [filters, setFilters] = useState<ResourceFilterState>({
    type: '',
    region: '',
    state: '',
    name: '',
  });
  const { toasts, show: showToast } = useToast();

  // Apply filters client-side
  const filteredRows = useMemo(() => {
    return allRows.filter((row) => {
      if (filters.type && row.type !== filters.type) return false;
      if (filters.region && row.region !== filters.region) return false;
      if (filters.state && row.state !== filters.state) return false;
      if (filters.name && !row.name.toLowerCase().includes(filters.name.toLowerCase())) return false;
      return true;
    });
  }, [allRows, filters]);

  const ec2Rows = useMemo(() => filteredRows.filter(isEc2), [filteredRows]);
  const rdsRows = useMemo(() => filteredRows.filter(isRds), [filteredRows]);
  const s3Rows  = useMemo(() => filteredRows.filter(isS3),  [filteredRows]);

  const staleDays = useMemo(() => staleDaysFromRows(filteredRows), [filteredRows]);

  // Collect unique values for filter dropdowns from unfiltered rows
  const availableTypes = useMemo(() => {
    const types = new Set<string>();
    allRows.forEach((r) => types.add(r.type));
    return Array.from(types).sort();
  }, [allRows]);

  const availableRegions = useMemo(() => {
    const regions = new Set<string>();
    allRows.forEach((r) => regions.add(r.region));
    return Array.from(regions).sort();
  }, [allRows]);

  const availableStates = useMemo(() => {
    const states = new Set<string>();
    allRows.forEach((r) => states.add(r.state));
    return Array.from(states).sort();
  }, [allRows]);

  const filtersActive = filters.type !== '' || filters.region !== '' || filters.state !== '' || filters.name !== '';

  // Tab cycling via ← / →
  useInput((_input, key) => {
    if (detailResource !== null) return;
    const idx = TABS.findIndex((t) => t.id === activeTab);
    if (key.leftArrow) {
      const prev = TABS[(idx - 1 + TABS.length) % TABS.length];
      if (prev !== undefined) setActiveTab(prev.id);
    } else if (key.rightArrow) {
      const next = TABS[(idx + 1) % TABS.length];
      if (next !== undefined) setActiveTab(next.id);
    }
  }, { isActive: isActive && detailResource === null });

  function openDetail(rows: ResourceRow[], index: number): void {
    const row = rows[index];
    if (row === undefined) return;
    setDetailResource({
      id: row.id,
      name: row.name,
      type: row.type,
      region: row.region,
      state: row.state,
      instanceType: row.instanceType,
      arn: row.arn,
      collectedAt: row.collectedAt,
      monthlyCostUsd: row.monthlyCostUsd,
      monthlyCostSource: row.monthlyCostSource,
    });
    onDetailOpen?.();
  }

  // Helper: copy text to clipboard (cross-platform)
  function copyToClipboard(text: string): void {
    const result = copyTextToClipboard(text.slice(0, 100_000));
    if (result.ok) {
      showToast({ level: 'success', message: 'Resource ID copied' });
    } else {
      showToast({ level: 'warning', message: 'Failed to copy to clipboard' });
    }
  }

  // Handle local actions
  useInput((input, _key) => {
    if (!isActive || detailResource !== null || filterOverlayOpen) return;
    if (input === 'f') {
      setFilterOverlayOpen(true);
      onFilterOpen?.();
    }
  }, { isActive });

  // Respond to copy request from ActionBar (lifted)
  useEffect(() => {
    if (copyRequestToken === undefined || copyRequestToken === 0) return;

    function getCurrentFocusedResourceIdLocal(): string | null {
      if (activeTab === 'ec2') {
        const row = ec2Rows[tabState.ec2.selectedIndex];
        return row?.id ?? null;
      } else if (activeTab === 'rds') {
        const row = rdsRows[tabState.rds.selectedIndex];
        return row?.id ?? null;
      } else {
        const row = s3Rows[tabState.s3.selectedIndex];
        return row?.id ?? null;
      }
    }

    const id = getCurrentFocusedResourceIdLocal();
    if (id) {
      const result = copyTextToClipboard(id.slice(0, 100_000));
      showToast({ level: result.ok ? 'success' : 'error', message: result.ok ? 'Resource ID copied' : 'Failed to copy ID' });
    }
  }, [copyRequestToken, activeTab, ec2Rows, rdsRows, s3Rows, tabState, showToast]);

  // Respond to filter-open request from ActionBar — use token so it works even
  // when isActive=false (e.g. when AI insights outer tab is active).
  const prevFilterTokenRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (filterOpenToken === undefined || filterOpenToken === 0) return;
    if (filterOpenToken === prevFilterTokenRef.current) return;
    prevFilterTokenRef.current = filterOpenToken;
    setFilterOverlayOpen(true);
    onFilterOpen?.();
  }, [filterOpenToken, onFilterOpen]);

  // Enter on a row → open detail
  useInput((_input, key) => {
    if (detailResource !== null) return;
    if (filterOverlayOpen) return;
    if (!key.return) return;
    if (activeTab === 'ec2') openDetail(ec2Rows, tabState.ec2.selectedIndex);
    else if (activeTab === 'rds') openDetail(rdsRows, tabState.rds.selectedIndex);
    else openDetail(s3Rows, tabState.s3.selectedIndex);
  }, { isActive: isActive && detailResource === null });

  if (filterOverlayOpen) {
    return (
      <ResourceFilterOverlay
        availableTypes={availableTypes}
        availableRegions={availableRegions}
        availableStates={availableStates}
        onApply={(newFilters) => {
          setFilters(newFilters);
          setFilterOverlayOpen(false);
          onFilterClose?.();
        }}
        onCancel={() => { setFilterOverlayOpen(false); onFilterClose?.(); }}
        isActive={isActive}
      />
    );
  }

  if (detailResource !== null) {
    return (
      <ResourceDetailOverlay
        resource={detailResource}
        onClose={() => { setDetailResource(null); onDetailClose?.(); }}
        isActive={isActive}
        onCopyArn={() => copyToClipboard(detailResource.arn ?? detailResource.id)}
      />
    );
  }

  function makeEmptyState(service: string): React.JSX.Element {
    if (filtersActive) {
      return (
        <EmptyState
          key={`empty-${service}-filtered`}
          icon="○"
          message="No resources match filters."
          hint="Press f to change filters."
        />
      );
    }
    return (
      <EmptyState
        key={`empty-${service}`}
        icon="○"
        message={`No ${service} resources found.`}
        hint={`No ${service} resources found. Run scan to collect inventory.`}
      />
    );
  }

  return (
    <Box flexDirection="column">
      {staleDays !== null && <StaleBanner days={staleDays} />}
      {filtersActive && <Box marginBottom={GAP_BETWEEN_SECTIONS}><Text color={colors.warning}>AI insights apply to filtered view only — not full inventory</Text></Box>}

      <TabbedResult
        tabs={TABS}
        activeTab={activeTab}
        onTabChange={(id) => setActiveTab(id as TabId)}
        isActive={isActive && !filterOverlayOpen}
      >
        {activeTab === 'ec2' && (
          ec2Rows.length === 0
            ? makeEmptyState('EC2')
            : <DataTable<ResourceRow>
                columns={EC2_COLUMNS}
                rows={ec2Rows}
                selectedIndex={tabState.ec2.selectedIndex}
                onSelect={(i) => setTabState((prev) => ({ ...prev, ec2: { selectedIndex: i } }))}
                getRowKey={(row) => `${row.type}-${row.id}`}
              />
        )}
        {activeTab === 'rds' && (
          rdsRows.length === 0
            ? makeEmptyState('RDS')
            : <DataTable<ResourceRow>
                columns={RDS_COLUMNS}
                rows={rdsRows}
                selectedIndex={tabState.rds.selectedIndex}
                onSelect={(i) => setTabState((prev) => ({ ...prev, rds: { selectedIndex: i } }))}
                getRowKey={(row) => `${row.type}-${row.id}`}
              />
        )}
        {activeTab === 's3' && (
          s3Rows.length === 0
            ? makeEmptyState('S3')
            : <DataTable<ResourceRow>
                columns={S3_COLUMNS}
                rows={s3Rows}
                selectedIndex={tabState.s3.selectedIndex}
                onSelect={(i) => setTabState((prev) => ({ ...prev, s3: { selectedIndex: i } }))}
                getRowKey={(row) => `${row.type}-${row.id}`}
              />
        )}
      </TabbedResult>

      {toasts[0] !== undefined && (
        <Box marginTop={GAP_BETWEEN_SECTIONS}>
          <Text color={toasts[0].level === 'success' ? semanticColors.status.pass : toasts[0].level === 'warning' ? colors.warning : colors.error}>
            {icons.info} {toasts[0].message}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ─── renderResult helper ──────────────────────────────────────────────────────

interface BuildResultViewArgs {
  onDetailOpen?: (() => void) | undefined;
  onDetailClose?: (() => void) | undefined;
  onFilterOpen?: (() => void) | undefined;
  onFilterClose?: (() => void) | undefined;
  copyRequestToken?: number | undefined;
  filterOpenToken?: number | undefined;
  filterOverlayOpen?: boolean | undefined;
  detailOverlayOpen?: boolean | undefined;
  isActive?: boolean | undefined;
}

function buildResultView(
  allRows: ResourceRow[],
  args: BuildResultViewArgs = {},
): CommandResultView {
  const items: React.JSX.Element[] = [
    <TabbedResourceBrowser
      key="tabbed-browser"
      allRows={allRows}
      isActive={args.isActive ?? true}
      onDetailOpen={args.onDetailOpen}
      onDetailClose={args.onDetailClose}
      onFilterOpen={args.onFilterOpen}
      onFilterClose={args.onFilterClose}
      copyRequestToken={args.copyRequestToken}
      filterOpenToken={args.filterOpenToken}
    />,
  ];

  if (args.filterOverlayOpen === true || args.detailOverlayOpen === true) {
    return { items };
  }

  const actions = [
    { key: 'f', label: 'filter',     action: { type: 'open-filter' as const } },
    { key: 'c', label: 'copy ID',    action: { type: 'copy-id' as const, id: '' } },
    { key: 'r', label: 'refresh',    action: { type: 'run-again' as const } },
    { key: 'p', label: 'report',     action: { type: 'navigate' as const, command: 'report' as const, args: ['--format', 'html'] } },
    { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'scan' as const } },
  ];

  return { items, actions };
}

// ─── Command component ────────────────────────────────────────────────────────

export interface ResourcesCommandProps {
  provider: AgentProvider | null;
  args?: string[];
  onRunAgain?: () => void;
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
  promptMaxResources?: number | undefined;
  promptMaxRecommendations?: number | undefined;
}

export function ResourcesCommand({
  provider,
  args = [],
  onRunAgain,
  onBack,
  onAction,
  promptMaxResources,
  promptMaxRecommendations,
}: ResourcesCommandProps): React.JSX.Element {
  const regionsRaw = parseArg(args, '--regions') ?? parseArg(args, '-r');
  const regions = regionsRaw?.split(',').map((r) => r.trim()).filter(Boolean);

  // Stable string key so useMemo doesn't re-run when args array identity changes
  const regionsKey = regions?.join(',') ?? '';
  const pipelineSteps = useMemo(
    () => buildResourcesPipelineSteps(regions !== undefined ? { regions } : {}),
    [regions],
  );

  // ── Overlay state (lifted so HybridPipeline can suppress FollowUpPanel Esc) ──
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const [detailActive, setDetailActive] = useState(false);
  const [filterActive, setFilterActive] = useState(false);
  const [copyRequestToken, setCopyRequestToken] = useState(0);
  const [filterOpenToken, setFilterOpenToken] = useState(0);
  const [resourceRows, setResourceRows] = useState<ResourceRow[]>([]);
  const [headerScope, setHeaderScope] = useState<string | undefined>(undefined);
  const handleDetailOpen  = useCallback(() => { setDetailActive(true); },  []);
  const handleDetailClose = useCallback(() => { setDetailActive(false); }, []);
  const handleFilterOpen  = useCallback(() => { setFilterActive(true); },  []);
  const handleFilterClose = useCallback(() => { setFilterActive(false); }, []);

  const handleAction = useCallback((action: TuiAction) => {
    if (action.type === 'copy-id') {
      if (detailActive) return;
      setCopyRequestToken((n) => n + 1);
      return;
    }
    if (action.type === 'open-filter') {
      if (detailActive) return;
      setFilterOpenToken((n) => n + 1);
      return;
    }
    onAction?.(action);
  }, [onAction, detailActive]);

  const buildArgs = useMemo(() => ({
    onDetailOpen: handleDetailOpen,
    onDetailClose: handleDetailClose,
    onFilterOpen: handleFilterOpen,
    onFilterClose: handleFilterClose,
    copyRequestToken,
    filterOpenToken,
    filterOverlayOpen: filterActive,
    detailOverlayOpen: detailActive,
    isActive: !helpOpen && !paletteOpen,
  }), [handleDetailOpen, handleDetailClose, handleFilterOpen, handleFilterClose, copyRequestToken, filterOpenToken, filterActive, detailActive, helpOpen, paletteOpen]);

  const renderResult = useCallback(
    (ctx: PipelineContext): CommandResultView => {
      const rows = extractResourceRows(ctx);
      queueMicrotask(() => {
        setResourceRows((prev) => (prev.length === rows.length ? prev : rows));
      });
      return buildResultView(rows, buildArgs);
    },
    [buildArgs],
  );

  const renderFallback = useCallback(
    (ctx: PipelineContext): CommandResultView => {
      const rows = extractResourceRows(ctx);
      queueMicrotask(() => {
        setResourceRows((prev) => (prev.length === rows.length ? prev : rows));
      });
      return buildResultView(rows, buildArgs);
    },
    [buildArgs],
  );

  // Update header scope reactively from latest data (not during render).
  useEffect(() => {
    const totalCount = resourceRows.length;
    const regionLabel = regions && regions.length > 0 ? regions[0] : undefined;
    if (totalCount === 0 && regionLabel === undefined) {
      setHeaderScope(undefined);
      return;
    }
    const label = `${totalCount} resource${totalCount === 1 ? '' : 's'}`;
    setHeaderScope(regionLabel ? `${label}${DOT_SEP}${regionLabel}` : label);
  }, [resourceRows, regionsKey, regions]);

  const [pipelineHasError, setPipelineHasError] = useState(false);
  // Suppress parent NavHints when the filter overlay owns its own footer.
  const hints = pipelineHasError || filterActive ? undefined : (
    <InteractionHints hints={[IH_TABS, IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />
  );

  const scope = headerScope;

  // ── No-AI mode ───────────────────────────────────────────────────────────
  if (provider === null) {
    return (
      <ScreenShell
        header={<CommandHeader command="resources" description="browse AWS resources" variant="compact" mode="local" scope={scope} />}
        hints={hints}
      >
        <DirectPipeline
          steps={pipelineSteps}
          renderResult={renderResult}
          onRunAgain={onRunAgain}
          onBack={onBack}
          onAction={handleAction}
          overlayActive={detailActive || filterActive || helpOpen || paletteOpen}
          onError={setPipelineHasError}
        />
      </ScreenShell>
    );
  }

  // ── Hybrid mode ──────────────────────────────────────────────────────────
  return (
    <ScreenShell
      header={<CommandHeader command="resources" description="browse AWS resources" variant="compact" scope={scope} />}
      hints={hints}
    >
      <HybridPipeline
        steps={pipelineSteps}
        provider={provider}
        buildAnalysisPrompt={(ctx) => buildResourcesAnalysisPrompt(ctx, { promptMaxResources, promptMaxRecommendations })}
        systemPrompt={getAnalysisPrompt('resources')}
        renderResult={renderResult}
        renderFallback={renderFallback}
        onRunAgain={onRunAgain}
        onBack={onBack}
        onAction={handleAction}
        overlayActive={detailActive || filterActive || helpOpen || paletteOpen}
        onError={setPipelineHasError}
      />
    </ScreenShell>
  );
}
