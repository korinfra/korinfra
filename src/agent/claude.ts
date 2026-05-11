import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentProvider, AgentQueryOptions, AgentEvent, ClaudeProviderConfig } from './types.js';
import { prompts } from './prompts.js';
import { createToolServer } from './tools-registry.js';
import { redact } from '../redaction/index.js';
import { logger } from '../utils/logger.js';

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude';
  private abortController: AbortController | null = null;
  private readonly config: ClaudeProviderConfig;

  constructor(config: ClaudeProviderConfig = {}) {
    this.config = config;
  }

  async *query(prompt: string, options: AgentQueryOptions = {}): AsyncGenerator<AgentEvent, void> {
    if (this.abortController !== null) {
      throw new Error('ClaudeProvider: a query is already in progress. Call abort() first.');
    }
    const ac = new AbortController();
    this.abortController = ac;
    if (options.signal?.aborted) { ac.abort(); }
    const onAbort = () => ac.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // Wall-clock timeout — aborts the internal AbortController after the deadline.
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    const timeoutHandle: ReturnType<typeof setTimeout> | undefined = setTimeout(() => { ac.abort(); }, timeoutMs);

    // systemPrompt accepts either a string or { type:'preset', preset:'claude_code', append? }
    // Redact any dynamic caller-supplied string at strict level before it reaches the SDK.
    // Strict catches ARNs, account IDs, public/private IPs, emails, and domains in addition
    // to access keys/tokens — system prompts may contain infra context with sensitive data.
    // Preset objects (e.g. prompts.general) are static and must NOT be redacted.
    const rawSystemPrompt = options.systemPrompt ?? prompts.general;
    const systemPrompt = typeof rawSystemPrompt === 'string'
      ? redact(rawSystemPrompt, 'strict')
      : rawSystemPrompt !== null && rawSystemPrompt !== undefined && typeof rawSystemPrompt === 'object' && 'append' in rawSystemPrompt && typeof rawSystemPrompt.append === 'string'
        ? { ...rawSystemPrompt, append: redact(rawSystemPrompt.append, 'strict') }
        : rawSystemPrompt;
    const tools = options.tools ?? [];
    const startMs = Date.now();

    const mcpServers: Record<string, ReturnType<typeof createToolServer>> = {};
    if (tools.length > 0) {
      mcpServers['korinfra-tools'] = createToolServer('korinfra-tools', tools);
    }

    // Default to read-only built-in tools. Commands that apply file patches
    // (e.g. fix) should pass builtinTools: ['Read','Glob','Grep','Edit','Write'].
    // Bash, WebSearch, WebFetch are permanently denied — enabling them would allow
    // shell execution and external network access from the agent reasoning loop.
    const MANDATORY_DENIED = ['Bash', 'WebSearch', 'WebFetch'];
    const rawBuiltinTools = options.builtinTools ?? ['Read', 'Glob', 'Grep'];

    // Throw if the caller attempts to enable a permanently denied tool — silent
    // filtering would hide a misconfiguration and make audits harder to reason about.
    const illegalEnabled = rawBuiltinTools.filter(t => MANDATORY_DENIED.includes(t));
    if (illegalEnabled.length > 0) {
      throw new Error(
        `ClaudeProvider: builtinTools contains permanently denied tool(s): ${illegalEnabled.join(', ')}. ` +
        `The following tools can never be enabled: ${MANDATORY_DENIED.join(', ')}.`,
      );
    }
    const builtinTools = rawBuiltinTools;

    // Always deny shell execution and external network access from the agent.
    // Callers can extend the deny list but cannot remove these three regardless.
    const callerDenied = options.disallowedTools ?? [];
    const disallowedTools = [...new Set([...callerDenied, ...MANDATORY_DENIED])];

    // Build the env to pass to the SDK. Only forward keys the Claude Agent SDK
    // actually needs — passing all of process.env would expose every secret and
    // credential loaded into the environment (DB passwords, other API keys, etc.).
    // If the caller configured a custom apiKeyEnv (e.g. "MY_ANTHROPIC_KEY"),
    // forward its value under the canonical ANTHROPIC_API_KEY so the SDK finds it.
    const SDK_ENV_ALLOWLIST: ReadonlyArray<string> = [
      'ANTHROPIC_API_KEY',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'NODE_EXTRA_CA_CERTS',
      'HTTPS_PROXY',
      'HTTP_PROXY',
    ];
    const sdkEnv: NodeJS.ProcessEnv = {};
    for (const key of SDK_ENV_ALLOWLIST) {
      const val = process.env[key];
      if (val !== undefined) sdkEnv[key] = val;
    }
    // Custom apiKeyEnv: read from process.env directly (not sdkEnv, which may not
    // have the custom key) and map it to ANTHROPIC_API_KEY.
    if (this.config.apiKeyEnv && this.config.apiKeyEnv !== 'ANTHROPIC_API_KEY') {
      const customValue = process.env[this.config.apiKeyEnv];
      if (customValue) {
        sdkEnv['ANTHROPIC_API_KEY'] = customValue;
      } else {
        logger.warn({ envVar: this.config.apiKeyEnv }, 'apiKeyEnv is set but env var not found; SDK will use ANTHROPIC_API_KEY if available');
      }
    }

    const sdkOptions: Record<string, unknown> = {
      abortController: ac,
      systemPrompt,
      env: sdkEnv,
      tools: builtinTools,
      allowedTools: [
        ...builtinTools,
        'mcp__korinfra-tools__*',
      ] as string[],
      disallowedTools: disallowedTools,
      // Load CLAUDE.md / hooks from filesystem when caller requests it.
      // Default [] = isolation mode (no filesystem settings).
      // Pass ['project'] for fix command to load the user's project CLAUDE.md.
      settingSources: (options.settingSources ?? []),
      model: options.model ?? this.config.model,
      maxTurns: options.maxTurns ?? 50,
      maxBudgetUsd: options.maxBudgetUsd ?? 0.50,
      // 'dontAsk' silently denies unlisted tools — correct for automated agents.
      // Commands that need user confirmation should pass permissionMode: 'default'.
      // Commands that need autonomous writes should pass permissionMode: 'acceptEdits'.
      permissionMode: (options.permissionMode ?? 'dontAsk'),
      allowDangerouslySkipPermissions: false,
      includePartialMessages: true,
      persistSession: false,
    };
    if (this.config.extendedThinking && (this.config.thinkingBudget ?? 0) > 0) {
      sdkOptions['thinking'] = { type: 'enabled', budgetTokens: this.config.thinkingBudget };
    }
    if (tools.length > 0) {
      sdkOptions['mcpServers'] = mcpServers;
    }
    if (options.outputFormat) {
      sdkOptions['outputFormat'] = options.outputFormat;
    }
    if (options.cwd) {
      sdkOptions['cwd'] = options.cwd;
    }
    const sdkQuery = query({
      prompt: redact(prompt, 'moderate'),
      options: sdkOptions,
    });

    try {
      for await (const message of sdkQuery) {
        if (ac.signal.aborted) break;
        yield* processStreamEvent(message, startMs);
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      const msg = redact(err instanceof Error ? err.message : String(err), 'moderate');
      yield {
        type: 'error' as const,
        errors: [msg],
        costUsd: 0,
        numTurns: 0,
      } satisfies AgentEvent;
    } finally {
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', onAbort);
      this.abortController = null;
    }
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}

function* processStreamEvent(message: SDKMessage, startMs: number): Generator<AgentEvent> {
  switch (message.type) {
    case 'system':
      yield* processSystemMessage(message as SDKSystemMessage);
      break;
    case 'assistant':
      yield* processAssistantMessage(message, startMs);
      break;
    case 'user':
      yield* processUserMessage(message);
      break;
    case 'result':
      if (message.subtype === 'success') {
        yield* processResultSuccess(message, startMs);
      } else {
        yield* processResultError(message);
      }
      break;
    case 'stream_event':
      yield* dispatchMessage(message);
      break;
    case 'tool_progress':
    case 'auth_status':
    case 'tool_use_summary':
    case 'rate_limit_event':
    case 'prompt_suggestion':
      // These event types are not currently handled
      break;
    default:
      break;
  }
}

function* processSystemMessage(message: SDKSystemMessage): Generator<AgentEvent> {
  if (message.subtype !== 'init') return;
  const failed = (message.mcp_servers ?? []).filter(s => s.status !== 'connected');
  if (failed.length > 0) {
    const names = failed.map(s => `${s.name} (${s.status})`).join(', ');
    yield {
      type: 'error' as const,
      errors: [`MCP server connection failed: ${names}`],
      costUsd: 0,
      numTurns: 0,
    } satisfies AgentEvent;
  }
}

function* processAssistantMessage(message: SDKAssistantMessage, _startMs: number): Generator<AgentEvent> {
  // Text, tool_use, and thinking content arrive incrementally via stream_event
  // (content_block_start / content_block_delta). The final assistant message
  // contains the same content again — do NOT re-emit it to avoid duplicates.
  // Only emit an error event if the assistant message carries an error field.
  if (message.error) {
    const errorLabel = redact(message.error, 'moderate');
    yield {
      type: 'error' as const,
      errors: [errorLabel],
      costUsd: 0,
      numTurns: 0,
    } satisfies AgentEvent;
  }
}

function* processUserMessage(message: SDKUserMessage): Generator<AgentEvent> {
  const msg = message.message;
  if (!Array.isArray(msg.content)) return;
  for (const block of msg.content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
      const toolResult = block as {
        type: 'tool_result';
        tool_use_id: string;
        content?: unknown;
        is_error?: boolean;
      };
      const content = toolResult.content;
      let outputText = '';
      if (typeof content === 'string') {
        outputText = content;
      } else if (Array.isArray(content)) {
        // Preserve the full content array as JSON so callers can inspect all
        // content blocks (e.g. tool_result with multiple blocks).
        outputText = JSON.stringify(content);
      }
      // Redact before surfacing tool output to TUI — agent built-in tools
      // (Read, Grep) can read .env or credential files whose raw content must
      // not reach the UI unredacted.
      outputText = redact(outputText, 'moderate');
      yield {
        type: 'tool_end' as const,
        toolUseId: toolResult.tool_use_id,
        toolName: '',
        isError: toolResult.is_error ?? false,
        output: outputText,
      } satisfies AgentEvent;
    }
  }
}

