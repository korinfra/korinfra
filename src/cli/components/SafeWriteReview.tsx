/**
 * SafeWriteReview — pre-apply review screen for write operations.
 *
 * Shows exactly what will change, what will not change, what data is used,
 * and safety information (dry-run availability, rollback instructions).
 *
 * Hints are rendered inside the component — no external NavHints wrapper.
 * X-1: Enter = confirm, b/Esc = back. No auto-focus or pre-selected state.
 */

import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import { colors, icons } from '../theme.js';
import { DOT_SEP } from '../ui/text.js';
import { GAP_AFTER_HEADER, GAP_BETWEEN_SECTIONS, GAP_BEFORE_ACTIONS, GAP_ICON_TEXT, GAP_ROW, MARGIN_LEFT_CONTENT } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';
import { getAvailableSafeWidth, padEndWidth, truncateWidth } from '../ui/width.js';

// ─── Public types ─────────────────────────────────────────────────────────────

interface ChangeItem {
  /** Short description of the change, e.g. "Add MCP server entry to Cursor project config" */
  description: string;
  /** Optional detail value, e.g. the exact string being written */
  detail?: string;
  /** Optional preview element rendered below the detail line (e.g. a diff box) */
  preview?: React.JSX.Element;
}

interface SafetyInfo {
  dryRunAvailable: boolean;
  /**
   * When true, the dry-run flag is currently active (not just available).
   * Overrides dryRunAvailable for display: shows "active" instead of "available".
   * Call sites that pass `--dry-run` should set this to `true`.
   */
  dryRunActive?: boolean;
  requiresAwsWrite: boolean;
  createsPrOnly: boolean;
  /** Human-readable rollback instruction, e.g. "Remove generated block from .cursorrules" */
  rollback: string;
}

interface SafeWriteReviewProps {
  willChange: ChangeItem[];
  willNotChange: string[];
  /** Data sources used to generate the proposed change, e.g. ["scan 8bbd1846", "rule EC2_IDLE"] */
  dataUsed: string[];
  safety: SafetyInfo;
  onConfirm: () => void;
  onBack: () => void;
  /** When false, keyboard input is suppressed (e.g. during apply). */
  isActive?: boolean;
  /**
   * Operation mode. When 'virtual', AWS writes are never performed — the AWS write
   * row is forced to "no" regardless of `safety.requiresAwsWrite`, and the confirm
   * CTA is suppressed (only "b back" is shown).
   */
  mode?: 'virtual' | 'live';
  /**
   * When true, removes inner marginTop gaps between safety rows and the footer
   * margin to save 4 rows — use when willChange has ≥3 items to avoid Yoga
   * flex-shrink with a 25-row content area.
   */
  compact?: boolean;
}

