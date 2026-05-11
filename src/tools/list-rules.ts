import { listRules } from '../rules/registry.js';
import { jsonResult } from './types.js';
import type { ToolDefinition } from './types.js';

/** MCP tool: list all built-in cost optimization rules. */
export const listRulesTool: ToolDefinition = {
  name: 'list_rules',
  description:
    'List all available built-in cost optimization rules with their IDs, titles, descriptions, categories, and impact/risk levels.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
  // eslint-disable-next-line @typescript-eslint/require-await -- implements Tool.handler: (args) => Promise<ToolResult>
  handler: async () => {
    const rules = listRules();
    return jsonResult({ rules, count: rules.length });
  },
};
