/**
 * ToolCallCard — progressive disclosure for tool call results.
 *
 * Tool inputs/results use progressive disclosure.
 * Collapsed: one-line summary with input params and result summary.
 * Expanded: full input key/value block + full result text.
 *
 * Used by AgentLoop for the tool timeline.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

import { colors, icons, borders } from '../theme.js';
import { GAP_ROW, MARGIN_LEFT_CONTENT, MARGIN_LEFT_TOOL_DETAIL, PADDING_X, GAP_BETWEEN_SECTIONS } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';
import type { ToolCallCardRecord } from './toolCallFormat.js';
import { formatToolDuration } from './toolCallFormat.js';
import { redactObject } from '../../redaction/index.js';

interface ToolCallCardProps {
  call: ToolCallCardRecord;
  collapsed?: boolean;
  isSelected?: boolean;
  isExpanded?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isSensitiveToolInputKey(key: string): boolean {
  return /pass(word)?|secret|token|api[_-]?key|access[_-]?key|auth|credential|session|cookie|bearer|private[_-]?key|client[_-]?secret/i.test(key);
}

function summarizeToolInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input)
    .filter(([key, value]) => value !== undefined && value !== null && !isSensitiveToolInputKey(key));

  if (entries.length === 0) return '';

  const pairs = entries.slice(0, 2).map(([key, value]) => {
    const rendered = typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : Array.isArray(value)
          ? `[${value.length}]`
          : typeof value === 'object' && value !== null
            ? '{…}'
            : String((value as string | number | boolean | null | undefined) ?? '');
    const compact = rendered.replace(/\s+/g, ' ').trim();
    return `${key}=${compact.length > 28 ? compact.slice(0, 25) + '…' : compact}`;
  });

  const suffix = entries.length > 2 ? ` +${entries.length - 2}` : '';
  return `(${pairs.join(', ')}${suffix})`;
}

function summarizeToolResult(result: string | undefined, isError?: boolean): string {
  if (result === undefined) return '';
  const trimmed = result.trim();
  if (trimmed.length === 0) return '';

  let rendered = trimmed;

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        // Try to extract text content blocks first
        const texts = (parsed as Array<Record<string, unknown>>)
          .filter((block) => block['type'] === 'text' && typeof block['text'] === 'string')
          .map((block) => (block['text'] as string).trim())
          .filter(Boolean);
        if (texts.length > 0) {
          rendered = texts.join(' ').replace(/\s+/g, ' ').trim();
        } else {
          // Generic array — show item count instead of raw JSON
          rendered = `Array (${parsed.length} item${parsed.length !== 1 ? 's' : ''})`;
        }
      }
    } catch {
      // non-JSON array text — keep as-is
    }
  } else if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed['type'] === 'text' && typeof parsed['text'] === 'string') {
        rendered = (parsed['text']).replace(/\s+/g, ' ').trim();
      } else {
        // Generic object — show key names instead of raw JSON
        const keys = Object.keys(parsed);
        const keyList = keys.slice(0, 3).join(', ');
        const suffix = keys.length > 3 ? `, +${keys.length - 3}` : '';
        rendered = `Object (${keys.length} key${keys.length !== 1 ? 's' : ''}: ${keyList}${suffix})`;
      }
    } catch {
      // non-JSON object text — keep as-is
    }
  }

  const compact = rendered.replace(/\s+/g, ' ').trim();
  const limit = isError ? 140 : 180;
  return compact.length > limit ? compact.slice(0, limit - 1) + '…' : compact;
}

function formatToolNameForDisplay(name: string): string {
  const parts = name.split('__');
  const raw = parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join(' ') : name;
  const readable = raw.replace(/_/g, ' ');
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * ToolCallCard — progressive disclosure for tool calls.
 *
 * Collapsed (default):
 *   ✓ list_resources 1.3s
 *   Input: service=ec2 | region=us-east-1
 *   Result: 42 resources | 3 warnings
 *
 * Expanded (isExpanded=true):
 *   ┌─ list_resources ─────────────────────┐
 *   │ Input                                │
 *   │   service: ec2                       │
 *   │   region: us-east-1                  │
 *   │                                      │
 *   │ Result                               │
 *   │   42 resources                       │
 *   │   3 warnings                         │
 *   │                                      │
 *   │ c copy result · Enter close          │
 *   └──────────────────────────────────────┘
 */
