/**
 * FixCommand — §9 Apply one recommendation with AI workflow.
 *
 * Lifecycle:
 *   §9.1 Picking: no pre-selected rec, table SEV | TITLE | SAVINGS. Header subtitle `select a recommendation`.
 *   §9.2 Reviewing: three labeled boxes WHAT / WHY / HOW. WHY omitted when both risk AND reasoning null.
 *        HOW ends with automation line. Header subtitle `reviewing: <short-title>`.
 *   §9.3 Running: active spinner + completed steps list. Header subtitle `applying: <short-title>`.
 *   §9.4 Done: `✓ Fix applied` + modified file line + savings + next-step hint.
 *        Header subtitle `done`. ActionBar `s scan again, p report`.
 *   §9.5 Dry-run: preview diff without applying. Header subtitle `dry-run preview`.
 *        ActionBar `Enter apply now`. NavHints `b back q quit`.
 *
 * Pre-selected rec flow: when invoked with rec id, skip picking, start at reviewing.
 *
 * Rules enforced:
 *   VRHYTHM_RULE  — GAP_AFTER_HEADER / GAP_BETWEEN_SECTIONS / GAP_BEFORE_ACTIONS only
 *   DOT_SEP_RULE  — DOT_SEP from ui/text.js
 *   SEVERITY_LABELS_RULE — SEVERITY_LABELS from ui/text.ts
 *   SCREEN_SHELL_RULE — wrapped in ScreenShell
 *   X-1 rule — NavHints = navigation only; d/p/s in ActionBar
 *   ERR2-1 rule — ErrorBox owns its footer
 *   G-2 rule — renderResult returns CommandResultView
 */

import path from 'node:path';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';

import type { AgentProvider } from '../../agent/types.js';
import { CommandHeader } from '../components/CommandHeader.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { ErrorBox } from '../components/ErrorBox.js';
import { InteractionHints, IH_QUIT, IH_BACK, IH_COMMAND, IH_HELP } from '../components/InteractionHints.js';
import { ActionBar } from '../components/ActionBar.js';
import { EmptyState } from '../components/EmptyState.js';
import { colors, semanticColors, borders } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, GAP_SECTION_WIDE, GAP_AFTER_HEADER, PADDING_X } from '../ui/spacing.js';
import { SEVERITY_LABELS, DOT_SEP } from '../ui/text.js';
import { formatMoneyPerMonth } from '../ui/format.js';
import { truncateWidth } from '../ui/width.js';
import type { TuiAction } from '../actions.js';
import { getDb } from '../../storage/db.js';
import {
  getRecommendationById,
  listPendingRecommendations,
  updateRecommendationStatus,
} from '../../storage/queries/recommendations.js';
import type { Recommendation } from '../../storage/queries/recommendations.js';
import { buildAgentPrompt, detectGitHubRepo } from './fix-core.js';
import { AgentLoop } from '../components/AgentLoop.js';
import { fixTools } from '../../tools/index.js';
import { getPrompt } from '../../agent/prompts.js';
import { AiStatusBanner } from '../components/AiStatusBanner.js';
import { logger } from '../../utils/logger.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';
import { loadConfig } from '../../config/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type FixStep = 'loading' | 'picking' | 'reviewing' | 'dry-run' | 'running' | 'done';

