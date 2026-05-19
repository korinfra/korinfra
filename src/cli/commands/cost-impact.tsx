/**
 * CostImpactCommand — Terraform plan cost-impact analysis (deterministic, no AI).
 *
 * Layout:
 *   - Summary line: net monthly delta, annualized, counts by action.
 *   - DataTable: ACTION | ADDRESS | TYPE | DELTA | STATUS.
 *   - Findings inline list: SEV · RULE · ADDRESS · TITLE — top 5.
 *   - ActionBar: p report, r run again.
 */

import React, { useMemo, useState } from 'react';
import { Box, Text } from 'ink';

import { CommandHeader } from '../components/CommandHeader.js';
import { DataTable } from '../components/DataTable.js';
import type { ColumnDef } from '../components/DataTable.js';
import { DirectPipeline } from '../components/DirectPipeline.js';
import type { CommandResultView, PipelineContext } from '../components/DirectPipeline.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorBox } from '../components/ErrorBox.js';
import { InteractionHints, IH_BACK, IH_COMMAND, IH_HELP, IH_QUIT } from '../components/InteractionHints.js';
import { ScreenShell } from '../components/ScreenShell.js';
import {
  buildCostImpactPipelineSteps,
  extractCostImpact,
  type CostImpactFinding,
  type CostImpactRow,
} from '../pipelines/cost-impact.js';
import { semanticColors } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, MARGIN_LEFT_CONTENT } from '../ui/spacing.js';
import { DOT_SEP, SEVERITY_LABELS } from '../ui/text.js';
import type { ActionHint, TuiAction } from '../actions.js';
import { parseArg } from '../utils/parseArgs.js';

// ─── Row type ──────────────────────────────────────────────────────────────────