export function ToolCallCard({
  call,
  collapsed = false,
  isSelected = false,
  isExpanded = false,
}: ToolCallCardProps): React.JSX.Element {
  // TC-2: input must be pre-redacted by caller (AgentLoop/agent provider) — see src/redaction/
  // Fallback redaction as safety net for any unredacted credentials/ARNs/IPs
  const safeInput = redactObject(call.toolInput ?? {}, 'strict') as Record<string, unknown>;
  const safeResult = redactObject(call.toolResult ?? '', 'strict') as string;

  const isRunning = call.endedAt === undefined;
  const isError = call.isError === true;
  const statusColor = isRunning ? colors.brand : isError ? colors.error : colors.success;
  const displayName = formatToolNameForDisplay(call.toolName);
  const inputSummary = summarizeToolInput(safeInput);
  const rawResult = safeResult;
  const resultSummary = rawResult && rawResult.trim().length > 0
    ? (isError ? summarizeToolResult(rawResult, true) : summarizeToolResult(rawResult, false))
    : '';

  // Expanded view: show full input/result in a bordered card
  if (isExpanded && !isRunning) {
    const inputEntries = Object.entries(safeInput)
      .filter(([key]) => !isSensitiveToolInputKey(key));

    return (
      <Box
        marginLeft={MARGIN_LEFT_CONTENT}
        flexDirection="column"
        borderStyle={borders.section}
        borderColor={colors.brand}
        paddingX={PADDING_X}
      >
        <Text bold color={colors.brand}>{displayName}</Text>

        {inputEntries.length > 0 && (
          <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
            <Text dimColor>Input</Text>
            {inputEntries.map(([key, value]) => {
              const rendered = typeof value === 'string'
                ? value
                : typeof value === 'number' || typeof value === 'boolean'
                  ? String(value)
                  : Array.isArray(value)
                    ? `${(value as unknown[]).length} items`
                    : JSON.stringify(value);
              return (
                <Box key={key} marginLeft={TUI.indent.content} gap={GAP_ROW}>
                  <Text dimColor>{key}:</Text>
                  <Text wrap="wrap">{String(rendered)}</Text>
                </Box>
              );
            })}
          </Box>
        )}

        {safeResult !== undefined && (
          <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
            <Text dimColor>Result</Text>
            <Box marginLeft={TUI.indent.content}>
              <Text color={isError ? colors.error : colors.success} wrap="wrap">
                {safeResult}
              </Text>
            </Box>
          </Box>
        )}

        <Box gap={GAP_ROW} marginTop={GAP_BETWEEN_SECTIONS} flexWrap="wrap">
          <Text dimColor><Text color={colors.warning}>c</Text> copy result</Text>
          <Text dimColor>{icons.dot}</Text>
          <Text dimColor><Text color={colors.warning}>Enter</Text> close</Text>
        </Box>
      </Box>
    );
  }

  // Collapsed / normal view
  return (
    <Box
      marginLeft={isSelected ? 0 : MARGIN_LEFT_CONTENT}
      flexDirection="column"
    >
      <Box gap={GAP_ROW}>
        {isSelected && <Text color={colors.brand}>{icons.pointer}</Text>}
        <Box width={TUI.table.selectionCol}>
          {isRunning ? (
            <Text color={colors.brand}><Spinner type="dots" /></Text>
          ) : (
            <Text color={statusColor}>{isError ? icons.error : icons.checkmark}</Text>
          )}
        </Box>
        <Box flexGrow={1}>
          <Text bold={isRunning} color={statusColor}>
            {displayName}{isRunning ? '…' : ''}
          </Text>
          {inputSummary !== '' && <Text dimColor> {inputSummary}</Text>}
        </Box>
        <Box marginLeft={MARGIN_LEFT_CONTENT}>
          <Text dimColor>{formatToolDuration(call.startedAt, call.endedAt)}</Text>
        </Box>
      </Box>
      {!collapsed && resultSummary !== '' && (
        <Box marginLeft={MARGIN_LEFT_TOOL_DETAIL}>
          <Text color={isError ? colors.error : colors.success}>
            {isError ? 'error' : 'result'}:
          </Text>
          <Text dimColor> {resultSummary}</Text>
        </Box>
      )}
    </Box>
  );
}
