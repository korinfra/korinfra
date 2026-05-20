/**
 * Shared types for MCP tools — used by both agent mode and MCP server mode.
 */

import { sep } from 'node:path';
import { loadConfig } from '../config/index.js';
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

/**
 * Wraps a tool handler function in a standard try/catch → errorResult pattern.
 * Eliminates per-tool boilerplate.
 */
export function createToolHandler<T>(
  fn: (args: T) => Promise<ToolResult>,
): (args: T) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

/** Extract a string arg from an untyped args record. */
export function getStringArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  return typeof args[key] === 'string' ? args[key] : fallback;
}

/** Extract a typed array arg from an untyped args record. */
export function getArrayArg<T>(args: Record<string, unknown>, key: string): T[] {
  return Array.isArray(args[key]) ? (args[key] as T[]) : [];
}

/**
 * Load the default AWS region from korinfra config.
 * Returns undefined if config is unavailable or the field is not set.
 */
export async function getDefaultRegion(): Promise<string | undefined> {
  try {
    const config = await loadConfig();
    return config.aws?.default_region;
  } catch {
    return undefined;
  }
}

/** Shared JSON Schema fragment for the AWS CLI profile parameter. */
export const PROFILE_SCHEMA = { type: 'string', description: 'AWS CLI profile name.' } as const;

/** Shared JSON Schema fragment for the regions array parameter. */
export const REGIONS_SCHEMA = { type: 'array', items: { type: 'string' }, description: 'AWS regions to scan.', maxItems: 20 } as const;
