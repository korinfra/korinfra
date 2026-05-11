import type { AgentEvent, ToolCallRecord } from '../../agent/types.js';
import { stripStructuredData, sanitizeAgentText } from '../utils/format.js';

export interface LoopState {
  completedToolCalls: ToolCallRecord[];
  activeToolCall: ToolCallRecord | null;
  streamedText: string;
  isThinking: boolean;
  result: string | null;
  error: string | null;
  isRunning: boolean;
  isAborting: boolean;
  wasAborted: boolean;
  totalCostUsd: number | undefined;
  numTurns: number | undefined;
  durationMs: number | undefined;
  /** Number of AI reasoning rounds (increments each time AI starts thinking after a tool). */
  agentTurn: number;
  startedAt: number | null;
}

export const INITIAL_STATE: LoopState = {
  completedToolCalls: [],
  activeToolCall: null,
  streamedText: '',
  isThinking: false,
  result: null,
  error: null,
  isRunning: false,
  isAborting: false,
  wasAborted: false,
  totalCostUsd: undefined,
  numTurns: undefined,
  durationMs: undefined,
  agentTurn: 1,
  startedAt: null,
};

type IdCounter = { current: number };

export function handleEvent(
  event: AgentEvent,
  prev: LoopState,
  startMs: number,
  idCounter: IdCounter,
): LoopState {
  switch (event.type) {
    case 'thinking':
      // Increment turn counter each time AI starts a new reasoning cycle after tool use
      return {
        ...prev,
        isThinking: true,
        agentTurn: prev.completedToolCalls.length > 0 && !prev.isThinking
          ? prev.agentTurn + 1
          : prev.agentTurn,
      };

    case 'text':
      // Once a terminal state is reached (result / error / aborted),
      // ignore any straggling text events that arrive after the agent signals done.
      if (prev.result !== null || prev.error !== null || prev.wasAborted) return prev;
      return {
        ...prev,
        isThinking: false,
        streamedText: prev.streamedText + sanitizeAgentText(event.text),
      };

    case 'tool_start': {
      idCounter.current += 1;
      const record: ToolCallRecord = {
        id: `tool-${idCounter.current}`,
        toolName: event.toolName,
        toolInput: event.input,
        startedAt: Date.now(),
      };
      return {
        ...prev,
        isThinking: false,
        activeToolCall: record,
      };
    }

    case 'tool_end': {
      const finished: ToolCallRecord | null = prev.activeToolCall
        ? {
            ...prev.activeToolCall,
            toolResult: event.output,
            isError: event.isError,
            endedAt: Date.now(),
          }
        : null;
      return {
        ...prev,
        activeToolCall: null,
        completedToolCalls: finished
          ? [...prev.completedToolCalls, finished]
          : prev.completedToolCalls,
        isThinking: true,
      };
    }

    case 'cost_update':
      return {
        ...prev,
        totalCostUsd: event.totalCostUsd,
        durationMs: Date.now() - startMs,
      };

    case 'result':
      return {
        ...prev,
        result: stripStructuredData(sanitizeAgentText(event.text)),
        numTurns: event.numTurns,
        durationMs: event.durationMs,
        totalCostUsd: event.costUsd,
        isRunning: false,
        isThinking: false,
        isAborting: false,
      };

    case 'error':
      return {
        ...prev,
        error: event.errors.join('\n'),
        isRunning: false,
        isThinking: false,
        isAborting: false,
      };

    default:
      return prev;
  }
}
