/**
 * SecurityCommand — §6 Terraform security scan with optional posture analysis.
 *
 * Lifecycle:
 *   §6.0 Path picker: shown when --path not provided and no terraform path configured
 *   §6.1 Result state: DataTable with SEV | RULE | RESOURCE columns
 *   §6.2 Detail panel: Enter to open, Esc/b to close
 *   §6.3 Empty states: rules variations
 *
 * Rules enforced:
 *   VRHYTHM_RULE  — GAP_AFTER_HEADER / GAP_BETWEEN_SECTIONS / GAP_BEFORE_ACTIONS only
 *   DOT_SEP_RULE  — DOT_SEP from ui/text.js
 *   SEVERITY_LABELS_RULE — SEVERITY_LABELS from ui/text.ts
 *   SCREEN_SHELL_RULE — wrapped in ScreenShell
 *   X-1 rule — NavHints = navigation only; p s in ActionBar, r runs again
 *   ERR2-1 rule — ErrorBox owns its footer
 *   G-2 rule — renderResult returns CommandResultView; ActionBar never inside items
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { Box, Text, useApp, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';

import type { AgentProvider } from '../../agent/types.js';
import { DirectPipeline } from '../components/DirectPipeline.js';
import { HybridPipeline } from '../components/HybridPipeline.js';
import type { PipelineContext, CommandResultView } from '../components/DirectPipeline.js';
import { DataTable } from '../components/DataTable.js';
import type { ColumnDef } from '../components/DataTable.js';
import { ErrorBox } from '../components/ErrorBox.js';
import { CommandHeader } from '../components/CommandHeader.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { EmptyState } from '../components/EmptyState.js';
import { InteractionHints, IH_BACK, IH_COMMAND, IH_HELP, IH_QUIT } from '../components/InteractionHints.js';
import { ActionBar } from '../components/ActionBar.js';
import { SecurityDetailOverlay } from '../components/SecurityDetailOverlay.js';
import type { SecurityFindingDetail } from '../components/SecurityDetailOverlay.js';
import { colors, semanticColors } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, GAP_BEFORE_ACTIONS, GAP_ROW, PADDING_X, GAP_AFTER_HEADER } from '../ui/spacing.js';
import { SEVERITY_LABELS, DOT_SEP } from '../ui/text.js';
import { parseArg } from '../utils/parseArgs.js';
import { getAnalysisPrompt } from '../../agent/prompts.js';
import { logger } from '../../utils/logger.js';
import { useInputMode } from '../hooks/useInputMode.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';
import { buildSecurityPipelineSteps, extractSecurityFindings } from '../pipelines/security.js';
import { buildSecurityAnalysisPrompt } from '../pipelines/analysis.js';
import type { ActionHint, TuiAction } from '../actions.js';
import { AiStatusBanner } from '../components/AiStatusBanner.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
type Severity = (typeof VALID_SEVERITIES)[number];

// ─── Finding row type for DataTable ──────────────────────────────────────────

interface FindingRow {
  id: string;
  severity: string;
  rule: string;
  title: string;
  resource: string;
  /** Original detail fields for overlay */
  _description: string;
  _remediation: string;
  _severityRaw: 'critical' | 'high' | 'medium' | 'low';
  _filePath?: string | null;
}

// ─── Column definitions (§6.1: SEV | RULE | TITLE | RESOURCE) ───────────────

const FINDINGS_COLUMNS: ColumnDef<FindingRow>[] = [
  {
    key: 'severity',
    label: 'SEV',
    width: 10,
    priority: 1,
    renderCell: (v, _row, width) => {
      const lower = String(v).toLowerCase() as keyof typeof SEVERITY_LABELS;
      const label = (SEVERITY_LABELS[lower] ?? String(v)).padEnd(width);
      const color = lower === 'critical' ? semanticColors.severity.critical
        : lower === 'high' ? semanticColors.severity.high
        : lower === 'medium' ? semanticColors.severity.medium
        : lower === 'low' ? semanticColors.severity.low
        : undefined;
      return <Text color={color}>{label}</Text>;
    },
  },
  {
    key: 'rule',
    label: 'RULE',
    priority: 2,
    truncate: 'end',
    maxWidth: 15,
  },
  {
    key: 'title',
    label: 'TITLE',
    priority: 1,
    truncate: 'end',
    maxWidth: 45,
  },
  {
    key: 'resource',
    label: 'RESOURCE',
    priority: 2,
    truncate: 'end',
    maxWidth: 40,
  },
];

// ─── FindingsTable ────────────────────────────────────────────────────────────

