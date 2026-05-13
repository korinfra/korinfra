import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { homedir } from 'node:os';

import type { AgentProvider } from '../../agent/types.js';
import { AgentLoop } from '../components/AgentLoop.js';
import { DirectPipeline } from '../components/DirectPipeline.js';
import { HybridPipeline } from '../components/HybridPipeline.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { scanTools } from '../../tools/index.js';
import type { ColumnDef } from '../components/DataTable.js';
import { CommandHeader } from '../components/CommandHeader.js';
import { EmptyState } from '../components/EmptyState.js';
import { StatusLine } from '../components/StatusLine.js';
import { ScanDetailOverlay } from '../components/ScanDetailOverlay.js';
import type { ScanDetailRec } from '../components/ScanDetailOverlay.js';
import { colors, icons, semanticColors } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, MARGIN_LEFT_CONTENT, MARGIN_LEFT_RESULT } from '../ui/spacing.js';
import { DBG_DIR } from '../../aws/debug.js';
import { DOT_SEP, SEVERITY_LABELS } from '../ui/text.js';
import { formatMoney } from '../ui/format.js';
import { parseArg, sanitizePromptInput } from '../utils/parseArgs.js';
import { validateRegions } from '../utils/validateRegions.js';
import { ErrorBox } from '../components/ErrorBox.js';
import { getPrompt, getAnalysisPrompt } from '../../agent/prompts.js';
import { buildScanPipelineSteps, extractScanSummary, extractRecommendations } from '../pipelines/scan.js';
import { buildScanAnalysisPrompt } from '../pipelines/analysis.js';
import type { PipelineContext, CommandResultView } from '../components/DirectPipeline.js';
import type { ActionHint, TuiAction } from '../actions.js';
import { truncateWidth } from '../ui/width.js';
import { AiStatusBanner } from '../components/AiStatusBanner.js';
import { InteractionHints, IH_CANCEL, IH_BACK, IH_COMMAND, IH_HELP, IH_QUIT, IH_NAVIGATE } from '../components/InteractionHints.js';
import { TERMINAL_WIDTHS } from '../ui/breakpoints.js';
import { getDb } from '../../storage/db.js';
import { listScans } from '../../storage/queries/scans.js';
import { useTuiViewportLayout } from '../hooks/useTuiViewportLayout.js';
import { useConfig } from '../hooks/useConfig.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseRegions(args: string[]): string[] {
  const val = parseArg(args, '--regions') ?? parseArg(args, '-r');
  if (val === null) return [];
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}

// SCAN-2: selectable recommendations component with responsive max visible
interface SelectableRecsResponsiveProps {
  recs: ReturnType<typeof extractRecommendations>;
  maxVisible: number;
  /** Hard row budget: groups are added greedily until this many rows would be exceeded. */
  maxRows?: number | undefined;
  onAction?: ((action: TuiAction) => void) | undefined;
  /** Called when user presses Enter on a row to open the detail overlay. */
  onOpenDetail?: ((rec: ScanDetailRec) => void) | undefined;
  /** When true, this component's keyboard handler is inactive (overlay is open). */
  overlayActive?: boolean | undefined;
}

interface ScanRecommendationRow {
  id: string;
  severity: string;
  title: string;
  savings: string;
  description: string;
}

export const SCAN_RECOMMEND_COLUMNS: ColumnDef<ScanRecommendationRow>[] = [
  {
    key: 'severity',
    label: 'Severity',
    width: 10,
    priority: 1,
    renderCell: (value, _row) => {
      const v = String(value).toLowerCase();
      const color = v === 'critical' ? semanticColors.severity.critical
        : v === 'high' ? semanticColors.severity.high
        : v === 'medium' ? semanticColors.severity.medium
        : v === 'low' ? semanticColors.severity.low
        : undefined;
      return <Text color={color}>{String(value)}</Text>;
    },
  },
  { key: 'title', label: 'Recommendation', priority: 1, truncate: 'end', maxWidth: 80 },
  {
    key: 'savings',
    label: 'Savings/mo',
    width: 12,
    priority: 1,
    renderCell: (value) => {
      const v = String(value);
      return <Text color={v !== '—' ? semanticColors.savings.value : undefined}>{v}</Text>;
    },
  },
];

