/**
 * RulesCommand — read-only catalog of built-in cost optimization rules.
 *
 * Data source is in-memory (`listRules()` from src/rules/registry.ts) — no AWS
 * calls, no DB, no AI. Rules are grouped by category and rendered through
 * `ResultViewport` so users can scroll the whole catalog with ↑/↓/PgUp/PgDn
 * inside `ScreenShell`'s fixed-height content region.
 *
 * Mirrors the headless `korinfra rules list` output so users can preview the
 * catalog from the TUI before piping it to `--json` for scripting.
 */

import React, { useMemo } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import { CommandHeader } from '../components/CommandHeader.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { InteractionHints, IH_NAVIGATE, IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT } from '../components/InteractionHints.js';
import { ResultViewport, type ResultBlock } from '../components/ResultViewport.js';
import { listRules } from '../../rules/registry.js';
import type { RuleInfo } from '../../rules/types.js';
import { colors } from '../theme.js';
import { MARGIN_LEFT_CONTENT } from '../ui/spacing.js';
import type { TuiAction } from '../actions.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';
import { useTuiViewportLayout } from '../hooks/useTuiViewportLayout.js';

export interface RulesCommandProps {
  args: string[];
  onBack?: (() => void) | undefined;
  onAction?: ((action: TuiAction) => void) | undefined;
}

function groupByCategory(rules: readonly RuleInfo[]): [string, RuleInfo[]][] {
  const byCategory = new Map<string, RuleInfo[]>();
  for (const rule of rules) {
    const arr = byCategory.get(rule.category) ?? [];
    arr.push(rule);
    byCategory.set(rule.category, arr);
  }
  return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function impactColor(impact: RuleInfo['impact']): string | undefined {
  if (impact === 'high') return colors.warning;
  if (impact === 'medium') return colors.info;
  return colors.muted;
}

export function RulesCommand({ args: _args, onBack }: RulesCommandProps): React.JSX.Element {
  const { exit } = useApp();
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  // Reserve an extra row for the in-content "JSON hint" prefix above the viewport.
  const { contentRows } = useTuiViewportLayout({ status: 2 });

  const rules = useMemo(() => listRules(), []);
  const grouped = useMemo(() => groupByCategory(rules), [rules]);

  const blocks: ResultBlock[] = useMemo(() => grouped.map(([category, categoryRules]) => ({
    key: category,
    // 1 row for the category header + 1 row per rule + 1 row of marginBottom.
    rows: 1 + categoryRules.length + 1,
    element: (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={colors.brand}>
          {category.toUpperCase()} ({categoryRules.length})
        </Text>
        {categoryRules.map((rule) => (
          <Box key={rule.id} flexDirection="row">
            <Box width={11}>
              <Text color={colors.success}>{rule.id}</Text>
            </Box>
            <Box width={10}>
              <Text color={impactColor(rule.impact)}>[{rule.impact}]</Text>
            </Box>
            <Text>{rule.title}</Text>
          </Box>
        ))}
      </Box>
    ),
  })), [grouped]);

  useInput((input, key) => {
    if (helpOpen || paletteOpen) return;
    if (input === 'q') {
      exit();
      return;
    }
    if (input === 'b' || key.escape === true) {
      onBack?.();
    }
  }, { isActive: !helpOpen && !paletteOpen });

  // ResultViewport handles ↑/↓/PgUp/PgDn/Home/End scroll while the panel is active.
  const viewportActive = !helpOpen && !paletteOpen;

  return (
    <ScreenShell
      header={
        <CommandHeader
          command="rules"
          description="built-in cost optimization rules"
          scope={`${rules.length} rules, ${grouped.length} categories`}
          variant="compact"
        />
      }
      hints={
        <InteractionHints
          hints={[
            IH_NAVIGATE,
            IH_COMMAND,
            IH_HELP,
            ...(onBack !== undefined ? [IH_BACK] : []),
            IH_QUIT,
          ]}
        />
      }
    >
      <Box flexDirection="column" marginLeft={MARGIN_LEFT_CONTENT}>
        <Box marginBottom={1}>
          <Text dimColor>For machine-readable output: </Text>
          <Text color={colors.info}>korinfra rules list --json</Text>
        </Box>
        <ResultViewport
          blocks={blocks}
          viewportRows={Math.max(8, contentRows - 2)}
          isActive={viewportActive}
        />
      </Box>
    </ScreenShell>
  );
}