interface ChangeRow {
  action: CostImpactRow['action'];
  address: string;
  resourceType: string;
  delta: string;
  status: CostImpactRow['costStatus'];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatMoney(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}$${abs.toFixed(2)}`;
}

function actionLabel(a: CostImpactRow['action']): string {
  switch (a) {
    case 'create': return 'create';
    case 'update': return 'update';
    case 'destroy': return 'destroy';
    case 'replace': return 'replace';
    case 'no-op': return 'no-op';
    case 'read': return 'read';
    default: return String(a);
  }
}

function actionColor(a: CostImpactRow['action']): string | undefined {
  switch (a) {
    case 'create': return semanticColors.severity.medium;
    case 'destroy': return semanticColors.severity.high;
    case 'replace': return semanticColors.severity.medium;
    case 'update': return semanticColors.severity.low;
    case 'no-op':
    case 'read':
      return undefined;
  }
}

const COLUMNS: ColumnDef<ChangeRow>[] = [
  {
    key: 'action',
    label: 'ACTION',
    width: 10,
    priority: 1,
    renderCell: (_v, row, width) => {
      const label = actionLabel(row.action).padEnd(width);
      const color = actionColor(row.action);
      return <Text color={color}>{label}</Text>;
    },
  },
  { key: 'address', label: 'ADDRESS', priority: 1, truncate: 'middle', maxWidth: 48 },
  { key: 'resourceType', label: 'TYPE', priority: 2, truncate: 'end', maxWidth: 22 },
  {
    key: 'delta',
    label: 'DELTA',
    width: 12,
    priority: 1,
    renderCell: (_v, row, width) => {
      const label = row.delta.padStart(width);
      const color =
        row.delta.startsWith('+') ? semanticColors.severity.high
          : row.delta.startsWith('-') ? semanticColors.severity.low
            : undefined;
      return <Text color={color}>{label}</Text>;
    },
  },
  { key: 'status', label: 'STATUS', width: 10, priority: 3, truncate: 'end' },
];

function sortRows(rows: CostImpactRow[]): CostImpactRow[] {
  const actionRank: Record<CostImpactRow['action'], number> = {
    'replace': 0, 'update': 1, 'create': 2, 'destroy': 3, 'no-op': 4, 'read': 5,
  };
  return [...rows].sort((a, b) => {
    const aMag = Math.abs(a.deltaUsd);
    const bMag = Math.abs(b.deltaUsd);
    if (aMag !== bMag) return bMag - aMag;
    return (actionRank[a.action] ?? 99) - (actionRank[b.action] ?? 99);
  });
}

function severityColor(sev: CostImpactFinding['severity']): string | undefined {
  return semanticColors.severity[sev];
}

// ─── renderResult factory ──────────────────────────────────────────────────────

function makeRenderResult(
  onHeaderScopeChange: (scope: string) => void,
): (ctx: PipelineContext) => CommandResultView {
  return (ctx: PipelineContext): CommandResultView => {
    const view = extractCostImpact(ctx);
    const { summary, changes, findings, warnings } = view;
    const totalChanges = changes.length;
    const scope = `${totalChanges} change${totalChanges === 1 ? '' : 's'}${DOT_SEP}net ${formatMoney(summary.netDeltaMonthlyUsd)}/mo`;
    onHeaderScopeChange(scope);

    const items: React.JSX.Element[] = [];

    items.push(
      <Box key="summary" marginLeft={MARGIN_LEFT_CONTENT} flexDirection="column">
        <Box>
          <Text bold>
            Net delta:{' '}
            <Text color={summary.netDeltaMonthlyUsd > 0 ? semanticColors.severity.high : summary.netDeltaMonthlyUsd < 0 ? semanticColors.severity.low : undefined}>
              {formatMoney(summary.netDeltaMonthlyUsd)}/mo
            </Text>
            {' '}
            <Text dimColor>(annualized {formatMoney(summary.netDeltaAnnualUsd)})</Text>
          </Text>
        </Box>
        <Box>
          <Text dimColor>
            {summary.counts.create} created{DOT_SEP}{summary.counts.update} updated{DOT_SEP}{summary.counts.destroy} destroyed{DOT_SEP}{summary.counts.replace} replaced
          </Text>
        </Box>
        {(summary.unknownCount > 0 || summary.unpricedCount > 0 || summary.variableCount > 0) && (
          <Box>
            <Text dimColor>
              {summary.unknownCount} unknown{DOT_SEP}{summary.unpricedCount} unpriced{DOT_SEP}{summary.variableCount} variable
            </Text>
          </Box>
        )}
      </Box>,
    );

    if (totalChanges === 0) {
      items.push(
        <Box key="empty" marginTop={GAP_BETWEEN_SECTIONS}>
          <EmptyState
            message="No cost-impacting changes."
            hint="The plan has no create/update/destroy actions on supported resource types."
          />
        </Box>,
      );
    } else {
      const sorted = sortRows(changes);
      const rows: ChangeRow[] = sorted.map((c) => ({
        action: c.action,
        address: c.address,
        resourceType: c.resourceType,
        delta: c.costStatus === 'unknown' || c.costStatus === 'unpriced' ? '—' : formatMoney(c.deltaUsd),
        status: c.costStatus,
      }));
      const pageSize = Math.max(3, (ctx.viewportHeight ?? 14) - 8);
      items.push(
        <Box key="table" marginTop={GAP_BETWEEN_SECTIONS} flexDirection="column">
          <DataTable<ChangeRow>
            columns={COLUMNS}
            rows={rows}
            getRowKey={(row) => `${row.address}/${row.action}`}
            pageSize={pageSize}
          />
        </Box>,
      );
    }

    if (findings.length > 0) {
      const severityOrder: CostImpactFinding['severity'][] = ['critical', 'high', 'medium', 'low'];
      const sortedFindings = [...findings].sort(
        (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity),
      );
      const top = sortedFindings.slice(0, 5);
      const more = sortedFindings.length - top.length;
      items.push(
        <Box key="findings" marginTop={GAP_BETWEEN_SECTIONS} marginLeft={MARGIN_LEFT_CONTENT} flexDirection="column">
          <Text bold>
            {findings.length} finding{findings.length === 1 ? '' : 's'} would trigger after apply:
          </Text>
          {top.map((f, i) => (
            <Box key={`f-${i}`}>
              <Text color={severityColor(f.severity)}>
                {(SEVERITY_LABELS[f.severity] ?? f.severity).padEnd(8)}
              </Text>
              <Text>{' '}{f.ruleId}{DOT_SEP}{f.address}{DOT_SEP}</Text>
              <Text dimColor>{f.title}</Text>
            </Box>
          ))}
          {more > 0 && (
            <Text dimColor>… {more} more{DOT_SEP}run with --json for the full list</Text>
          )}
        </Box>,
      );
    }

    if (warnings.length > 0) {
      items.push(
        <Box key="warnings" marginTop={GAP_BETWEEN_SECTIONS} marginLeft={MARGIN_LEFT_CONTENT} flexDirection="column">
          <Text dimColor>
            {warnings.length} warning{warnings.length === 1 ? '' : 's'}{DOT_SEP}see --json for details
          </Text>
        </Box>,
      );
    }

    const actions: ActionHint[] = [
      { key: 'p', label: 'report', action: { type: 'navigate' as const, command: 'report', args: ['--format', 'html', '--output', 'reports/cost-impact.html'] } },
      { key: 'r', label: 'run again', action: { type: 'run-again' as const } },
    ];

    return { items, actions };
  };
}

// ─── CostImpactCommand ─────────────────────────────────────────────────────────

interface CostImpactCommandProps {
  args: string[];
  onRunAgain?: () => void;
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
}

export function CostImpactCommand({ args, onRunAgain, onBack, onAction }: CostImpactCommandProps): React.JSX.Element {
  const planFile = parseArg(args, '--plan-file', '-f');
  const [headerScope, setHeaderScope] = useState<string | undefined>(undefined);
  const [pipelineHasError, setPipelineHasError] = useState(false);

  const pipelineSteps = useMemo(
    () => (planFile !== null ? buildCostImpactPipelineSteps({ planFile }) : []),
    [planFile],
  );
  const renderResult = useMemo(
    () => makeRenderResult(setHeaderScope),
    [],
  );

  if (planFile === null) {
    return (
      <ScreenShell
        header={<CommandHeader command="cost-impact" description="Terraform plan cost impact" />}
      >
        <ErrorBox
          title="Missing required flag"
          message="cost-impact requires --plan-file <path>"
          hint="Generate the plan first: terraform show -json plan.tfplan > plan.json"
          actions={[]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  return (
    <ScreenShell
      header={
        <CommandHeader
          command="cost-impact"
          description="Terraform plan cost impact"
          scope={headerScope}
          variant="compact"
        />
      }
      hints={pipelineHasError ? undefined : (
        <InteractionHints
          hints={[
            IH_COMMAND,
            IH_HELP,
            ...(onBack !== undefined ? [IH_BACK] : []),
            IH_QUIT,
          ]}
        />
      )}
    >
      <DirectPipeline
        steps={pipelineSteps}
        renderResult={renderResult}
        onRunAgain={onRunAgain}
        onBack={onBack}
        onAction={onAction}
        onError={setPipelineHasError}
      />
    </ScreenShell>
  );
}