// ─── Grouped recommendations renderer ───────────────────────────────────────

type RecItem = ReturnType<typeof extractRecommendations>[number];

interface RecGroup {
  resourceKey: string;
  label: string;
  recs: RecItem[];
}

function buildGroups(visible: RecItem[]): RecGroup[] {
  const order: string[] = [];
  const map = new Map<string, RecItem[]>();
  for (const rec of visible) {
    const key = rec.resourceId ?? 'unknown';
    if (!map.has(key)) {
      order.push(key);
      map.set(key, []);
    }
    const bucket = map.get(key);
    if (bucket !== undefined) bucket.push(rec);
  }
  return order.map((key) => {
    const items = map.get(key) ?? [];
    const first = items[0];
    let label: string;
    if (key === 'unknown') {
      label = 'Unmanaged resources';
    } else if (first?.type !== undefined) {
      label = `${key} (${first.type})`;
    } else {
      label = key;
    }
    return { resourceKey: key, label, recs: items };
  });
}

const SEV_WIDTH = 8;    // "CRITICAL" = 8 chars
const AUTO_WIDTH = 7;   // "autofix" = 7 chars, or "       " when not autofix
const SAVINGS_WIDTH = 8;
const REC_INDENT = 4;

function RecRow({
  rec,
  isSelected,
  termWidth,
}: {
  rec: RecItem;
  isSelected: boolean;
  termWidth: number;
}): React.JSX.Element {
  const impact = rec.impact;
  const sevKey = (impact === 'critical' || impact === 'high' || impact === 'medium' || impact === 'low')
    ? impact
    : 'medium' as const;
  const sevLabel = SEVERITY_LABELS[sevKey];
  const sevColor = semanticColors.severity[sevKey];

  const isAutofix = rec.scenario === 'A' || rec.scenario === 'B';
  const savingsNum = rec.estimatedSavingsUsd ?? 0;
  const savingsStr = savingsNum > 0 ? `$${savingsNum.toFixed(0)}` : '—';

  // Title gets remaining width: total - container chrome (border+paddingX=4) - indent - sev - savings - auto - separating spaces
  const titleWidth = Math.max(10, termWidth - 4 - REC_INDENT - SEV_WIDTH - 1 - SAVINGS_WIDTH - 1 - AUTO_WIDTH - 2);
  const titleTrunc = truncateWidth(rec.title, titleWidth);

  return (
    <Box flexDirection="row">
      <Text color={isSelected ? colors.highlight : undefined}>{isSelected ? '❯' : ' '}</Text>
      <Text>{' '.repeat(REC_INDENT - 1)}</Text>
      <Text color={sevColor}>{sevLabel.slice(0, SEV_WIDTH).padEnd(SEV_WIDTH)}</Text>
      <Text>{' '}</Text>
      <Text bold={isSelected} color={isSelected ? colors.highlight : undefined}>{titleTrunc.padEnd(titleWidth)}</Text>
      <Text>{' '}</Text>
      <Text color={savingsNum > 0 ? semanticColors.savings.value : undefined} dimColor={savingsNum === 0}>{savingsStr.padStart(SAVINGS_WIDTH)}</Text>
      <Text>{' '}</Text>
      {isAutofix
        ? <Text color={colors.success}>{'autofix'}</Text>
        : rec.scenario === 'C'
          ? <Text dimColor>{'manual'.padEnd(AUTO_WIDTH)}</Text>
          : <Text>{' '.repeat(AUTO_WIDTH)}</Text>
      }
    </Box>
  );
}

