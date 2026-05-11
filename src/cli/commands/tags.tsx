/**
 * TagsCommand — AWS resource tag management and compliance.
 *
 * Lifecycle per §11:
 *   §11.1 list — HybridPipeline: compliance audit with tab bar (Data/AI)
 *   §11.2 suggest — overlay: AI-suggested tags for selected resource (centered bordered box)
 *   §11.2b preflight — read-only confirmation: tag plan summary before apply
 *   §11.3 apply — DataTable: tag plan preview (RESOURCE | TAG | VALUE)
 *   §11.3b costs — tag cost allocation breakdown table
 *
 * Key contract (G-5):
 *   NavHints (InteractionHints) = navigation only: ↑↓, Esc/b, q, ?, :
 *   ActionBar = domain actions: g (suggest), r (refresh), a (apply plan), s (scan)
 *   d = clear plan (in apply state only)
 *
 * Rules: SCREEN_SHELL, VRHYTHM, DOT_SEP, X-1, G-2, ERR2-1
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { AgentProvider } from '../../agent/types.js';
import { AgentLoop } from '../components/AgentLoop.js';
import { DirectPipeline } from '../components/DirectPipeline.js';
import { HybridPipeline } from '../components/HybridPipeline.js';
import type { PipelineContext, CommandResultView } from '../components/DirectPipeline.js';
import { DataTable } from '../components/DataTable.js';
import type { ColumnDef } from '../components/DataTable.js';
import { ErrorBox } from '../components/ErrorBox.js';
import { CommandHeader } from '../components/CommandHeader.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { ActionBar } from '../components/ActionBar.js';
import { colors, icons, borders, semanticColors } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, GAP_ICON_TEXT, GAP_ROW, PADDING_X, GAP_BEFORE_ACTIONS } from '../ui/spacing.js';
import { DOT_SEP } from '../ui/text.js';
import { truncateWidth } from '../ui/width.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { getAnalysisPrompt } from '../../agent/prompts.js';
import { buildTagsPipelineSteps, extractTagCompliance } from '../pipelines/tags.js';
import type { TagComplianceRow } from '../pipelines/tags.js';
import { buildTagsAnalysisPrompt } from '../pipelines/analysis.js';
import { sanitizePromptInput } from '../utils/parseArgs.js';
import type { TuiAction, ActionHint, TuiCommand } from '../actions.js';
import { InteractionHints, IH_BACK, IH_COMMAND, IH_HELP, IH_QUIT } from '../components/InteractionHints.js';
import { ConfirmApplyTags } from '../components/ConfirmApplyTags.js';
import { EmptyState } from '../components/EmptyState.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';
import { useConfig } from '../hooks/useConfig.js';
import { tagsTools } from '../../tools/index.js';

type TagsSubcommand = 'list' | 'suggest' | 'apply' | 'costs';

const VALID_SUBCOMMANDS = new Set(['list', 'suggest', 'apply', 'costs']);

function parseArgs(args: string[]): {
  subcommand: TagsSubcommand | null;
  invalidSubcommand: string | null;
  resource: string | undefined;
  virtual: boolean;
} {
  const positional = args.filter((a) => !a.startsWith('-'));
  const rawSub = positional[0] ?? 'list';

  if (!VALID_SUBCOMMANDS.has(rawSub)) {
    return { subcommand: null, invalidSubcommand: rawSub, resource: undefined, virtual: false };
  }

  const subcommand = rawSub as TagsSubcommand;
  const virtual = args.includes('--virtual');

  let resource: string | undefined;
  const resourceIdx = args.findIndex((a) => a === '--resource' || a === '-r');
  if (resourceIdx !== -1 && args[resourceIdx + 1] && !(args[resourceIdx + 1] ?? '').startsWith('-')) {
    resource = sanitizePromptInput(args[resourceIdx + 1] ?? '');
  }

  return { subcommand, invalidSubcommand: null, resource, virtual };
}

function buildTagsPrompt(
  subcommand: TagsSubcommand,
  resource: string | undefined,
  virtual: boolean,
  requiredTags?: string[],
): string {
  const resourceFilter = resource ? ` for resource: ${resource}` : '';
  const virtualNote = virtual ? ' Include virtual/inferred tags.' : '';

  switch (subcommand) {
    case 'list':
      return `Audit tag compliance${resourceFilter}.${virtualNote}

Steps: collect_aws_resources → check required tags (${(requiredTags ?? ['Environment', 'Team', 'Project']).join(', ')})

Output:
## Compliance Summary (X% compliant, Y of Z resources)
## Missing Tags (table: tag | missing from N resources)
## Non-Compliant Resources (table: resource | type | missing tags)`;

    case 'suggest':
      return `Suggest tags for resource${resourceFilter}.${virtualNote}

For the selected resource, generate recommended tag key=value pairs.
Infer from resource name, type, and usage patterns.

Output: key=value pairs, one per line. Include source (inferred from X).`;

    case 'apply':
      return `Plan tag changes${resourceFilter}. Generate exact tag mutations but do NOT write.

Steps: collect_aws_resources → for each selected resource, generate tag key=value pairs.

Output format: JSON array only, no prose:
[{"resource": "resource-id", "tag": "key", "value": "value"}, ...]`;

    case 'costs':
      return `Cost allocation by tag${resourceFilter}.

Steps: get_costs with tag dimensions

Output:
## Cost by Tag Key (table: tag_key | tag_value | cost/month | % of total)
## Untagged Spend (total and % of all spend)`;

    default: {
      const _exhaustive: never = subcommand;
      return _exhaustive;
    }
  }
}

// ─── Tags table rows and columns (§11.1, §11.3) ──────────────────────────────

interface ComplianceTableRow {
  id: string;
  name: string;
  type: string;
  region: string;
  missing: string;
  _prodScore: number;
}

const COMPLIANCE_COLS: ColumnDef<ComplianceTableRow>[] = [
  { key: 'name', label: 'NAME', priority: 1, truncate: 'middle', maxWidth: 50 },
  { key: 'type', label: 'TYPE', priority: 2, maxWidth: 14, truncate: 'end' },
  {
    key: 'missing',
    label: 'MISSING TAGS',
    priority: 1,
    truncate: 'end',
    renderCell: (value, _row, width) => {
      const v = String(value);
      if (v === '—') return <Text dimColor>{v}</Text>;
      const count = v.split(',').length;
      const color = count >= 4 ? semanticColors.severity.high
        : count >= 2 ? semanticColors.severity.medium
        : semanticColors.severity.low;
      return <Text color={color}>{truncateWidth(v, width)}</Text>;
    },
  },
];

function prodScore(row: TagComplianceRow): number {
  let score = 0;
  const name = (row.name + row.id).toLowerCase();
  if (name.includes('prod') || name.includes('production')) score += 10;
  if (row.missingTags.includes('Team')) score += 3;
  if (row.missingTags.includes('Environment')) score += 2;
  return score;
}

function toComplianceRow(r: TagComplianceRow): ComplianceTableRow {
  return {
    id: r.id,
    name: r.name || r.id,
    type: r.type,
    missing: r.missingTags.join(', ') || '—',
    region: r.region,
    _prodScore: prodScore(r),
  };
}

// ─── §11.1 Compliance list (HybridPipeline) ───────────────────────────────

interface ComplianceTableProps {
  nonCompliant: TagComplianceRow[];
  compliantCount: number;
  totalCount: number;
  selectedResourceId?: string | undefined;
  onSelectionChange?: ((resourceId: string | null) => void) | undefined;
}

function ComplianceTable({
  nonCompliant,
  selectedResourceId,
  onSelectionChange,
}: ComplianceTableProps): React.JSX.Element {
  const sorted = useMemo(
    () => [...nonCompliant].sort((a, b) => prodScore(b) - prodScore(a)).map(toComplianceRow),
    [nonCompliant],
  );
  const [selectedIdx, setSelectedIdx] = useState(() => {
    if (!selectedResourceId) return 0;
    const sortedForInit = [...nonCompliant].sort((a, b) => prodScore(b) - prodScore(a));
    const idx = sortedForInit.findIndex((r) => r.id === selectedResourceId);
    return idx >= 0 ? idx : 0;
  });
  const selectedIdxRef = useRef(selectedIdx);
  selectedIdxRef.current = selectedIdx;

  useEffect(() => {
    const selected = sorted[selectedIdx];
    onSelectionChange?.(selected?.id ?? null);
  }, [sorted, selectedIdx, onSelectionChange]);

  // Sync local index when parent drives selectedResourceId (e.g. external navigation).
  // selectedIdx intentionally excluded from deps — read via ref to avoid resetting
  // user-initiated navigation before the parent propagates the new selectedResourceId.
  useEffect(() => {
    if (selectedResourceId === undefined || selectedResourceId === '') return;
    const idx = sorted.findIndex((row) => row.id === selectedResourceId);
    if (idx >= 0 && idx !== selectedIdxRef.current) setSelectedIdx(idx);
  }, [selectedResourceId, sorted]);

  return (
    <DataTable<ComplianceTableRow>
      columns={COMPLIANCE_COLS}
      rows={sorted}
      selectedIndex={selectedIdx}
      onSelect={setSelectedIdx}
      getRowKey={(row) => row.id}
    />
  );
}

function makeRenderListResult(
  resource: string | undefined,
  provider: AgentProvider | null,
  selectedResourceId?: string,
  onSelectionChange?: (resourceId: string | null) => void,
  requiredTags?: string[],
): (ctx: PipelineContext) => CommandResultView {
  return (ctx: PipelineContext): CommandResultView => {
    const { resources, totalCount, compliantCount, compliancePercent } = extractTagCompliance(ctx, { resource, requiredTags });

    // Empty state
    if (totalCount === 0) {
      const message = resource
        ? `No resources matched filter: ${resource}`
        : 'No resources found';
      const hint = resource ? 'Try adjusting the --resource filter or run a fresh scan.' : 'Run a fresh scan to populate resource data.';
      return {
        items: [
          <EmptyState key="empty" message={message} hint={hint} />,
        ],
        actions: [
          { key: 's', label: 'scan', action: { type: 'navigate' as const, command: 'scan' as TuiCommand } },
        ],
      };
    }

    // All compliant
    if (compliancePercent === 100) {
      return {
        items: [
          <Box key="ok" gap={GAP_ICON_TEXT}>
            <Text color={colors.success}>{icons.checkmark}</Text>
            <Text color={colors.success}>All {totalCount} resources are compliant</Text>
          </Box>,
        ],
        actions: [
          { key: 's', label: 'scan', action: { type: 'navigate' as const, command: 'scan' as TuiCommand } },
          { key: 'p', label: 'report', action: { type: 'navigate' as const, command: 'report' as TuiCommand, args: ['--format', 'html'] } },
        ],
      };
    }

    const nonCompliant = resources.filter((r) => !r.isCompliant);
    const elements: React.JSX.Element[] = [];

    elements.push(
      <ProgressBar key="progress" value={compliancePercent} label={`${compliantCount} of ${totalCount} compliant`} />,
    );
    elements.push(<Box key="sep1" marginTop={GAP_BETWEEN_SECTIONS} />);

    // Non-compliant table
    if (nonCompliant.length > 0) {
      elements.push(
        <ComplianceTable
          key="compliance-table"
          nonCompliant={nonCompliant}
          compliantCount={compliantCount}
          totalCount={totalCount}
          selectedResourceId={selectedResourceId}
          onSelectionChange={onSelectionChange}
        />,
      );
    }

    // Find the currently selected row object to reference in navigation
    const row = nonCompliant.find((r) => r.id === selectedResourceId);
    const targetResource = resource ?? selectedResourceId;

    const baseActions: ActionHint[] = [
      ...(provider !== null ? [{ key: 'r', label: 'refresh AI', action: { type: 'navigate' as const, command: 'tags' as TuiCommand, args: ['list'] } }] : []),
      { key: 's', label: 'scan', action: { type: 'navigate' as const, command: 'scan' as TuiCommand } },
    ];

    const hasAi = provider !== null;
    const gAction = (row: { id: string }): ActionHint => hasAi
      ? { key: 'g', label: 'suggest tags', action: { type: 'navigate' as const, command: 'tags' as TuiCommand, args: ['suggest', '--resource', row.id] } }
      : { key: 'g', label: 'suggest tags', disabled: true, reason: 'needs AI provider' };
    const actions: ActionHint[] = row
      ? [
          gAction(row),
          ...baseActions,
          { key: 'a', label: 'plan apply', action: { type: 'navigate' as const, command: 'tags' as TuiCommand, args: ['apply', '--resource', row.id] } },
        ]
      : targetResource
        ? [
            gAction({ id: targetResource }),
            ...baseActions,
            { key: 'a', label: 'plan apply', action: { type: 'navigate' as const, command: 'tags' as TuiCommand, args: ['apply', '--resource', targetResource] } },
          ]
        : baseActions;

    return { items: elements, actions };
  };
}

// ─── Helper components (for integration of §11.2/§11.2b) ──

interface SuggestOverlayProps {
  resourceName: string;
  suggestedTags: Record<string, string>;
  sourceNote?: string;
  onAddToPlan?: () => void;
  onBack?: (() => void) | undefined;
  onQuit?: () => void;
}

const SuggestOverlay = (props: SuggestOverlayProps): React.JSX.Element => {
  const { resourceName, suggestedTags, sourceNote } = props;
  return (
    <Box flexDirection="column">
      <Box
        borderStyle={borders.card}
        borderColor={colors.brand}
        flexDirection="column"
        paddingX={PADDING_X}
      >
        {/* Header: resource name */}
        <Box gap={GAP_ROW}>
          <Text color={colors.brand} bold>{'Suggested tags: '}{resourceName}</Text>
        </Box>

        {/* Tag key=value rows */}
        <Box marginTop={GAP_BETWEEN_SECTIONS} flexDirection="column" gap={GAP_ROW}>
          {Object.entries(suggestedTags).map(([key, val]) => (
            <Box key={`tag-${key}`} gap={GAP_ROW}>
              <Text dimColor>{key.padEnd(16)}</Text>
              <Text>{'= '}{val}</Text>
            </Box>
          ))}
        </Box>

        {/* Source note (dim) */}
        {sourceNote && (
          <Box marginTop={GAP_BETWEEN_SECTIONS}>
            <Text dimColor>{sourceNote}</Text>
          </Box>
        )}

        {/* Footer: ActionBar */}
        <Box marginTop={GAP_BEFORE_ACTIONS}>
          <ActionBar
            actions={[
              { key: 'a', label: 'add to plan', action: { type: 'navigate', command: 'tags', args: ['apply'] } },
            ]}
          />
        </Box>
      </Box>
    </Box>
  );
};

