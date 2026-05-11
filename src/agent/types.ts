import type { ZodRawShape } from 'zod/v4';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition as PlainToolDefinition } from '../tools/types.js';

// ---------------------------------------------------------------------------
// AgentEvent — events emitted from an AgentProvider to the TUI / consumer
// ---------------------------------------------------------------------------

export type ThinkingEvent = {
  type: 'thinking';
  text: string;
};

export type TextEvent = {
  type: 'text';
  text: string;
};

export type ToolStartEvent = {
  type: 'tool_start';
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
};

export type ToolEndEvent = {
  type: 'tool_end';
  toolName: string;
  toolUseId: string;
  /** true when the tool returned an error result */
  isError: boolean;
  output: string;
};

export type ResultEvent = {
  type: 'result';
  text: string;
  costUsd: number;
  numTurns: number;
  durationMs: number;
};

export type ErrorEvent = {
  type: 'error';
  errors: string[];
  costUsd: number;
  numTurns: number;
};

export type CostUpdateEvent = {
  type: 'cost_update';
  totalCostUsd: number;
};

export type AgentEvent =
  | ThinkingEvent
  | TextEvent
  | ToolStartEvent
  | ToolEndEvent
  | ResultEvent
  | ErrorEvent
  | CostUpdateEvent;

// ---------------------------------------------------------------------------
// AgentQueryOptions — per-query configuration
// ---------------------------------------------------------------------------

export type AgentQueryOptions = {
  /**
   * System prompt override.
   * - Pass a string for a fully custom prompt (korinfra default: FinOps prompt).
   * - Pass `{ type: 'preset', preset: 'claude_code', append?: '...' }` to use
   *   Claude Code's built-in system prompt, optionally extended with your own text.
   *   Useful for commands that need Claude Code's file-editing guidance.
   */
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  /** Custom tool definitions to expose to the model */
  tools?: Array<ToolDefinition | PlainToolDefinition>;
  /**
   * Built-in Agent SDK tools to enable (Read, Glob, Grep, Edit, Write, Bash…).
   * Defaults to ['Read', 'Glob', 'Grep'] — read-only.
   * Pass ['Read', 'Glob', 'Grep', 'Edit', 'Write'] for commands that apply patches.
   */
  builtinTools?: string[];
  /**
   * Tools to always deny, even if listed in allowedTools or builtinTools.
   * Defaults to ['Bash', 'WebSearch', 'WebFetch'] — blocks shell execution
   * and external network access from the agent.
   * Note: Bash, WebSearch, WebFetch are permanently denied — passing them in
   * builtinTools will throw an error rather than silently ignoring the request.
   */
  disallowedTools?: string[];
  /**
   * Filesystem setting sources to load (CLAUDE.md, hooks, skills).
   * Defaults to [] — no filesystem settings loaded (isolation mode).
   * Pass ['project'] for fix command to load the user's project CLAUDE.md,
   * giving Claude context about project conventions when making patches.
   */
  settingSources?: Array<'user' | 'project' | 'local'>;
  /** Maximum agentic turns before stopping */
  maxTurns?: number;
  /** Hard USD budget cap */
  maxBudgetUsd?: number;
  /** Model identifier, e.g. 'claude-sonnet-4-6' */
  model?: string;
  /** Reasoning effort level */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Working directory forwarded to the SDK */
  cwd?: string;
  /** Abort signal — linked to the internal AbortController */
  signal?: AbortSignal;
  /** Wall-clock timeout in milliseconds before the query is aborted (default: 5 minutes) */
  timeoutMs?: number;
  /** Permission mode forwarded to the Agent SDK */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
  /**
   * Enforce structured JSON output from the agent.
   * Uses the SDK's native outputFormat — more reliable than prompt-instructed JSON.
   * Pass a JSON Schema object matching your expected output shape.
   * Example: scan/fix/security commands pass the recommendations array schema.
   */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
};

// ---------------------------------------------------------------------------
// ToolDefinition — defines a custom tool for the agent
// ---------------------------------------------------------------------------

export type ToolDefinition<Schema extends ZodRawShape = ZodRawShape> = {
  name: string;
  description: string;
  /** Zod v4 raw shape — keys are parameter names, values are Zod schemas */
  inputSchema: Schema;
  /** Called when the model invokes this tool */
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  annotations?: ToolAnnotations;
};

// ---------------------------------------------------------------------------
// ToolResult — what a tool handler returns
// ---------------------------------------------------------------------------

export type ToolResult = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
};

// ---------------------------------------------------------------------------
// AgentProvider — interface all provider implementations must satisfy
// ---------------------------------------------------------------------------

export interface AgentProvider {
  /** Human-readable provider name */
  readonly name: string;
  /**
   * Run a query and stream events back to the caller.
   * Yields AgentEvents until the conversation is complete.
   */
  query(prompt: string, options?: AgentQueryOptions): AsyncGenerator<AgentEvent, void>;
  /** Abort an in-flight query */
  abort(): void;
}

// ---------------------------------------------------------------------------
// ToolCallRecord — UI record for a completed or in-flight tool call
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  startedAt: number;
  endedAt?: number;
}

// ---------------------------------------------------------------------------
// Provider config — optional configuration passed to factory functions
// ---------------------------------------------------------------------------

export type ClaudeProviderConfig = {
  /** Override the default model */
  model?: string;
  /** Override the default effort level */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Name of the env var holding the API key (defaults to ANTHROPIC_API_KEY) */
  apiKeyEnv?: string;
  /** Enable extended thinking (Claude reasons before responding) */
  extendedThinking?: boolean;
  /** Token budget for extended thinking when extendedThinking is true */
  thinkingBudget?: number;
};
