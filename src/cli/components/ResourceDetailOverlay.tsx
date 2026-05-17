/**
 * ResourceDetailOverlay — §5.3 detail overlay for a resource row.
 *
 * Shows resource metadata, current costs, associated issues, and related resources.
 * Footer: `f fix`, `c copy ID`, `p report` actions via keyboard; then Esc/b close in NavHints.
 *
 * Rules:
 *   VRHYTHM_RULE — spacing via GAP_* constants only
 *   DOT_SEP_RULE — DOT_SEP from ui/text.js
 *   ERR2-1 rule scope — this component owns its own footer hints
 */

import React from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';

import { colors, icons, borders, semanticColors } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, GAP_ROW, GAP_BEFORE_ACTIONS, PADDING_X } from '../ui/spacing.js';
import { DOT_SEP, stripAnsi } from '../ui/text.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResourceDetailItem {
  id: string;
  name: string;
  type: string;
  region: string;
  state: string;
  instanceType: string;
  arn?: string | undefined;
  collectedAt?: string | undefined;
  monthlyCostUsd?: number | undefined;
  monthlyCostSource?: 'cost_explorer' | 'pricing_api' | null | undefined;
  /** Associated issues from evaluate_rules output, keyed by resource id. */
  issues?: Array<{ title: string; impact: string }>;
}