/**
 * §11.2b Preflight confirmation — read-only summary before apply.
 * Used by apply subcommand to show before tag writes.
 */
interface PreflightBoxProps {
  scope: string;
  tagsToWrite: number;
  mode: string;
  requiredTags: string[];
  rollback: string;
  onConfirm?: () => void;
  onBack?: () => void;
  onQuit?: () => void;
}

const PreflightBox = (props: PreflightBoxProps): React.JSX.Element => {
  const { scope, tagsToWrite, mode, requiredTags, rollback } = props;
  return (
    <Box
      borderStyle={borders.card}
      borderColor={colors.brand}
      flexDirection="column"
      paddingX={PADDING_X}
    >
      <Box gap={GAP_ROW}>
        <Text color={colors.brand} bold>{'Tag plan summary'}</Text>
      </Box>

      <Box marginTop={GAP_BETWEEN_SECTIONS} flexDirection="column" gap={GAP_ROW}>
        <Box gap={GAP_ROW}>
          <Text dimColor>{'Scope:           '}</Text>
          <Text>{scope}</Text>
        </Box>
        <Box gap={GAP_ROW}>
          <Text dimColor>{'Tags to write:   '}</Text>
          <Text>{tagsToWrite} tag key/value pairs</Text>
        </Box>
        <Box gap={GAP_ROW}>
          <Text dimColor>{'Mode:            '}</Text>
          <Text>{mode}</Text>
        </Box>
        <Box gap={GAP_ROW}>
          <Text dimColor>{'Required tags:   '}</Text>
          <Text>{requiredTags.join(', ')}</Text>
        </Box>
        <Box gap={GAP_ROW}>
          <Text dimColor>{'Rollback:        '}</Text>
          <Text dimColor>{rollback}</Text>
        </Box>
      </Box>
    </Box>
  );
};