interface FindingsTableProps {
  rows: FindingRow[];
  /** Ref written on every render so SecurityCommand can read the selected row. */
  selectedRowRef: React.MutableRefObject<FindingRow | null>;
  pageSize?: number;
}

function FindingsTable({ rows, selectedRowRef, pageSize }: FindingsTableProps): React.JSX.Element {
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Keep ref current so SecurityCommand's useInput can read it without stale closure issues.
  selectedRowRef.current = rows[selectedIdx] ?? null;

  return (
    <DataTable<FindingRow>
      columns={FINDINGS_COLUMNS}
      rows={rows}
      selectedIndex={selectedIdx}
      onSelect={setSelectedIdx}
      getRowKey={(row) => `${row.id}/${row.resource}`}
      {...(pageSize !== undefined ? { pageSize } : {})}
    />
  );
}

// ─── renderResult factory ─────────────────────────────────────────────────────

function makeRenderSecurityResult(
  severityFilter: Severity | null,
  selectedRowRef: React.MutableRefObject<FindingRow | null>,
  terraformDir: string,
  onHeaderScopeChange?: (scope: string) => void,
): (ctx: PipelineContext) => CommandResultView {
  return (ctx: PipelineContext): CommandResultView => {
    const { findings, totalCount } = extractSecurityFindings(ctx, severityFilter);

    // Compute header scope: "<count> findings · <basename>"
    const fileBasename = path.basename(terraformDir);
    const scope = `${totalCount} finding${totalCount === 1 ? '' : 's'}${DOT_SEP}${fileBasename}`;
    onHeaderScopeChange?.(scope);

    if (totalCount === 0) {
      return {
        items: [
          <EmptyState
            key="empty"
            message="No Terraform security findings."
            hint="Infrastructure looks clean."
          />,
        ],
        actions: [
          { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'security' } },
        ],
      };
    }

    // Build DataTable rows — sorted by severity
    const severityOrder = ['critical', 'high', 'medium', 'low'];
    const sortedFindings = [...findings].sort((a, b) => {
      const ai = severityOrder.indexOf(a.severity);
      const bi = severityOrder.indexOf(b.severity);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const findingRows: FindingRow[] = sortedFindings.map((f) => ({
      id: f.id,
      severity: f.severity,
      rule: f.id.split('/').pop() ?? f.id,
      title: f.title,
      resource: f.resource,
      _description: f.description,
      _remediation: f.remediation,
      _severityRaw: f.severity,
      _filePath: f.filePath ?? null,
    }));

    // DataTable overhead: counter(1) + gap(1) + header(1) + separator(1) + ↓indicator(1) = 5
    const pageSize = Math.max(3, (ctx.viewportHeight ?? 14) - 5);

    const items: React.JSX.Element[] = [
      <FindingsTable
        key="findings-table"
        rows={findingRows}
        selectedRowRef={selectedRowRef}
        pageSize={pageSize}
      />,
    ];

    const actions: ActionHint[] = [
      { key: 'p', label: 'report', action: { type: 'navigate' as const, command: 'report' as const, args: ['--format', 'html', '--output', 'reports/security.html'] } },
      { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'security' as const } },
    ];

    return { items, actions };
  };
}

// ─── PathPickerScreen ─────────────────────────────────────────────────────────

function PathPickerScreen({ onSubmit, onCancel }: { onSubmit: (p: string) => void; onCancel: () => void }): React.JSX.Element {
  const { exit } = useApp();
  const { setInputMode } = useInputMode();
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const isWindows = process.platform === 'win32';
  const placeholder = isWindows
    ? `e.g. C:\\Users\\you\\repo\\infra`
    : `e.g. /home/you/repo/infra or ./terraform`;

  useEffect(() => {
    setInputMode('field');
    return () => { setInputMode('none'); };
  }, [setInputMode]);

  useInput((input, key) => {
    if (key.escape) onCancel();
    if (input === 'q') exit();
  }, { isActive: !helpOpen && !paletteOpen });

  return (
    <ScreenShell
      header={<CommandHeader command="security" description="terraform path" />}
    >
      <Box flexDirection="column" gap={GAP_BETWEEN_SECTIONS} marginLeft={PADDING_X} marginTop={GAP_AFTER_HEADER}>
        <Text>Enter the path to your Terraform files:</Text>
        <Box>
          <TextInput
            placeholder={placeholder}
            onSubmit={(v) => { if (v.trim()) onSubmit(v.trim()); }}
          />
        </Box>
        <Text dimColor>(e.g. terraform/  or  ./infra/  or an absolute path)</Text>
      </Box>
      <Box marginTop={GAP_BEFORE_ACTIONS} gap={GAP_ROW}>
        <Text dimColor>
          <Text color={colors.warning}>Enter</Text>{' scan this path'}
        </Text>
        <Text dimColor>{DOT_SEP}</Text>
        <Text dimColor>
          <Text color={colors.warning}>Esc</Text>{' skip (rules-only mode)'}
        </Text>
        <Text dimColor>{DOT_SEP}</Text>
        <Text dimColor>
          <Text color={colors.warning}>q</Text>{' quit'}
        </Text>
      </Box>
    </ScreenShell>
  );
}

