/**
 * DirectPipeline — runs a fixed sequence of tool handlers without AI.
 *
 * This is the no-AI counterpart to AgentLoop. Instead of an LLM deciding
 * which tools to call, steps run in a predetermined order. The same tool
 * handler functions from src/tools/ are reused — no duplication.
 *
 * Used when `ai.provider` is set to `none` in the korinfra config.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import { ErrorBox } from './ErrorBox.js';
import { ResultViewport, type ResultBlock } from './ResultViewport.js';
import type { ActionHint, TuiAction } from '../actions.js';
import { ActionBar } from './ActionBar.js';
import { PipelineRunStatus } from './PipelineRunStatus.js';
import { GAP_BETWEEN_SECTIONS } from '../ui/spacing.js';
import { PipelineStatusSummary } from './PipelineStatusSummary.js';
import { TUI } from '../ui/tokens.js';
import { useTuiViewportLayout } from '../hooks/useTuiViewportLayout.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineContext {
  /** Named results from completed steps. Each step stores its parsed output here. */
  results: Map<string, unknown>;
  /** Called by a step mid-execution to show sub-status progress in the TUI. */
  setSubStatus?: (subStatus: string) => void;
  /**
   * Available viewport rows for result content.
   * Injected by DirectPipeline before calling renderResult so commands can
   * pass it to DataTable as pageSize to prevent Yoga from shrinking rows to 0.
   */
  viewportHeight?: number;
}

export interface PipelineStep {
  /** Human-readable label shown during execution (e.g. "Collecting AWS resources"). */
  name: string;
  /** Past-tense label shown after completion (e.g. "Collected AWS resources"). */
  completedName?: string;
  /** Unique key used to store this step's result in `context.results`. */
  key: string;
  /** Optional detail string derived from the step result (e.g. "9 services"). */
  getDetail?: (result: unknown) => string;
  /**
   * Runs the step. Receives the shared context so it can read prior results.
   * Should return the parsed result (not a ToolResult wrapper).
   */
  run: (context: PipelineContext) => Promise<unknown>;
}

/**
 * Richer result contract for pipeline commands.
 * Commands can return sticky actions and a next-text blurb separately from
 * the scrollable items, so they are never hidden below the fold.
 */
export interface CommandResultView {
  items: React.JSX.Element[];
  /** Sticky action bar shown below scrollable content. */
  actions?: ActionHint[];
  /**
   * Optional short text shown above the action bar.
   * Always rendered in TUI mode — both when an ActionBar is present and when
   * there are no actions. Helps users understand what to do next.
   *
   * Example: "Review the top recommendation, export a report, or ask AI."
   */
  nextText?: string;
}

interface DirectPipelineProps {
  steps: PipelineStep[];
  /** Renders the final output once all steps complete. */
  renderResult: (context: PipelineContext) => CommandResultView;
  onBack?: (() => void) | undefined;
  onRunAgain?: (() => void) | undefined;
  onAction?: ((action: TuiAction) => void) | undefined;
  /** Optional sticky action hints passed from the parent (alternative to renderResult.actions). */
  resultActions?: ActionHint[];
  /** When true, suppresses keyboard handlers (e.g. an overlay is active). */
  overlayActive?: boolean;
  /**
   * Called when a step completes (or the pipeline finishes all steps).
   * Receives the index of the completed step (0-based) and total step count.
   * Used by progress indicators that need to sync with actual pipeline progress.
   */
  onStepComplete?: (completedIndex: number, totalSteps: number) => void;
  /** Called once the pipeline finishes producing a result. */
  onResult?: () => void;
  /**
   * Called when the pipeline transitions into / out of an error state.
   * Parents must gate any external NavHints on this so ErrorBox owns the only
   * hint row when an error renders.
   */
  onError?: (isError: boolean) => void;
  /** Extra rows consumed by content rendered outside this component (e.g. StatusLine). */
  viewportRowsOffset?: number;
}

type StepState = 'pending' | 'running' | 'done' | 'error';

interface StepStatus {
  name: string;
  completedName?: string;
  state: StepState;
  error?: string;
  durationMs?: number;
  subStatus?: string;
  detail?: string;
}

type PipelineStatusType<T> =
  | { status: 'loading'; steps: StepStatus[] }
  | { status: 'error'; error: Error; steps: StepStatus[] }
  | { status: 'result'; data: T; steps: StepStatus[]; durationMs: number }
  | { status: 'empty'; reason: string; steps: StepStatus[] };

