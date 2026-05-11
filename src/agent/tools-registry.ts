import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import type { ToolDefinition } from './types.js';
import type { ToolDefinition as PlainToolDefinition } from '../tools/types.js';
import { redact } from '../redaction/redactor.js';
import { logger } from '../utils/logger.js';

type JsonSchema = Record<string, unknown>;

// Handles: string, number, boolean, integer, array, object, enum. Does NOT handle: anyOf, oneOf, $ref, nullable, format constraints.
/** @internal */
export function jsonSchemaToZod(schema: JsonSchema): z.ZodTypeAny {
  if (schema['anyOf'] !== undefined || schema['oneOf'] !== undefined || schema['$ref'] !== undefined) {
    throw new Error(
      `jsonSchemaToZod: unsupported schema keyword(s): ${
        ['anyOf', 'oneOf', '$ref'].filter((k) => schema[k] !== undefined).join(', ')
      } — register a custom handler before using this schema`
    );
  }

  const type = typeof schema['type'] === 'string' ? schema['type'] : undefined;

  if (type === 'string') {
    const values = Array.isArray(schema['enum'])
      ? schema['enum'].filter((v): v is string => typeof v === 'string')
      : [];
    if (values.length > 0) return z.enum(values as [string, ...string[]]);
    let str = z.string();
    if (typeof schema['minLength'] === 'number') str = str.min(schema['minLength']);
    if (typeof schema['maxLength'] === 'number') str = str.max(schema['maxLength']);
    return str;
  }

  if (type === 'number' || type === 'integer') {
    let base = z.number();
    if (type === 'integer') base = base.int();
    if (typeof schema['minimum'] === 'number') base = base.gte(schema['minimum']);
    if (typeof schema['maximum'] === 'number') base = base.lte(schema['maximum']);
    return base;
  }

  if (type === 'boolean') {
    return z.boolean();
  }

  if (type === 'array') {
    const items: z.ZodTypeAny =
      typeof schema['items'] === 'object' && schema['items'] !== null
        ? jsonSchemaToZod(schema['items'] as JsonSchema)
        : z.unknown();
    const minItems = typeof schema['minItems'] === 'number' ? schema['minItems'] : undefined;
    const maxItems = typeof schema['maxItems'] === 'number' ? schema['maxItems'] : undefined;
    let arr = z.array(items);
    if (minItems !== undefined) arr = arr.min(minItems);
    if (maxItems !== undefined) arr = arr.max(maxItems);
    return arr;
  }

  if (type === 'object') {
    const properties =
      typeof schema['properties'] === 'object' && schema['properties'] !== null
        ? (schema['properties'] as Record<string, JsonSchema>)
        : {};
    const required = new Set(
      Array.isArray(schema['required'])
        ? schema['required'].filter((v): v is string => typeof v === 'string')
        : [],
    );
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, value] of Object.entries(properties)) {
      const field = jsonSchemaToZod(value);
      shape[key] = required.has(key) ? field : field.optional();
    }

    const objectSchema = z.object(shape);
    return schema['additionalProperties'] === false ? objectSchema.strict() : objectSchema.passthrough();
  }

  // z.unknown() is intentional here — allows forward compatibility with newer JSON Schema types
  // without breaking tool registration. Do NOT throw.
  logger.error({ type }, 'Unsupported JSON Schema type in tool definition — using z.unknown() fallback');
  return z.unknown();
}

function toSdkShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const result = jsonSchemaToZod(schema);
  // Runtime guard: jsonSchemaToZod may return z.unknown() for unsupported types.
  // Verify the result is an object schema with a parse method before accessing .shape.
  if (typeof result !== 'object' || result === null || typeof (result as { parse?: unknown }).parse !== 'function') {
    throw new Error(`jsonSchemaToZod: expected Zod schema object, got ${typeof result}`);
  }
  const zodObj = result as unknown as z.ZodObject<Record<string, z.ZodTypeAny>>;
  if (typeof zodObj.shape !== 'object' || zodObj.shape === null) {
    // Not a ZodObject (e.g. z.unknown()) — return empty shape so registration
    // still succeeds but the tool accepts no typed arguments.
    return {};
  }
  return zodObj.shape;
}

/**
 * Convert an array of ToolDefinitions into an in-process MCP server that the
 * Claude Agent SDK can use directly (no subprocess, no network hop).
 *
 * The SDK's `tool()` helper expects a Zod v4 raw shape — our ToolDefinition
 * uses `ZodRawShape` from `zod/v4`, so the schemas pass through without
 * any conversion.
 */
export function createToolServer(
  name: string,
  tools: Array<ToolDefinition | PlainToolDefinition>,
): McpSdkServerConfigWithInstance {
  const sdkTools = tools.map((def) =>
    tool(
      def.name,
      def.description,
      toSdkShape(def.inputSchema as Record<string, unknown>),
      async (args, _extra): Promise<CallToolResult> => {
        const zodSchema = z.object(toSdkShape(def.inputSchema as Record<string, unknown>));
        const parseResult = zodSchema.safeParse(args);
        if (!parseResult.success) {
          return {
            content: [{
              type: 'text' as const,
              text: `Invalid tool arguments: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            }],
            isError: true,
          };
        }
        try {
          const result = await def.handler(parseResult.data);
          return {
            content: result.content.map((c) => {
              if (c.type === 'text') {
                return { type: 'text' as const, text: c.text };
              }
              // image block — pass through as-is
              return c;
            }),
            isError: result.isError ?? false,
          };
        } catch (err) {
          const message = redact(err instanceof Error ? err.message : String(err), 'moderate');
          return {
            content: [{ type: 'text' as const, text: `Tool error: ${message}` }],
            isError: true,
          };
        }
      },
      def.annotations !== null && def.annotations !== undefined ? { annotations: def.annotations } : undefined,
    ),
  );

  return createSdkMcpServer({ name, tools: sdkTools });
}