function SelectableRecsResponsive({ recs, maxVisible, maxRows, onAction, onOpenDetail, overlayActive = false }: SelectableRecsResponsiveProps): React.JSX.Element {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Top-N slice → group by resource
  const visible = useMemo(() => recs.slice(0, maxVisible), [recs, maxVisible]);
  const allGroups = useMemo(() => buildGroups(visible), [visible]);

  // Greedy row budget: 1 (marginTop) + 1 (header) = 2 fixed, then groups until maxRows hit.
  // No gap between groups (saves G-1 rows). Each group = 1 header + N rec rows.
  const { shownGroups, hiddenRecs } = useMemo(() => {
    if (maxRows === undefined) return { shownGroups: allGroups, hiddenRecs: 0 };
    let used = 2; // marginTop + "Top Recommendations" header
    const shown: typeof allGroups = [];
    for (const group of allGroups) {
      const groupRows = 1 + group.recs.length; // group header + recs, no gap
      if (used + groupRows <= maxRows) {
        shown.push(group);
        used += groupRows;
      } else {
        break;
      }
    }
    // indicator "↓ N more" adds 1 extra row beyond maxRows — acceptable marginal overflow
    const hidden = allGroups.slice(shown.length).reduce((n, g) => n + g.recs.length, 0);
    return { shownGroups: shown, hiddenRecs: hidden };
  }, [allGroups, maxRows]);

  const flatRecs = useMemo(() => shownGroups.flatMap(g => g.recs), [shownGroups]);

  useEffect(() => {
    if (flatRecs.length === 0) { setSelectedIndex(0); return; }
    setSelectedIndex((i) => Math.min(i, flatRecs.length - 1));
  }, [flatRecs.length]);

  const selectedRec = flatRecs[selectedIndex];

  useInput((input, key) => {
    if (key.upArrow) { setSelectedIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIndex((i) => Math.min(flatRecs.length - 1, i + 1)); return; }
    if (key.return && selectedRec !== undefined) {
      if (onOpenDetail !== undefined) { onOpenDetail(selectedRec); }
      else { onAction?.({ type: 'navigate' as const, command: 'recommend', args: ['--select', selectedRec.id] }); }
      return;
    }
    if (input === 'f' && selectedRec !== undefined) {
      onAction?.({ type: 'navigate' as const, command: 'fix', args: [selectedRec.id] });
      return;
    }
    if (input === 'm' && selectedRec !== undefined) {
      onAction?.({ type: 'navigate' as const, command: 'recommend', args: ['--refresh', '--select', selectedRec.id] });
      return;
    }
  }, { isActive: !overlayActive });

  let flatIdx = 0;

  return (
    <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS} marginLeft={MARGIN_LEFT_CONTENT} flexShrink={0}>
      <Text bold color={colors.muted}>
        Top Recommendations
        {flatRecs.length < recs.length ? ` (${flatRecs.length} of ${recs.length})` : ` (${recs.length})`}
      </Text>

      {shownGroups.map((group) => {
        const groupStartIdx = flatIdx;
        flatIdx += group.recs.length;
        return (
          <Box key={group.resourceKey} flexDirection="column">
            <Text bold color={colors.highlight}>{'  '}{group.label}</Text>
            {group.recs.map((rec, ri) => (
              <RecRow
                key={rec.id}
                rec={rec}
                isSelected={groupStartIdx + ri === selectedIndex}
                termWidth={termWidth}
              />
            ))}
          </Box>
        );
      })}

      {hiddenRecs > 0 && (
        <Text dimColor>↓ {hiddenRecs} more finding{hiddenRecs !== 1 ? 's' : ''}</Text>
      )}
    </Box>
  );
}

function ScanStatsSummary({ summary, criticalCount, totalSavings, recCount }: {
  summary: ReturnType<typeof extractScanSummary>;
  criticalCount: number;
  totalSavings: number;
  recCount: number;
}): React.JSX.Element {
  const hasTf = summary.tfManaged !== undefined;
  return (
    <Box flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS} marginLeft={MARGIN_LEFT_CONTENT}>
      <Text dimColor wrap="truncate">
        {recCount} finding{recCount !== 1 ? 's' : ''}{criticalCount > 0 ? `${DOT_SEP}${criticalCount} ${SEVERITY_LABELS.critical}` : ''}{totalSavings > 0 ? `${DOT_SEP}${formatMoney(totalSavings)}/mo savings available` : ''}{DOT_SEP}{summary.resourceCount} resource{summary.resourceCount !== 1 ? 's' : ''}{DOT_SEP}{formatMoney(summary.totalMonthlyCostUsd)}/mo{summary.anomalyCount > 0 ? `${DOT_SEP}${summary.anomalyCount} anomal${summary.anomalyCount !== 1 ? 'ies' : 'y'}` : ''}{hasTf ? `${DOT_SEP}Terraform: ${summary.tfManaged ?? 0} managed${DOT_SEP}${summary.tfUndeployed ?? 0} undeployed` : ''}
      </Text>
    </Box>
  );
}

