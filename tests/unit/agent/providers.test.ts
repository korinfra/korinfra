/**
 * Unit tests for src/agent/claude.ts and src/agent/index.ts.
 *
 * The Claude SDK's `query` function is mocked so no real AI calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/claude-agent-sdk before any imports that pull it in
// ---------------------------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await import('@anthropic-ai/claude-agent-sdk');
  return {
    ...actual,
    query: vi.fn(),
    createSdkMcpServer: vi.fn(() => ({ instance: {}, config: {} })),
    tool: vi.fn((name: string, _desc: string, _shape: unknown, handler: unknown, _opts?: unknown) => ({
      name,
      handler,
    })),
  };
});

import { query as mockQueryFn } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeProvider, createClaudeProvider } from '../../../src/agent/claude.js';
import { createAgentProvider } from '../../../src/agent/index.js';

// Typed alias so TypeScript lets us call mockReturnValue etc.
const mockQuery = mockQueryFn as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helper — build a fake async iterable from an array of SDK messages
// ---------------------------------------------------------------------------

function makeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < items.length) {
            return { value: items[i++]!, done: false };
          }
          return { value: undefined as unknown as T, done: true };
        },
      };
    },
  };
}

// Collect all events from an async generator into an array
async function collect(gen: AsyncGenerator<AgentEvent, void>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// ClaudeProvider — basic structure
// ---------------------------------------------------------------------------

describe('ClaudeProvider — structure', () => {
  it('has name "claude"', () => {
    const p = new ClaudeProvider();
    expect(p.name).toBe('claude');
  });

  it('createClaudeProvider returns a ClaudeProvider', () => {
    const p = createClaudeProvider();
    expect(p).toBeInstanceOf(ClaudeProvider);
    expect(p.name).toBe('claude');
  });

  it('createClaudeProvider accepts config', () => {
    const p = createClaudeProvider({ model: 'claude-opus-4-5', effort: 'high' });
    expect(p).toBeInstanceOf(ClaudeProvider);
  });

  it('abort() is a no-op when no query is in flight', () => {
    const p = new ClaudeProvider();
    expect(() => p.abort()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider — text event from stream
// ---------------------------------------------------------------------------

describe('ClaudeProvider — stream event processing', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('emits text events from content_block_delta / text_delta', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'Hello world',
          total_cost_usd: 0.001,
          num_turns: 1,
          duration_ms: 500,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('hello'));

    const textEvents = events.filter((e) => e.type === 'text') as Array<{ type: 'text'; text: string }>;
    expect(textEvents.map((e) => e.text)).toEqual(['Hello', ' world']);
  });

  it('redacts sensitive values in text_delta chunks', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'AKIAIOSFODNN7EXAMPLE' } },
        },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 10,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('redact stream'));

    const textEvents = events.filter((e) => e.type === 'text') as Array<{ type: 'text'; text: string }>;
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]!.text).toBe('[ACCESS-KEY]');
  });

  it('emits thinking events from thinking_delta', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'Let me think...' },
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 100,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('think'));

    const thinking = events.filter((e) => e.type === 'thinking') as Array<{ type: 'thinking'; text: string }>;
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.text).toBe('Let me think...');
  });

  it('emits tool_start on content_block_start for tool_use block', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tu_123', name: 'get_costs' },
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 50,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('run tool'));

    const starts = events.filter((e) => e.type === 'tool_start') as Array<{
      type: 'tool_start';
      toolName: string;
      toolUseId: string;
    }>;
    expect(starts).toHaveLength(1);
    expect(starts[0]!.toolName).toBe('get_costs');
    expect(starts[0]!.toolUseId).toBe('tu_123');
  });

  it('ignores content_block_start for non-tool-use blocks', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'text' },
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 10,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('start'));

    const starts = events.filter((e) => e.type === 'tool_start');
    expect(starts).toHaveLength(0);
  });

  it('ignores unrecognised delta types (input_json_delta)', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"foo":' },
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 10,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('partial'));

    // Only a result event — no text/thinking/tool events
    expect(events.filter((e) => e.type !== 'result' && e.type !== 'cost_update')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider — tool_end from user message
// ---------------------------------------------------------------------------

describe('ClaudeProvider — user message / tool_end', () => {
  beforeEach(() => mockQuery.mockReset());

  it('emits tool_end for tool_result blocks in user messages', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_abc',
                content: 'ec2 data',
                is_error: false,
              },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'done',
          total_cost_usd: 0.002,
          num_turns: 2,
          duration_ms: 800,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('analyze'));

    const ends = events.filter((e) => e.type === 'tool_end') as Array<{
      type: 'tool_end';
      toolUseId: string;
      isError: boolean;
      output: string;
    }>;
    expect(ends).toHaveLength(1);
    expect(ends[0]!.toolUseId).toBe('tu_abc');
    expect(ends[0]!.isError).toBe(false);
    expect(ends[0]!.output).toBe('ec2 data');
  });

  it('sets isError=true when tool_result has is_error=true', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_err',
                content: 'Something went wrong',
                is_error: true,
              },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 50,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('fail'));

    const ends = events.filter((e) => e.type === 'tool_end') as Array<{
      type: 'tool_end';
      isError: boolean;
      output: string;
    }>;
    expect(ends[0]!.isError).toBe(true);
    expect(ends[0]!.output).toBe('Something went wrong');
  });

  it('handles array content in tool_result output', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_arr',
                content: [{ type: 'text', text: 'result text' }],
                is_error: false,
              },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 20,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('array'));

    const ends = events.filter((e) => e.type === 'tool_end') as Array<{
      type: 'tool_end';
      output: string;
    }>;
    expect(ends[0]!.output).toBe(JSON.stringify([{ type: 'text', text: 'result text' }]));
  });

  it('ignores user messages with string content (not array)', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'user',
          message: { content: 'plain string content' },
        },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 10,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('string content'));

    const ends = events.filter((e) => e.type === 'tool_end');
    expect(ends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider — result events
// ---------------------------------------------------------------------------

describe('ClaudeProvider — result and error events', () => {
  beforeEach(() => mockQuery.mockReset());

  it('emits a result event on success', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'result',
          subtype: 'success',
          result: 'Analysis complete',
          total_cost_usd: 0.05,
          num_turns: 3,
          duration_ms: 1200,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('analyze'));

    const results = events.filter((e) => e.type === 'result') as Array<{
      type: 'result';
      text: string;
      costUsd: number;
      numTurns: number;
      durationMs: number;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe('Analysis complete');
    expect(results[0]!.costUsd).toBe(0.05);
    expect(results[0]!.numTurns).toBe(3);
    expect(results[0]!.durationMs).toBe(1200);
  });

  it('redacts sensitive content in final result text', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'result',
          subtype: 'success',
          result: 'leaked key AKIAIOSFODNN7EXAMPLE',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 5,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('result redaction'));
    const result = events.find((e) => e.type === 'result') as { type: 'result'; text: string } | undefined;

    expect(result).toBeDefined();
    expect(result!.text).toContain('[ACCESS-KEY]');
    expect(result!.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('emits a cost_update event when cost changes', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'result',
          subtype: 'success',
          result: 'done',
          total_cost_usd: 0.1,
          num_turns: 2,
          duration_ms: 600,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('cost test'));

    const costUpdates = events.filter((e) => e.type === 'cost_update') as Array<{
      type: 'cost_update';
      totalCostUsd: number;
    }>;
    expect(costUpdates).toHaveLength(1);
    expect(costUpdates[0]!.totalCostUsd).toBe(0.1);
  });

  it('does NOT emit cost_update when total_cost_usd is 0', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 50,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('zero cost'));

    const costUpdates = events.filter((e) => e.type === 'cost_update');
    expect(costUpdates).toHaveLength(0);
  });

  it('emits an error event on result subtype error', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'result',
          subtype: 'error_max_turns',
          errors: ['Max turns exceeded'],
          total_cost_usd: 0.01,
          num_turns: 10,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('error test'));

    const errors = events.filter((e) => e.type === 'error') as Array<{
      type: 'error';
      errors: string[];
      costUsd: number;
      numTurns: number;
    }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.errors).toEqual(['Max turns exceeded']);
    expect(errors[0]!.costUsd).toBe(0.01);
  });

  it('generates fallback error message when errors array is absent', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'result',
          subtype: 'error_budget_exceeded',
          total_cost_usd: 0.5,
          num_turns: 5,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('budget test'));

    const errors = events.filter((e) => e.type === 'error') as Array<{
      type: 'error';
      errors: string[];
    }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.errors[0]).toContain('error_budget_exceeded');
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider — unknown message types are silently ignored
// ---------------------------------------------------------------------------

describe('ClaudeProvider — unknown message types', () => {
  beforeEach(() => mockQuery.mockReset());

  it('emits no event for system/init with all MCP servers connected', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        { type: 'system', subtype: 'init', mcp_servers: [{ name: 'korinfra-tools', status: 'connected' }] },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 10,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('system'));

    // Only result event expected — all servers connected, no error
    expect(events.filter((e) => e.type !== 'result')).toHaveLength(0);
  });

  it('emits error event when system/init reports a failed MCP server', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'system',
          subtype: 'init',
          mcp_servers: [
            { name: 'korinfra-tools', status: 'failed' },
          ],
        },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 10,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('mcp-fail'));

    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as { errors: string[] }).errors[0]).toContain('korinfra-tools');
    expect((errorEvents[0] as { errors: string[] }).errors[0]).toContain('failed');
  });

  it('ignores system/init with no mcp_servers field', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        { type: 'system', subtype: 'init' },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 10,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('system'));

    // Only result event expected — no mcp_servers to check
    expect(events.filter((e) => e.type !== 'result')).toHaveLength(0);
  });

  it('ignores "tool_progress" messages', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        { type: 'tool_progress', content: 'loading...' },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 10,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('progress'));

    expect(events.filter((e) => e.type !== 'result')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider — abort
// ---------------------------------------------------------------------------

describe('ClaudeProvider — abort signal', () => {
  beforeEach(() => mockQuery.mockReset());

  it('propagates abort signal to SDK AbortController', async () => {
    const outer = new AbortController();

    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 10,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const done = collect(p.query('abort test', { signal: outer.signal }));
    // Abort the outer controller after starting the query — the listener on
    // outer.signal must propagate the abort to the inner AbortController.
    outer.abort();
    await done;

    expect(mockQuery).toHaveBeenCalledOnce();
    const sdkArgs = mockQuery.mock.calls[0]![0] as { options: { abortController: AbortController } };
    const innerController = sdkArgs.options.abortController;
    expect(innerController).toBeDefined();
    expect(innerController.signal.aborted).toBe(true);
  });

  it('pre-aborts when signal is already aborted', async () => {
    const outer = new AbortController();
    outer.abort(); // already aborted before query starts

    mockQuery.mockReturnValue(makeAsyncIterable([]));

    const p = new ClaudeProvider();
    await collect(p.query('pre-aborted', { signal: outer.signal }));

    expect(mockQuery).toHaveBeenCalledOnce();
    const sdkArgs = mockQuery.mock.calls[0]![0] as { options: { abortController: AbortController } };
    const innerController = sdkArgs.options.abortController;
    // Inner controller must already be aborted because claude.ts calls ac.abort()
    // synchronously when options.signal.aborted is true (line 33 of claude.ts).
    expect(innerController).toBeDefined();
    expect(innerController.signal.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider — security defaults (9-4)
// Verifies that persistSession and allowDangerouslySkipPermissions are
// always hardcoded to their safe values regardless of caller options, and
// that permissionMode defaults to 'dontAsk' when not provided.
// ---------------------------------------------------------------------------

describe('ClaudeProvider — security defaults', () => {
  beforeEach(() => mockQuery.mockReset());

  it('defaults permissionMode to "dontAsk" when not specified', async () => {
    mockQuery.mockReturnValue(makeAsyncIterable([]));
    const p = new ClaudeProvider();
    await collect(p.query('test'));

    const callArg = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(callArg.options['permissionMode']).toBe('dontAsk');
  });

  it('always passes persistSession: false regardless of options', async () => {
    mockQuery.mockReturnValue(makeAsyncIterable([]));
    const p = new ClaudeProvider();
    // No way to override persistSession — it is hardcoded in claude.ts
    await collect(p.query('test'));

    const callArg = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(callArg.options['persistSession']).toBe(false);
  });

  it('always passes allowDangerouslySkipPermissions: false regardless of options', async () => {
    mockQuery.mockReturnValue(makeAsyncIterable([]));
    const p = new ClaudeProvider();
    await collect(p.query('test'));

    const callArg = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(callArg.options['allowDangerouslySkipPermissions']).toBe(false);
  });

  it('caller can override permissionMode but not persistSession or allowDangerouslySkipPermissions', async () => {
    mockQuery.mockReturnValue(makeAsyncIterable([]));
    const p = new ClaudeProvider();
    await collect(p.query('test', { permissionMode: 'acceptEdits' }));

    const callArg = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(callArg.options['permissionMode']).toBe('acceptEdits');
    // These two are immutable regardless of any caller-supplied options
    expect(callArg.options['persistSession']).toBe(false);
    expect(callArg.options['allowDangerouslySkipPermissions']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider — assistant message (intentionally yields nothing)
// ---------------------------------------------------------------------------

describe('ClaudeProvider — assistant messages', () => {
  beforeEach(() => mockQuery.mockReset());

  it('emits no events for assistant messages (handled via stream_event)', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'assistant',
          message: {
            id: 'msg_123',
            content: [{ type: 'text', text: 'Response text' }],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'Response text',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 100,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('assistant msg'));

    // assistant message produces no direct events (text comes via stream_event)
    const nonResult = events.filter((e) => e.type !== 'result' && e.type !== 'cost_update');
    expect(nonResult).toHaveLength(0);
  });

  it('emits redacted assistant error events', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'assistant',
          message: {
            id: 'msg_456',
            content: [],
          },
          error: 'failed with token=supersecretvalue12345678',
        },
        {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 1,
        },
      ]),
    );

    const p = new ClaudeProvider();
    const events = await collect(p.query('assistant error'));
    const errors = events.filter((e) => e.type === 'error') as Array<{ type: 'error'; errors: string[] }>;

    expect(errors).toHaveLength(1);
    expect(errors[0]!.errors[0]).toContain('[REDACTED]');
    expect(errors[0]!.errors[0]).not.toContain('supersecretvalue12345678');
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider — custom tools wired up
// ---------------------------------------------------------------------------

describe('ClaudeProvider — options passthrough', () => {
  beforeEach(() => mockQuery.mockReset());

  it('passes maxTurns and systemPrompt to the SDK', async () => {
    mockQuery.mockReturnValue(makeAsyncIterable([]));

    const p = new ClaudeProvider();
    await collect(p.query('with options', { maxTurns: 5, systemPrompt: 'Be concise.' }));

    expect(mockQuery).toHaveBeenCalledOnce();
    const callArg = mockQuery.mock.calls[0]![0] as {
      prompt: string;
      options: Record<string, unknown>;
    };
    expect(callArg.prompt).toBe('with options');
    expect(callArg.options['systemPrompt']).toBe('Be concise.');
    expect(callArg.options['maxTurns']).toBe(5);
  });

  it('passes settingSources, disallowedTools, and outputFormat to the SDK', async () => {
    mockQuery.mockReturnValue(makeAsyncIterable([]));

    const schema = { type: 'object', properties: { recommendations: { type: 'array' } } };
    const p = new ClaudeProvider();
    await collect(p.query('opts', {
      settingSources: ['project'],
      disallowedTools: ['MyTool'],
      outputFormat: { type: 'json_schema', schema },
    }));

    const callArg = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(callArg.options['settingSources']).toEqual(['project']);
    // Bash, WebSearch, WebFetch are always merged in regardless of caller's disallowedTools
    expect(callArg.options['disallowedTools']).toEqual(
      expect.arrayContaining(['Bash', 'WebSearch', 'WebFetch']),
    );
    expect(callArg.options['outputFormat']).toEqual({ type: 'json_schema', schema });
  });

  it('uses config model when no options.model is given', async () => {
    mockQuery.mockReturnValue(makeAsyncIterable([]));

    const p = createClaudeProvider({ model: 'claude-haiku-3-5' });
    await collect(p.query('model test'));

    const callArg = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(callArg.options['model']).toBe('claude-haiku-3-5');
  });

  it('options.model overrides config model', async () => {
    mockQuery.mockReturnValue(makeAsyncIterable([]));

    const p = createClaudeProvider({ model: 'claude-haiku-3-5' });
    await collect(p.query('override', { model: 'claude-sonnet-4-6' }));

    const callArg = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(callArg.options['model']).toBe('claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider — redaction before SDK input (2A)
// Verifies the prompt is redacted BEFORE it reaches the SDK mock.
// Mutation check: if the redact() call on line 83 of claude.ts were removed,
// mockQuery would receive the raw key and the assertion below would fail.
// ---------------------------------------------------------------------------

describe('ClaudeProvider — redaction before SDK call', () => {
  beforeEach(() => mockQuery.mockReset());

  it('redacts AWS access key in prompt BEFORE passing to SDK', async () => {
    mockQuery.mockReturnValue(makeAsyncIterable([]));

    const p = new ClaudeProvider();
    await collect(p.query('AKIAIOSFODNN7EXAMPLE'));

    expect(mockQuery).toHaveBeenCalledOnce();
    const callArg = mockQuery.mock.calls[0]![0] as { prompt: string };

    // The raw key must NOT reach the SDK
    expect(callArg.prompt).not.toContain('AKIAIOSFODNN7EXAMPLE');
    // It must be replaced with the canonical redaction token
    expect(callArg.prompt).toContain('[ACCESS-KEY]');
  });

  it('redacts AWS access key embedded in a longer prompt before SDK', async () => {
    mockQuery.mockReturnValue(makeAsyncIterable([]));

    const p = new ClaudeProvider();
    await collect(p.query('analyze costs for key AKIAIOSFODNN7EXAMPLE in us-east-1'));

    const callArg = mockQuery.mock.calls[0]![0] as { prompt: string };
    expect(callArg.prompt).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(callArg.prompt).toContain('[ACCESS-KEY]');
  });
});

// ---------------------------------------------------------------------------
// createAgentProvider factory (index.ts)
// ---------------------------------------------------------------------------

describe('createAgentProvider — factory', () => {
  it('returns ClaudeProvider for "claude"', () => {
    const p = createAgentProvider('claude');
    expect(p).toBeInstanceOf(ClaudeProvider);
    expect(p.name).toBe('claude');
  });

  it('passes config to ClaudeProvider', () => {
    const p = createAgentProvider('claude', { model: 'claude-opus-4-5' });
    expect(p).toBeInstanceOf(ClaudeProvider);
  });
});
