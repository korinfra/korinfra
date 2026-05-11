/**
 * TabbedResult — a pure presentation component for tab-switched content panels.
 *
 * Key contract (enforced):
 * - Tab       → next tab
 * - Shift+Tab → previous tab
 * - NO '1', '2', or numeric key handlers (P0-1 audit fix)
 * - Does NOT capture Esc, q, or b — leave those to the parent
 */

import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import { colors, supportsUnicode } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, GAP_ROW, MARGIN_LEFT_RESULT } from '../ui/spacing.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Tab {
  id: string;
  /** Display label — no prefix numbers, e.g. "Data" not "[1] Data" */
  label: string;
}

interface TabbedResultProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  /**
   * Set to false to disable key handling when a modal/overlay is on top.
   * Defaults to true.
   */
  isActive?: boolean;
  /** Content for the currently active tab. */
  children: React.ReactNode;
  /** Optional status badge rendered inline at the right end of the tab strip. */
  statusBadge?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TabbedResult({
  tabs,
  activeTab,
  onTabChange,
  isActive = true,
  children,
  statusBadge,
}: TabbedResultProps): React.JSX.Element {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  useInput((_input, key) => {
    if (tabs.length < 2) return;

    const currentIdx = tabs.findIndex((t) => t.id === activeTab);
    const safeIdx = currentIdx === -1 ? 0 : currentIdx;

    // Shift+Tab — previous tab (check shift first)
    if (key.tab && key.shift) {
      const prevIdx = safeIdx === 0 ? tabs.length - 1 : safeIdx - 1;
      const prev = tabs[prevIdx];
      if (prev !== undefined) onTabChange(prev.id);
      return;
    }

    // Tab — next tab
    if (key.tab) {
      const nextIdx = safeIdx === tabs.length - 1 ? 0 : safeIdx + 1;
      const next = tabs[nextIdx];
      if (next !== undefined) onTabChange(next.id);
      return;
    }
  }, { isActive });

  const sepChar = supportsUnicode ? '─' : '-';
  const pipeChar = supportsUnicode ? '│' : '|';
  const MAX_SEP_WIDTH = 220;
  const sepWidth = Math.max(20, Math.min(termWidth - 4, MAX_SEP_WIDTH));

  return (
    <Box flexDirection="column">
      {/* Tab strip — tabs on left, optional status badge on right */}
      <Box gap={GAP_ROW} marginBottom={GAP_BETWEEN_SECTIONS}>
        {tabs.map((tab, idx) => {
          const isTabActive = tab.id === activeTab;
          return (
            <React.Fragment key={tab.id}>
              {idx > 0 && <Text dimColor> {pipeChar} </Text>}
              <Text
                bold={isTabActive}
                color={isTabActive ? colors.brand : undefined}
                dimColor={!isTabActive}
              >
                {isTabActive ? `[ ${tab.label} ]` : tab.label}
              </Text>
            </React.Fragment>
          );
        })}
        {statusBadge !== undefined && (
          <Box marginLeft={MARGIN_LEFT_RESULT}>
            {statusBadge}
          </Box>
        )}
      </Box>
      {/* Underline separator under tab strip */}
      <Box marginBottom={GAP_BETWEEN_SECTIONS}>
        <Text color={colors.brand} dimColor>{sepChar.repeat(sepWidth)}</Text>
      </Box>

      {/* Active tab content — key forces unmount/remount on tab switch to prevent render artifact bleed */}
      <Box key={activeTab}>
        {children}
      </Box>
    </Box>
  );
}