function makeRenderScanResult(
  onAction?: (action: TuiAction) => void,
  onOpenDetail?: (rec: ScanDetailRec) => void,
  overlayActive?: boolean,
  staleBannerAge?: number | null,
  scanTopRecs: number = 2,
  viewportHeight: number = 6,
  hasAi: boolean = true,
): (ctx: PipelineContext) => CommandResultView {
  return (ctx: PipelineContext): CommandResultView => {
    const summary = extractScanSummary(ctx);
    const recs = extractRecommendations(ctx);
    const scanId = summary.scanId;

    const reportArgs = scanId !== undefined
      ? ['--scan', scanId, '--format', 'html', '--output', `reports/scan-${scanId.slice(0, 8)}.html`]
      : ['--format', 'html', '--output', 'reports/latest-scan.html'];

    const SCAN_TOP_RECS = scanTopRecs;

    const items: React.JSX.Element[] = [];

    // Stale data banner — shown if last scan age > 1 hour
    if (staleBannerAge !== undefined && staleBannerAge !== null && staleBannerAge > 0) {
      const ageHours = Math.round(staleBannerAge / 3600);
      const ageLabel = ageHours >= 2 ? `${ageHours}h` : '1h';
      const isNarrow = (process.stdout.columns ?? 80) <= TERMINAL_WIDTHS.narrow;
      items.push(
        <Box key="stale-banner" flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
          {isNarrow ? (
            <>
              <Text color={semanticColors.badge.stale}>
                {icons.warning} Scan {ageLabel} old
              </Text>
              <Text color={semanticColors.badge.stale}>
                Press <Text color={colors.warning}>(r)</Text> to refresh
              </Text>
            </>
          ) : (
            <Text color={semanticColors.badge.stale}>
              {icons.warning}{'  '}Scan results are {ageLabel} old. Press <Text color={colors.warning}>(r)</Text> to refresh.
            </Text>
          )}
        </Box>,
      );
    }

    // Partial results banner — shown when one or more regions returned IAM/permission errors
    if (summary.partial) {
      const isNarrow = (process.stdout.columns ?? 80) <= TERMINAL_WIDTHS.narrow;
      const regionLabel = summary.failedRegions.length > 0 ? summary.failedRegions.join(', ') : null;
      const shortMsg = summary.failedRegions.length > 0
        ? `Partial results — ${summary.failedRegions.length} region${summary.failedRegions.length !== 1 ? 's' : ''} skipped`
        : `Partial results — ${summary.errorCount} collection error${summary.errorCount !== 1 ? 's' : ''}`;
      items.push(
        <Box key="partial-banner" flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
          {isNarrow ? (
            <>
              <Text color={colors.warning}>{icons.warning} {shortMsg}</Text>
              {regionLabel !== null && <Text color={colors.warning}>Skipped: {regionLabel}</Text>}
            </>
          ) : (
            <Text color={colors.warning}>
              {icons.warning}{'  '}
              {regionLabel !== null
                ? `${shortMsg}: ${regionLabel}`
                : `${shortMsg} — run with --debug for details`}
            </Text>
          )}
        </Box>,
      );
    }

    const criticalCount = recs.filter((r) => r.impact === 'critical').length;
    const totalSavings = recs.reduce((s, r) => s + (r.estimatedSavingsUsd ?? 0), 0);
    items.push(
      <ScanStatsSummary
        key="scan-stats"
        summary={summary}
        criticalCount={criticalCount}
        totalSavings={totalSavings}
        recCount={recs.length}
      />,
    );


    if (recs.length > 0) {
      // viewportHeight - 2: subtract ScanStatsSummary (1 text row + 1 marginBottom gap).
      const recsMaxRows = Math.max(4, viewportHeight - 2);
      items.push(
        <SelectableRecsResponsive
          key="selectable-recs"
          recs={recs}
          maxVisible={SCAN_TOP_RECS}
          maxRows={recsMaxRows}
          onAction={onAction}
          onOpenDetail={onOpenDetail}
          overlayActive={overlayActive}
        />,
      );

    } else {
      // Empty state — no findings
      items.push(
        <EmptyState
          key="empty-state"
          icon="○"
          message="No issues found. Infrastructure looks healthy."
        />,
      );
    }

    // ActionBar: f fix · m analyze · p report · s scan again (f/m handled by SelectableRecsResponsive local useInput)
    // f fix and m analyze require an AI provider — omit when ai.provider is none.
    const actions: ActionHint[] = recs.length > 0
      ? [
        ...(hasAi ? [
          { key: 'f', label: 'fix', action: { type: 'navigate' as const, command: 'fix' as const, args: [] } },
          { key: 'm', label: 'analyze', action: { type: 'navigate' as const, command: 'recommend' as const, args: [] } },
        ] : [
          { key: 'm', label: 'recommendations', action: { type: 'navigate' as const, command: 'recommend' as const, args: [] } },
        ]),
        { key: 'p', label: 'save report', action: { type: 'navigate' as const, command: 'report' as const, args: reportArgs } },
        { key: 's', label: 'scan again', action: { type: 'run-again' as const } },
      ]
      : [
        { key: 'p', label: 'save report', action: { type: 'navigate' as const, command: 'report' as const, args: reportArgs } },
        { key: 's', label: 'scan again', action: { type: 'run-again' as const } },
      ];
    return { items, actions };
  };
}

