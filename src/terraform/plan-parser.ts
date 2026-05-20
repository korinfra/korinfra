/**
 * Terraform plan JSON parser.
 *
 * Reads the output of `terraform show -json <plan>` and validates the
 * subset of fields we use for cost-impact analysis. Plans from OpenTofu
 * use the same schema and are supported without dedicated tests.
 *
 * The plan JSON schema is documented at:
 * https://developer.hashicorp.com/terraform/internals/json-format
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ChangeSchema = z.object({
  // Default to ['no-op'] when the field is missing entirely (legacy plans).
  // An empty array still slips through Zod default — handled by resolveAction().
  actions: z.array(z.string()).default(['no-op']),
  before: z.record(z.string(), z.unknown()).nullable().optional(),
  after: z.record(z.string(), z.unknown()).nullable().optional(),
  after_unknown: z.record(z.string(), z.unknown()).optional(),
});

const ResourceChangeSchema = z.object({
  address: z.string(),
  type: z.string(),
  module_address: z.string().optional(),
  change: ChangeSchema,
});

const PlanSchema = z.object({
  format_version: z.string().optional(),
  terraform_version: z.string().optional(),
  resource_changes: z.array(ResourceChangeSchema).default([]),
  configuration: z.unknown().optional(),
});

export type TerraformPlan = z.infer<typeof PlanSchema>;
export type TerraformResourceChange = z.infer<typeof ResourceChangeSchema>;
export type TerraformPlanChange = z.infer<typeof ChangeSchema>;

// ---------------------------------------------------------------------------
// Region extraction (best-effort)
// ---------------------------------------------------------------------------

/**
 * Best-effort extraction of the default AWS region from the plan's
 * `configuration.provider_config.aws.expressions.region.constant_value` path.
 *
 * Returns null when the path is missing or the value is not a string —
 * callers should fall back to a hardcoded default (e.g. 'us-east-1').
 *
 * Alias-provider plans (`provider["aws.us-east-2"]`) are not fully resolved
 * here; consumers reading the alias provider must inspect `configuration`
 * themselves.
 */
export function extractDefaultRegion(plan: TerraformPlan): string | null {
  const cfg = plan.configuration;
  if (cfg === null || cfg === undefined || typeof cfg !== 'object') return null;
  const providerConfig = (cfg as Record<string, unknown>)['provider_config'];
  if (providerConfig === null || providerConfig === undefined || typeof providerConfig !== 'object') return null;
  const aws = (providerConfig as Record<string, unknown>)['aws'];
  if (aws === null || aws === undefined || typeof aws !== 'object') return null;
  const expressions = (aws as Record<string, unknown>)['expressions'];
  if (expressions === null || expressions === undefined || typeof expressions !== 'object') return null;
  const region = (expressions as Record<string, unknown>)['region'];
  if (region === null || region === undefined || typeof region !== 'object') return null;
  const value = (region as Record<string, unknown>)['constant_value'];
  if (typeof value !== 'string' || value === '') return null;
  return value;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Validate and parse a Terraform plan from a JSON string. Throws on validation error. */
export function parsePlanFromString(content: string): TerraformPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in Terraform plan: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  const result = PlanSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '(root)';
    const message = issue?.message ?? 'unknown validation error';
    throw new Error(`Terraform plan does not match expected schema at "${path}": ${message}`);
  }
  return result.data;
}

const MAX_PLAN_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Read a Terraform plan JSON file from disk and validate it. */
export async function parsePlanFile(filePath: string): Promise<TerraformPlan> {
  const absPath = resolve(filePath);
  let buffer: Buffer;
  try {
    buffer = await readFile(absPath);
  } catch (err) {
    throw new Error(`Failed to read Terraform plan file ${absPath}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  if (buffer.length > MAX_PLAN_FILE_BYTES) {
    throw new Error(`Terraform plan file is too large: ${buffer.length} bytes (max ${MAX_PLAN_FILE_BYTES})`);
  }
  const plan = parsePlanFromString(buffer.toString('utf8'));
  logger.debug({ planFile: absPath, changes: plan.resource_changes.length }, 'Parsed Terraform plan');
  return plan;
}
