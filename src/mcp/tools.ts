/**
 * MCP tool registration — converts ToolDefinition[] to low-level Server request handlers.
 * Uses raw setRequestHandler on the underlying Server to support plain JSON Schema inputSchema.
 * Thin adapter: no business logic here.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { allTools } from '../tools/index.js';
import { redact } from '../redaction/redactor.js';

// Sanitize tool descriptions to prevent zero-width character and control character injection
// Zero-width characters: U+200B (ZERO WIDTH SPACE), U+200C (ZERO WIDTH NON-JOINER),
// U+200D (ZERO WIDTH JOINER), U+FEFF (ZERO WIDTH NO-BREAK SPACE)
// Control characters: U+0000-U+001F, U+007F-U+009F
function sanitizeToolDescription(desc: string): string {
  return desc
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '') // Remove zero-width characters
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '');       // Remove control characters
}

/**
 * Register all korinfra tools on the given low-level Server instance.
 * We use setRequestHandler directly because our tools carry plain JSON Schema
 * objects (not Zod schemas), which the high-level McpServer.registerTool API
 * rejects at runtime.
 */
export function registerTools(server: Server): void {
  // Guard against duplicate tool names — fail fast at startup
  const toolNames = new Set<string>();
  for (const tool of allTools) {
    if (toolNames.has(tool.name)) {
      throw new Error(`Duplicate MCP tool name detected: "${tool.name}". Fix src/tools/index.ts.`);
    }
    toolNames.add(tool.name);
  }

  // List tools
  // eslint-disable-next-line @typescript-eslint/require-await -- MCP SDK requires async handler signature
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: allTools.map((tool) => ({
        name: tool.name,
        description: sanitizeToolDescription(tool.description),
        inputSchema: tool.inputSchema as {
          type: 'object';
          properties?: Record<string, unknown>;
        },
        annotations: tool.annotations
          ? {
              readOnlyHint: tool.annotations.readOnlyHint,
              destructiveHint: tool.annotations.destructiveHint,
              idempotentHint: tool.annotations.idempotentHint,
            }
          : undefined,
      })),
    };
  });

  // H-3: Define destructive tools that require MCP_ALLOW_WRITE flag
  const DESTRUCTIVE_TOOLS = new Set([
    'create_github_pr',
    'apply_recommendation',
    'save_scan',
  ]);
  const WRITE_OPS_DISABLED_MSG = 'Write operations are disabled. Set MCP_ALLOW_WRITE=1 and restart the MCP server to enable: create_github_pr, apply_recommendation, save_scan';

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const tool = allTools.find((t) => t.name === name);

    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // H-3: Check MCP_ALLOW_WRITE for destructive tools
    if (DESTRUCTIVE_TOOLS.has(name) && process.env['MCP_ALLOW_WRITE'] !== '1') {
      return {
        content: [{ type: 'text' as const, text: WRITE_OPS_DISABLED_MSG }],
        isError: false,
      };
    }

    const toolArgs = request.params.arguments ?? {};
    if (tool.inputSchema?.['required']) {
      for (const key of tool.inputSchema['required'] as string[]) {
        if (!(key in toolArgs)) {
          return { content: [{ type: 'text' as const, text: `Missing required parameter: ${key}` }], isError: true };
        }
        const expectedType = (tool.inputSchema?.['properties'] as Record<string, { type?: string }>)?.[key]?.type;
        if (expectedType) {
          const actualType = Array.isArray(toolArgs[key]) ? 'array' : typeof toolArgs[key];
          if (toolArgs[key] !== null && actualType !== expectedType) {
            return {
              content: [{ type: 'text' as const, text: `Parameter '${key}' must be of type ${expectedType}, got ${actualType}` }],
              isError: true,
            };
          }
        }
      }
    }

    // Validate optional parameters — if provided, must match declared type
    for (const [key, value] of Object.entries(toolArgs)) {
      if (value === undefined) continue;
      const paramSchema = (tool.inputSchema['properties'] as Record<string, { type?: string }>)?.[key];
      if (!paramSchema?.type) continue;
      const expectedType = paramSchema.type;
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== expectedType && !(expectedType === 'integer' && typeof value === 'number')) {
        return {
          content: [{ type: 'text' as const, text: `Invalid type for parameter "${key}": expected ${expectedType}, got ${actualType}` }],
          isError: true,
        };
      }
    }

    try {
      const result = await tool.handler(
        toolArgs,
      );
      return {
        content: result.content,
        isError: result.isError,
      };
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err), 'moderate');
      return {
        content: [{ type: 'text' as const, text: `Tool error: ${message}` }],
        isError: true,
      };
    }
  });
}