// ─── SecurityCommand ──────────────────────────────────────────────────────────

interface SecurityCommandProps {
  args: string[];
  provider: AgentProvider | null;
  onRunAgain?: () => void;
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
  aiConfigured?: boolean;
}

export function SecurityCommand({ args, provider, onRunAgain, onBack, onAction, aiConfigured = false }: SecurityCommandProps): React.JSX.Element {
  const pathArg = parseArg(args, '--path') ?? parseArg(args, '-p');
  const rawSeverity = parseArg(args, '--severity') ?? parseArg(args, '-s');
  const severity: Severity | null =
    rawSeverity !== null && VALID_SEVERITIES.includes(rawSeverity as Severity)
      ? (rawSeverity as Severity)
      : null;

  const [hasTerraform, setHasTerraform] = useState<boolean | null>(null);
  const [pipelineHasError, setPipelineHasError] = useState(false);
  const [showPathPicker, setShowPathPicker] = useState(false);
  const [detailFinding, setDetailFinding] = useState<SecurityFindingDetail | null>(null);
  const [headerScope, setHeaderScope] = useState<string | undefined>(undefined);

  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const detailActive = detailFinding !== null;
  const overlayActive = detailActive || helpOpen || paletteOpen;

  function handleEnterFinding(row: FindingRow): void {
    setDetailFinding({
      id: row.id,
      severity: row._severityRaw,
      rule: row.rule,
      resource: row.resource,
      description: row._description,
      remediation: row._remediation,
      filePath: row._filePath ?? null,
    });
  }

  // Ref written by FindingsTable on every render — avoids stale closure in useInput below.
  const selectedRowRef = useRef<FindingRow | null>(null);

  // Enter is handled here (not inside FindingsTable) so the handler re-registers
  // whenever overlayActive changes, ensuring it always has a fresh closure.
  useInput((_input, key) => {
    if (key.return && selectedRowRef.current !== null) {
      handleEnterFinding(selectedRowRef.current);
    }
  }, { isActive: !overlayActive });

  // Static branches (no-tf, invalid-severity) have no HybridPipeline to handle b/Esc.
  const isInStaticBranch =
    !showPathPicker &&
    detailFinding === null &&
    (hasTerraform === false || (rawSeverity !== null && severity === null));

  useInput((input, key) => {
    if (!overlayActive && (key.escape || input === 'b')) onBack?.();
  }, { isActive: isInStaticBranch });

  const tagsList: string[] = [];
  if (severity) tagsList.push(`severity: ${severity}`);

  const resolvedDir = pathArg !== null ? path.resolve(pathArg) : process.cwd();
  const pipelineSteps = useMemo(
    () => buildSecurityPipelineSteps({ terraformDir: resolvedDir, severity }),
    [resolvedDir, severity],
  );

  const renderResult = useMemo(
    () => makeRenderSecurityResult(severity, selectedRowRef, resolvedDir, setHeaderScope),
    [severity, resolvedDir],
  );

  useEffect(() => {
    const dir = pathArg !== null ? path.resolve(pathArg) : process.cwd();
    try {
      const hasTf = readdirSync(dir).some(f => f.endsWith('.tf'));
      setHasTerraform(hasTf);
    } catch (e) {
      logger.debug({ err: e }, '[security] Failed to read directory for .tf files');
      setHasTerraform(false);
    }
  }, [pathArg]);

  // ── Path picker wizard ────────────────────────────────────────────────────
  if (showPathPicker) {
    return (
      <PathPickerScreen
        onSubmit={(p) => {
          onAction?.({ type: 'navigate' as const, command: 'security', args: ['--path', p] });
        }}
        onCancel={() => setShowPathPicker(false)}
      />
    );
  }

  // ── Invalid severity error ────────────────────────────────────────────────
  if (rawSeverity !== null && severity === null) {
    return (
      <ScreenShell
        header={<CommandHeader command="security" description="security scan" />}
      >
        <ErrorBox
          title="Invalid severity"
          message={`Unknown severity "${rawSeverity}". Valid values: ${VALID_SEVERITIES.join(', ')}`}
          actions={[
            { key: '1', label: 'critical', action: { type: 'navigate' as const, command: 'security', args: ['--severity', 'critical'] } },
            { key: '2', label: 'high', action: { type: 'navigate' as const, command: 'security', args: ['--severity', 'high'] } },
            { key: '3', label: 'medium', action: { type: 'navigate' as const, command: 'security', args: ['--severity', 'medium'] } },
            { key: '4', label: 'low', action: { type: 'navigate' as const, command: 'security', args: ['--severity', 'low'] } },
          ]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  // ── Loading (hasTerraform check in flight) ────────────────────────────────
  if (hasTerraform === null) {
    return (
      <ScreenShell
        header={<CommandHeader command="security" description="check Terraform security" />}
      >
        <Box marginTop={GAP_AFTER_HEADER} marginLeft={PADDING_X}>
          <Text>Checking for Terraform files...</Text>
        </Box>
      </ScreenShell>
    );
  }

  // ── No Terraform files found ──────────────────────────────────────────────
  if (!hasTerraform) {
    return (
      <ScreenShell
        header={<CommandHeader command="security" description="security scan" />}
        actions={
          <ActionBar
            actions={[
              { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'security' } },
            ]}
            onAction={onAction}
          />
        }
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
      >
        <Box
          marginLeft={PADDING_X}
          marginTop={GAP_AFTER_HEADER}
          flexDirection="column"
        >
          <EmptyState
            message="No Terraform files found at path."
            hint="Run with --path <dir> or scan again."
          />
        </Box>
      </ScreenShell>
    );
  }

  // ── No-AI mode (rules-only) ───────────────────────────────────────────────
  if (provider === null) {
    return (
      <ScreenShell
        header={
          detailFinding !== null ? (
            <CommandHeader command="security" description="finding detail" variant="compact" />
          ) : (
            <CommandHeader
              command="security"
              description="security rules scan"
              scope={headerScope}
              mode="diagnostic"
              tags={tagsList.length > 0 ? tagsList : undefined}
              variant="compact"
            />
          )
        }
        hints={detailFinding !== null || pipelineHasError ? undefined : (
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
        <AiStatusBanner provider={provider} aiConfigured={aiConfigured} />
        <Box display={detailFinding !== null ? 'none' : 'flex'}>
          <DirectPipeline
            steps={pipelineSteps}
            renderResult={renderResult}
            onRunAgain={onRunAgain}
            onBack={onBack}
            onAction={onAction}
            onError={setPipelineHasError}
            overlayActive={overlayActive}
          />
        </Box>
        {detailFinding !== null && (
          <Box marginTop={GAP_AFTER_HEADER}>
            <SecurityDetailOverlay
              finding={detailFinding}
              onClose={() => setDetailFinding(null)}
              isActive={!helpOpen && !paletteOpen}
            />
          </Box>
        )}
      </ScreenShell>
    );
  }

  // ── Hybrid mode (with AI) ──────────────────────────────────────────────────
  return (
    <ScreenShell
      header={
        detailFinding !== null ? (
          <CommandHeader command="security" description="finding detail" variant="compact" />
        ) : (
          <CommandHeader
            command="security"
            description="security posture scan"
            scope={headerScope}
            tags={tagsList.length > 0 ? tagsList : undefined}
            flags={severity ? [`--severity ${severity}`] : []}
            variant="compact"
          />
        )
      }
      hints={detailFinding !== null || pipelineHasError ? undefined : (
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
      <Box display={detailFinding !== null ? 'none' : 'flex'}>
        <HybridPipeline
          steps={pipelineSteps}
          provider={provider}
          buildAnalysisPrompt={buildSecurityAnalysisPrompt}
          systemPrompt={getAnalysisPrompt('security')}
          renderResult={renderResult}
          renderFallback={renderResult}
          onRunAgain={onRunAgain}
          onBack={onBack}
          onAction={onAction}
          overlayActive={overlayActive}
          allowFollowUp
          followUpContextSource="security posture"
          onError={setPipelineHasError}
        />
      </Box>
      {detailFinding !== null && (
        <Box marginTop={GAP_AFTER_HEADER}>
          <SecurityDetailOverlay
            finding={detailFinding}
            onClose={() => setDetailFinding(null)}
            isActive={!helpOpen && !paletteOpen}
          />
        </Box>
      )}
    </ScreenShell>
  );
}
