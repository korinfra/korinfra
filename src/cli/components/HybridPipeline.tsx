/**
 * HybridPipeline — collect data via deterministic pipeline, then analyze with AI.
 *
 * Phase 1: Run PipelineSteps sequentially (same as DirectPipeline, no API calls).
 * Phase 2: Send collected data to AI in a single prompt (1 API call, no tools).
 * Phase 3: Display AI response in ResultPanel with follow-up support.
 *
 * Falls back to renderFallback() if the AI call fails — user still gets results.
 * Token savings: ~80% vs full AgentLoop (1 call instead of 5+).
 *
 * AI cache rules:
 * - Dataset fingerprint change → AI stale, explicit r to refresh
 * - View fingerprint change (groupBy/filter) → AI stale for view insights, NOT for dataset insights
 * - Sort change → NOT stale
 * - Tab switch / scroll → NOT stale
 * - Follow-up → adds to history, does NOT invalidate cache
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';

import type { AgentProvider, AgentEvent } from '../../agent/types.js';
import type { PipelineStep, PipelineContext, CommandResultView } from './DirectPipeline.js';
import { clearApiCallLog } from '../../aws/rate-limiter.js';
import { colors, icons, borders } from '../theme.js';
import { ResultViewport, type ResultBlock } from './ResultViewport.js';
import { StreamText } from './StreamText.js';
import { ResultPanel, renderMarkdown } from './ResultPanel.js';
import { ErrorBox } from './ErrorBox.js';
import { PipelineStatusSummary } from './PipelineStatusSummary.js';
import { PipelineRunStatus } from './PipelineRunStatus.js';
import { ActionBar } from './ActionBar.js';
import { FollowUpPanel } from './FollowUpPanel.js';
import type { Turn } from './FollowUpPanel.js';
import { TabbedResult } from './TabbedResult.js';
import { stripStructuredData, stripMarkdownForStream, sanitizeAgentText } from '../utils/format.js';
import type { ActionHint, TuiAction } from '../actions.js';
import { GAP_BETWEEN_SECTIONS, MARGIN_LEFT_CONTENT, PADDING_X, GAP_ROW } from '../ui/spacing.js';
import { TUI } from '../ui/tokens.js';
import { useTuiViewportLayout } from '../hooks/useTuiViewportLayout.js';
import { AICostConfirm } from './AICostConfirm.js';
import { useActiveOps } from '../hooks/useActiveOps.js';
import { useConfig } from '../hooks/useConfig.js';
import { categorizeError } from '../utils/errorCategory.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Scope of an AI insight: dataset-level or view-level (affected by groupBy/filters). */
type AiInsightScope = 'dataset' | 'view';

/** Status of AI in the current state — deterministic, derived from cache + pipeline state. */
export type AiStatus = 'ai-cached' | 'ai-stale' | 'ai-running' | 'ai-off' | 'ai-unavailable';

interface AiInsight {
  /** Fingerprint that was current when this insight was produced. */
  fingerprint: string;
  scope: AiInsightScope;
  result: string;
  createdAt: number;
  model?: string;
  estimatedCost?: number;
}

