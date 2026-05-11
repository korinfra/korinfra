import { createClaudeProvider } from './claude.js';
import type { AgentProvider, ClaudeProviderConfig } from './types.js';

export type ProviderName = 'claude';

/**
 * Factory that returns the correct AgentProvider implementation.
 *
 * @example
 * ```ts
 * const agent = createAgentProvider('claude', { model: 'claude-sonnet-4-6' });
 * for await (const event of agent.query('Analyze my AWS costs')) {
 *   console.log(event);
 * }
 * ```
 */
export function createAgentProvider(
  provider: ProviderName,
  config?: ClaudeProviderConfig,
): AgentProvider {
  switch (provider) {
    case 'claude':
      return createClaudeProvider(config);
    default: {
      // Exhaustiveness check
      const _exhaustive: never = provider;
      throw new Error(`Unknown agent provider: ${String(_exhaustive)}`);
    }
  }
}

// Re-export everything consumers might need
export { createClaudeProvider } from './claude.js';
export { createToolServer } from './tools-registry.js';
export { prompts, getPrompt } from './prompts.js';
export type { PromptKey } from './prompts.js';
export type {
  AgentEvent,
  AgentProvider,
  AgentQueryOptions,
  ClaudeProviderConfig,
  ToolDefinition,
  ToolResult,
  ThinkingEvent,
  TextEvent,
  ToolStartEvent,
  ToolEndEvent,
  ResultEvent,
  ErrorEvent,
  CostUpdateEvent,
} from './types.js';
