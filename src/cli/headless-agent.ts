/**
 * Headless agent event consumer — no Ink/React dependencies.
 *
 * Consumes the AsyncGenerator<AgentEvent> from AgentProvider.query() and
 * outputs to stdout/stderr without any TUI layer.
 */

import type { AgentProvider, AgentQueryOptions } from '../agent/types.js';

interface HeadlessAgentResult {
  result: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  aborted: boolean;
}

/**
 * Run a prompt through the agent and stream events to stdout/stderr.
 *
 * outputMode:
 *   'text'   — stream text deltas to stdout, progress dots/tool info to stderr
 *   'json'   — collect result silently, no stdout during run (use result.result)
 *   'silent' — collect result, no output at all
 */
export async function runHeadlessAgent(
  prompt: string,
  provider: AgentProvider,
  options: AgentQueryOptions,
  outputMode: 'text' | 'json' | 'silent',
): Promise<HeadlessAgentResult> {
  const startMs = Date.now();
  const abortController = new AbortController();

  let aborted = false;
  let resultText = '';
  let costUsd = 0;
  let turns = 0;

  // Wire abort — mirror AgentLoop.tsx:257-270 pattern
  const previousAbort = globalThis.__korinfraAgentAbort;
  const handleAbort = (): void => {
    if (aborted) return;
    aborted = true;
    abortController.abort();
    provider.abort();
  };
  globalThis.__korinfraAgentAbort = handleAbort;

  try {
    for await (const event of provider.query(prompt, {
      signal: abortController.signal,
      cwd: process.cwd(),
      maxTurns: 10,
      maxBudgetUsd: 0.50,
      ...options,
    })) {
      if (aborted) break;

      switch (event.type) {
        case 'thinking': {
          if (outputMode === 'text') {
            process.stderr.write('.');
          }
          break;
        }
        case 'text': {
          if (outputMode === 'text') {
            process.stdout.write(event.text);
          } else {
            // json/silent: accumulate — but result event has authoritative full text
            // We accumulate as fallback in case result event is absent
            resultText += event.text;
          }
          break;
        }
        case 'tool_start': {
          if (outputMode === 'text') {
            process.stderr.write(`\n[tool] ${event.toolName}\n`);
          }
          break;
        }
        case 'tool_end': {
          if (outputMode === 'text' && event.isError) {
            process.stderr.write(`[error] ${event.toolName}: ${event.output}\n`);
          }
          break;
        }
        case 'cost_update': {
          costUsd = event.totalCostUsd;
          break;
        }
        case 'result': {
          resultText = event.text;
          costUsd = event.costUsd;
          turns = event.numTurns;
          if (outputMode === 'text') {
            process.stderr.write(`\n(${turns} turn${turns !== 1 ? 's' : ''}, $${costUsd.toFixed(4)})\n`);
          }
          break;
        }
        case 'error': {
          costUsd = event.costUsd;
          turns = event.numTurns;
          const errorMsg = event.errors.join('; ');
          if (outputMode === 'text') {
            process.stderr.write(`\n[korinfra] agent error: ${errorMsg}\n`);
          }
          // Restore abort handler before throwing
          if (globalThis.__korinfraAgentAbort === handleAbort) {
            globalThis.__korinfraAgentAbort = previousAbort;
          }
          throw new Error(`Agent error: ${errorMsg}`);
        }
      }
    }
  } finally {
    // Restore the previous abort handler — mirror AgentLoop.tsx:363-365
    if (globalThis.__korinfraAgentAbort === handleAbort) {
      globalThis.__korinfraAgentAbort = previousAbort;
    }
  }

  return {
    result: resultText,
    costUsd,
    turns,
    durationMs: Date.now() - startMs,
    aborted,
  };
}
