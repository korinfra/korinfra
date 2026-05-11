/**
 * Shared tool call formatting helpers for ToolCallCard and AgentLoop.
 */


export interface ToolCallCardRecord {
  id: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
}

/**
 * Format tool duration as a human-readable string.
 * Returns "1.4s" or "running" if endedAt is missing.
 */
export function formatToolDuration(startedAt: number, endedAt?: number): string {
  if (endedAt === undefined) {
    return 'running';
  }

  const ms = endedAt - startedAt;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

