/**
 * MCP tool: analyze_plan
 *
 * Reads a `terraform show -json plan.tfplan` output, computes per-resource
 * monthly cost deltas, and runs both rule engines (cost rules + security
 * rules) against the synthetic post-apply state to surface findings that
 * would trigger after apply.
 */

import { existsSync, statSync } from 'node:fs';
import path, { resolve } from 'node:path';

import type { Resource } from '../aws/types.js';
import { estimateMonthlyCost } from '../pricing/engine.js';
import { redactObject } from '../redaction/index.js';
import { evaluateRules } from '../rules/index.js';
import { evaluateSecurityRules } from '../rules/security/index.js';
import { extractDefaultRegion, parsePlanFile } from '../terraform/plan-parser.js';
import type { TerraformResourceChange } from '../terraform/plan-parser.js';
import {
  buildTaskDefIndex,
  resolveAction,
  synthesizeResource,
  type CostStatus,
  type NormalizedAction,
  type TaskDefIndex,
} from '../terraform/plan-resource.js';
import { normalizeResourceType, parseTerraformDir } from '../terraform/parser.js';
import type { TerraformResource } from '../terraform/types.js';
import { logger } from '../utils/logger.js';

import { assertInsideRoot, errorResult, jsonResult } from './types.js';
import type { ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Output types — also imported by the pipeline extractor.
// ---------------------------------------------------------------------------

type AnalyzePlanFindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface AnalyzePlanChangeRow {
  action: NormalizedAction;
  address: string;
  tfType: string;
  resourceType: string;
  beforeUsd: number;
  afterUsd: number;
  deltaUsd: number;
  costStatus: CostStatus;
  triggeredRuleIds: string[];
  filePath?: string;
}

export interface AnalyzePlanFinding {
  ruleId: string;
  address: string;
  severity: AnalyzePlanFindingSeverity;
  title: string;
  description: string;
  suggestedAction?: string;
  filePath?: string;
}

export interface AnalyzePlanResult {
  summary: {
    netDeltaMonthlyUsd: number;
    netDeltaAnnualUsd: number;
    counts: { create: number; update: number; destroy: number; replace: number };
    unpricedCount: number;
    unknownCount: number;
    variableCount: number;
    skippedCount: number;
  };
  changes: AnalyzePlanChangeRow[];
  findings: AnalyzePlanFinding[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSeverity(raw: string): AnalyzePlanFindingSeverity {
  if (raw === 'critical' || raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  return 'medium';
}

function safeCost(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Round to 2 decimals to avoid JSON output like `1237.8999999999999`. */
function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

// Net-delta total includes only 'known' and 'variable' (with a base floor)
// rows. 'unknown' / 'partial-unknown' / 'unpriced' rows are reported in the
// counts but excluded from the headline delta to avoid misleading totals.
function contributesToTotal(status: CostStatus): boolean {
  return status === 'known' || status === 'variable';
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

async function costForChange(
  change: TerraformResourceChange,
  side: 'before' | 'after',
  defaultRegion: string,
  taskDefIndex: TaskDefIndex,
): Promise<{
  cost: number;
  status: CostStatus;
  resource: Resource | null;
  tfResource: TerraformResource | null;
  warnings?: string[];
} | null> {
  const synth = synthesizeResource(change, side, defaultRegion, taskDefIndex);
  if (synth === null) return null;
  const raw = await estimateMonthlyCost(synth.resource);
  return {
    cost: safeCost(raw),
    status: synth.costStatus,
    resource: synth.resource,
    tfResource: synth.tfResource,
    ...(synth.warnings !== undefined ? { warnings: synth.warnings } : {}),
  };
}

export async function runAnalyzePlan(
  planFile: string,
  currency = 'USD',
  options?: { tfdirPath?: string },
): Promise<AnalyzePlanResult> {
  const plan = await parsePlanFile(planFile);
  const planRegion = extractDefaultRegion(plan);
  const defaultRegion = planRegion ?? 'us-east-1';
  const planWarnings: string[] = [];
  if (planRegion === null) {
    logger.debug({ planFile, defaultRegion }, 'Plan has no provider region — defaulting');
    planWarnings.push(
      'No AWS region found in plan provider config — defaulting to us-east-1. ' +
      'Set a provider region block to avoid mispriced resources in non-US regions.',
    );
  }

  const taskDefIndex = buildTaskDefIndex(plan.resource_changes);

  // Build filePath index from --tfdir if provided
  const filePathByAddress = new Map<string, string>();
  const changes: AnalyzePlanChangeRow[] = [];
  const afterResources: Resource[] = [];
  const afterTfResources: TerraformResource[] = [];

  if (options?.tfdirPath !== undefined) {
    try {
      const tfResources = await parseTerraformDir(options.tfdirPath);
      const cwd = process.cwd();
      for (const r of tfResources) {
        if (r.filePath !== '' && r.type !== 'module' && r.type !== 'variable' && r.type !== 'local') {
          filePathByAddress.set(r.address, path.relative(cwd, r.filePath));
        }
      }
    } catch (err) {
      planWarnings.push(`--tfdir scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let createCount = 0;
  let updateCount = 0;
  let destroyCount = 0;
  let replaceCount = 0;
  let skippedCount = 0;
  let unknownCount = 0;
  let unpricedCount = 0;
  let variableCount = 0;
  let netDelta = 0;

  for (const change of plan.resource_changes) {
    const action = resolveAction(change.change.actions);
    if (action === 'no-op' || action === 'read') {
      skippedCount++;
      continue;
    }
    if (change.address.startsWith('data.')) {
      skippedCount++;
      continue;
    }

    const before = (action === 'update' || action === 'destroy' || action === 'replace')
      ? await costForChange(change, 'before', defaultRegion, taskDefIndex)
      : null;
    const after = (action === 'create' || action === 'update' || action === 'replace')
      ? await costForChange(change, 'after', defaultRegion, taskDefIndex)
      : null;

    if (action === 'destroy' && before === null) {
      planWarnings.push(`${change.address}: before state unavailable for destroy — savings shown as $0.00`);
    }
    // Warnings for unresolvable task defs are only surfaced for the after
    // (future) side — before-side misses are expected when the currently-deployed
    // task def is not part of this plan.
    if (after?.warnings !== undefined) planWarnings.push(...after.warnings);
    const beforeUsd = before?.cost ?? 0;
    const afterUsd = after?.cost ?? 0;
    const deltaUsd = afterUsd - beforeUsd;

    // Pick the cost status that represents the *kept* side: for create/update/
    // replace use 'after'; for destroy use 'before'. Fall back through.
    const costStatus: CostStatus =
      after?.status ?? before?.status ?? 'unpriced';

    switch (action) {
      case 'create':
        createCount++;
        break;
      case 'update':
        updateCount++;
        break;
      case 'destroy':
        destroyCount++;
        break;
      case 'replace':
        replaceCount++;
        break;
      // 'no-op' / 'read' filtered above
      default:
        break;
    }

    if (contributesToTotal(costStatus)) {
      netDelta += deltaUsd;
    }
    if (costStatus === 'unknown' || costStatus === 'partial-unknown') unknownCount++;
    else if (costStatus === 'unpriced') unpricedCount++;
    else if (costStatus === 'variable') variableCount++;

    if (after?.resource !== null && after?.resource !== undefined) {
      afterResources.push(after.resource);
    }
    if (after?.tfResource !== null && after?.tfResource !== undefined) {
      afterTfResources.push(after.tfResource);
    }

    changes.push({
      action,
      address: change.address,
      tfType: change.type,
      resourceType: normalizeResourceType(change.type),
      beforeUsd: round2(beforeUsd),
      afterUsd: round2(afterUsd),
      deltaUsd: round2(deltaUsd),
      costStatus,
      triggeredRuleIds: [], // filled in below
    });
  }

  // Annotate synthesized resources with file paths when --tfdir was provided.
  if (filePathByAddress.size > 0) {
    const unmatchedModule: string[] = [];
    const unmatchedRoot: string[] = [];
    for (const res of afterResources) {
      const fp = filePathByAddress.get(res.id);
      if (fp !== undefined) {
        res.configuration['file_path'] = fp; // consumed by cost rules via strConfig
      } else if (res.id.startsWith('module.')) {
        unmatchedModule.push(res.id);
      } else {
        unmatchedRoot.push(res.id);
      }
    }
    for (const tfRes of afterTfResources) {
      const fp = filePathByAddress.get(tfRes.address);
      if (fp !== undefined) tfRes.filePath = fp; // consumed by security rule engine
    }
    // Populate filePath on change rows for display/downstream tooling.
    for (const row of changes) {
      const fp = filePathByAddress.get(row.address);
      if (fp !== undefined) row.filePath = fp;
    }
    if (unmatchedModule.length > 0) {
      planWarnings.push(
        `${unmatchedModule.length} module resource(s) not matched in --tfdir ` +
        `(module paths are not scanned): ${unmatchedModule.join(', ')}`,
      );
    }
    if (unmatchedRoot.length > 0) {
      planWarnings.push(
        `${unmatchedRoot.length} resource(s) not matched in --tfdir: ${unmatchedRoot.join(', ')}`,
      );
    }
  }

  // Run both rule engines over the post-apply state.
  const { recommendations: costRecs, warnings: costWarnings } = evaluateRules(
    afterResources,
    undefined,
    undefined,
    currency,
  );
  const securityFindings = evaluateSecurityRules(afterTfResources);

  const findings: AnalyzePlanFinding[] = [];
  const seen = new Set<string>();

  for (const rec of costRecs) {
    const ruleId = rec.ruleId ?? '';
    const key = `${ruleId}::${rec.resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fp = filePathByAddress.get(rec.resourceId);
    findings.push({
      ruleId,
      address: rec.resourceId,
      severity: normalizeSeverity(rec.impact),
      title: rec.title,
      description: rec.description,
      ...(rec.suggestedAction !== undefined ? { suggestedAction: rec.suggestedAction } : {}),
      ...(fp !== undefined ? { filePath: fp } : {}),
    });
  }
  for (const f of securityFindings) {
    const key = `${f.ruleId}::${f.resource}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fp = filePathByAddress.get(f.resource);
    findings.push({
      ruleId: f.ruleId,
      address: f.resource,
      severity: normalizeSeverity(f.severity),
      title: f.title,
      description: f.description,
      ...(f.recommendation !== '' ? { suggestedAction: f.recommendation } : {}),
      ...(fp !== undefined ? { filePath: fp } : {}),
    });
  }

  // Attach triggeredRuleIds back to each change row.
  const findingsByAddress = new Map<string, string[]>();
  for (const f of findings) {
    const arr = findingsByAddress.get(f.address) ?? [];
    arr.push(f.ruleId);
    findingsByAddress.set(f.address, arr);
  }
  for (const row of changes) {
    const ruleIds = findingsByAddress.get(row.address);
    if (ruleIds !== undefined) row.triggeredRuleIds = ruleIds;
  }

  // Filter rule-warning noise from utilization-missing reasons — every
  // synthetic plan resource has no utilization, so those warnings would
  // overwhelm useful diagnostics.
  const warnings = [
    ...planWarnings,
    ...costWarnings
      .filter((w) => !/utilization|metrics|monthly_cost/i.test(w.reason))
      .map((w) => `${w.ruleId} @ ${w.resourceId}: ${w.reason}`),
  ];

  const netDeltaMonthlyUsd = round2(netDelta);

  return {
    summary: {
      netDeltaMonthlyUsd,
      netDeltaAnnualUsd: round2(netDeltaMonthlyUsd * 12),
      counts: {
        create: createCount,
        update: updateCount,
        destroy: destroyCount,
        replace: replaceCount,
      },
      unpricedCount,
      unknownCount,
      variableCount,
      skippedCount,
    },
    changes,
    findings,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const analyzePlanTool: ToolDefinition = {
  name: 'analyze_plan',
  description:
    'Analyze a Terraform plan JSON file (terraform show -json plan.tfplan) for ' +
    'monthly cost delta and post-apply rule findings. Returns before/after costs ' +
    'per resource change, a net delta, and findings (cost + security) that would ' +
    'trigger against the post-apply state. No AWS API calls.',
  inputSchema: {
    type: 'object',
    properties: {
      planFile: {
        type: 'string',
        description:
          'Absolute or cwd-relative path to terraform show -json output (.json file).',
      },
      currency: {
        type: 'string',
        description: 'Currency code for reasoning text in findings (default "USD").',
      },
      tfdir: {
        type: 'string',
        description:
          'Optional path to the Terraform source directory (.tf files). When supplied, findings include filePath for each matched resource address.',
      },
    },
    required: ['planFile'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    try {
      const planFile = args['planFile'];
      if (typeof planFile !== 'string' || planFile === '') {
        return errorResult('planFile must be a non-empty string');
      }
      const currency = typeof args['currency'] === 'string' && args['currency'] !== ''
        ? args['currency']
        : 'USD';
      const abs = resolve(planFile);
      assertInsideRoot(abs, 'planFile');
      if (!abs.toLowerCase().endsWith('.json')) {
        return errorResult(
          `planFile must be a .json file (terraform show -json output): ${abs}`,
        );
      }
      if (!existsSync(abs)) {
        return errorResult(`planFile does not exist: ${abs}`);
      }

      let tfdirPath: string | undefined;
      const tfdirArg = args['tfdir'];
      if (typeof tfdirArg === 'string' && tfdirArg !== '') {
        const absTfdir = resolve(tfdirArg);
        assertInsideRoot(absTfdir, 'tfdir');
        if (!existsSync(absTfdir) || !statSync(absTfdir).isDirectory()) {
          return errorResult(`tfdir does not exist or is not a directory: ${absTfdir}`);
        }
        tfdirPath = absTfdir;
      }

      const result = await runAnalyzePlan(abs, currency, ...(tfdirPath !== undefined ? [{ tfdirPath }] : []));
      return jsonResult(redactObject(result, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