function* processResultSuccess(message: SDKResultSuccess, startMs: number): Generator<AgentEvent> {
  const costUsd = message.total_cost_usd ?? 0;
  yield {
    type: 'result' as const,
    text: redact(message.result, 'moderate'),
    costUsd,
    numTurns: message.num_turns,
    durationMs: message.duration_ms ?? (Date.now() - startMs),
  } satisfies AgentEvent;
  // Only emit cost_update when there is an actual cost to report.
  if (costUsd > 0) {
    yield { type: 'cost_update' as const, totalCostUsd: costUsd } satisfies AgentEvent;
  }
}

function* processResultError(message: SDKResultError): Generator<AgentEvent> {
  const costUsd = message.total_cost_usd ?? 0;
  const rawErrors = message.errors && message.errors.length > 0 ? message.errors : [message.subtype];
  const errors = rawErrors.map(e => redact(String(e), 'moderate'));
  yield {
    type: 'error' as const,
    errors,
    costUsd,
    numTurns: message.num_turns,
  } satisfies AgentEvent;
}

function* dispatchMessage(message: SDKPartialAssistantMessage): Generator<AgentEvent> {
  const ev = message.event;
  if (ev.type === 'content_block_start') {
    const block = (ev as { type: string; content_block?: { type: string; id?: string; name?: string } }).content_block;
    if (block?.type === 'tool_use' && block.id && block.name) {
      yield {
        type: 'tool_start' as const,
        toolName: block.name,
        toolUseId: block.id,
        input: {},
      } satisfies AgentEvent;
    }
  } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
    yield { type: 'text' as const, text: redact(ev.delta.text, 'moderate') } satisfies AgentEvent;
  } else if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta') {
    yield { type: 'thinking' as const, text: ev.delta.thinking } satisfies AgentEvent;
  }
}

export function createClaudeProvider(config?: ClaudeProviderConfig): ClaudeProvider {
  return new ClaudeProvider(config);
}
