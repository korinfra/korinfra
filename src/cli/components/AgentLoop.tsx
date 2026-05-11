import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';

declare global {

  var __korinfraAgentAbort: (() => void) | undefined;
}

import type { AgentEvent, AgentProvider, AgentQueryOptions } from '../../agent/types.js';
import { colors, icons } from '../theme.js';
import { formatCost, stripStructuredData, stripMarkdownForStream } from '../utils/format.js';
import { ThinkingSpinner } from './ThinkingSpinner.js';
import { StreamText } from './StreamText.js';
import { ResultPanel } from './ResultPanel.js';
import { ErrorBox } from './ErrorBox.js';
import { InteractionHints, buildInteractionHints, IH_QUIT, IH_CANCEL } from './InteractionHints.js';
import { ActionBar } from './ActionBar.js';
import { ToolCallCard } from './ToolCallCard.js';
import type { ToolCallCardRecord } from './toolCallFormat.js';
import { formatToolNameForStatus } from './ToolTimelineItem.js';
import { cleanErrorMessage, errorHint, errorActions } from './ErrorHandling.js';
import { INITIAL_STATE, handleEvent } from './AgentEventHandler.js';
import type { LoopState } from './AgentEventHandler.js';
import { useKeyboard } from '../hooks/useKeyboard.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';
import { allTools } from '../../tools/index.js';
import type { ToolDefinition } from '../../tools/index.js';
import type { ActionHint, TuiAction } from '../actions.js';
import { GAP_ICON_TEXT, GAP_ROW, GAP_BETWEEN_SECTIONS, MARGIN_LEFT_CONTENT, MARGIN_LEFT_RESULT, PADDING_X } from '../ui/spacing.js';
import { DOT_SEP } from '../ui/text.js';
import { useTuiViewportLayout } from '../hooks/useTuiViewportLayout.js';
import { FollowUpPanel } from './FollowUpPanel.js';
import type { Turn } from './FollowUpPanel.js';

interface AgentLoopProps {
  prompt: string;
  provider: AgentProvider;
  onRunAgain?: (() => void) | undefined;
  onBack?: (() => void) | undefined;
  /** Called with the final result text when the agent completes successfully. */
  onResult?: (result: string) => void;
  /** Called when the loop reaches any terminal state. */
  onFinished?: (status: 'result' | 'error' | 'aborted') => void;
  /** Extra query options forwarded to provider.query() */
  queryOptions?: Partial<AgentQueryOptions>;
  /** Tool subset to expose to the agent. Defaults to allTools if omitted. */
  tools?: ToolDefinition[];
  /**
   * Built-in Agent SDK tools to enable (Read, Glob, Grep, Edit, Write…).
   * Defaults to [] — no built-in tools. Pass ['Read','Glob','Grep','Edit','Write']
   * for commands that apply file patches.
   */
  builtinTools?: string[];
  /** When true, renders a follow-up input after the result is shown. */
  allowFollowUp?: boolean;
  onAction?: ((action: TuiAction) => void) | undefined;
  /** Command-specific title shown in result header instead of "Agent result". */
  resultTitle?: string;
  /** Command-specific sticky actions shown below result. */
  resultActions?: ActionHint[];
  /** Optional dataset fingerprint for FollowUpPanel context line. */
  datasetFingerprint?: string;
  /** Optional active groupBy/filter for FollowUpPanel context line. */
  viewContext?: string;
  /** When true, suppresses the internal "q quit / Esc abort" hints rendered while running. */
  suppressRunningHints?: boolean;
  /** Called with the tool name each time a tool call completes. */
  onToolUse?: (toolName: string) => void;
  /** Per-command AI spend cap in USD. Overrides the default AGENT_BUDGET_USD constant. */
  maxBudgetUsd?: number;
}

const AGENT_BUDGET_USD = 0.50;

/** Explicit focus state so tool timeline and result panel do not compete for arrow keys. */
type AgentFocus = 'tools' | 'result' | 'followup';

function ElapsedTimer(): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((p) => p + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <Text dimColor>{elapsed}s</Text>;
}