export interface ScanCommandProps {
  provider: AgentProvider | null;
  args?: string[];
  onRunAgain?: () => void;
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
  allowFollowUp?: boolean;
  /** True when ai.provider is configured (not 'none') but the provider failed to init. */
  aiConfigured?: boolean;
}

export function ScanCommand({
  provider,
  args = [],
  onRunAgain,
  onBack,
  onAction,
  allowFollowUp = false,
  aiConfigured = false,
}: ScanCommandProps): React.JSX.Element {
  const customPrompt = parseArg(args, '--prompt');
  // Stabilize derived values so pipelineSteps memo doesn't fire on every render.
  // parseRegions/parseArg/hasFlag create new values each call — memoize them.
  const regions = useMemo(() => parseRegions(args), [args]);
  const profile = useMemo(() => parseArg(args, '--profile') ?? parseArg(args, '-p'), [args]);
  const skipCosts = useMemo(() => hasFlag(args, '--skip-costs'), [args]);
  const skipMetrics = useMemo(() => hasFlag(args, '--skip-metrics'), [args]);
  const { config } = useConfig();

  const dir = useMemo(() => {
    const explicit = parseArg(args, '--dir');
    if (explicit) return explicit;
    return config?.terraform?.default_path ?? null;
  }, [args, config]);

  // Detail overlay state
  const [overlayRec, setOverlayRec] = useState<ScanDetailRec | null>(null);
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const overlayActive = overlayRec !== null || helpOpen || paletteOpen;

  const handleOpenDetail = useMemo(
    () => (rec: ScanDetailRec) => { setOverlayRec(rec); },
    [],
  );
  const handleCloseDetail = useMemo(
    () => () => { setOverlayRec(null); },
    [],
  );

  const [pipelineDone, setPipelineDone] = useState(false);

  // Stale banner — check age of last completed scan from DB; re-check when scan finishes
  const [staleBannerAgeSec, setStaleBannerAgeSec] = useState<number | null>(null);
  useEffect(() => {
    try {
      const db = getDb();
      const scans = listScans(db, 1, 0);
      const latest = scans[0];
      if (latest?.completed_at !== undefined && latest.completed_at !== null) {
        const ageMs = Date.now() - new Date(latest.completed_at).getTime();
        const ageSec = Math.floor(ageMs / 1000);
        // Only show banner if older than 1 hour (3600s)
        setStaleBannerAgeSec(ageSec > 3600 ? ageSec : null);
      }
    } catch {
      // DB not accessible or no scans yet — no banner
    }
  }, [pipelineDone]);

  const pipelineSteps = useMemo(
    () => buildScanPipelineSteps({ regions, profile, skipCosts, skipMetrics, dir }),
    [regions, profile, skipCosts, skipMetrics, dir],
  );

  // Mirror DirectPipeline result-mode viewportHeight: max(6, contentRows - STATUS_SUMMARY_ROWS(2))
  const { contentRows: vpContentRows } = useTuiViewportLayout({ header: 4, status: 2, actions: 2, hints: 2 });
  const scanViewportHeight = Math.max(6, vpContentRows - 2);
  const scanTopRecs = Math.max(2, scanViewportHeight - 2);

  const renderScanResult = useMemo(
    () => makeRenderScanResult(onAction, handleOpenDetail, overlayActive, staleBannerAgeSec, scanTopRecs, scanViewportHeight, provider !== null),
    [onAction, handleOpenDetail, overlayActive, staleBannerAgeSec, scanTopRecs, scanViewportHeight, provider],
  );

  // When the pipeline renders an ErrorBox, suppress ScreenShell hints.
  const [pipelineHasError, setPipelineHasError] = useState(false);

  // IH_CANCEL: Esc navigates back during pipeline; unmount triggers cancelled=true cleanup.
  useInput((_, key) => {
    if (key.escape) { onBack?.(); }
  }, { isActive: !overlayActive && !pipelineDone });

  const isDebugMode = process.env['KORINFRA_DEBUG'] === '1';

  const regionValidation = validateRegions(regions);

  const regionLabel = regions.length > 0 ? regions.join(', ') : (process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1');
  const profileLabel = profile ?? process.env['AWS_PROFILE'] ?? 'default';
  const scope = `${regionLabel}${DOT_SEP}${profileLabel}`;

  const tags = [
    ...(skipCosts ? ['skip-costs'] : []),
    ...(skipMetrics ? ['skip-metrics'] : []),
  ];

  // Validate region format upfront before starting any pipeline
  if (!regionValidation.valid) {
    return (
      <ScreenShell
        header={<CommandHeader command="scan" description="full infrastructure scan" scope={scope || undefined} variant="compact" />}
        hints={undefined}
      >
        <ErrorBox
          title="Invalid region"
          message={`Invalid AWS region${regionValidation.invalid.length > 1 ? 's' : ''}: ${regionValidation.invalid.join(', ')}. Use region codes like us-east-1 or eu-west-1.`}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  // Detail overlay — rendered on top of content when a row is selected
  const detailOverlay = overlayRec !== null ? (
    <ScanDetailOverlay
      rec={overlayRec}
      onAction={onAction}
      onClose={handleCloseDetail}
      isActive={overlayActive}
      hasAi={provider !== null}
    />
  ) : undefined;

  // No-AI mode: deterministic pipeline only
  if (provider === null) {
    return (
      <ScreenShell
        header={
          <CommandHeader
            command="scan"
            description="full infrastructure scan (local)"
            scope={scope || undefined}
            tags={tags}
            variant="compact"
          />
        }
        hints={!overlayActive && !pipelineHasError ? <InteractionHints hints={[...(!pipelineDone ? [IH_CANCEL] : [IH_NAVIGATE]), IH_COMMAND, IH_HELP, ...(pipelineDone ? [IH_BACK] : []), IH_QUIT]} /> : undefined}
        overlayActive={overlayActive}
      >
        {overlayActive && detailOverlay}
        <Box display={overlayActive ? "none" : "flex"} flexDirection="column">
          <AiStatusBanner provider={provider} aiConfigured={aiConfigured} />
          <Box marginLeft={MARGIN_LEFT_RESULT} marginBottom={GAP_BETWEEN_SECTIONS}>
            <StatusLine
              source="local"
              profile={profile ?? undefined}
              region={regionLabel}
            />
          </Box>
          <DirectPipeline
            steps={pipelineSteps}
            renderResult={renderScanResult}
            onRunAgain={onRunAgain}
            onBack={onBack}
            onAction={onAction}
            overlayActive={overlayActive}
            onResult={() => { setPipelineDone(true); }}
            onError={setPipelineHasError}
            viewportRowsOffset={2}
          />
        </Box>
        {!pipelineDone && isDebugMode && (
          <Box marginLeft={MARGIN_LEFT_RESULT}>
            <Text dimColor>Debug: {DBG_DIR.replace(homedir(), '~')}/</Text>
          </Box>
        )}
      </ScreenShell>
    );
  }

  // Custom prompt: full AgentLoop (user needs agent flexibility) — no table, no overlay
  if (customPrompt) {
    const safePrompt = sanitizePromptInput(customPrompt);
    const filters: string[] = [];
    if (regions?.length) filters.push(`Regions: ${regions.join(', ')}`);
    if (profile) filters.push(`AWS Profile: ${profile}`);
    if (skipCosts) filters.push('Skip cost analysis');
    if (skipMetrics) filters.push('Skip CloudWatch metrics');
    const prompt = filters.length > 0
      ? `${safePrompt}\n\nContext — ${filters.join('; ')}`
      : safePrompt;

    return (
      <ScreenShell
        header={<CommandHeader command="ask" description="AI agent" scope={scope || undefined} tags={tags} variant="compact" />}
        hints={<InteractionHints hints={[...(!pipelineDone ? [IH_CANCEL] : []), IH_COMMAND, IH_HELP, ...(pipelineDone ? [IH_BACK] : []), IH_QUIT]} />}
      >
        <Box marginBottom={GAP_BETWEEN_SECTIONS}>
          <StatusLine
            source="agent"
            profile={profile ?? undefined}
            region={regionLabel}
          />
        </Box>
        <AgentLoop
          prompt={prompt}
          provider={provider}
          tools={scanTools}
          builtinTools={[]}
          queryOptions={{ systemPrompt: getPrompt('scan') }}
          maxBudgetUsd={config?.ai.max_budget_usd ?? 0.5}
          onRunAgain={onRunAgain}
          onBack={onBack}
          onAction={onAction}
          allowFollowUp={allowFollowUp}
          onResult={() => { setPipelineDone(true); }}
        />
        {!pipelineDone && isDebugMode && (
          <Box marginLeft={MARGIN_LEFT_RESULT}>
            <Text dimColor>Debug: {DBG_DIR.replace(homedir(), '~')}/</Text>
          </Box>
        )}
      </ScreenShell>
    );
  }

  // Standard scan: HybridPipeline — collect data locally, then 1 AI call for analysis
  return (
    <ScreenShell
      header={
        <CommandHeader
          command="scan"
          description="full infrastructure scan"
          scope={scope || undefined}
          tags={tags}
          variant="compact"
        />
      }
      hints={!overlayActive && !pipelineHasError ? <InteractionHints hints={[...(!pipelineDone ? [IH_CANCEL] : [IH_NAVIGATE]), IH_COMMAND, IH_HELP, ...(pipelineDone ? [IH_BACK] : []), IH_QUIT]} /> : undefined}
      overlayActive={overlayActive}
    >
      {overlayActive && detailOverlay}
      <Box display={overlayActive ? "none" : "flex"} flexDirection="column">
        <Box marginLeft={MARGIN_LEFT_CONTENT} marginBottom={GAP_BETWEEN_SECTIONS}>
          <StatusLine
            source="AWS"
            profile={profile ?? undefined}
            region={regionLabel}
          />
        </Box>
        <HybridPipeline
          steps={pipelineSteps}
          provider={provider}
          buildAnalysisPrompt={(ctx) => buildScanAnalysisPrompt(ctx, { promptMaxResources: config?.ai.prompt_max_resources, promptMaxRecommendations: config?.ai.prompt_max_recommendations })}
          systemPrompt={getAnalysisPrompt('scan')}
          renderResult={renderScanResult}
          renderFallback={renderScanResult}
          onRunAgain={onRunAgain}
          onBack={onBack}
          onAction={onAction}
          allowFollowUp={allowFollowUp}
          overlayActive={overlayActive}
          onResult={() => { setPipelineDone(true); }}
          onError={setPipelineHasError}
          viewportRowsOffset={2}
        />
      </Box>
      {!pipelineDone && isDebugMode && (
        <Box marginLeft={MARGIN_LEFT_RESULT}>
          <Text dimColor>Debug: {DBG_DIR.replace(homedir(), '~')}/</Text>
        </Box>
      )}
    </ScreenShell>
  );
}
