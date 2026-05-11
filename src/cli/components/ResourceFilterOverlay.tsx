/**
 * ResourceFilterOverlay — §5.2 filter modal for resources command.
 *
 * Provides filters for Type, Region, State, and Name (substring search).
 * Tab cycles through fields. Enter applies filters. Esc/b cancels.
 * `r` clears all filters (domain action, not in NavHints).
 *
 * Rules:
 *   VRHYTHM_RULE — spacing via GAP_* constants only
 *   DOT_SEP_RULE — DOT_SEP from ui/text.js
 *   ActionBar owns `r clear filters` (domain key, not navigation)
 *   NavHints: Tab, Esc/b, q only
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';

import { colors, icons, borders } from '../theme.js';
import { DOT_SEP } from '../ui/text.js';
import { GAP_BETWEEN_SECTIONS, GAP_ROW } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResourceFilterState {
  type: string;
  region: string;
  state: string;
  name: string;
}

interface ResourceFilterOverlayProps {
  availableTypes: string[];
  availableRegions: string[];
  availableStates: string[];
  onApply: (filters: ResourceFilterState) => void;
  onCancel: () => void;
  isActive?: boolean;
}

// ─── Helper: dropdown field ───────────────────────────────────────────────────

interface DropdownFieldProps {
  options: string[];
  value: string;
  isFocused: boolean;
  onChange: (val: string) => void;
}

function DropdownField({ options, value, isFocused, onChange }: DropdownFieldProps): React.JSX.Element {
  const currentIdx = options.indexOf(value);

  useInput(
    (_input, key) => {
      if (key.leftArrow || key.upArrow) {
        const prev = currentIdx <= 0 ? options.length - 1 : currentIdx - 1;
        onChange(options[prev] ?? '');
      }
      if (key.rightArrow || key.downArrow) {
        const next = currentIdx >= options.length - 1 ? 0 : currentIdx + 1;
        onChange(options[next] ?? '');
      }
    },
    { isActive: isFocused },
  );

  if (options.length === 0) {
    return <Text dimColor>(no options)</Text>;
  }

  const displayValue = value !== '' ? value : '—';
  return (
    <Text color={isFocused ? colors.focus : undefined}>
      [{displayValue} {isFocused ? '▼' : ''}]
    </Text>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export function ResourceFilterOverlay({
  availableTypes,
  availableRegions,
  availableStates,
  onApply,
  onCancel,
  isActive = true,
}: ResourceFilterOverlayProps): React.JSX.Element {
  const [filters, setFilters] = useState<ResourceFilterState>({
    type: '',
    region: '',
    state: '',
    name: '',
  });
  const [focusIdx, setFocusIdx] = useState(0);

  const fields = [
    { key: 'type', label: 'Type', type: 'select' as const, options: availableTypes },
    { key: 'region', label: 'Region', type: 'select' as const, options: availableRegions },
    { key: 'state', label: 'State', type: 'select' as const, options: availableStates },
    { key: 'name', label: 'Name', type: 'text' as const },
  ];

  const focusedField = fields[focusIdx];
  const isNameFieldFocused = focusedField?.key === 'name';

  const moveFocus = useCallback(
    (delta: number) => {
      setFocusIdx((i) => {
        const next = i + delta;
        if (next < 0) return fields.length - 1;
        if (next >= fields.length) return 0;
        return next;
      });
    },
    [fields.length],
  );

  const updateFilter = useCallback((key: string, val: string) => {
    setFilters((prev) => ({ ...prev, [key]: val }));
  }, []);

  const clearAllFilters = useCallback(() => {
    setFilters({ type: '', region: '', state: '', name: '' });
  }, []);

  // Overlay-level keyboard (non-text-field keys)
  useInput(
    (input, key) => {
      if (key.escape || input === 'b') {
        onCancel();
        return;
      }
      if (key.return) {
        onApply(filters);
        return;
      }
      if (key.tab && !key.shift) {
        moveFocus(1);
        return;
      }
      if (key.tab && key.shift) {
        moveFocus(-1);
        return;
      }
      // `r` clear all filters (domain key, not in NavHints)
      if (input === 'r') {
        clearAllFilters();
      }
    },
    { isActive: isActive && !isNameFieldFocused },
  );

  // Text-field-level keyboard
  useInput(
    (input, key) => {
      if (key.escape || input === 'b') {
        onCancel();
        return;
      }
      if (key.return) {
        onApply(filters);
        return;
      }
      if (key.tab && !key.shift) {
        moveFocus(1);
        return;
      }
      if (key.tab && key.shift) {
        moveFocus(-1);
        return;
      }
    },
    { isActive: isActive && isNameFieldFocused },
  );

  return (
    <Box flexDirection="column">
      {/* Centered box */}
      <Box
        borderStyle={borders.card}
        borderColor={colors.focus}
        paddingX={TUI.padding.boxX}
        paddingY={TUI.padding.boxY}
        flexDirection="column"
      >
        {/* Title */}
        <Box marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text bold color={colors.focus}>{icons.pointer} Filter resources</Text>
        </Box>

        {/* Field rows */}
        <Box flexDirection="column" gap={GAP_ROW}>
          {fields.map((field, idx) => {
            const isFocused = idx === focusIdx;
            const val = filters[field.key as keyof ResourceFilterState] ?? '';

            return (
              <Box key={field.key} flexDirection="row" gap={GAP_ROW}>
                {/* Label (fixed width) */}
                <Box width={10}>
                  <Text
                    color={isFocused ? colors.focus : undefined}
                    bold={isFocused}
                  >
                    {field.label}:
                  </Text>
                </Box>

                {/* Field value */}
                {field.type === 'text' && isFocused ? (
                  <TextInput
                    defaultValue={val}
                    placeholder="search by name"
                    onChange={(newVal) => updateFilter(field.key, newVal)}
                    onSubmit={() => onApply(filters)}
                  />
                ) : field.type === 'text' ? (
                  <Text dimColor>{val !== '' ? val : '(empty)'}</Text>
                ) : (
                  <DropdownField
                    options={field.options ?? []}
                    value={val}
                    isFocused={isFocused}
                    onChange={(newVal) => updateFilter(field.key, newVal)}
                  />
                )}
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* Footer: hints — directly below box border */}
      <Box>
        <Text dimColor>
          <Text color={colors.warning}>Enter</Text>{' apply'}
          {DOT_SEP}
          <Text color={colors.warning}>r</Text>{' clear filters'}
          {DOT_SEP}
          <Text color={colors.warning}>Tab</Text>{' next field'}
          {DOT_SEP}
          <Text color={colors.warning}>Esc</Text>{' cancel'}
          {DOT_SEP}
          <Text color={colors.warning}>q</Text>{' quit'}
        </Text>
      </Box>
    </Box>
  );
}