// ─── Section header ────────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }): React.JSX.Element {
  return (
    <Box marginTop={GAP_BETWEEN_SECTIONS}>
      <Text bold color={colors.brand}>{label}</Text>
    </Box>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SafeWriteReview({
  willChange,
  willNotChange,
  dataUsed,
  safety,
  onConfirm,
  onBack,
  isActive = true,
  mode,
  compact = false,
}: SafeWriteReviewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  // Reserve extra chrome to avoid wrapping when parent adds indent/border.
  const safeWidth = getAvailableSafeWidth(termWidth, TUI.indent.content + 2, 0);
  const contentWidth = Math.max(20, safeWidth - 4);
  const detailWidth = Math.max(16, safeWidth - TUI.indent.detail - 2);
  const rollbackWidth = Math.max(16, safeWidth - TUI.indent.detail - 2);
  const safetyLabelWidth = 10;

  // In virtual mode Enter does nothing — only b/Esc to go back (no real write will occur)
  const isVirtual = mode === 'virtual';
  // Derive effective safety signals
  const effectiveAwsWrite = isVirtual ? false : safety.requiresAwsWrite;
  const isDryRunActive = safety.dryRunActive === true;

  useInput((input, key) => {
    if (!isVirtual && key.return) { onConfirm(); return; }
    if (input === 'b' || key.escape) { onBack(); return; }
  }, { isActive });

  return (
    <Box flexDirection="column" marginTop={GAP_AFTER_HEADER} marginLeft={MARGIN_LEFT_CONTENT} flexGrow={1}>
      {/* ── Header ── */}
      <Box gap={GAP_ROW}>
        <Text color={colors.warning}>{icons.warning}</Text>
        <Text bold color={colors.warning}>Review before applying</Text>
      </Box>

      {/* ── Will change ── */}
      <SectionLabel label="Will change" />
      {willChange.length === 0 ? (
        <Box marginLeft={TUI.indent.content}>
          <Text dimColor>Nothing will change.</Text>
        </Box>
      ) : (
        willChange.map((item, i) => (
          <Box key={i} marginLeft={TUI.indent.content} flexDirection="column">
            <Box gap={GAP_ROW}>
              <Text color={colors.warning}>{icons.bullet}</Text>
              <Text>{truncateWidth(item.description, contentWidth)}</Text>
            </Box>
            {item.detail !== undefined && (
              <Box marginLeft={TUI.indent.detail}>
                <Text dimColor>{truncateWidth(item.detail, detailWidth)}</Text>
              </Box>
            )}
            {item.preview !== undefined && (
              <Box marginLeft={TUI.indent.detail} marginTop={GAP_BETWEEN_SECTIONS}>
                {item.preview}
              </Box>
            )}
          </Box>
        ))
      )}

      {/* ── Will NOT change (hidden in compact — saves rows for small terminals) ── */}
      {!compact && willNotChange.length > 0 && (
        <>
          <SectionLabel label="Will not change" />
          {willNotChange.map((entry, i) => (
            <Box key={i} marginLeft={TUI.indent.content} gap={GAP_ICON_TEXT}>
              <Text color={colors.success}>{icons.checkmark}</Text>
              <Text dimColor>{truncateWidth(entry, contentWidth)}</Text>
            </Box>
          ))}
        </>
      )}

      {/* ── Data used (hidden in compact — saves rows for small terminals) ── */}
      {!compact && dataUsed.length > 0 && (
        <>
          <SectionLabel label="Data used" />
          <Box marginLeft={TUI.indent.content} flexDirection="column">
            {dataUsed.map((source, i) => (
              <Box key={i} gap={GAP_ROW}>
                <Text dimColor>{icons.bullet}</Text>
                <Text dimColor>{truncateWidth(source, contentWidth)}</Text>
              </Box>
            ))}
          </Box>
        </>
      )}

      {/* ── Safety ── */}
      <SectionLabel label="Safety" />
      <Box marginLeft={TUI.indent.content} flexDirection="column" gap={0}>
        <Box gap={GAP_ROW}>
          <Text dimColor>{padEndWidth('Dry-run:', safetyLabelWidth)}</Text>
          <Text color={isDryRunActive ? colors.success : safety.dryRunAvailable ? colors.success : colors.muted}>
            {isDryRunActive ? 'active' : safety.dryRunAvailable ? 'available' : 'not available'}
          </Text>
        </Box>
        <Box gap={GAP_ROW} {...(!compact && { marginTop: GAP_BETWEEN_SECTIONS })}>
          <Text dimColor>{padEndWidth('AWS write:', safetyLabelWidth)}</Text>
          <Text color={effectiveAwsWrite ? colors.warning : colors.success}>
            {effectiveAwsWrite ? 'yes' : 'no'}
          </Text>
        </Box>
        <Box gap={GAP_ROW} {...(!compact && { marginTop: GAP_BETWEEN_SECTIONS })}>
          <Text dimColor>{padEndWidth('PR only:', safetyLabelWidth)}</Text>
          <Text color={safety.createsPrOnly ? colors.success : colors.muted}>
            {safety.createsPrOnly ? 'yes' : 'no'}
          </Text>
        </Box>
        {/* Pre-truncate rollback text to available width — no wrap="wrap" */}
        <Box flexDirection="column" {...(!compact && { marginTop: GAP_BETWEEN_SECTIONS })}>
          <Text dimColor>{padEndWidth('Rollback:', safetyLabelWidth)}</Text>
          <Box marginLeft={TUI.indent.detail}>
            <Text>{truncateWidth(safety.rollback, rollbackWidth)}</Text>
          </Box>
        </Box>
      </Box>

      {/* Spacer pushes footer to bottom of ScreenShell content area */}
      <Box flexGrow={1} />

      {/* ── Footer hints (inside component, no external NavHints) ── */}
      {/* In virtual mode, no confirm CTA — only back */}
      <Box marginTop={compact ? 0 : GAP_BEFORE_ACTIONS} gap={GAP_ROW}>
        {!isVirtual && (
          <>
            <Text dimColor>
              <Text color={colors.warning}>Enter</Text> confirm
            </Text>
            <Text dimColor>{DOT_SEP}</Text>
          </>
        )}
        <Text dimColor>
          <Text color={colors.warning}>b</Text> back
        </Text>
        <Text dimColor>{DOT_SEP}</Text>
        <Text dimColor>
          <Text color={colors.warning}>q</Text> quit
        </Text>
      </Box>
    </Box>
  );
}
