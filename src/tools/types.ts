/**
 * Shared types for MCP tools — used by both agent mode and MCP server mode.
 */

import { sep } from 'node:path';
import { redact } from '../redaction/redactor.js';
import type { TerraformResource } from '../terraform/types.js';

export function assertInsideRoot(resolvedPath: string, label = 'path'): void {
  const root = process.cwd();
  // Reject filesystem roots, drive roots, and Windows extended-length / UNC paths
  // where path normalization rules differ and containment checks are unreliable.
  if (root === '/' || /^[A-Z]:\\?$/i.test(root) || /^\\\\[?.]?\\/i.test(root)) {
    throw new Error(
      `assertInsideRoot: process.cwd() is "${root}" — cannot safely contain paths. ` +
      `Run korinfra from a project directory, not the filesystem root.`
    );
  }
  const normalizedRoot = root.endsWith(sep) ? root : root + sep;
  if (resolvedPath !== root && !resolvedPath.startsWith(normalizedRoot)) {
    throw new Error(`${label} must be inside the project directory: ${resolvedPath}`);
  }
}

/** Result returned by tool handlers. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Definition for a custom tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

/** Helper to create a successful JSON result. */
export function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/** Helper to create a text result. */
export function textResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Normalize a raw terraform resource record into a well-typed TerraformResource shape.
 * Shared by scan-terraform and classify-resources tools.
 */
export function normalizeTerraformResource(
  resource: TerraformResource | Record<string, unknown>,
): TerraformResource {
  // Cast required: TerraformResource | Record<string, unknown> union is not directly indexable
  const r = resource as unknown as Record<string, unknown>;
  const filePath =
    typeof r['filePath'] === 'string'
      ? r['filePath']
      : typeof r['filename'] === 'string'
        ? r['filename']
        : '';
  const configuration =
    typeof r['configuration'] === 'object' && r['configuration'] !== null
      ? (r['configuration'] as Record<string, unknown>)
      : typeof r['config'] === 'object' && r['config'] !== null
        ? (r['config'] as Record<string, unknown>)
        : {};

  return {
    address: typeof r['address'] === 'string' ? r['address'] : '',
    type: typeof r['type'] === 'string' ? r['type'] : '',
    name: typeof r['name'] === 'string' ? r['name'] : '',
    provider: typeof r['provider'] === 'string' ? r['provider'] : '',
    module: typeof r['module'] === 'string' ? r['module'] : '',
    filePath,
    lineNumber: typeof r['lineNumber'] === 'number' ? r['lineNumber'] : 0,
    configuration,
    estimatedCost:
      typeof r['estimatedCost'] === 'number' ? r['estimatedCost'] : 0,
    dependencies: Array.isArray(r['dependencies'])
      ? (r['dependencies'] as string[])
      : [],
  };
}

/** Helper to create an error result. */
export function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: redact(message, 'moderate') }],
    isError: true,
  };
}