// Classify pipeline error by step and message
type PipelineErrorKind = 'aws' | 'db' | 'terraform' | 'pricing' | 'report' | 'generic';

interface PipelineErrorInfo {
  kind: PipelineErrorKind;
  hint: string;
  actions: ActionHint[];
}

function classifyPipelineError(stepName: string, message: string): PipelineErrorInfo {
  const lower = message.toLowerCase();
  const step = stepName.toLowerCase();

  if (step.includes('terraform') || lower.includes('terraform') || lower.includes('.tf') || lower.includes('hcl')) {
    return {
      kind: 'terraform',
      hint: 'Check your Terraform path and file syntax.',
      actions: [
        { key: 'd', label: 'run doctor', action: { type: 'navigate' as const, command: 'doctor' } },
        { key: 'c', label: 'config', action: { type: 'navigate' as const, command: 'config' } },
      ],
    };
  }

  if (step.includes('pricing') || lower.includes('pricing') || lower.includes('price list')) {
    return {
      kind: 'pricing',
      hint: 'Pricing cache may be incomplete. Try refreshing.',
      actions: [
        { key: 'p', label: 'open pricing', action: { type: 'navigate' as const, command: 'pricing' } },
        { key: 'd', label: 'run doctor', action: { type: 'navigate' as const, command: 'doctor' } },
      ],
    };
  }

  if (step.includes('report') || lower.includes('output path') || lower.includes('write') || lower.includes('permission denied')) {
    return {
      kind: 'report',
      hint: 'Check the output path is writable and within the project directory.',
      actions: [
        { key: 'r', label: 'retry', action: { type: 'run-again' as const } },
      ],
    };
  }

  if (
    (step.includes('db') || step.includes('sqlite') || step.includes('storage') || step.includes('save') || step.includes('saving') || lower.includes('sqlite') || lower.includes('database') || lower.includes('unique constraint') || lower.includes('constraint failed') || lower.includes('disk i/o error') || lower.includes('database is locked')) &&
    !(lower.includes('credentials') || lower.includes('accessdenied') || lower.includes('unauthorized') || lower.includes('noauthtoken') || lower.includes('expired') || lower.includes('reauthenticate'))
  ) {
    return {
      kind: 'db',
      hint: 'Local database error. Try running doctor.',
      actions: [
        { key: 'd', label: 'run doctor', action: { type: 'navigate' as const, command: 'doctor' } },
        { key: 'c', label: 'config', action: { type: 'navigate' as const, command: 'config' } },
      ],
    };
  }

  if (
    lower.includes('credentials') || lower.includes('accessdenied') || lower.includes('unauthorized') ||
    lower.includes('noauthtoken') || lower.includes('expired') || lower.includes('network') ||
    lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('timeout') ||
    step.includes('aws') || step.includes('collect') || step.includes('resources') || step.includes('costs')
  ) {
    return {
      kind: 'aws',
      hint: 'AWS credentials expired or access was denied.',
      actions: [
        { key: 'd', label: 'run doctor', action: { type: 'navigate' as const, command: 'doctor' } },
        { key: 'c', label: 'config', action: { type: 'navigate' as const, command: 'config' } },
      ],
    };
  }

  return {
    kind: 'generic',
    hint: 'Check your configuration and network connection.',
    actions: [
      { key: 'd', label: 'run doctor', action: { type: 'navigate' as const, command: 'doctor' } },
      { key: 'c', label: 'config', action: { type: 'navigate' as const, command: 'config' } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function elementBlock(key: string, element: React.JSX.Element, rows = 1): ResultBlock {
  return { key, rows, element };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DirectPipeline({
  steps,
  renderResult,
  onBack,
  onRunAgain,
  onAction,
  resultActions: resultActionsProp,
  onStepComplete,
  onResult,
  onError,
  overlayActive = false,
  viewportRowsOffset = 0,
}: DirectPipelineProps): React.JSX.Element {
  const { exit } = useApp();
  // Use viewport layout instead of fixed `rows - 8` offset
  const { contentRows } = useTuiViewportLayout({ header: 2, status: 2, actions: 2, hints: 2 });

  const [context] = useState<PipelineContext>(() => ({ results: new Map() }));
  const [pipelineState, setPipelineState] = useState<PipelineStatusType<void>>({
    status: 'loading',
    steps: steps.map((s): StepStatus => ({
      name: s.name,
      state: 'pending' as const,
      ...(s.completedName !== undefined ? { completedName: s.completedName } : {}),
    }))
  });

  // In result state, summary collapses to 1 line + marginBottom = 2 rows.
  // While running/errored: 1 summary + gap + N steps + marginBottom = steps + 3.
  const STATUS_SUMMARY_ROWS = pipelineState.status === 'result' ? 2 : steps.length + 3;
  // No outer TabbedResult wrapper → RESULT_BOX_CHROME = 0.
  const viewportHeight = Math.max(6, contentRows - STATUS_SUMMARY_ROWS - viewportRowsOffset);

  // Inject viewport height so commands can pass it to DataTable as pageSize.
  context.viewportHeight = viewportHeight;
  const rawResult: CommandResultView | null = pipelineState.status === 'result' ? renderResult(context) : null;
  const resultItems = rawResult?.items ?? [];
  const resultActions = rawResult?.actions ?? resultActionsProp;
  const resultNextText = rawResult?.nextText;
  const isRunning = pipelineState.status === 'loading';

  const isInteractive = pipelineState.status !== 'loading';

  const [disabledMsg, setDisabledMsg] = useState<string | null>(null);
  const disabledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleDisabledAction = (reason: string): void => {
    if (disabledTimerRef.current !== null) clearTimeout(disabledTimerRef.current);
    setDisabledMsg(reason);
    disabledTimerRef.current = setTimeout(() => setDisabledMsg(null), 2500);
  };

  // Notify parent on error state transitions so it can suppress its own NavHints.
  const isErrorState = pipelineState.status === 'error';
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    onErrorRef.current?.(isErrorState);
  }, [isErrorState]);

  // Navigation when running, done, or errored
  useInput((input, key) => {
    if (input === 'q') exit();
    if ((input === 'b' || key.escape)) {
      if (onBack) onBack();
      else exit();
      return;
    }
    if (isRunning) return;
    if (input === 'r' && onRunAgain) onRunAgain();
  }, { isActive: isInteractive && !overlayActive });

  useEffect(() => {
    let cancelled = false;
    const startMs = Date.now();

    async function runPipeline(): Promise<void> {
      for (let i = 0; i < steps.length; i++) {
        if (cancelled) return;
        const step = steps[i];
        if (!step) continue;
        const stepStart = Date.now();

        setPipelineState((prev) => {
          if (prev.status !== 'loading') return prev;
          return {
            status: 'loading',
            steps: prev.steps.map((s, idx) => (idx === i ? { ...s, state: 'running' as const } : s))
          };
        });

        context.setSubStatus = (subStatus: string) => {
          if (cancelled) return;
          setPipelineState((prev) => {
            if (prev.status !== 'loading') return prev;
            return {
              ...prev,
              steps: prev.steps.map((s, idx) => idx === i ? { ...s, subStatus } : s),
            };
          });
        };

        try {
          const result = await step.run(context);
          if (cancelled) return;
          context.results.set(step.key, result);

          const detail = step.getDetail?.(result);
          setPipelineState((prev) => {
            if (prev.status !== 'loading') return prev;
            return {
              status: 'loading',
              steps: prev.steps.map((s, idx) =>
                idx === i
                  ? { ...s, state: 'done' as const, durationMs: Date.now() - stepStart, ...(detail !== undefined ? { detail } : {}) }
                  : s
              )
            };
          });
          onStepComplete?.(i, steps.length);
        } catch (err: unknown) {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          // Audit line 926: truncate only inline step rows, pass full error to ErrorBox
          const displayError = message.slice(0, 120);

          setPipelineState((prev) => {
            if (prev.status !== 'loading') return prev;
            return {
              status: 'error',
              error: new Error(message),
              steps: prev.steps.map((s, idx) => (idx === i ? { ...s, state: 'error' as const, error: displayError, durationMs: Date.now() - stepStart } : s))
            };
          });
          return;
        }
      }

      if (!cancelled) {
        const elapsed = Date.now() - startMs;
        context.results.set('__pipelineDurationMs', elapsed);
        setPipelineState((prev) => {
          if (prev.status !== 'loading') return prev;
          return {
            status: 'result',
            data: undefined,
            steps: prev.steps,
            durationMs: elapsed
          };
        });
        onResult?.();
      }
    }

    void runPipeline();
    return () => { cancelled = true; };
  }, [steps, context, onResult, onStepComplete]);

  // Find the current running step index for collapsed view
  const allSteps = pipelineState.status !== 'empty' ? pipelineState.steps : [];
  const runningStepIdx = pipelineState.status === 'loading'
    ? allSteps.findIndex((s) => s.state === 'running')
    : -1;
  const completedCount = allSteps.filter((s) => s.state === 'done').length;
  const fatalError = pipelineState.status === 'error' ? pipelineState.error : null;
  const totalDurationMs = pipelineState.status === 'result' ? pipelineState.durationMs : 0;
  const errorStepIdx = pipelineState.status === 'error'
    ? allSteps.findIndex((s) => s.state === 'error')
    : -1;
  const errorStepName = errorStepIdx >= 0 ? allSteps[errorStepIdx]?.name : 'Unknown';

  return (
    <Box flexDirection="column">
      {/* Running — one compact progress surface instead of separate step/count rows */}
      {isRunning && pipelineState.status === 'loading' && (
        <PipelineRunStatus
          title="Collecting data"
          activeLabel={runningStepIdx >= 0 ? (allSteps[runningStepIdx]?.name ?? 'Processing') : 'Processing'}
          completed={completedCount}
          total={allSteps.length}
          {...(() => {
            const runningStep = pipelineState.steps.find(s => s.state === 'running');
            return runningStep?.subStatus !== undefined ? { subStatus: runningStep.subStatus } : {};
          })()}
        />
      )}

      {/* Done — collapsed single-line summary (steps visible during loading only) */}
      {pipelineState.status === 'result' && (
        <PipelineStatusSummary
          steps={allSteps.map((s) => ({
            label: s.completedName ?? s.name,
            status: s.state,
            ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
            ...(s.detail !== undefined ? { detail: s.detail } : {}),
          }))}
          totalDurationMs={totalDurationMs}
          showStepCount={false}
          collapsed={true}
        />
      )}



      {/* Fatal error — ErrorBox owns the hint row inside itself */}
      {pipelineState.status === 'error' && fatalError !== null && (() => {
        const errInfo = classifyPipelineError(errorStepName ?? '', fatalError.message);
        return (
          <ErrorBox
            title={`Could not complete: ${errorStepName}`}
            message={fatalError.message}
            hint={errInfo.hint}
            actions={[
              ...(onRunAgain !== undefined ? [{ key: 'r', label: 'retry', action: { type: 'run-again' as const } }] : []),
              ...errInfo.actions.filter((a) => !(onRunAgain !== undefined && a.key === 'r')),
            ]}
            onAction={onAction}
            onBack={onBack}
          />
        );
      })()}

      {/* Result */}
      {pipelineState.status === 'result' && (
        <Box flexDirection="column">
          {/* Small result: render items directly so DataTables get natural height.
               Large result: use ResultViewport for keyboard scrolling. */}
          {resultItems.length <= 5 ? (
            <Box flexDirection="column">
              {resultItems.map((el, i) => <Box key={`result-${i}`}>{el}</Box>)}
            </Box>
          ) : (
            <Box flexDirection="column" height={viewportHeight} overflow="hidden" flexShrink={0}>
              <ResultViewport
                blocks={resultItems.map((el, i) => elementBlock(`result-${i}`, el, 1))}
                viewportRows={viewportHeight}
                isActive={pipelineState.status === 'result' && !overlayActive}
              />
            </Box>
          )}

          {/* Always render nextText when present */}
          {resultNextText !== undefined && resultNextText.length > 0 && (
            <Box marginTop={GAP_BETWEEN_SECTIONS} marginLeft={TUI.indent.content}>
              <Text dimColor>{resultNextText}</Text>
            </Box>
          )}

          {/* Disabled-action feedback toast */}
          {disabledMsg !== null && (
            <Box marginLeft={TUI.indent.content}>
              <Text dimColor>✗ {disabledMsg}</Text>
            </Box>
          )}

          {/* Sticky action bar — rendered after nextText */}
          {resultActions !== undefined && resultActions.length > 0 && (
            <ActionBar
              actions={resultActions}
              onAction={onAction}
              onDisabledAction={handleDisabledAction}
              noGap
            />
          )}

    
        </Box>
      )}
    </Box>
  );
}