interface HybridPipelineProps {
  steps: PipelineStep[];
  provider: AgentProvider;
  /** Builds the user prompt from collected pipeline data for AI analysis. */
  buildAnalysisPrompt: (context: PipelineContext) => string;
  /** System prompt for the AI analysis phase. */
  systemPrompt: string;
  /** Structured result components shown above AI insights. */
  renderResult?: (context: PipelineContext) => CommandResultView;
  /** Fallback render if AI call fails (same output as DirectPipeline mode). */
  renderFallback: (context: PipelineContext) => CommandResultView;
  onRunAgain?: (() => void) | undefined;
  onBack?: (() => void) | undefined;
  /** Called with the final AI result text. */
  onResult?: ((result: string) => void) | undefined;
  /** When true, renders a follow-up input after the result is shown. */
  allowFollowUp?: boolean;
  onAction?: ((action: TuiAction) => void) | undefined;
  /** Optional sticky action hints shown below the structured result area. */
  resultActions?: ActionHint[];
  /**
   * Stable fingerprint for the dataset (e.g. days-based only).
   * AI re-runs ONLY when this changes or user explicitly refreshes.
   * When provided, AI does not re-run on viewFingerprint-only changes.
   */
  datasetFingerprint?: string;
  /**
   * View fingerprint including groupBy/filters (superset of datasetFingerprint).
   * Changing this marks the cached insight as stale for view-level analysis,
   * but does NOT automatically re-run AI.
   */
  viewFingerprint?: string;
  /**
   * Called when a phase-1 (deterministic) step completes, mirroring DirectPipeline.
   * Receives the 0-based index of the completed step and the total step count.
   * Also called with (steps.length, steps.length) when the pipeline hands off to AI.
   */
  onStepComplete?: (completedIndex: number, totalSteps: number) => void;
  /**
   * When true, the AI call does NOT start automatically after data collection.
   * Instead, the pipeline enters 'awaiting-activation' state and waits for the
   * user to switch to the AI tab before starting the AI call.
   * The per-scan AI result is cached in module-level storage so re-opens are free.
   */
  deferAi?: boolean;
  /**
   * Stable identifier for this dataset — used as the key in the module-level AI cache.
   * Required when deferAi is true. Typically the scan ID.
   */
  cacheKey?: string | undefined;
  /**
   * Estimated cost (USD) of the AI call, used for the confirmation gate.
   * When combined with confirmThresholds, shows a gate before the AI call starts.
   */
  aiEstimateCostUsd?: number;
  /**
   * Estimated duration (seconds) of the AI call.
   */
  aiEstimateSec?: number;
  /**
   * Thresholds for the confirmation gate.
   * Gate shows when estimate > threshold. Defaults: { usd: 0.01, sec: 10 }.
   */
  confirmThresholds?: { usd: number; sec: number };
  /** Label shown in the FollowUpPanel context line (e.g. 'cost data', 'security posture'). Defaults to 'AI analysis'. */
  followUpContextSource?: string;
  /** When true, disables this component's input handler so an overlay can own Esc. */
  overlayActive?: boolean;
  /**
   * Called when the pipeline enters / leaves an error state where ErrorBox
   * is rendered. Parents must gate any external NavHints on this. Note: 'fallback'
   * is NOT an error — it renders its own warning surface, not ErrorBox.
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

type HybridPipelineStatusType =
  | { status: 'collecting'; steps: StepStatus[]; streamedText: string; aiCostUsd: number; aiDurationMs: number; pipelineDurationMs: number }
  | { status: 'awaiting-activation'; steps: StepStatus[]; pipelineDurationMs: number }
  | { status: 'confirming'; steps: StepStatus[]; pipelineDurationMs: number }
  | { status: 'analyzing'; steps: StepStatus[]; streamedText: string; aiCostUsd: number; aiDurationMs: number; pipelineDurationMs: number }
  | { status: 'done'; steps: StepStatus[]; streamedText: string; aiResult: string; aiCostUsd: number; aiDurationMs: number; pipelineDurationMs: number; totalDurationMs: number }
  | { status: 'error'; steps: StepStatus[]; aiError: string; fallbackResult: CommandResultView; pipelineDurationMs: number; totalDurationMs: number }
  | { status: 'fallback'; steps: StepStatus[]; fallbackResult: CommandResultView; pipelineDurationMs: number; totalDurationMs: number }

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function formatTotalDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function elementBlock(key: string, element: React.JSX.Element, rows = 1): ResultBlock {
  return { key, rows, element };
}

// ---------------------------------------------------------------------------
// AI status derivation — pure function, exported for testing
// ---------------------------------------------------------------------------

export function deriveAiStatus(args: {
  status: HybridPipelineStatusType['status'];
  datasetFingerprint?: string;
  viewFingerprint?: string;
  aiInsightCache: Map<string, { fingerprint: string }>;
}): AiStatus {
  const { status, datasetFingerprint, viewFingerprint, aiInsightCache } = args;
  if (status === 'analyzing') return 'ai-running';
  if (status === 'awaiting-activation' || status === 'confirming') return 'ai-off';
  const fp = datasetFingerprint ?? viewFingerprint;
  if (fp === undefined) return 'ai-off';
  const cached = aiInsightCache.get(fp);
  if (cached !== undefined) {
    // Check if view changed while dataset stayed the same
    if (viewFingerprint !== undefined && fp === datasetFingerprint && viewFingerprint !== cached.fingerprint) {
      return 'ai-stale';
    }
    return 'ai-cached';
  }
  if (status === 'done') return 'ai-cached';
  if (status === 'fallback') return 'ai-unavailable';
  return 'ai-stale';
}

// ---------------------------------------------------------------------------
// AI status badge helper
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Module-level AI result cache — survives re-mounts of show <id> views
// ---------------------------------------------------------------------------

/** Per-scan AI result cache. Key: cacheKey prop (e.g. "scan-<id>"). */
const AI_RESULT_MODULE_CACHE = new Map<string, string>();

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function HybridPipeline({
  steps,
  provider,
  buildAnalysisPrompt,
  systemPrompt,
  renderResult,
  renderFallback,
  onRunAgain,
  onBack,
  onResult,
  allowFollowUp = false,
  onAction,
  resultActions: resultActionsProp,
  datasetFingerprint,
  viewFingerprint,
  onStepComplete,
  deferAi = false,
  cacheKey,
  aiEstimateCostUsd = 0,
  aiEstimateSec = 0,
  confirmThresholds,
  followUpContextSource = 'AI analysis',
  overlayActive = false,
  onError,
  viewportRowsOffset = 0,
}: HybridPipelineProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { contentRows } = useTuiViewportLayout({ header: 2, status: 2, actions: 2, hints: 2 });
  const { config } = useConfig();
  const effectiveConfirmThresholds = confirmThresholds ?? {
    usd: config?.ai.confirm_threshold_usd ?? 0.01,
    sec: config?.ai.confirm_threshold_sec ?? 10,
  };
  // Result/fallback box has border (2 rows) + header line (1 row) + marginBottom (1 row) = 4 rows chrome.
  // PipelineStatusSummary (1 row) + its marginBottom gap (1 row) = 2 rows above result box,
  // not accounted for by contentRows. Without this subtraction the result box overflows safeHeight by 2,
  // Yoga squeezes DataTable's separator Box to height=0, bleeding its chars onto the first data row.
  const RESULT_BOX_CHROME = 4;
  const STATUS_SUMMARY_ROWS = 2;
  const viewportHeight = Math.max(6, contentRows - RESULT_BOX_CHROME - STATUS_SUMMARY_ROWS - viewportRowsOffset);

  // Pipeline state
  const [context] = useState<PipelineContext>(() => ({ results: new Map() }));
  // Inject viewportHeight so renderResult/renderFallback functions can pass it to DataTable pageSize
  context.viewportHeight = viewportHeight;
  const [hybridState, setHybridState] = useState<HybridPipelineStatusType>({
    status: 'collecting',
    steps: steps.map((s) => {
      const step: Record<string, unknown> = { name: s.name, state: 'pending' as const };
      if (s.completedName !== undefined) step['completedName'] = s.completedName;
      return step;
    }) as unknown as StepStatus[],
    streamedText: '',
    aiCostUsd: 0,
    aiDurationMs: 0,
    pipelineDurationMs: 0,
  });

  // AI insight cache — keyed by fingerprint (dataset or view)
  const [aiInsightCache, setAiInsightCache] = useState<Map<string, AiInsight>>(new Map());

  // Follow-up state
  const [followUpCounter, setFollowUpCounter] = useState(0);
  const [followUpPrompt, setFollowUpPrompt] = useState('');
  const followUpPromptRef = useRef('');
  followUpPromptRef.current = followUpPrompt;

  // Conversation history for FollowUpPanel
  const [turnHistory, setTurnHistory] = useState<Turn[]>([]);
  const lastUserQuestionRef = useRef('');

  // Heuristic estimate computed after data collection — drives AICostConfirm display
  const [computedEstimate, setComputedEstimate] = useState<{ costUsd: number; durationSec: number }>({ costUsd: 0, durationSec: 0 });

  // Refs
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const onStepCompleteRef = useRef(onStepComplete);
  onStepCompleteRef.current = onStepComplete;

  // Stabilize callback/prop refs so Phase 1 doesn't re-run on view-only changes.
  // renderFallback can change reference when groupBy/filters change — using a ref
  // prevents those prop changes from re-triggering data collection.
  const renderFallbackRef = useRef(renderFallback);
  useEffect(() => { renderFallbackRef.current = renderFallback; });

  const buildAnalysisPromptRef = useRef(buildAnalysisPrompt);
  useEffect(() => { buildAnalysisPromptRef.current = buildAnalysisPrompt; });

  const systemPromptRef = useRef(systemPrompt);
  useEffect(() => { systemPromptRef.current = systemPrompt; });

  const confirmThresholdsRef = useRef(effectiveConfirmThresholds);
  useEffect(() => { confirmThresholdsRef.current = effectiveConfirmThresholds; });

  const isRunning = hybridState.status === 'collecting' || hybridState.status === 'analyzing';
  const isConfirming = hybridState.status === 'confirming';

  // Notify parent on ErrorBox-rendering state transitions. 'fallback' is
  // NOT an error (it renders its own warning surface, not ErrorBox).
  const isErrorState = hybridState.status === 'error';
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    onErrorRef.current?.(isErrorState);
  }, [isErrorState]);

  // Register with ActiveOpsContext while AI/collect is in flight so
  // the global 'q' handler can show a confirm prompt instead of hard-quitting.
  const { registerOp, unregisterOp } = useActiveOps();
  useEffect(() => {
    if (!isRunning) return;
    const id = registerOp('AI analysis');
    return () => { unregisterOp(id); };
  }, [isRunning, registerOp, unregisterOp]);

  // Scroll support for fallback/error mode
  const fallbackResult: CommandResultView | null =
    hybridState.status === 'fallback' ? renderFallback(context) :
    hybridState.status === 'error' ? hybridState.fallbackResult : null;
  const fallbackItems = fallbackResult?.items ?? [];
  const fallbackActions = fallbackResult?.actions;
  const hasFinalResult = hybridState.status === 'done' && hybridState.aiResult.trim().length > 0;

  // Input handling — single consolidated useInput for all non-follow-up states
  const terminalKeyboardActive = isRunning
    || hybridState.status === 'fallback'
    || hybridState.status === 'error'
    || hybridState.status === 'awaiting-activation'
    || (hybridState.status === 'done' && !allowFollowUp);

  useInput((input, key) => {
    if (input === 'q') exit();
    if (input === 'b' || key.escape) {
      clearApiCallLog();
      provider.abort();
      if (onBack !== undefined) onBack();
      else exit();
      return;
    }
    if (isRunning) return;
    if (input === 'r' && onRunAgain) onRunAgain();
  }, { isActive: terminalKeyboardActive && !overlayActive });

  // Phase 1: Run pipeline steps
  useEffect(() => {
    let cancelled = false;
    const startMs = Date.now();

    async function runPipeline(): Promise<void> {
      for (let i = 0; i < steps.length; i++) {
        if (cancelled) return;
        const step = steps[i];
        if (!step) continue;
        const stepStart = Date.now();

        setHybridState((prev) => {
          if (prev.status !== 'collecting') return prev;
          return {
            ...prev,
            steps: prev.steps.map((s, idx) => (idx === i ? { ...s, state: 'running' as const } : s))
          };
        });

        context.setSubStatus = (subStatus: string) => {
          if (cancelled) return;
          setHybridState((prev) => {
            if (prev.status !== 'collecting') return prev;
            return {
              ...prev,
              steps: prev.steps.map((s, idx) => (idx === i ? { ...s, subStatus } : s)),
            };
          });
        };

        try {
          const result = await step.run(context);
          if (cancelled) return;
          context.results.set(step.key, result);

          const detail = step.getDetail?.(result);
          setHybridState((prev) => {
            if (prev.status !== 'collecting') return prev;
            return {
              ...prev,
              steps: prev.steps.map((s, idx) =>
                idx === i
                  ? { ...s, state: 'done' as const, durationMs: Date.now() - stepStart, ...(detail !== undefined ? { detail } : {}) }
                  : s
              )
            };
          });
          onStepCompleteRef.current?.(i, steps.length);
        } catch (err: unknown) {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);

          setHybridState((prev) => {
            if (prev.status !== 'collecting') return prev;
            const items = renderFallbackRef.current(context);
            const elapsed = Date.now() - startMs;
            return {
              status: 'error',
              steps: prev.steps.map((s, idx) => (idx === i ? { ...s, state: 'error' as const, error: message.slice(0, 120), durationMs: Date.now() - stepStart } : s)),
              aiError: message.length > 200 ? message.slice(0, 197) + '...' : message,
              fallbackResult: items,
              pipelineDurationMs: elapsed,
              totalDurationMs: elapsed,
            };
          });
          return;
        }
      }

      if (!cancelled) {
        const elapsed = Date.now() - startMs;
        context.results.set('__pipelineDurationMs', elapsed);

        // Check module-level cache first (for deferAi mode)
        const moduleCached = cacheKey !== undefined ? AI_RESULT_MODULE_CACHE.get(cacheKey) : undefined;
        if (moduleCached !== undefined) {
          onStepCompleteRef.current?.(steps.length, steps.length);
          setHybridState((prev) => {
            if (prev.status !== 'collecting') return prev;
            return {
              status: 'done',
              steps: prev.steps,
              streamedText: '',
              aiResult: moduleCached,
              aiCostUsd: 0,
              aiDurationMs: 0,
              pipelineDurationMs: elapsed,
              totalDurationMs: elapsed,
            };
          });
          return;
        }

        // Check per-component AI insight cache
        const fp = datasetFingerprint ?? viewFingerprint;
        const cachedInsight = fp !== undefined ? aiInsightCache.get(fp) : undefined;

        if (cachedInsight !== undefined) {
          // Cache hit — skip AI call, go directly to done with cached result
          onStepCompleteRef.current?.(steps.length, steps.length);
          setHybridState((prev) => {
            if (prev.status !== 'collecting') return prev;
            return {
              status: 'done',
              steps: prev.steps,
              streamedText: '',
              aiResult: cachedInsight.result,
              aiCostUsd: cachedInsight.estimatedCost ?? 0,
              aiDurationMs: 0,
              pipelineDurationMs: elapsed,
              totalDurationMs: elapsed,
            };
          });
        } else if (deferAi) {
          // deferAi: wait for user to activate the AI tab before starting the call
          onStepCompleteRef.current?.(steps.length, steps.length);
          setHybridState((prev) => {
            if (prev.status !== 'collecting') return prev;
            return {
              status: 'awaiting-activation',
              steps: prev.steps,
              pipelineDurationMs: elapsed,
            };
          });
        } else {
          // Heuristic cost/time estimate from prompt byte count.
          // Computed after data collection so the prompt reflects actual payload size.
          // ~4 chars per token (UTF-8 average); Haiku input cost ~$1.00 / 1M tokens;
          // output assumed ~512 tokens at $5.00 / 1M tokens; ~0.3s per 1K input tokens.
          const promptBytes = buildAnalysisPromptRef.current(context).length;
          const systemBytes = systemPromptRef.current.length;
          const inputTokens = Math.ceil((promptBytes + systemBytes) / 4);
          const outputTokens = 512;
          const estimatedCostUsd =
            (inputTokens / 1_000_000) * 1.0 + (outputTokens / 1_000_000) * 5.0;
          const estimatedSec = Math.ceil((inputTokens / 1000) * 0.3) + 3; // +3s overhead
          const effectiveCostUsd = aiEstimateCostUsd > 0 ? aiEstimateCostUsd : estimatedCostUsd;
          const effectiveSec = aiEstimateSec > 0 ? aiEstimateSec : estimatedSec;
          setComputedEstimate({ costUsd: effectiveCostUsd, durationSec: effectiveSec });

          // Check confirmation gate threshold
          const needsConfirm =
            effectiveCostUsd > confirmThresholdsRef.current.usd ||
            effectiveSec > confirmThresholdsRef.current.sec;

          if (needsConfirm) {
            onStepCompleteRef.current?.(steps.length, steps.length);
            setHybridState((prev) => {
              if (prev.status !== 'collecting') return prev;
              return {
                status: 'confirming',
                steps: prev.steps,
                pipelineDurationMs: elapsed,
              };
            });
          } else {
            // Signal AI handoff — all data-collection steps done, AI phase beginning
            onStepCompleteRef.current?.(steps.length, steps.length);
            setHybridState((prev) => {
              if (prev.status !== 'collecting') return prev;
              return {
                status: 'analyzing',
                steps: prev.steps,
                streamedText: '',
                aiCostUsd: 0,
                aiDurationMs: 0,
                pipelineDurationMs: elapsed,
              };
            });
          }
        }
      }
    }

    void runPipeline();
    return () => { cancelled = true; };
  // viewFingerprint intentionally excluded: view-only changes (groupBy/filters) must NOT
  // re-run data collection. renderFallback/buildAnalysisPrompt/systemPrompt/confirmThresholds
  // are accessed via refs so they don't gate collection re-runs.
  }, [steps, context, datasetFingerprint, aiInsightCache, aiEstimateCostUsd, aiEstimateSec, cacheKey, deferAi, viewFingerprint]);

  // Phase 2: AI analysis (triggered when status changes to 'analyzing')
  useEffect(() => {
    if (hybridState.status !== 'analyzing') return;
    let cancelled = false;
    const analysisStart = Date.now();
    const pipelineDurationMs = hybridState.pipelineDurationMs;

    async function runAnalysis(): Promise<void> {
      const isFollowUp = followUpCounter > 0;
      const prompt = isFollowUp
        ? followUpPromptRef.current
        : buildAnalysisPrompt(context);

      try {
        for await (const event of provider.query(prompt, {
          systemPrompt,
          tools: [],
          builtinTools: [],
          maxTurns: 1,
          maxBudgetUsd: config?.ai.max_budget_usd ?? 0.25,
          cwd: process.cwd(),
        })) {
          if (cancelled) break;
          handleAnalysisEvent(event, analysisStart);
        }
      } catch {
        if (cancelled) return;
        // AI failed — fall back to deterministic output
        const items = renderFallbackRef.current(context);
        setHybridState((prev) => {
          if (prev.status !== 'analyzing') return prev;
          return {
            status: 'fallback',
            steps: prev.steps,
            fallbackResult: items,
            pipelineDurationMs,
            totalDurationMs: pipelineDurationMs + (Date.now() - analysisStart),
          };
        });
      }
    }

    function handleAnalysisEvent(event: AgentEvent, startMs: number): void {
      switch (event.type) {
        case 'text':
          setHybridState((prev) => {
            if (prev.status !== 'analyzing') return prev;
            return {
              ...prev,
              streamedText: prev.streamedText + sanitizeAgentText(event.text),
            };
          });
          break;
        case 'result': {
          const cleaned = stripStructuredData(sanitizeAgentText(event.text));
          const isFollowUp = followUpCounter > 0;
          const fp = datasetFingerprint ?? viewFingerprint;

          // Store in AI insight cache — only on initial analysis, not follow-up answers
          if (fp !== undefined && !isFollowUp) {
            const insight: AiInsight = {
              fingerprint: viewFingerprint ?? fp,
              scope: viewFingerprint !== undefined ? 'view' : 'dataset',
              result: cleaned,
              createdAt: Date.now(),
              estimatedCost: event.costUsd,
            };
            setAiInsightCache((prev) => {
              const next = new Map(prev);
              next.set(fp, insight);
              return next;
            });
          }
          // Store in module-level cache for deferAi re-open persistence
          if (cacheKey !== undefined && !isFollowUp) {
            AI_RESULT_MODULE_CACHE.set(cacheKey, cleaned);
          }

          setHybridState((prev) => {
            if (prev.status !== 'analyzing') return prev;
            return {
              status: 'done',
              steps: prev.steps,
              streamedText: prev.streamedText,
              aiResult: cleaned,
              aiCostUsd: event.costUsd,
              aiDurationMs: event.durationMs,
              pipelineDurationMs: pipelineDurationMs,
              totalDurationMs: pipelineDurationMs + event.durationMs,
            };
          });

          // Record turn for follow-up history
          if (isFollowUp && lastUserQuestionRef.current.length > 0) {
            setTurnHistory((prev) => [
              ...prev,
              { question: lastUserQuestionRef.current, answer: cleaned, timestamp: Date.now() },
            ]);
          }

          onResultRef.current?.(cleaned);
          break;
        }
        case 'error': {
          // AI error — fall back to deterministic output
          const items = renderFallbackRef.current(context);
          setHybridState((prev) => {
            if (prev.status !== 'analyzing') return prev;
            return {
              status: 'fallback',
              steps: prev.steps,
              fallbackResult: items,
              pipelineDurationMs,
              totalDurationMs: pipelineDurationMs + (Date.now() - startMs),
            };
          });
          break;
        }
        case 'cost_update':
          setHybridState((prev) => {
            if (prev.status !== 'analyzing') return prev;
            return {
              ...prev,
              aiCostUsd: event.totalCostUsd,
            };
          });
          break;
        case 'thinking':
        case 'tool_start':
        case 'tool_end':
          // These events are not used in HybridPipeline; silently ignore
          break;
        default:
          break;
      }
    }

    void runAnalysis();
    return () => {
      cancelled = true;
      provider.abort();
    };
  // buildAnalysisPrompt/systemPrompt/renderFallback accessed via refs — excluded intentionally.
  }, [hybridState.status, hybridState.pipelineDurationMs, provider, context, followUpCounter, datasetFingerprint, viewFingerprint, buildAnalysisPrompt, cacheKey, config?.ai.max_budget_usd, systemPrompt]);

  // Tab state — switched via Tab/Shift+Tab in TabbedResult
  const [activeTab, setActiveTab] = useState<'data' | 'ai'>('data');

  // When deferAi is true, activating the AI tab triggers the AI call
  function handleTabChange(id: string): void {
    const newTab = id as 'data' | 'ai';
    setActiveTab(newTab);
    if (newTab === 'ai' && hybridState.status === 'awaiting-activation') {
      const pipelineDurationMs = hybridState.pipelineDurationMs;
      setHybridState((prev) => {
        if (prev.status !== 'awaiting-activation') return prev;
        return {
          status: 'analyzing',
          steps: prev.steps,
          streamedText: '',
          aiCostUsd: 0,
          aiDurationMs: 0,
          pipelineDurationMs,
        };
      });
    }
  }

  // Build combined items for done or awaiting-activation phase: structured data + AI insights
  const termCols = stdout?.columns ?? 100;
  const rawStructuredResult: CommandResultView | null =
    ((hybridState.status === 'done' || hybridState.status === 'awaiting-activation') && renderResult) ? renderResult(context) : null;
  const structuredItems = rawStructuredResult?.items ?? [];
  const resultActions = rawStructuredResult?.actions ?? resultActionsProp;
  const resultNextText = rawStructuredResult?.nextText;
  const aiMdElements = (hybridState.status === 'done') ? renderMarkdown(hybridState.aiResult, termCols) : [];
  // awaiting-activation: show a hint in the AI tab instead of empty
  const awaitingAiHint: React.JSX.Element[] = hybridState.status === 'awaiting-activation'
    ? [<Text key="await-hint" dimColor>Tab here to run AI analysis...</Text>]
    : [];

  // Scroll for done phase (awaiting-activation: show hint in AI tab)
  const doneItems = activeTab === 'data'
    ? structuredItems
    : hybridState.status === 'awaiting-activation'
      ? awaitingAiHint
      : aiMdElements;

  // Running step index for collapsed view
  const runningStepIdx = hybridState.status === 'collecting' || hybridState.status === 'analyzing'
    ? hybridState.steps.findIndex((s) => s.state === 'running')
    : -1;
  const completedCount = hybridState.steps.filter((s) => s.state === 'done').length;
  const hybridTotalPhases = hybridState.steps.length + 1;
  const hybridCompletedPhases = hybridState.status === 'analyzing'
    ? completedCount
    : Math.min(completedCount, hybridTotalPhases);
  const runningLabel = hybridState.status === 'analyzing'
    ? 'AI analysis'
    : runningStepIdx >= 0
      ? (hybridState.steps[runningStepIdx]?.name ?? 'Collecting data')
      : 'Collecting data';

  // Tab switching is handled by TabbedResult component via Tab/Shift+Tab
  // Also active during awaiting-activation (deferAi: show Data tab before AI starts)
  const doneInlineActive = (hybridState.status === 'done' || hybridState.status === 'awaiting-activation') && renderResult !== undefined;

  // ---------------------------------------------------------------------------
  // FollowUpPanel submit handler — builds context-rich prompt
  // ---------------------------------------------------------------------------

  function handleFollowUpSubmit(question: string): void {
    if (!question.trim()) return;

    lastUserQuestionRef.current = question;

    // Build full context prompt: last 3 turns + current question
    const historyLines: string[] = [];
    const recentTurns = turnHistory.slice(-3);
    for (const turn of recentTurns) {
      historyLines.push(`Q: ${turn.question}`);
      historyLines.push(`A: ${turn.answer.slice(0, 300)}`);
    }

    const dataContext = datasetFingerprint !== undefined
      ? `Dataset: ${datasetFingerprint}`
      : '';
    const viewContext = viewFingerprint !== undefined
      ? `View: ${viewFingerprint}`
      : '';

    const currentResultContext = hybridState.status === 'done'
      ? hybridState.aiResult.replace(/<\/prior-result>/gi, '[…]').slice(0, 400)
      : '';

    const parts: string[] = [];
    if (dataContext.length > 0) parts.push(dataContext);
    if (viewContext.length > 0) parts.push(viewContext);
    // Include the original analysis prompt (which carries the full cost data
    // summary built from context.results) so the AI keeps full data context across turns.
    try {
      const originalDataPrompt = buildAnalysisPromptRef.current(context);
      if (originalDataPrompt.length > 0) {
        parts.push(`Original data context:\n${originalDataPrompt}`);
      }
    } catch {
      // Ignore — fall back to fingerprints only
    }
    if (currentResultContext.length > 0) {
      parts.push(`Prior analysis (truncated):\n${currentResultContext}`);
    }
    if (historyLines.length > 0) {
      parts.push(`Conversation history:\n${historyLines.join('\n')}`);
    }
    parts.push(`Follow-up: ${question.trim()}`);

    const fullPrompt = parts.join('\n\n');
    setFollowUpPrompt(fullPrompt);
    setFollowUpCounter((c) => c + 1);

    // Transition to analyzing for follow-up
    setHybridState((prev) => {
      if (prev.status !== 'done') return prev;
      return {
        status: 'analyzing',
        steps: prev.steps,
        streamedText: '',
        aiCostUsd: 0,
        aiDurationMs: 0,
        pipelineDurationMs: prev.pipelineDurationMs,
      };
    });
  }

  return (
    <Box flexDirection="column">
      {/* Running — one compact progress surface instead of duplicate step/count/spinner rows */}
      {isRunning && (
        <PipelineRunStatus
          title={hybridState.status === 'collecting' ? 'Collecting data' : 'Analyzing with AI'}
          activeLabel={runningLabel}
          completed={hybridCompletedPhases}
          total={hybridTotalPhases}
          unitLabel="phases"
          {...(hybridState.status === 'collecting' && hybridState.steps.find(s => s.state === 'running')?.subStatus !== undefined
            ? { subStatus: hybridState.steps.find(s => s.state === 'running')?.subStatus }
            : {})}
        />
      )}

      {/* Done step summary using PipelineStatusSummary — audit 973-996 */}
      {/* Suppressed during fallback: the yellow warning line inside the bordered box is the sole status indicator */}
      {!isRunning && !isConfirming && hybridState.status !== 'error' && hybridState.status !== 'fallback' && (
        <PipelineStatusSummary
          steps={[
            ...hybridState.steps.map((s) => ({
              label: s.name,
              status: s.state,
              ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
              ...(s.detail !== undefined ? { detail: s.detail } : {}),
            })),
            (() => {
              const st = hybridState.status;
              if (st === 'done') return { label: 'AI analysis', status: 'done' as const, durationMs: (hybridState as { aiDurationMs: number }).aiDurationMs };
              if (st === 'awaiting-activation' || st === 'confirming') return { label: 'AI analysis', status: 'pending' as const };
              return { label: 'AI analysis', status: 'error' as const };
            })(),
          ]}
          totalDurationMs={(hybridState.status === 'done') ? hybridState.totalDurationMs : 0}
          {...(hybridState.status === 'done' ? { totalCostUsd: hybridState.aiCostUsd } : {})}
          showStepCount={false}
          collapsed={true}
        />
      )}

      {/* Phase 2: AI streaming preview — collapse to 1 line during thinking/tool_call */}
      {hybridState.status === 'analyzing' && hybridState.streamedText.length > 0 && (
        <Box marginLeft={TUI.indent.content} marginBottom={GAP_BETWEEN_SECTIONS}>
          <StreamText
            text={stripMarkdownForStream(hybridState.streamedText)}
            dimColor
            isStreaming
            lineLimit={1}
          />
        </Box>
      )}

      {/* Confirmation gate — shown when cost/time estimate exceeds threshold */}
      {isConfirming && (
        <AICostConfirm
          estimate={computedEstimate}
          isActive
          onConfirm={() => {
            setHybridState((prev) => {
              if (prev.status !== 'confirming') return prev;
              return {
                status: 'analyzing',
                steps: prev.steps,
                streamedText: '',
                aiCostUsd: 0,
                aiDurationMs: 0,
                pipelineDurationMs: prev.pipelineDurationMs,
              };
            });
          }}
          onCancel={() => {
            setHybridState((prev) => {
              if (prev.status !== 'confirming') return prev;
              const items = renderFallback(context);
              return {
                status: 'fallback',
                steps: prev.steps,
                fallbackResult: items,
                pipelineDurationMs: prev.pipelineDurationMs,
                totalDurationMs: prev.pipelineDurationMs,
              };
            });
          }}
        />
      )}

      {/* Pipeline error — ErrorBox owns hints inside itself */}
      {hybridState.status === 'error' && (
        <ErrorBox
          message={hybridState.aiError}
          hint={categorizeError(hybridState.aiError).hint}
          actions={[
            ...(onRunAgain !== undefined ? [{ key: 'r', label: 'retry', action: { type: 'run-again' as const } }] : []),
            { key: 'd', label: 'run doctor', action: { type: 'navigate' as const, command: 'doctor' } },
          ]}
          onAction={onAction}
          onBack={onBack}
        />
      )}

      {/* Phase 3a: AI result — TabbedResult with Data / AI insights tabs */}
      {/* Also shown in awaiting-activation (deferAi): display Data tab while AI not yet started */}
      {(hybridState.status === 'done' && hasFinalResult || hybridState.status === 'awaiting-activation') && renderResult !== undefined && (
        <Box flexDirection="column">
          {/* Height clamps the box so AI tab content never bleeds onto the border line.
              paddingBottom keeps last content row clear of the bottom border glyph. */}
          <Box flexDirection="column" paddingX={PADDING_X} paddingBottom={1} height={viewportHeight + RESULT_BOX_CHROME} overflow="hidden">
            <TabbedResult
              tabs={[
                { id: 'data', label: 'Results' },
                { id: 'ai', label: 'AI insights' },
              ]}
              activeTab={activeTab}
              onTabChange={handleTabChange}
              isActive={doneInlineActive}
            >
              <ResultViewport
                blocks={doneItems.map((el, i) => elementBlock(`done-${i}`, el, 1))}
                viewportRows={viewportHeight}
                isActive={hybridState.status === 'done'}
              />
            </TabbedResult>
          </Box>

          {/* Always render nextText when present */}
          {!allowFollowUp && resultNextText !== undefined && resultNextText.length > 0 && (
            <Box marginTop={GAP_BETWEEN_SECTIONS} marginLeft={TUI.indent.content}>
              <Text dimColor>{resultNextText}</Text>
            </Box>
          )}

          {/* Sticky action bar — result actions only (no tab-switching keys) */}
          {!allowFollowUp && resultActions !== undefined && resultActions.length > 0 && (
            <ActionBar
              actions={resultActions}
              onAction={onAction}
            />
          )}



          {/* Follow-up via FollowUpPanel */}
          {allowFollowUp && (
            <Box flexDirection="column">
              <FollowUpPanel
                context={{
                  source: followUpContextSource,
                  ...(datasetFingerprint !== undefined ? { dateRange: datasetFingerprint } : {}),
                  ...(viewFingerprint !== undefined ? { grouping: viewFingerprint } : {}),
                }}
                history={turnHistory}
                {...('aiCostUsd' in hybridState && hybridState.aiCostUsd > 0 ? { estimatedCost: hybridState.aiCostUsd } : {})}
                isLoading={isRunning}
                overlayActive={overlayActive}
                onSubmit={handleFollowUpSubmit}
                onClose={() => { if (onBack !== undefined) onBack(); }}
              />
            </Box>
          )}
        </Box>
      )}

      {/* Phase 3a (legacy): AI result without renderResult — use ResultPanel */}
      {hybridState.status === 'done' && hasFinalResult && renderResult === undefined && (
        <Box flexDirection="column">
          <Box marginLeft={MARGIN_LEFT_CONTENT} marginBottom={GAP_BETWEEN_SECTIONS}>
            <Text bold color={colors.brand}>AI summary</Text>
          </Box>
          <ResultPanel
            result={hybridState.aiResult}
            totalCostUsd={hybridState.aiCostUsd}
            numTurns={1}
            durationMs={hybridState.totalDurationMs}
            {...(onRunAgain !== undefined ? { onRunAgain } : {})}
            {...(onBack !== undefined ? { onBack } : {})}
            isActive={!allowFollowUp}
          />
          {allowFollowUp && (
            <FollowUpPanel
              context={{
                source: 'AI analysis',
                ...(datasetFingerprint !== undefined ? { dateRange: datasetFingerprint } : {}),
                ...(viewFingerprint !== undefined ? { grouping: viewFingerprint } : {}),
              }}
              history={turnHistory}
              {...(hybridState.aiCostUsd > 0 ? { estimatedCost: hybridState.aiCostUsd } : {})}
              isLoading={isRunning}
              overlayActive={overlayActive}
              onSubmit={handleFollowUpSubmit}
              onClose={() => { if (onBack !== undefined) onBack(); }}
            />
          )}
        </Box>
      )}

      {/* Phase 3b: Fallback — still complete, offer retry-AI */}
      {hybridState.status === 'fallback' && (
        <Box flexDirection="column">
          {/* HIGH-4: small fallback (≤5 blocks) renders items directly so Yoga auto-sizes;
                      large fallback uses ResultViewport with scrolling + explicit height cap. */}
          {(() => {
            const fallbackIsSmall = fallbackItems.length <= 5;
            const banner = (
              <Box gap={GAP_ROW} marginBottom={GAP_BETWEEN_SECTIONS}>
                <Text color={colors.warning}>{icons.warning}</Text>
                <Text bold color={colors.warning}>AI analysis unavailable</Text>
                <Text dimColor>{icons.dot} Rule-based results are complete {icons.dot} {formatTotalDuration(hybridState.totalDurationMs)}</Text>
              </Box>
            );
            if (fallbackIsSmall) {
              return (
                <Box
                  borderStyle={borders.result}
                  borderColor={colors.warning}
                  flexDirection="column"
                  paddingX={PADDING_X}
                  paddingBottom={1}
                  overflow="hidden"
                >
                  {banner}
                  {fallbackItems.map((el, i) => <Box key={`fallback-${i}`}>{el}</Box>)}
                </Box>
              );
            }
            return (
              <Box
                borderStyle={borders.result}
                borderColor={colors.warning}
                flexDirection="column"
                paddingX={PADDING_X}
                paddingBottom={1}
                height={viewportHeight + RESULT_BOX_CHROME}
                overflow="hidden"
              >
                {banner}
                <ResultViewport
                  key="fallback-viewport"
                  blocks={fallbackItems.map((el, i) => elementBlock(`fallback-${i}`, el, 1))}
                  viewportRows={viewportHeight}
                  isActive={hybridState.status === 'fallback'}
                />
              </Box>
            );
          })()}

          {/* Fallback actions + retry AI only if key 'r' not already taken.
              Suppressed entirely when an overlay is active (filter/detail/help). */}
          {!overlayActive && (
            <ActionBar
              actions={(() => {
                const base = fallbackActions ?? [];
                const hasR = base.some((a) => a.key.toLowerCase() === 'r');
                return onRunAgain !== undefined && !hasR
                  ? [...base, { key: 'r', label: 'retry AI', action: { type: 'run-again' as const } }]
                  : base;
              })()}
              onAction={onAction}
            />
          )}


        </Box>
      )}
    </Box>
  );
}