/**
 * Format duration for metadata display.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function AgentLoop({
  prompt,
  provider,
  onRunAgain,
  onBack,
  onResult,
  onFinished,
  tools,
  builtinTools,
  queryOptions,
  allowFollowUp = false,
  onAction,
  resultTitle,
  resultActions,
  datasetFingerprint,
  viewContext,
  suppressRunningHints = false,
  onToolUse,
  maxBudgetUsd,
}: AgentLoopProps): React.JSX.Element {
  const { exit } = useApp();
  const [state, setState] = useState<LoopState>(INITIAL_STATE);
  const abortRef = useRef<(() => void) | null>(null);
  const idCounterRef = useRef(0);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const queryOptionsRef = useRef(queryOptions);
  queryOptionsRef.current = queryOptions;
  const [followUpCounter, setFollowUpCounter] = useState(0);
  const [followUpPrompt, setFollowUpPrompt] = useState('');
  const followUpPromptRef = useRef('');
  followUpPromptRef.current = followUpPrompt;
  const [showAllSteps, setShowAllSteps] = useState(false);

  // Conversation history — preserved across follow-up turns (not reset on re-run)
  const [turnHistory, setTurnHistory] = useState<Turn[]>([]);
  const lastUserQuestionRef = useRef('');
  // Accumulated tool call count across all turns
  const accumulatedToolCallsRef = useRef(0);
  const accumulatedTurnsRef = useRef(0);

  const hasResult = state.result !== null && state.result.trim().length > 0;
  const terminalKeyboardActive = state.isRunning || (!allowFollowUp || !hasResult);

  // Explicit focus state (tools | result | followup)
  const [agentFocus, setAgentFocus] = useState<AgentFocus>('tools');
  // Store selected tool call ID (not visible index) for stable selection
  const [selectedToolCallId, setSelectedToolCallId] = useState<string | null>(null);
  const [expandedToolCallId, setExpandedToolCallId] = useState<string | null>(null);

  // Viewport layout available for result panel scroll
  useTuiViewportLayout({ header: 2, status: 4, actions: 2, hints: 2 });

  const { helpOpen, paletteOpen } = useGlobalOverlay();

  useInput((input, key) => {
    if (state.isRunning) {
      // Only respond to 's' if there are hidden steps to toggle
      if (input === 's' && completedToolCalls.length > 3) setShowAllSteps((v) => !v);
      return;
    }

    if (input === 'q') exit();
    // Only respond to 's' if there are hidden steps to toggle
    if (input === 's' && completedToolCalls.length > 3) setShowAllSteps((v) => !v);

    // Tab toggles focus between tools and result
    if (key.tab) {
      if (hasResult) {
        setAgentFocus((f) => f === 'tools' ? 'result' : 'tools');
        return;
      }
    }

    if (input === 'b' || key.escape) {
      if (expandedToolCallId !== null) { setExpandedToolCallId(null); return; }
      if (agentFocus === 'result' && hasResult) { setAgentFocus('tools'); return; }
      if (onBack !== undefined) onBack();
      else exit();
      return;
    }
    if (input === 'q') { exit(); return; }
    if (input === 'r' && onRunAgain) { onRunAgain(); return; }

    // Derive visible index from filtered list using IDs for stable selection
    const visibleCalls = showAllSteps ? completedToolCalls : completedToolCalls.slice(-3);
    const selectedVisibleIdx = selectedToolCallId !== null
      ? visibleCalls.findIndex((c) => c.id === selectedToolCallId)
      : -1;

    // Navigate tool timeline (only when focus is on tools)
    if (agentFocus === 'tools') {
      if (key.upArrow && visibleCalls.length > 0) {
        const nextIdx = selectedVisibleIdx <= 0 ? visibleCalls.length - 1 : selectedVisibleIdx - 1;
        setSelectedToolCallId(visibleCalls[nextIdx]?.id ?? null);
        return;
      }
      if (key.downArrow && visibleCalls.length > 0) {
        const nextIdx = selectedVisibleIdx < 0 ? 0 : Math.min(visibleCalls.length - 1, selectedVisibleIdx + 1);
        setSelectedToolCallId(visibleCalls[nextIdx]?.id ?? null);
        return;
      }
      if (key.return && selectedToolCallId !== null) {
        setExpandedToolCallId((id) => id === selectedToolCallId ? null : selectedToolCallId);
        return;
      }
      if (input === 'c' && selectedToolCallId !== null) {
        const call = visibleCalls.find((c) => c.id === selectedToolCallId);
        if (call !== undefined) onAction?.({ type: 'copy' as const, text: call.toolResult ?? '' });
        return;
      }
    }
  }, { isActive: terminalKeyboardActive && !helpOpen && !paletteOpen });

  const abort = useCallback(() => {
    if (abortRef.current) abortRef.current();
  }, []);

  useKeyboard({
    isDisabled: !state.isRunning || state.isAborting,
    onEscape: abort,
    onQuit: () => {
      abort();
      exit();
    },
    exitOnQ: true,
  });

  useEffect(() => {
    let unmounted = false;
    let aborted = false;
    let finished = false;
    const abortController = new AbortController();
    // Watchdog timer handle — cleared on every new event, fires if SDK hangs
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    const WATCHDOG_MS = 30_000;

    const emitFinished = (status: 'result' | 'error' | 'aborted'): void => {
      if (finished) return;
      finished = true;
      onFinishedRef.current?.(status);
    };

    const clearWatchdog = (): void => {
      if (watchdogTimer !== null) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    };

    const armWatchdog = (): void => {
      clearWatchdog();
      watchdogTimer = setTimeout(() => {
        if (unmounted || aborted || finished) return;
        // SDK generator appears stuck — force terminal state with a visible timeout error
        abortController.abort();
        provider.abort();
        setState((prev) => ({
          ...prev,
          isRunning: false,
          isThinking: false,
          isAborting: false,
          // Preserve any partial result; set error only if no result yet
          error: prev.result === null
            ? 'AI response timed out. Press Esc to go back.'
            : prev.error,
        }));
        emitFinished('error');
      }, WATCHDOG_MS);
    };

    abortRef.current = () => {
      if (aborted) return;
      aborted = true;
      clearWatchdog();
      abortController.abort();
      provider.abort();
      setState((prev) => ({
        ...prev,
        isAborting: true,
        isThinking: false,
      }));
    };

    globalThis.__korinfraAgentAbort = abortRef.current;

    setState({ ...INITIAL_STATE, isRunning: true, isThinking: true, startedAt: Date.now() });

    const effectivePrompt = followUpCounter > 0 ? followUpPromptRef.current : prompt;

    async function run(): Promise<void> {
      const startMs = Date.now();

      try {
        for await (const event of provider.query(effectivePrompt, {
          signal: abortController.signal,
          cwd: process.cwd(),
          tools: tools ?? allTools,
          builtinTools: builtinTools ?? [],
          maxTurns: 10,
          maxBudgetUsd: maxBudgetUsd ?? AGENT_BUDGET_USD,
          ...queryOptionsRef.current,
        })) {
          if (unmounted || aborted) break;
          // Clear any watchdog on each new event; arm one after tool_end isError:true
          clearWatchdog();
          if (event.type === 'tool_end' && event.isError) {
            armWatchdog();
          }
          handleEventLocal(event, startMs);
          if (event.type === 'result') {
            clearWatchdog();
            const cleaned = stripStructuredData(event.text);
            onResultRef.current?.(cleaned);

            // Record turn in history — preserved across follow-ups
            const isFollowUp = followUpCounter > 0;
            if (isFollowUp && lastUserQuestionRef.current.length > 0) {
              setTurnHistory((prev) => [
                ...prev,
                { question: lastUserQuestionRef.current, answer: cleaned, timestamp: Date.now() },
              ]);
            }

            emitFinished('result');
          } else if (event.type === 'error') {
            clearWatchdog();
            emitFinished('error');
          }
        }
      } catch (err: unknown) {
        clearWatchdog();
        if (!unmounted && !aborted) {
          setState((prev) => ({
            ...prev,
            error: cleanErrorMessage(err instanceof Error ? err.message : String(err)),
            isRunning: false,
            isThinking: false,
            isAborting: false,
          }));
          emitFinished('error');
        }
      } finally {
        clearWatchdog();
        if (!unmounted) {
          if (aborted) {
            setState((prev) => ({
              ...prev,
              isRunning: false,
              isThinking: false,
              isAborting: false,
              wasAborted: true,
            }));
            emitFinished('aborted');
          } else {
            setState((prev) => ({
              ...prev,
              isRunning: false,
              isThinking: false,
              isAborting: false,
            }));
          }
        }
      }
    }

    function handleEventLocal(event: AgentEvent, startMs: number): void {
      setState((prev) => handleEvent(event, prev, startMs, idCounterRef));
    }

    void run();

    return () => {
      unmounted = true;
      clearWatchdog();
      abortController.abort();
      provider.abort();
      if (globalThis.__korinfraAgentAbort === abortRef.current) {
        globalThis.__korinfraAgentAbort = undefined;
      }
      abortRef.current = null;
    };
  }, [prompt, provider, followUpCounter, builtinTools, maxBudgetUsd, tools]);

  const {
    completedToolCalls,
    activeToolCall,
    streamedText,
    isThinking,
    result,
    error,
    isRunning,
    isAborting,
    totalCostUsd,
    numTurns,
    durationMs,
  } = state;

  // Accumulate tool call count and turns across follow-up re-runs
  useEffect(() => {
    if (!isRunning && completedToolCalls.length > 0) {
      accumulatedToolCallsRef.current = completedToolCalls.length;
    }
    if (!isRunning && numTurns !== undefined && numTurns > 0) {
      accumulatedTurnsRef.current = (accumulatedTurnsRef.current || 0) + numTurns;
    }
  }, [isRunning, completedToolCalls.length, numTurns]);

  // Fire onToolUse whenever a new tool call completes
  const onToolUseRef = useRef(onToolUse);
  onToolUseRef.current = onToolUse;
  const prevToolCountRef = useRef(0);
  useEffect(() => {
    const newCount = completedToolCalls.length;
    if (newCount > prevToolCountRef.current && newCount > 0) {
      const lastTool = completedToolCalls[newCount - 1];
      if (lastTool) onToolUseRef.current?.(lastTool.toolName);
    }
    prevToolCountRef.current = newCount;
  }, [completedToolCalls]);

  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 60;

  // Show streaming text only before any tools run, or when producing final answer
  const showStream = isRunning && streamedText && (
    completedToolCalls.length === 0 ||
    (!isThinking && activeToolCall === null)
  );

  // During thinking/tool_call collapse tool timeline; during response collapse to summary
  const isInResponseStreaming = showStream && completedToolCalls.length > 0;

  // Group consecutive same-type tool calls for collapsing ≥4 group
  type ToolGroup = { type: 'single'; call: typeof completedToolCalls[0] } | { type: 'group'; toolName: string; count: number; startIdx: number; elapsed: number };

  function groupToolCalls(calls: typeof completedToolCalls): ToolGroup[] {
    const groups: ToolGroup[] = [];
    let i = 0;
    while (i < calls.length) {
      const current = calls[i];
      if (current === undefined) break;
      const baseToolType = current.toolName.split('__')[0]; // Extract tool family (e.g., 'mcp' from 'mcp__...')

      let j = i + 1;
      while (j < calls.length) {
        const next = calls[j];
        if (next === undefined) break;
        const nextToolType = next.toolName.split('__')[0];
        if (baseToolType !== nextToolType) break;
        j++;
      }

      const groupSize = j - i;
      if (groupSize >= 4) {
        // Collapse: compute elapsed time from first to last
        const firstCall = calls[i];
        const lastCall = calls[j - 1];
        if (firstCall !== undefined && lastCall !== undefined) {
          const elapsed = (lastCall.endedAt ?? Date.now()) - firstCall.startedAt;
          groups.push({ type: 'group', toolName: baseToolType ?? 'unknown', count: groupSize, startIdx: i, elapsed });
        }
      } else {
        // Show individually
        for (let k = i; k < j; k++) {
          const call = calls[k];
          if (call !== undefined) {
            groups.push({ type: 'single', call });
          }
        }
      }
      i = j;
    }
    return groups;
  }

  const visibleCalls = showAllSteps ? completedToolCalls : completedToolCalls.slice(-3);
  const toolCallGroups = groupToolCalls(visibleCalls);

  // Build follow-up prompt with full context
  function buildFollowUpPrompt(question: string): string {
    const historyLines: string[] = [];
    const recentTurns = turnHistory.slice(-3);
    for (const turn of recentTurns) {
      historyLines.push(`Q: ${turn.question}`);
      historyLines.push(`A: ${turn.answer.slice(0, 300)}`);
    }

    const parts: string[] = [];
    if (datasetFingerprint !== undefined) parts.push(`Dataset: ${datasetFingerprint}`);
    if (viewContext !== undefined) parts.push(`View: ${viewContext}`);

    const currentResult = result ?? '';
    if (currentResult.length > 0) {
      parts.push(`Prior result (truncated):\n${currentResult.replace(/<\/prior-result>/gi, '[…]').slice(0, 400)}`);
    }

    // Tool timeline summary
    if (accumulatedToolCallsRef.current > 0) {
      parts.push(`Tools used: ${accumulatedToolCallsRef.current} total across ${accumulatedTurnsRef.current > 0 ? accumulatedTurnsRef.current : 1} turn(s)`);
    }

    if (historyLines.length > 0) {
      parts.push(`Conversation history:\n${historyLines.join('\n')}`);
    }
    parts.push(`Follow-up: ${question.trim()}`);

    return parts.join('\n\n');
  }

  function handleFollowUpSubmit(question: string): void {
    if (!question.trim()) return;
    lastUserQuestionRef.current = question;
    const fullPrompt = buildFollowUpPrompt(question);
    setFollowUpPrompt(fullPrompt);
    setFollowUpCounter((c) => c + 1);
  }

  // Budget guard: show warning when approaching limit
  const effectiveBudget = maxBudgetUsd ?? AGENT_BUDGET_USD;
  const budgetPct = totalCostUsd !== undefined ? totalCostUsd / effectiveBudget : 0;
  const showBudgetWarning = budgetPct >= 0.8 && isRunning;

  return (
    <Box flexDirection="column">
      {/* During response streaming, collapse tool timeline to "✓ N tools used" */}
      {isInResponseStreaming && completedToolCalls.length > 0 ? (
        <Box marginLeft={MARGIN_LEFT_CONTENT}>
          <Text dimColor>
            <Text color={colors.success}>{icons.checkmark}</Text>
            {' '}{completedToolCalls.length} tool{completedToolCalls.length !== 1 ? 's' : ''} used
          </Text>
        </Box>
      ) : (
        <>
          {/* Tool timeline summary header */}
          {completedToolCalls.length > 0 && (
            <Box marginLeft={MARGIN_LEFT_CONTENT}>
              <Text dimColor>
                Tools used{DOT_SEP}{completedToolCalls.length} total{DOT_SEP}{visibleCalls.length} visible
              </Text>
            </Box>
          )}

          {/* Completed tool calls — show last 3, or all if expanded */}
          {completedToolCalls.length > 3 && !showAllSteps && (
            <Box marginLeft={MARGIN_LEFT_CONTENT}>
              <Text dimColor>
                … {completedToolCalls.length - 3} earlier step{completedToolCalls.length - 3 !== 1 ? 's' : ''}{DOT_SEP}<Text color={colors.warning}>s</Text> show all …
              </Text>
            </Box>
          )}
          {completedToolCalls.length > 3 && showAllSteps && (
            <Box marginLeft={MARGIN_LEFT_CONTENT}>
              <Text dimColor>
                … showing all steps{DOT_SEP}<Text color={colors.warning}>s</Text> hide earlier steps …
              </Text>
            </Box>
          )}
          {/* Render grouped or individual tool calls */}
          {toolCallGroups.map((group, idx) => (
            group.type === 'single' ? (
              <ToolCallCard
                key={`${group.call.id}-${idx}`}
                call={group.call as ToolCallCardRecord}
                isSelected={selectedToolCallId === group.call.id}
                isExpanded={expandedToolCallId === group.call.id}
              />
            ) : (
              <Box key={`group-${group.startIdx}`} marginLeft={MARGIN_LEFT_CONTENT}>
                <Text dimColor>
                  {icons.checkmark} Collected {group.count} {group.toolName} items [{(group.elapsed / 1000).toFixed(1)}s…]
                </Text>
              </Box>
            )
          ))}
        </>
      )}

      {/* Breathing room between completed tools and live area */}
      {completedToolCalls.length > 0 && isRunning && <Box marginBottom={GAP_BETWEEN_SECTIONS} />}

      {/* Live area */}
      <Box flexDirection="column">
        {/* During thinking/tool_call, collapse streaming preview to 1 line */}
        {isRunning && (
          <>
            {showStream && (
              <Box marginLeft={MARGIN_LEFT_RESULT}>
                <Text dimColor>
                  {/* 1-line preview during thinking; full stream during response */}
                  <StreamText
                    text={stripMarkdownForStream(streamedText)}
                    isStreaming={isRunning}
                    lineLimit={isThinking || activeToolCall !== null ? 1 : 6}
                  />
                </Text>
              </Box>
            )}
            {isAborting
              ? <Box gap={GAP_ROW}><Text color={colors.warning}><Spinner type="dots" /></Text><Text color={colors.warning}>Aborting…</Text></Box>
              : isThinking && activeToolCall === null && <ThinkingSpinner key="thinking-spinner" label="Thinking" />
            }
          </>
        )}

        {/* Active (in-flight) tool call */}
        {activeToolCall !== null && (
          <ToolCallCard call={activeToolCall} collapsed />
        )}

        {/* Budget warning */}
        {showBudgetWarning && (
          <Box marginTop={GAP_BETWEEN_SECTIONS} marginLeft={MARGIN_LEFT_CONTENT}>
            <Text color={colors.warning}>{icons.warning} Approaching budget limit ({Math.round(budgetPct * 100)}% of ${effectiveBudget})</Text>
          </Box>
        )}

        {/* Status bar while running — flex layout */}
        {isRunning && termCols >= 72 && (
          <Box marginTop={GAP_BETWEEN_SECTIONS} marginLeft={MARGIN_LEFT_CONTENT} paddingX={PADDING_X} flexWrap="wrap" gap={GAP_ROW}>
            {/* Status (abort/tool/thinking/starting) */}
            {isAborting ? (
              <Text color={colors.warning}>{icons.warning} Aborting…</Text>
            ) : activeToolCall !== null ? (
              <Text color={colors.brand}>
                {icons.running} {formatToolNameForStatus(activeToolCall.toolName)}
              </Text>
            ) : isThinking ? (
              <Text dimColor>{icons.running} Analyzing…</Text>
            ) : (
              <Text dimColor>{icons.pending} Starting…</Text>
            )}
            {/* Elapsed timer */}
            <ElapsedTimer />
            {/* Steps count */}
            {completedToolCalls.length > 0 && (
              <>
                <Text dimColor>{icons.dot}</Text>
                <Text dimColor>{completedToolCalls.length} step{completedToolCalls.length !== 1 ? 's' : ''}</Text>
              </>
            )}
            {/* Cost */}
            {totalCostUsd !== undefined && (
              <>
                <Text dimColor>{icons.dot}</Text>
                <Text color={colors.cost}>{totalCostUsd < 0.01 ? '<$0.01' : formatCost(totalCostUsd)}</Text>
              </>
            )}
          </Box>
        )}
        {isRunning && termCols < 72 && (
          <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS} marginLeft={MARGIN_LEFT_CONTENT} gap={0}>
            <Box gap={GAP_ROW}>
              {isAborting ? (
                <Text color={colors.warning}>{icons.warning} Aborting…</Text>
              ) : activeToolCall !== null ? (
                <Text color={colors.brand}>{icons.running} {formatToolNameForStatus(activeToolCall.toolName)}</Text>
              ) : isThinking ? (
                <Text dimColor>{icons.running} Analyzing…</Text>
              ) : (
                <Text dimColor>{icons.pending} Starting…</Text>
              )}
              <ElapsedTimer />
            </Box>
            <Box gap={GAP_ROW}>
              {completedToolCalls.length > 0 && (
                <Text dimColor>{completedToolCalls.length} step{completedToolCalls.length !== 1 ? 's' : ''}</Text>
              )}
              {totalCostUsd !== undefined && (
                <>
                  <Text dimColor>{icons.dot}</Text>
                  <Text color={colors.cost}>{totalCostUsd < 0.01 ? '<$0.01' : formatCost(totalCostUsd)}</Text>
                </>
              )}
            </Box>
          </Box>
        )}

        {isRunning && !suppressRunningHints && (
          <InteractionHints
            hints={[IH_QUIT, IH_CANCEL]}
          />
        )}

        {/* Errors */}
        {error !== null && (
          <ErrorBox
            message={error}
            hint={errorHint(error)}
            actions={errorActions(error, onRunAgain)}
            onAction={onAction}
            onBack={onBack}
            isActive={!isRunning}
          />
        )}

        {/* Result with command-specific title and sticky actions */}
        {result !== null && result.trim().length > 0 && !isRunning && error === null && (
          <>
            {(() => {
              const parts: string[] = [];
              if (numTurns !== undefined) parts.push(`${numTurns} turn${numTurns !== 1 ? 's' : ''}`);
              if (durationMs !== undefined) parts.push(formatDuration(durationMs));
              if (totalCostUsd !== undefined) parts.push(totalCostUsd < 0.01 ? '<$0.01' : formatCost(totalCostUsd));
              return (
                <ResultPanel
                  title={resultTitle}
                  result={result}
                  metadata={parts.length > 0 ? parts.join(` ${DOT_SEP} `) : undefined}
                  onRunAgain={onRunAgain}
                  onBack={onBack}
                  isActive={!allowFollowUp}
                />
              );
            })()}
            {/* Command-specific actions — domain actions in ActionBar */}
            {resultActions !== undefined && resultActions.length > 0 && (
              <ActionBar
                title="actions"
                actions={resultActions}
                onAction={onAction}
                marginLeft={MARGIN_LEFT_RESULT}
              />
            )}
            {/* Tool timeline navigation — show hints when tools exist */}
            {completedToolCalls.length > 0 && !allowFollowUp && (
              <>
                {selectedToolCallId !== null && (
                  <ActionBar
                    title="tools"
                    actions={[
                      { key: 'c', label: 'copy selected', action: { type: 'copy' as const, text: '' } },
                    ]}
                    onAction={(a) => {
                      if (a.type === 'copy' && selectedToolCallId !== null) {
                        const visibleCalls = showAllSteps ? completedToolCalls : completedToolCalls.slice(-3);
                        const call = visibleCalls.find((c) => c.id === selectedToolCallId);
                        onAction?.({ type: 'copy' as const, text: call?.toolResult ?? '' });
                      }
                    }}
                    marginLeft={MARGIN_LEFT_RESULT}
                  />
                )}
                <InteractionHints
                  hints={[
                    { key: '↑↓', label: 'select step' },
                    { key: 'Enter', label: 'expand step' },
                  ]}
                />
              </>
            )}
            {/* Follow-up via FollowUpPanel — replaces inline follow-up block */}
            {allowFollowUp && (
              <FollowUpPanel
                context={{
                  source: resultTitle ?? 'agent result',
                  scanId: datasetFingerprint,
                  grouping: viewContext,
                  dateRange: undefined,
                }}
                history={turnHistory}
                estimatedCost={totalCostUsd !== undefined && totalCostUsd > 0 ? totalCostUsd : undefined}
                isLoading={isRunning}
                onSubmit={handleFollowUpSubmit}
                onClose={() => { if (onBack !== undefined) onBack(); else exit(); }}
              />
            )}
          </>
        )}

        {/* Done without result */}
        {!isRunning && (result === null || result.trim().length === 0) && error === null && (
          <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
            {(() => {
              const elapsed = state.startedAt ? Date.now() - state.startedAt : 0;
              const abortLabel = state.wasAborted
                ? elapsed >= 290_000
                  ? 'Timed out (5 min limit). Try a more focused query.'
                  : 'Aborted.'
                : null;
              if (abortLabel !== null) {
                return <Text color={colors.warning}>{abortLabel}</Text>;
              }
              const stepCount = completedToolCalls.length;
              const lastTool = stepCount > 0 ? completedToolCalls[stepCount - 1] : null;
              const lastAction = lastTool && !lastTool.isError
                ? ` ${icons.dot} last: ${formatToolNameForStatus(lastTool.toolName).replace(/…$/, '')}`
                : '';
              return (
                <Box gap={GAP_ICON_TEXT}>
                  <Text color={colors.success}>{icons.success}</Text>
                  <Text dimColor>
                    Completed{stepCount > 0 ? ` ${icons.dot} ${stepCount} tool call${stepCount !== 1 ? 's' : ''}` : ''}{lastAction}
                  </Text>
                </Box>
              );
            })()}
            <Box marginTop={GAP_BETWEEN_SECTIONS}>
              <InteractionHints hints={buildInteractionHints({ onBack })} />
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );

}