// ─── Main component ──────────────────────────────────────────────────────────

interface TagsCommandProps {
  args: string[];
  provider: AgentProvider | null;
  onRunAgain?: () => void;
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
  aiConfigured?: boolean;
}

export function TagsCommand({
  args,
  provider,
  onRunAgain,
  onBack,
  onAction,
}: TagsCommandProps): React.JSX.Element {
  const { subcommand, invalidSubcommand, resource, virtual } = parseArgs(args);
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const { config } = useConfig();
  const [selectedResourceId, setSelectedResourceId] = useState<string>('');
  const [pipelineHasError, setPipelineHasError] = useState(false);
  const [applyPlan, setApplyPlan] = useState<Array<{ resource: string; tag: string; value: string }>>([]);
  const [costData, setCostData] = useState<Array<{ tagKey: string; tagValue: string; costPerMonth: number; share: number }>>([]);
  const [suggestedTags, setSuggestedTags] = useState<Record<string, string> | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [complianceScope, setComplianceScope] = useState('');
  const pendingComplianceScopeRef = useRef('');
  useEffect(() => {
    if (pendingComplianceScopeRef.current !== complianceScope) {
      setComplianceScope(pendingComplianceScopeRef.current);
    }
  }, [complianceScope]);

  // Back key clears the apply plan instead of navigating away
  useInput((input, key) => {
    if (input === 'b' || key.escape) setApplyPlan([]);
  }, { isActive: subcommand === 'apply' && applyPlan.length > 0 && !helpOpen && !paletteOpen });

  function parseJsonBlock(text: string): unknown {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = fenceMatch ? (fenceMatch[1] ?? '') : text;
    try {
      const trimmed = raw.trim();
      const start = Math.min(
        ...['{', '['].map((c) => {
          const i = trimmed.indexOf(c);
          return i === -1 ? Number.POSITIVE_INFINITY : i;
        }),
      );
      if (!Number.isFinite(start)) return null;
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }

  function handleSuggestResult(result: string): void {
    const parsed = parseJsonBlock(result);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const tags: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') tags[k] = v;
      }
      if (Object.keys(tags).length > 0) setSuggestedTags(tags);
    }
  }

  function handleApplyResult(result: string): void {
    const parsed = parseJsonBlock(result);
    if (Array.isArray(parsed)) {
      const rows = parsed
        .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
        .map((r) => ({
          resource: String((r['resource'] as string | number | null | undefined) ?? (r['resourceId'] as string | number | null | undefined) ?? ''),
          tag: String((r['tag'] as string | number | null | undefined) ?? (r['key'] as string | number | null | undefined) ?? ''),
          value: String((r['value'] as string | number | null | undefined) ?? ''),
        }))
        .filter((r) => r.resource && r.tag);
      if (rows.length > 0) setApplyPlan(rows);
    }
  }

  function handleCostsResult(result: string): void {
    const parsed = parseJsonBlock(result);
    if (Array.isArray(parsed)) {
      const rows = parsed
        .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
        .map((r) => ({
          tagKey: String((r['tagKey'] as string | number | null | undefined) ?? (r['key'] as string | number | null | undefined) ?? ''),
          tagValue: String((r['tagValue'] as string | number | null | undefined) ?? (r['value'] as string | number | null | undefined) ?? ''),
          costPerMonth: Number(r['costPerMonth'] ?? r['cost'] ?? 0),
          share: Number(r['share'] ?? r['percent'] ?? 0),
        }))
        .filter((r) => r.tagKey);
      if (rows.length > 0) setCostData(rows);
    }
  }

  const pipelineSteps = useMemo(
    () => buildTagsPipelineSteps({ resource }),
    [resource],
  );

  const handleSelectionChange = useCallback((id: string | null) => {
    setSelectedResourceId(id ?? '');
  }, []);

  const renderListResult = useMemo(
    () => makeRenderListResult(resource, provider, selectedResourceId, handleSelectionChange, config?.scan.required_tags),
    [resource, provider, selectedResourceId, handleSelectionChange, config?.scan.required_tags],
  );

  if (subcommand === null) {
    return (
      <ScreenShell
        header={<CommandHeader command="tags" description="tag management" />}
      >
        <ErrorBox
          title="Invalid subcommand"
          message={`Unknown subcommand "${invalidSubcommand ?? ''}". Valid: list, suggest, apply, costs`}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  const headerSubtitle: Record<TagsSubcommand, string> = {
    list: 'tag compliance audit',
    suggest: 'suggest tags for resource',
    apply: 'plan tag changes',
    costs: 'cost allocation by tag',
  };

  // List subcommand — HybridPipeline with Data/AI tabs
  if (subcommand === 'list') {
    return (
      <ScreenShell
        header={<CommandHeader command="tags" description={headerSubtitle.list} scope={complianceScope} />}
        hints={pipelineHasError ? undefined : <InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
      >
        {provider ? (
          <HybridPipeline
            steps={pipelineSteps}
            provider={provider}
            buildAnalysisPrompt={(ctx) => buildTagsAnalysisPrompt(ctx, config?.scan.required_tags, { promptMaxResources: config?.ai.prompt_max_resources })}
            systemPrompt={getAnalysisPrompt('tags')}
            onError={setPipelineHasError}
            renderResult={(ctx: PipelineContext) => {
              const { resources, totalCount, compliantCount, compliancePercent } = extractTagCompliance(ctx, { resource, requiredTags: config?.scan.required_tags });
              const nonCompliant = resources.filter((r) => !r.isCompliant);

              pendingComplianceScopeRef.current = `${compliantCount} of ${totalCount} resources tagged`;

              const tabsElement = (
                <Box key="list-content" flexDirection="column">
                  <ProgressBar value={compliancePercent} label={`${compliantCount} of ${totalCount} compliant`} />
                  <Box marginTop={GAP_BETWEEN_SECTIONS} />
                  {nonCompliant.length > 0 ? (
                    <ComplianceTable
                      nonCompliant={nonCompliant}
                      compliantCount={compliantCount}
                      totalCount={totalCount}
                      selectedResourceId={selectedResourceId}
                      onSelectionChange={handleSelectionChange}
                    />
                  ) : (
                    <Text dimColor>All resources are correctly tagged.</Text>
                  )}
                </Box>
              );

              const row = nonCompliant.find((r) => r.id === selectedResourceId);
              const targetResource = resource ?? selectedResourceId;

              const baseActions: ActionHint[] = [
                ...(provider !== null ? [{ key: 'r', label: 'refresh AI', action: { type: 'navigate' as const, command: 'tags' as TuiCommand, args: ['list'] } }] : []),
                { key: 's', label: 'scan', action: { type: 'navigate' as const, command: 'scan' as TuiCommand } },
              ];

              const hasAi = provider !== null;
              const gAction2 = (row: { id: string }): ActionHint => hasAi
                ? { key: 'g', label: 'suggest tags', action: { type: 'navigate' as const, command: 'tags' as TuiCommand, args: ['suggest', '--resource', row.id] } }
                : { key: 'g', label: 'suggest tags', disabled: true, reason: 'needs AI provider' };
              const actions: ActionHint[] = row
                ? [
                    gAction2(row),
                    ...baseActions,
                    { key: 'a', label: 'plan apply', action: { type: 'navigate' as const, command: 'tags' as TuiCommand, args: ['apply', '--resource', row.id] } },
                  ]
                : targetResource
                  ? [
                      gAction2({ id: targetResource }),
                      ...baseActions,
                      { key: 'a', label: 'plan apply', action: { type: 'navigate' as const, command: 'tags' as TuiCommand, args: ['apply', '--resource', targetResource] } },
                    ]
                  : baseActions;

              return { items: [tabsElement], actions };
            }}
            renderFallback={renderListResult}
            onRunAgain={onRunAgain}
            onBack={onBack}
            onAction={onAction}
            overlayActive={helpOpen || paletteOpen}
          />
        ) : (
          <DirectPipeline
            steps={pipelineSteps}
            renderResult={renderListResult}
            onRunAgain={onRunAgain}
            onBack={onBack}
            onAction={onAction}
            onError={setPipelineHasError}
            overlayActive={helpOpen || paletteOpen}
          />
        )}
      </ScreenShell>
    );
  }

  // Suggest subcommand — AI-only with overlay support
  if (subcommand === 'suggest') {
    if (!provider) {
      return (
        <ScreenShell
          header={<CommandHeader command="tags suggest" description={headerSubtitle.suggest} />}
        >
          <ErrorBox
            title="AI not configured"
            message="Tag suggestions require an AI provider."
            onBack={onBack}
          />
        </ScreenShell>
      );
    }

    if (confirmApply && suggestedTags !== null) {
      return (
        <ScreenShell
          header={<CommandHeader command="tags suggest" description={headerSubtitle.suggest} scope={resource} />}
          overlayActive
        >
          <ConfirmApplyTags
            resourceCount={1}
            tags={suggestedTags}
            onConfirm={() => {
              setConfirmApply(false);
              // Navigate to apply subcommand with the resource — actual write happens there
              onAction?.({ type: 'navigate', command: 'tags', args: ['apply', ...(resource ? ['--resource', resource] : [])] });
            }}
            onCancel={() => setConfirmApply(false)}
          />
        </ScreenShell>
      );
    }

    if (suggestedTags !== null) {
      return (
        <ScreenShell
          header={<CommandHeader command="tags suggest" description={headerSubtitle.suggest} scope={resource} />}
          overlayActive
        >
          <SuggestOverlay
            resourceName={resource ?? 'resource'}
            suggestedTags={suggestedTags}
            sourceNote="Generated by AI from resource context"
            onBack={onBack}
          />
        </ScreenShell>
      );
    }

    return (
      <ScreenShell
        header={<CommandHeader command="tags suggest" description={headerSubtitle.suggest} />}
      >
        <AgentLoop
          prompt={buildTagsPrompt('suggest', resource, virtual)}
          provider={provider}
          tools={tagsTools}
          builtinTools={[]}
          maxBudgetUsd={config?.ai.max_budget_usd ?? 0.5}
          onRunAgain={onRunAgain}
          onBack={onBack}
          onResult={handleSuggestResult}
          suppressRunningHints
          resultActions={[
            { key: 'a', label: 'apply tags', action: { type: 'apply-fix' as const } },
          ]}
          onAction={(action) => {
            if (action.type === 'apply-fix') {
              if (suggestedTags !== null && Object.keys(suggestedTags).length > 0) {
                setConfirmApply(true);
              }
              return;
            }
            onAction?.(action);
          }}
        />
      </ScreenShell>
    );
  }

  // Apply subcommand — AI-only for plan generation
  if (subcommand === 'apply') {
    if (!provider) {
      return (
        <ScreenShell
          header={<CommandHeader command="tags apply" description={headerSubtitle.apply} />}
        >
          <ErrorBox
            title="AI not configured"
            message="Tag planning requires an AI provider."
            onBack={onBack}
          />
        </ScreenShell>
      );
    }

    // When applyPlan is populated, show the plan with scope and ActionBar (§11.3)
    if (applyPlan.length > 0) {
      const uniqueResources = new Set(applyPlan.map((p) => p.resource)).size;
      const planScope = `plan: ${uniqueResources} resources ${DOT_SEP} ${applyPlan.length} tags`;

      interface ApplyPlanRow {
        resource: string;
        tag: string;
        value: string;
      }

      const PLAN_COLS: ColumnDef<ApplyPlanRow>[] = [
        { key: 'resource', label: 'RESOURCE', priority: 1, maxWidth: 40, truncate: 'middle' },
        { key: 'tag', label: 'TAG', priority: 1, maxWidth: 20, renderCell: (value, _row, width) => <Text color={colors.brand}>{truncateWidth(String(value), width)}</Text> },
        { key: 'value', label: 'VALUE', priority: 1, maxWidth: 30, truncate: 'end' },
      ];

      const uniqueTagKeys = Array.from(new Set(applyPlan.map((p) => p.tag)));
      return (
        <ScreenShell
          header={<CommandHeader command="tags apply" description={headerSubtitle.apply} scope={planScope} />}
          hints={<InteractionHints hints={[IH_BACK, IH_QUIT]} />}
          actions={
            <ActionBar
              actions={[
                { key: 'Enter', label: 'confirm apply', action: { type: 'apply-fix' } },
                { key: 'd', label: 'clear plan', action: { type: 'navigate', command: 'tags', args: ['list'] } },
              ]}
              onAction={onAction}
            />
          }
        >
          <PreflightBox
            scope={`${uniqueResources} resources`}
            tagsToWrite={applyPlan.length}
            mode={virtual ? 'virtual (dry-run)' : 'live'}
            requiredTags={uniqueTagKeys}
            rollback="stored pre-apply state"
          />
          <Box marginTop={GAP_BETWEEN_SECTIONS} />
          <DataTable<ApplyPlanRow>
            columns={PLAN_COLS}
            rows={applyPlan}
            selectedIndex={0}
            onSelect={() => {}}
            getRowKey={(row) => `${row.resource}-${row.tag}`}
          />
        </ScreenShell>
      );
    }

    return (
      <ScreenShell
        header={<CommandHeader command="tags apply" description={headerSubtitle.apply} />}
      >
        <AgentLoop
          prompt={buildTagsPrompt('apply', resource, virtual)}
          provider={provider}
          tools={tagsTools}
          builtinTools={[]}
          maxBudgetUsd={config?.ai.max_budget_usd ?? 0.5}
          onRunAgain={onRunAgain}
          onBack={onBack}
          onAction={onAction}
          onResult={handleApplyResult}
          suppressRunningHints
          resultActions={[
            { key: 'd', label: 'clear plan', action: { type: 'navigate', command: 'tags', args: ['list'] } },
            { key: 's', label: 'scan', action: { type: 'navigate', command: 'scan' } },
          ]}
        />
      </ScreenShell>
    );
  }

  // Costs subcommand — tag cost allocation breakdown table
  if (subcommand === 'costs') {
    if (!provider) {
      return (
        <ScreenShell
          header={<CommandHeader command="tags costs" description={headerSubtitle.costs} />}
        >
          <ErrorBox
            title="AI not configured"
            message="Cost analysis requires an AI provider."
            onBack={onBack}
          />
        </ScreenShell>
      );
    }

    // When costData is populated, show table with ActionBar (§11.3b)
    if (costData.length > 0) {
      interface CostRow {
        tagKey: string;
        tagValue: string;
        costPerMonth: number;
        share: number;
      }

      const COST_COLS: ColumnDef<CostRow>[] = [
        { key: 'tagKey', label: 'TAG KEY', priority: 1, maxWidth: 20, renderCell: (value, _row, width) => <Text color={colors.brand}>{truncateWidth(String(value), width)}</Text> },
        { key: 'tagValue', label: 'TAG VALUE', priority: 1, maxWidth: 20 },
        {
          key: 'costPerMonth',
          label: 'COST/MO',
          priority: 1,
          maxWidth: 12,
          renderCell: (value) => {
            const n = typeof value === 'number' ? value : 0;
            return <Text color={n > 0 ? semanticColors.cost.value : undefined}>{n > 0 ? `$${n.toFixed(2)}` : '—'}</Text>;
          },
        },
        {
          key: 'share',
          label: 'SHARE',
          priority: 1,
          maxWidth: 8,
          renderCell: (value) => {
            const n = typeof value === 'number' ? value : 0;
            const color = n >= 20 ? semanticColors.severity.high : n >= 5 ? colors.warning : undefined;
            return <Text color={color}>{n > 0 ? `${n.toFixed(1)}%` : '—'}</Text>;
          },
        },
      ];

      return (
        <ScreenShell
          header={<CommandHeader command="tags costs" description={headerSubtitle.costs} scope="cost allocation by tag" />}
          hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
          actions={
            <ActionBar
              actions={[
                { key: 's', label: 'scan', action: { type: 'navigate', command: 'scan' } },
                { key: 'p', label: 'report', action: { type: 'navigate', command: 'report', args: ['--format', 'html'] } },
              ]}
              onAction={onAction}
            />
          }
        >
          <DataTable<CostRow>
            columns={COST_COLS}
            rows={costData}
            selectedIndex={0}
            onSelect={() => {}}
            getRowKey={(row) => `${row.tagKey}-${row.tagValue}`}
          />
        </ScreenShell>
      );
    }

    return (
      <ScreenShell
        header={<CommandHeader command="tags costs" description={headerSubtitle.costs} />}
      >
        <AgentLoop
          prompt={buildTagsPrompt('costs', resource, virtual)}
          provider={provider}
          tools={tagsTools}
          builtinTools={[]}
          maxBudgetUsd={config?.ai.max_budget_usd ?? 0.5}
          onRunAgain={onRunAgain}
          onBack={onBack}
          onAction={onAction}
          onResult={handleCostsResult}
          suppressRunningHints
        />
      </ScreenShell>
    );
  }

  return (
    <ScreenShell
      header={<CommandHeader command="tags" description={headerSubtitle.list} />}
    >
      <ErrorBox
        title="Invalid subcommand"
        message="Invalid tags subcommand"
        onBack={onBack}
      />
    </ScreenShell>
  );
}
