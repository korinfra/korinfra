import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { TextInput } from '@inkjs/ui';
import { colors, icons, borders } from '../theme.js';
import { TITLE_COMMAND, PALETTE_PLACEHOLDER, DOT_SEP } from '../ui/text.js';
import { GAP_BETWEEN_SECTIONS, GAP_ROW, PADDING_X } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';
import { truncateWidth } from '../ui/width.js';
import { useInputMode } from '../hooks/useInputMode.js';
import { COMMAND_REGISTRY } from '../commandRegistry.js';
import type { CommandDef } from '../commandRegistry.js';
import { levenshtein } from '../../utils/string.js';

// ─── Visible commands: exclude hidden registry entries ────────────────────────

const PALETTE_COMMANDS: CommandDef[] = COMMAND_REGISTRY.filter((c) => !c.hidden);

const PALETTE_VIEWPORT = 14;

// ─── Filtering ────────────────────────────────────────────────────────────────

function matchesFilter(cmd: CommandDef, query: string): boolean {
  if (query === '') return true;
  const head = query.trim().split(/\s+/)[0] ?? '';
  const q = head.toLowerCase();
  if (q === '') return true;
  if (cmd.id.includes(q)) return true;
  if (cmd.label.toLowerCase().includes(q)) return true;
  if (cmd.description.toLowerCase().includes(q)) return true;
  if (cmd.aliases?.some((a) => a.includes(q))) return true;
  return false;
}


function suggestCommand(input: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const cmd of PALETTE_COMMANDS) {
    const d = levenshtein(input.toLowerCase(), cmd.id);
    if (d < bestDist && d <= 2) {
      bestDist = d;
      best = cmd.id;
    }
  }
  return best;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CommandPaletteOverlay({
  onCommandLine,
  onClose,
  initialQuery = '',
}: {
  onCommandLine: (line: string) => void;
  onClose: () => void;
  /** Pre-seed the input with chars typed before the overlay mounted. */
  initialQuery?: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState(initialQuery);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [inputSubmitted, setInputSubmitted] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const { setInputMode } = useInputMode();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  // Signal to app shell that a text field is active (prevents menu bleed)
  useEffect(() => {
    setInputMode('command-palette');
    return () => { setInputMode('none'); };
  }, [setInputMode]);

  const filtered = PALETTE_COMMANDS.filter((c) => matchesFilter(c, draft.trim()));

  // Reset selection when filter changes; clamp to valid range
  const prevDraft = useRef(draft);
  useEffect(() => {
    if (prevDraft.current !== draft) {
      prevDraft.current = draft;
      setSelectedIdx(0);
    }
  }, [draft]);

  const clampedIdx = Math.min(selectedIdx, Math.max(0, filtered.length - 1));

  // Viewport window
  const viewportStart = Math.max(0, clampedIdx - Math.floor(PALETTE_VIEWPORT / 2));
  const viewportEnd = Math.min(filtered.length, viewportStart + PALETTE_VIEWPORT);
  const visibleItems = filtered.slice(viewportStart, viewportEnd);
  const hasMore = filtered.length > PALETTE_VIEWPORT;

  const handleChange = useCallback((val: string) => {
    setDraft(val);
  }, []);

  // TextInput's onSubmit fires on Enter — execute the selected palette item
  const handleTextSubmit = useCallback((_value: string) => {
    if (inputSubmitted) return;
    setInputSubmitted(true);
    setInputMode('none');
    const selected = filtered[clampedIdx];
    if (selected !== undefined) {
      const trimmed = draft.trim();
      const argsTail = trimmed.includes(' ') ? trimmed.slice(trimmed.indexOf(' ')).trim() : '';
      onCommandLine(argsTail !== '' ? `${selected.id} ${argsTail}` : selected.id);
    } else if (draft.trim() !== '') {
      // No match — fall back to raw text (did-you-mean scenario)
      onCommandLine(draft.trim());
    } else {
      onClose();
    }
  }, [inputSubmitted, filtered, clampedIdx, draft, onCommandLine, onClose, setInputMode]);

  // Arrow keys and Escape for palette navigation (intercept before menu)
  useInput((input, key) => {
    if (key.escape) {
      setInputMode('none');
      onClose();
      return;
    }
    // X-1 rule: '?' is a reserved global navigation key (help). Never typed as a literal.
    if (input === '?') {
      return;
    }
    if (key.ctrl && input === 'u') {
      setDraft('');
      setInputKey((k) => k + 1);
      return;
    }
    if (key.upArrow) {
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
  }, { isActive: true });

  // Did-you-mean for empty filtered list
  const noMatchSuggestion = filtered.length === 0 && draft.trim() !== ''
    ? suggestCommand(draft.trim())
    : null;

  const innerWidth = Math.max(20, termWidth - 4);

  return (
    <Box flexDirection="column" gap={GAP_ROW}>
      <Box
        borderStyle={borders.card}
        borderColor={colors.brand}
        paddingX={PADDING_X}
        flexDirection="column"
      >
        <Text bold color={colors.brand}>{TITLE_COMMAND}</Text>
        <Text dimColor>Run any korinfra command.</Text>
        <Box marginTop={GAP_BETWEEN_SECTIONS}>
          <Text color={colors.brand}>{'› '}</Text>
          <TextInput
            key={inputKey}
            placeholder={PALETTE_PLACEHOLDER}
            onChange={handleChange}
            onSubmit={handleTextSubmit}
          />
        </Box>

        {/* Matching command list */}
        {filtered.length > 0 && (
          <Box marginTop={GAP_BETWEEN_SECTIONS} flexDirection="column" gap={0}>
            {visibleItems.map((cmd, relIdx) => {
              const absIdx = viewportStart + relIdx;
              const isSelected = absIdx === clampedIdx;
              const descWidth = Math.max(10, innerWidth - cmd.id.length - 4);
              return (
                <Box key={cmd.id} gap={GAP_ROW}>
                  <Text color={isSelected ? colors.brand : colors.muted}>
                    {isSelected ? icons.pointer : ' '}
                  </Text>
                  <Box width={14}>
                    <Text bold={isSelected} color={isSelected ? colors.highlight : undefined}>
                      {cmd.id}
                    </Text>
                  </Box>
                  <Text dimColor>{truncateWidth(cmd.description, descWidth)}</Text>
                </Box>
              );
            })}
            {hasMore && (
              <Box marginLeft={TUI.indent.content}>
                <Text dimColor>
                  … {filtered.length - PALETTE_VIEWPORT > 0
                    ? filtered.length - viewportEnd
                    : 0} more {DOT_SEP} {filtered.length} total
                </Text>
              </Box>
            )}
          </Box>
        )}

        {/* No matches */}
        {filtered.length === 0 && draft.trim() !== '' && (
          <Box marginTop={GAP_BETWEEN_SECTIONS}>
            {noMatchSuggestion !== null ? (
              <Text color={colors.warning}>
                Unknown command "{draft.trim()}". Did you mean "{noMatchSuggestion}"?
              </Text>
            ) : (
              <Text color={colors.warning}>No commands match "{draft.trim()}".</Text>
            )}
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Box marginLeft={TUI.indent.content} gap={GAP_ROW} flexWrap="wrap">
        <Text dimColor>
          <Text color={colors.warning}>↑↓</Text> navigate
          {DOT_SEP}
          <Text color={colors.warning}>Enter</Text> run
          {DOT_SEP}
          <Text color={colors.warning}>Backspace</Text> delete
          {DOT_SEP}
          <Text color={colors.warning}>Ctrl-U</Text> clear
          {DOT_SEP}
          <Text color={colors.warning}>Esc</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}