interface PickRow {
  id: string;
  severity: string;
  title: string;
  savings: string;
  rawSavings: number;
  resourceId: string | null;
  scenario: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scenarioLabel(scenario: string | null | undefined): string {
  if (scenario === 'A') return 'Not deployed';
  if (scenario === 'B') return 'Deployed';
  if (scenario === 'C') return 'Unmanaged';
  return '';
}

function deriveSeverity(rec: Recommendation): string {
  const impact = rec.impact ?? 'medium';
  const validLevels = ['critical', 'high', 'medium', 'low'] as const;
  type SeverityKey = typeof validLevels[number];
  const level: SeverityKey = validLevels.includes(impact as SeverityKey)
    ? (impact as SeverityKey)
    : 'medium';
  return SEVERITY_LABELS[level];
}


function dbRecToPickRow(r: Recommendation): PickRow {
  const rawSavings = r.estimated_savings ?? 0;
  const savings = rawSavings > 0 ? formatMoneyPerMonth(rawSavings) : '—';
  const sevLabel = deriveSeverity(r);
  return {
    id: r.id,
    severity: sevLabel,
    title: r.title,
    savings,
    rawSavings,
    resourceId: r.resource_id ?? null,
    scenario: r.scenario ?? null,
  };
}

function automationLabel(rec: { patch_content?: string | null; file_path?: string | null }): string {
  if (rec.patch_content) return 'safe-auto';
  if (rec.file_path) return 'requires-approval';
  return 'manual';
}

// ─── Grouped pick list ────────────────────────────────────────────────────────

const SEV_W = 8;
const SAVINGS_W = 9;
const BADGE_W = 7; // "autofix" / "manual "

interface PickGroup {
  resourceId: string | null;
  rows: Array<{ row: PickRow; flatIdx: number }>;
}

function buildPickGroups(pickRows: PickRow[]): PickGroup[] {
  const map = new Map<string, PickGroup>();
  for (let i = 0; i < pickRows.length; i++) {
    const row = pickRows[i];
    if (!row) continue;
    const key = row.resourceId ?? '';
    if (!map.has(key)) map.set(key, { resourceId: row.resourceId, rows: [] });
    const group = map.get(key);
    if (group) group.rows.push({ row, flatIdx: i });
  }
  return [...map.values()];
}

function PickList({
  rows,
  selectedIdx,
  onSelect,
  termWidth,
}: {
  rows: PickRow[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
  termWidth: number;
}): React.JSX.Element {
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  useInput((_input, key) => {
    if (key.upArrow && selectedIdx > 0) onSelect(selectedIdx - 1);
    else if (key.downArrow && selectedIdx < rows.length - 1) onSelect(selectedIdx + 1);
  }, { isActive: !helpOpen && !paletteOpen });

  const groups = buildPickGroups(rows);
  // overhead: marginLeft(2) + cursor(1) + gap(1) + indent(2) + gap(1) + 3 inter-box gaps = 10
  const availWidth = termWidth - GAP_SECTION_WIDE - 5; // cursor(1)+gap(1)+indent(2)+gap(1)
  const titleWidth = Math.max(20, availWidth - SEV_W - SAVINGS_W - BADGE_W - 3);

  return (
    <Box flexDirection="column">
      {groups.map((group) => (
        <Box key={group.resourceId ?? '__none__'} flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
          {group.resourceId && (
            <Text bold>{group.resourceId}</Text>
          )}
          {group.rows.map(({ row, flatIdx }) => {
            const isSelected = flatIdx === selectedIdx;
            const isManual = row.scenario === 'C';
            const sev = row.severity.toLowerCase();
            const sevColor = sev === 'critical' ? semanticColors.severity.critical
              : sev === 'high' ? semanticColors.severity.high
              : sev === 'medium' ? semanticColors.severity.medium
              : sev === 'low' ? semanticColors.severity.low
              : undefined;
            return (
              <Box key={row.id} gap={1}>
                <Text color={colors.brand}>{isSelected ? '›' : ' '}</Text>
                {group.resourceId !== null && <Text>{'  '}</Text>}
                <Box width={SEV_W}>
                  <Text color={sevColor} bold={isSelected}>{row.severity}</Text>
                </Box>
                <Box width={titleWidth} overflow="hidden">
                  <Text bold={isSelected}>{truncateWidth(row.title, titleWidth)}</Text>
                </Box>
                <Box width={SAVINGS_W} justifyContent="flex-end">
                  <Text color={row.rawSavings > 0 ? semanticColors.savings.value : undefined}>
                    {row.savings}
                  </Text>
                </Box>
                <Box width={BADGE_W}>
                  {isManual
                    ? <Text dimColor>{'manual '}</Text>
                    : <Text color={colors.success}>{'autofix'}</Text>
                  }
                </Box>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface FixCommandProps {
  provider: AgentProvider | null;
  args?: string[];
  onRunAgain?: () => void;
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
  aiConfigured?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function FixCommand({
  provider,
  args = [],
  onRunAgain,
  onBack,
  onAction,
  aiConfigured = false,
}: FixCommandProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const { helpOpen, paletteOpen } = useGlobalOverlay();

  // Parse args
  const selectedId = args.find((a) => !a.startsWith('--'));
  const isDryRun = args.includes('--dry-run');
  const withPR = args.includes('--pr');
  const inlineRecArg = args.find((a) => a.startsWith('--inline-rec='));

  const decodeInlineRec = useCallback((): Recommendation | null => {
    if (inlineRecArg === undefined) return null;
    try {
      const encoded = inlineRecArg.slice('--inline-rec='.length);
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const raw = JSON.parse(decoded) as Record<string, unknown>;
      const id = String(typeof raw['id'] === 'string' || typeof raw['id'] === 'number' ? raw['id'] : selectedId ?? '');
      const impact = typeof raw['impact'] === 'string' ? raw['impact'] : 'medium';
      const risk = typeof raw['risk'] === 'string' ? raw['risk'] : 'low';
      const savings = typeof raw['estimatedSavingsUsd'] === 'number'
        ? (raw['estimatedSavingsUsd'])
        : typeof raw['estimated_savings'] === 'number'
        ? (raw['estimated_savings'])
        : 0;
      const resourceId = typeof raw['resourceId'] === 'string'
        ? (raw['resourceId'])
        : typeof raw['resource_id'] === 'string'
        ? (raw['resource_id'])
        : null;
      const resourceType = typeof raw['type'] === 'string' ? (raw['type']) : '';
      return {
        id,
        scan_id: typeof raw['scan_id'] === 'string' ? (raw['scan_id']) : '',
        resource_id: resourceId,
        resource_type: resourceType || null,
        type: resourceType,
        title: String(typeof raw['title'] === 'string' || typeof raw['title'] === 'number' ? raw['title'] : ''),
        description: typeof raw['description'] === 'string' ? (raw['description']) : null,
        reasoning: null,
        estimated_savings: savings,
        confidence: 0,
        quality_score: 0,
        impact,
        risk,
        status: 'pending',
        current_config: null,
        suggested_config: null,
        patch_content: null,
        file_path: null,
        implementation_steps: null,
        ai_model: null,
        scenario: null,
        applied_at: null,
        dismissed_at: null,
        dismiss_reason: null,
        created_at: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }, [inlineRecArg, selectedId]);

  const [step, setStep] = useState<FixStep>('loading');
  const [rows, setRows] = useState<PickRow[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Recommendation | null>(null);
  const [applyResult, setApplyResult] = useState<{ file: string; lineCount: number; savings: number } | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<'result' | 'error' | 'aborted' | null>(null);
  const [completedStepKeys, setCompletedStepKeys] = useState<Set<string>>(new Set());
  const [aiMaxBudget, setAiMaxBudget] = useState(0.50);
  const [aiTimeoutMs, setAiTimeoutMs] = useState(15 * 60_000);

  useEffect(() => {
    loadConfig().then((cfg) => {
      setAiMaxBudget(cfg.ai.max_budget_usd);
      setAiTimeoutMs(cfg.ai.timeout_ms * 3);
    }).catch((err: unknown) => {
      logger.warn({ err }, 'Failed to load config; using defaults');
    });
  }, []);

  const fixQueryOptions = useMemo(() => ({
    builtinTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'] as string[],
    settingSources: ['project'] as Array<'user' | 'project' | 'local'>,
    systemPrompt: getPrompt('fix'),
    timeoutMs: aiTimeoutMs,
    maxTurns: 20,
  }), [aiTimeoutMs]);

  useInput((input, key) => {
    // Picking state: q and b/Esc navigate back
    if (step === 'picking') {
      if (input === 'q') {
        if (onBack !== undefined) onBack();
        else exit();
        return;
      }
      if ((input === 'b' || key.escape) && onBack !== undefined) {
        onBack();
        return;
      }
      if (input === 'b' || key.escape) {
        exit();
      }
      return;
    }

    // Reviewing state: b/Esc back to picking, q quit
    if (step === 'reviewing') {
      if (input === 'q') {
        if (onBack !== undefined) onBack();
        else exit();
        return;
      }
      if ((input === 'b' || key.escape) && onBack !== undefined) {
        setStep('picking');
        return;
      }
      if (input === 'b' || key.escape) {
        exit();
      }
      return;
    }

    // Done state: b back to scan, q quit
    if (step === 'done') {
      if (input === 'q') {
        if (onBack !== undefined) onBack();
        else exit();
        return;
      }
      if ((input === 'b' || key.escape) && onBack !== undefined) {
        onBack();
        return;
      }
      if (input === 'b' || key.escape) {
        exit();
      }
      return;
    }

    // Dry-run state: b back to review, q quit
    if (step === 'dry-run') {
      if (input === 'q') {
        if (onBack !== undefined) onBack();
        else exit();
        return;
      }
      if ((input === 'b' || key.escape) && onBack !== undefined) {
        setStep('reviewing');
        return;
      }
      if (input === 'b' || key.escape) {
        exit();
      }
      return;
    }
  }, { isActive: !helpOpen && !paletteOpen });

  // Load recommendations on mount
  useEffect(() => {
    const tid = setTimeout(() => {
      try {
        const db = getDb();
        const pending = listPendingRecommendations(db);
        const pickRows = pending.map(dbRecToPickRow);
        setRows(pickRows);

        // If pre-selected rec ID provided, skip picking
        if (selectedId) {
          const rec = getRecommendationById(db, selectedId);
          if (!rec) {
            const inlineRec = decodeInlineRec();
            if (inlineRec !== null) {
              setSelected(inlineRec);
              setStep(isDryRun ? 'dry-run' : 'reviewing');
              return;
            }
            setLoadError(`Recommendation "${selectedId}" not found`);
            setStep('picking');
            return;
          }
          if (rec.status === 'applied') {
            setLoadError(`Already applied${rec.applied_at ? ` on ${rec.applied_at.slice(0, 10)}` : ''}`);
            setStep('picking');
            return;
          }
          if (rec.status === 'dismissed') {
            setLoadError(`Recommendation was dismissed`);
            setStep('picking');
            return;
          }
          setSelected(rec);
          setStep(isDryRun ? 'dry-run' : 'reviewing');
        } else {
          setStep('picking');
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load recommendations');
        setStep('picking');
      }
    }, 0);
    return () => clearTimeout(tid);
  }, [selectedId, isDryRun, inlineRecArg, decodeInlineRec]);

  // AI not configured
  if (provider === null) {
    return (
      <ScreenShell
        header={<CommandHeader command="fix" description="AI remediation workflow" />}
      >
        <AiStatusBanner provider={provider} aiConfigured={aiConfigured} />
        <ErrorBox
          title="AI provider required"
          message="Configure an AI provider before running fix."
          actions={[
            { key: 'i', label: 'init AI', action: { type: 'navigate' as const, command: 'init' } },
            { key: 'c', label: 'config', action: { type: 'navigate' as const, command: 'config' } },
          ]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  // ─── Loading state ────────────────────────────────────────────────────────────

  if (step === 'loading') {
    return (
      <ScreenShell
        header={<CommandHeader command="fix" description="AI remediation workflow" />}
        hints={<InteractionHints hints={[IH_QUIT]} />}
      >
        <Box marginLeft={GAP_SECTION_WIDE} marginTop={GAP_AFTER_HEADER}>
          <Text dimColor>Loading recommendations…</Text>
        </Box>
      </ScreenShell>
    );
  }

  // ─── Picking state (§9.1) ─────────────────────────────────────────────────────

  if (step === 'picking') {
    if (loadError !== null) {
      return (
        <ScreenShell
          header={<CommandHeader command="fix" description="AI remediation workflow" />}
        >
          <ErrorBox
            title="Could not load recommendations"
            message={loadError}
            actions={[
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
          header={<CommandHeader command="fix" description="AI remediation workflow" />}
          actions={
            <ActionBar
              actions={[
                { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'scan' } },
              ]}
              onAction={onAction}
            />
          }
          hints={<InteractionHints hints={[...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
        >
          <EmptyState message="No recommendations." hint="Run a scan first." />
        </ScreenShell>
      );
    }

    return (
      <ScreenShell
        header={<CommandHeader command="fix" description="select a recommendation" />}
        actions={
          <ActionBar
            actions={[
              { key: 'Enter', label: 'select', action: { type: 'run-again' as const } },
            ]}
            onAction={(action) => {
              if (action.type === 'run-again') {
                const rec = rows[selectedIdx];
                if (rec) {
                  try {
                    const db = getDb();
                    const fullRec = getRecommendationById(db, rec.id);
                    if (fullRec) {
                      setSelected(fullRec);
                      setStep('reviewing');
                    }
                  } catch (err) {
                    logger.error({ err }, '[fix] Failed to load selected recommendation');
                  }
                }
                return;
              }
              onAction?.(action);
            }}
            marginLeft={GAP_SECTION_WIDE}
          />
        }
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
      >
        <Box marginLeft={GAP_SECTION_WIDE} marginTop={GAP_AFTER_HEADER}>
          <PickList
            rows={rows}
            selectedIdx={selectedIdx}
            onSelect={setSelectedIdx}
            termWidth={termWidth}
          />
        </Box>
      </ScreenShell>
    );
  }

  // ─── Reviewing state (§9.2) ───────────────────────────────────────────────────

  if (step === 'reviewing' && selected !== null) {
    const reviewWidth = Math.max(60, termWidth - GAP_SECTION_WIDE - 2);
    const resourceScope = [selected.resource_type, selected.resource_id]
      .filter(Boolean)
      .join(DOT_SEP);
    const headerScope = resourceScope.length > 0
      ? truncateWidth(resourceScope, Math.max(20, termWidth - 40))
      : truncateWidth(selected.title, Math.max(20, termWidth - 40));

    return (
      <ScreenShell
        header={<CommandHeader command="fix" description="reviewing" scope={headerScope} />}
        actions={
          selected.scenario === 'C' ? (
            <Box marginLeft={GAP_SECTION_WIDE}>
              <Text dimColor>Manual fix — apply via AWS CLI or AWS Console</Text>
            </Box>
          ) : (
            <ActionBar
              actions={[
                { key: 'Enter', label: selected.scenario === 'A' || selected.scenario === 'B' ? 'apply + PR' : 'apply', action: { type: 'apply-fix' as const } },
                { key: 'd', label: 'dry-run preview', action: { type: 'preview-dry-run' as const } },
              ]}
              onAction={(action) => {
                if (action.type === 'apply-fix') setStep('running');
                else if (action.type === 'preview-dry-run') setStep('dry-run');
                onAction?.(action);
              }}
              marginLeft={GAP_SECTION_WIDE}
            />
          )
        }
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
      >
        <Box flexDirection="column" marginLeft={GAP_SECTION_WIDE} width={reviewWidth}>
          {/* WHAT box */}
          <Box
            flexDirection="column"
            borderStyle={borders.card}
            borderColor={colors.border}
            paddingX={PADDING_X}
            marginBottom={GAP_BETWEEN_SECTIONS}
          >
            <Text bold color={colors.brand}>WHAT</Text>
            {scenarioLabel(selected.scenario) !== '' && (
              <Text dimColor>
                {scenarioLabel(selected.scenario)}
                {selected.scenario === 'C' && <>{DOT_SEP}manual fix only</>}
              </Text>
            )}
            <Text>{selected.title}</Text>
            {selected.description && (
              <Text>{truncateWidth(selected.description, reviewWidth - 4)}</Text>
            )}
          </Box>

          {/* WHY box — omitted if both risk AND reasoning are null/empty */}
          {(selected.risk ?? selected.reasoning) && (
            <Box
              flexDirection="column"
              borderStyle={borders.card}
              borderColor={colors.border}
              paddingX={PADDING_X}
              marginBottom={GAP_BETWEEN_SECTIONS}
            >
              <Text bold color={colors.brand}>WHY</Text>
              <Box>
                <Text dimColor>Savings: </Text>
                <Text color={colors.brand}>{formatMoneyPerMonth(selected.estimated_savings ?? 0)}</Text>
                <Text dimColor>{DOT_SEP}Risk: </Text>
                {(() => {
                  const risk = (selected.risk ?? '').toLowerCase();
                  const riskColor = risk === 'low' ? colors.success
                    : risk === 'medium' ? colors.warning
                    : risk === 'high' || risk === 'critical' ? semanticColors.severity.high
                    : undefined;
                  return <Text color={riskColor}>{selected.risk ?? '—'}</Text>;
                })()}
                <Text dimColor>{DOT_SEP}Confidence: </Text>
                {(() => {
                  const pct = selected.confidence ? Math.round(selected.confidence * 100) : null;
                  const confColor = pct !== null && pct >= 80 ? colors.success
                    : pct !== null && pct >= 50 ? colors.warning
                    : undefined;
                  return <Text color={confColor}>{pct !== null ? `${pct}%` : '—'}</Text>;
                })()}
              </Box>
              {selected.reasoning && (
                <Text>{truncateWidth(selected.reasoning, reviewWidth - 4)}</Text>
              )}
            </Box>
          )}

          {/* HOW box with automation line */}
          <Box
            flexDirection="column"
            borderStyle={borders.card}
            borderColor={colors.border}
            paddingX={PADDING_X}
          >
            <Text bold color={colors.brand}>HOW</Text>
            {selected.implementation_steps && selected.implementation_steps.length > 0 ? (
              <Box flexDirection="column">
                {selected.implementation_steps.map((step, i) => (
                  <Box key={i} gap={1}>
                    <Text color={colors.highlight}>{i + 1}.</Text>
                    <Text>{step}</Text>
                  </Box>
                ))}
              </Box>
            ) : selected.scenario === 'C' && selected.patch_content ? (
              <Box flexDirection="column" gap={1}>
                <Text dimColor>Run this command in your terminal:</Text>
                {selected.patch_content.split('\n').map((line, i) => (
                  <Text key={i} color={line.trimStart().startsWith('#') ? undefined : colors.highlight} dimColor={line.trimStart().startsWith('#')}>
                    {line}
                  </Text>
                ))}
              </Box>
            ) : (
              <Text dimColor>
                {selected.scenario === 'C'
                  ? 'Apply this fix manually via AWS CLI or AWS Console (see description above)'
                  : selected.scenario === 'A' || selected.scenario === 'B'
                    ? 'Press Enter to apply — agent will edit the Terraform file and create a PR'
                    : 'Press Enter to apply the fix'}
              </Text>
            )}
            {/* Automation line at end of HOW box */}
            <Text dimColor>
              Automation: <Text>{automationLabel(selected)}</Text>
              <Text>{DOT_SEP}</Text>
              <Text>{selected.file_path ? 'Terraform' : 'AWS CLI'}</Text>
              <Text>{DOT_SEP}rollback: {selected.file_path ? 'revert file' : 'restore config'}</Text>
            </Text>
          </Box>
        </Box>
      </ScreenShell>
    );
  }

  // ─── Dry-run state (§9.5) ─────────────────────────────────────────────────────

  if (step === 'dry-run' && selected !== null) {
    return (
      <ScreenShell
        header={<CommandHeader command="fix" description="dry-run preview" />}
        actions={
          <ActionBar
            actions={[
              { key: 'Enter', label: 'apply now', action: { type: 'run-again' as const } },
            ]}
            onAction={(action) => {
              if (action.type === 'run-again') {
                setStep('running');
                return;
              }
              onAction?.(action);
            }}
            marginLeft={GAP_SECTION_WIDE}
          />
        }
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
      >
        <Box flexDirection="column" marginLeft={GAP_SECTION_WIDE} marginTop={GAP_AFTER_HEADER}>
          <Box>
            <Text dimColor>Changes that would be made (not applied):</Text>
          </Box>
          <Box marginTop={GAP_BETWEEN_SECTIONS}>
            <Text dimColor>
              {selected.file_path ?? 'resource'}
            </Text>
          </Box>
          {selected.patch_content !== null && selected.patch_content !== undefined && (
            <Box marginTop={GAP_BETWEEN_SECTIONS}>
              <Text>{selected.patch_content}</Text>
            </Box>
          )}
          <Box marginTop={GAP_BETWEEN_SECTIONS}>
            <Box>
              <Text dimColor>Estimated savings: {formatMoneyPerMonth(selected.estimated_savings ?? 0)}</Text>
            </Box>
          </Box>
        </Box>
      </ScreenShell>
    );
  }

  // ─── Running state (§9.3) ─────────────────────────────────────────────────────

  if (step === 'running' && selected !== null) {
    const effectivePR = withPR || selected.scenario === 'A' || selected.scenario === 'B';

    const FIX_STEPS = [
      { key: 'analyze', label: 'Analyzing recommendation', tools: [] as string[] },
      { key: 'edit',    label: 'Editing Terraform file',   tools: ['Edit', 'Write', 'apply_patch'] },
      { key: 'commit',  label: 'Committing & pushing',     tools: ['git_commit_push'] },
      { key: 'pr',      label: 'Creating pull request',    tools: ['create_github_pr'] },
    ].filter((s) => s.key !== 'pr' || effectivePR);

    const runningResourceScope = [selected.resource_type, selected.resource_id]
      .filter(Boolean)
      .join(DOT_SEP);
    const runningHeaderScope = runningResourceScope.length > 0
      ? truncateWidth(runningResourceScope, Math.max(20, termWidth - 40))
      : truncateWidth(selected.title, Math.max(20, termWidth - 40));

    // Derive active step index: first step not yet completed
    const activeStepIdx = FIX_STEPS.findIndex((s) => !completedStepKeys.has(s.key));

    return (
      <ScreenShell
        header={<CommandHeader command="fix" description={agentStatus === 'error' ? 'failed' : agentStatus === 'aborted' ? 'cancelled' : agentStatus === 'result' ? 'completed' : 'applying'} scope={agentStatus !== null ? undefined : runningHeaderScope} />}
      >
        {/* Fix progress steps */}
        <Box flexDirection="column" marginLeft={GAP_SECTION_WIDE} marginTop={GAP_AFTER_HEADER} marginBottom={GAP_BETWEEN_SECTIONS}>
          {FIX_STEPS.map((s, idx) => {
            const done = completedStepKeys.has(s.key);
            const active = !done && idx === activeStepIdx;
            if (done) {
              return (
                <Box key={s.key} gap={1}>
                  <Text color={colors.success} bold>{'✓'}</Text>
                  <Text color={colors.success} bold>{s.label}</Text>
                </Box>
              );
            }
            if (active) {
              return (
                <Box key={s.key} gap={1}>
                  <Text color={colors.brand}><Spinner type="dots" /></Text>
                  <Text>{s.label}</Text>
                </Box>
              );
            }
            return (
              <Box key={s.key}>
                <Text dimColor>{'  '}{s.label}</Text>
              </Box>
            );
          })}
        </Box>
        <AgentLoop
          prompt={buildAgentPrompt(selected, (() => {
            const tfDir = selected.file_path ? path.dirname(path.resolve(selected.file_path)) : undefined;
            return { isDryRun, isPR: effectivePR, prContext: effectivePR ? (detectGitHubRepo(tfDir) ?? detectGitHubRepo()) : null };
          })())}
          provider={provider}
          onRunAgain={onRunAgain}
          onBack={onBack}
          onAction={onAction}
          queryOptions={fixQueryOptions}
          tools={fixTools}
          maxBudgetUsd={aiMaxBudget}
          resultTitle="Fix applied"
          resultActions={[
            { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'scan' as const } },
            { key: 'p', label: 'report', action: { type: 'navigate' as const, command: 'report' as const } },
          ]}
          onToolUse={(toolName) => {
            setCompletedStepKeys((prev) => {
              const next = new Set(prev);
              next.add('analyze');
              if (['Edit', 'Write', 'apply_patch'].includes(toolName)) next.add('edit');
              if (toolName === 'git_commit_push') next.add('commit');
              if (toolName === 'create_github_pr') next.add('pr');
              return next;
            });
          }}
          onResult={(text) => {
            const match = text.match(/(https:\/\/github\.com\/[^/\s"]+\/[^/\s"]+\/pull\/\d+)/);
            if (match?.[1]) setPrUrl(match[1]);
          }}
          onFinished={(status) => {
            setAgentStatus(status);
            if (status === 'result') {
              try {
                updateRecommendationStatus(getDb(), selected.id, 'applied');
              } catch { /* non-fatal */ }
              setApplyResult({
                file: selected.file_path ?? 'AWS resource',
                lineCount: 1,
                savings: selected.estimated_savings ?? 0,
              });
              setStep('done');
            }
          }}
        />
      </ScreenShell>
    );
  }

  // ─── Done state (§9.4) ────────────────────────────────────────────────────────

  if (step === 'done') {
    const doneActions: Array<{ key: string; label: string; action: TuiAction }> = [
      { key: 's', label: 'scan again', action: { type: 'navigate' as const, command: 'scan' } },
      { key: 'p', label: 'report', action: { type: 'navigate' as const, command: 'report' } },
    ];
    if (prUrl) {
      doneActions.unshift({ key: 'o', label: 'open PR', action: { type: 'open-file' as const, path: prUrl } });
    }

    const filePath = applyResult?.file ?? selected?.file_path ?? null;
    const displayPath = filePath
      ? path.relative(process.cwd(), filePath) || filePath
      : 'AWS resource';
    const lineCount = applyResult?.lineCount ?? 1;
    const scenario = selected?.scenario ?? null;

    return (
      <ScreenShell
        header={<CommandHeader command="fix" description="done" />}
        actions={
          <ActionBar
            actions={doneActions}
            onAction={onAction}
            marginLeft={GAP_SECTION_WIDE}
          />
        }
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
      >
        <Box marginLeft={GAP_SECTION_WIDE} marginTop={GAP_AFTER_HEADER}>
          <Box
            flexDirection="column"
            borderStyle={borders.card}
            borderColor={colors.success}
            paddingX={PADDING_X}
          >
            {/* Line 1: ✓ Fix applied */}
            <Text color={colors.success} bold>{'✓ Fix applied'}</Text>
            {/* Line 2: file path */}
            <Text dimColor>{displayPath}</Text>
            {/* Line 3: lines changed · scenario */}
            <Text>
              {lineCount} line{lineCount !== 1 ? 's' : ''} changed
              {scenario !== null ? <>{DOT_SEP}Scenario {scenario}</> : null}
            </Text>
            {/* PR section */}
            {prUrl && (
              <>
                <Text>{' '}</Text>
                <Text color={colors.success}>PR created</Text>
                <Text dimColor>{prUrl}</Text>
              </>
            )}
            {/* Footer */}
            <Text>{' '}</Text>
            <Text dimColor>
              {prUrl ? 'Next: review and merge the PR' : 'Next: run terraform plan && apply'}
            </Text>
          </Box>
        </Box>
      </ScreenShell>
    );
  }

  return <Box />;
}