interface ResourceDetailOverlayProps {
  resource: ResourceDetailItem;
  onClose: () => void;
  isActive?: boolean;
  onFix?: () => void;
  onReport?: () => void;
  onCopyArn?: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stateColor(state: string): string | undefined {
  const s = state.toLowerCase();
  if (s === 'running' || s === 'available' || s === 'active') return semanticColors.status.pass;
  if (s === 'stopped' || s === 'stopping' || s === 'modifying') return semanticColors.status.warn;
  if (s === 'terminated' || s === 'deleting' || s === 'failed') return semanticColors.status.fail;
  if (s === 'pending') return colors.warning;
  return undefined;
}

function formatCostLine(monthlyCostUsd: number | undefined, source?: 'cost_explorer' | 'pricing_api' | null): string {
  if (monthlyCostUsd === undefined) return '—';
  if (monthlyCostUsd === 0) return 'no spend';
  const prefix = source === 'cost_explorer' ? '' : '~';
  const daily = (monthlyCostUsd / 30).toFixed(2);
  return `${prefix}$${monthlyCostUsd.toFixed(2)}/mo (≈$${daily}/day)`;
}

function formatCollectedAt(collectedAt: string | undefined): string {
  if (collectedAt === undefined) return '—';
  try {
    const d = new Date(collectedAt);
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch {
    return collectedAt;
  }
}

// ─── Detail row ───────────────────────────────────────────────────────────────

function DetailRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }): React.JSX.Element {
  const LABEL_WIDTH = 18;
  const padded = label.padEnd(LABEL_WIDTH);
  return (
    <Box gap={GAP_ROW}>
      <Text dimColor>{padded}</Text>
      <Text color={valueColor}>{value}</Text>
    </Box>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export function ResourceDetailOverlay({
  resource,
  onClose,
  isActive = true,
  onFix,
  onReport,
  onCopyArn,
}: ResourceDetailOverlayProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const overlayWidth = Math.min(termWidth - 4, 96);

  useInput((input, key) => {
    if (!isActive) return;
    if (input === 'q') exit();
    if (key.escape || input === 'b') onClose();
    if (input === 'f') onFix?.();
    if (input === 'c') onCopyArn?.();
    if (input === 'p') onReport?.();
  }, { isActive });

  const issues = resource.issues ?? [];
  const costLine = formatCostLine(resource.monthlyCostUsd, resource.monthlyCostSource);
  const safeName = stripAnsi(resource.name);
  const safeId = stripAnsi(resource.id);
  const safeType = stripAnsi(resource.type);
  const safeRegion = stripAnsi(resource.region);
  const safeState = stripAnsi(resource.state);
  const safeInstanceType = stripAnsi(resource.instanceType);
  const safeArn = resource.arn !== undefined ? stripAnsi(resource.arn) : undefined;
  const displayName = safeName !== '' && safeName !== safeId ? safeName : safeId;

  return (
    <Box flexDirection="column" width={overlayWidth}>
      <Box
        borderStyle={borders.card}
        borderColor={colors.highlight}
        flexDirection="column"
        paddingX={PADDING_X}
        width={overlayWidth}
      >
        {/* Header: resource name / ID */}
        <Box gap={GAP_ROW} marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text bold color={colors.highlight}>{displayName}</Text>
          {safeName !== '' && safeName !== safeId && (
            <Text dimColor>({safeId})</Text>
          )}
        </Box>

        {/* Metadata section */}
        <Box flexDirection="column" gap={0}>
          {colors.info !== undefined
            ? <DetailRow label="Type" value={safeType} valueColor={colors.info} />
            : <DetailRow label="Type" value={safeType} />}
          {colors.info !== undefined
            ? <DetailRow label="Region" value={safeRegion} valueColor={colors.info} />
            : <DetailRow label="Region" value={safeRegion} />}
          {(() => {
            const stateCol = stateColor(safeState);
            return stateCol !== undefined
              ? <DetailRow label="State" value={safeState} valueColor={stateCol} />
              : <DetailRow label="State" value={safeState} />;
          })()}
          {safeInstanceType !== '' && (
            colors.info !== undefined
              ? <DetailRow label="Instance type" value={safeInstanceType} valueColor={colors.info} />
              : <DetailRow label="Instance type" value={safeInstanceType} />
          )}
          {safeArn !== undefined && safeArn !== '' && (
            <DetailRow label="ARN" value={safeArn} />
          )}
          <DetailRow label="Last collected" value={formatCollectedAt(resource.collectedAt)} />
        </Box>

        {/* Cost section */}
        <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
          <Text bold color={semanticColors.cost.value}>Costs</Text>
          <Box marginTop={GAP_BETWEEN_SECTIONS}>
            <DetailRow
              label="Monthly cost"
              value={costLine}
              {...(resource.monthlyCostUsd !== undefined && resource.monthlyCostUsd > 0 && colors.cost !== undefined ? { valueColor: colors.cost } : {})}
            />
          </Box>
        </Box>

        {/* Associated issues */}
        {issues.length > 0 && (
          <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
            <Text bold color={colors.highlight}>Associated issues</Text>
            <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
              {issues.map((issue, i) => {
                const impactColor = semanticColors.severity[issue.impact as keyof typeof semanticColors.severity] ?? undefined;
                return (
                  <Box key={i} gap={GAP_ROW}>
                    <Text color={impactColor}>{icons.bullet}</Text>
                    <Text dimColor>{stripAnsi(issue.title)}</Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {/* Footer actions — overlay owns its hints (ERR2-1 scope) */}
        <Box marginTop={GAP_BEFORE_ACTIONS} gap={GAP_ROW}>
          {onFix !== undefined && (
            <>
              <Text dimColor><Text color={colors.warning}>f</Text> fix</Text>
              <Text dimColor>{DOT_SEP}</Text>
            </>
          )}
          {onCopyArn !== undefined && (
            <>
              <Text dimColor><Text color={colors.warning}>c</Text> copy ID</Text>
              <Text dimColor>{DOT_SEP}</Text>
            </>
          )}
          {onReport !== undefined && (
            <>
              <Text dimColor><Text color={colors.warning}>p</Text> report</Text>
              <Text dimColor>{DOT_SEP}</Text>
            </>
          )}
          <Text dimColor><Text color={colors.warning}>Esc</Text> close</Text>
          <Text dimColor>{DOT_SEP}</Text>
          <Text dimColor><Text color={colors.warning}>q</Text> quit</Text>
        </Box>
      </Box>
    </Box>
  );
}
