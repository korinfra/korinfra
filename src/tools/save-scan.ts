import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getDb } from '../storage/db.js';
import { insertScan } from '../storage/queries/scans.js';
import { insertResources } from '../storage/queries/resources.js';
import { insertCosts } from '../storage/queries/costs.js';
import { upsertRecommendations } from '../storage/queries/recommendations.js';
import type { Resource } from '../storage/queries/resources.js';
import type { CostEntry as StorageCostEntry } from '../storage/queries/costs.js';
import type { CostEntry as AwsCostEntry } from '../aws/types.js';
import type { Recommendation } from '../storage/queries/recommendations.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';
import { redactObject } from '../redaction/redactor.js';

function normalizeResource(r: Record<string, unknown>): Resource {
  const resource_id = (typeof r['resource_id'] === 'string' && r['resource_id'])
    || (typeof r['id'] === 'string' && r['id'])
    || `unknown-${randomUUID()}`;
  return {
    resource_id,
    arn: typeof r['arn'] === 'string' ? r['arn'] : null,
    type: typeof r['type'] === 'string' ? r['type'] : 'unknown',
    name: typeof r['name'] === 'string' ? r['name'] : null,
    region: typeof r['region'] === 'string' ? r['region'] : null,
    state: typeof r['state'] === 'string' ? r['state'] : null,
    instance_type: typeof r['instance_type'] === 'string' ? r['instance_type'] : null,
    monthly_cost: (() => {
      // Top-level field (compact mode) takes priority; fall back to configuration.monthlyCost (non-compact).
      const cfg = r['configuration'];
      const fromConfig = cfg && typeof cfg === 'object' && !Array.isArray(cfg)
        ? (cfg as Record<string, unknown>)['monthlyCost']
        : undefined;
      const v = typeof r['monthly_cost'] === 'number' ? r['monthly_cost']
        : typeof fromConfig === 'number' ? fromConfig
        : 0;
      // Reject NaN / Infinity / negative so a single bad pricing lookup
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    })(),
    monthly_cost_source: (() => {
      const direct = r['monthly_cost_source'];
      if (direct === 'cost_explorer' || direct === 'pricing_api') return direct;
      const cfg = r['configuration'];
      if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        const src = (cfg as Record<string, unknown>)['monthlyCostSource'];
        if (src === 'cost_explorer' || src === 'pricing_api') return src;
      }
      return null;
    })(),
    tags: (r['tags'] && typeof r['tags'] === 'object' && !Array.isArray(r['tags']))
      ? r['tags'] as Record<string, string> : null,
    utilization: (r['utilization'] && typeof r['utilization'] === 'object')
      ? r['utilization'] as Record<string, unknown> : null,
    configuration: (r['configuration'] && typeof r['configuration'] === 'object')
      ? r['configuration'] as Record<string, unknown> : null,
    scenario: typeof r['scenario'] === 'string' ? r['scenario'] : null,
    terraform_address: typeof r['terraform_address'] === 'string' ? r['terraform_address'] : null,
    collected_at: typeof r['collected_at'] === 'string' ? r['collected_at'] : null,
  } satisfies Resource;
}

function mapCostEntry(awsCost: AwsCostEntry): StorageCostEntry {
  const monthlyVal = awsCost.granularity === 'MONTHLY' ? awsCost.amount : awsCost.amount * 30;
  const dailyVal   = awsCost.granularity === 'DAILY'   ? awsCost.amount : awsCost.amount / 30;
  return {
    service_name: awsCost.service,
    cost_date: awsCost.startDate,
    monthly_cost: Number.isFinite(monthlyVal) ? monthlyVal : 0,
    daily_cost:   Number.isFinite(dailyVal)   ? dailyVal   : 0,
    region: awsCost.region ?? null,
    currency: awsCost.unit,
  };
}

function normalizeCost(c: Record<string, unknown>): AwsCostEntry {
  return {
    service: typeof c['service'] === 'string' ? c['service'] : 'Unknown',
    amount: typeof c['amount'] === 'number' ? c['amount'] : 0,
    unit: typeof c['unit'] === 'string' ? c['unit'] : 'USD',
    startDate: typeof c['startDate'] === 'string' ? c['startDate'] : '',
    endDate: typeof c['endDate'] === 'string' ? c['endDate'] : '',
    granularity: c['granularity'] === 'MONTHLY' ? 'MONTHLY' : 'DAILY',
    ...(typeof c['region'] === 'string' ? { region: c['region'] } : {}),
  };
}

function normalizeRecommendation(r: Record<string, unknown>): Recommendation {
  // Validate file_path before storing — must be inside project and have .tf/.tf.json extension
  let validatedFilePath: string | undefined;
  if (typeof r['file_path'] === 'string' && r['file_path']) {
    const resolved = path.resolve(r['file_path']);
    const cwd = process.cwd();
    const sep = path.sep;
    const isInside = resolved.startsWith(cwd + sep) || resolved === cwd;
    const isTerraform = /\.(tf|tf\.json|hcl)$/.test(resolved);
    validatedFilePath = (isInside && isTerraform) ? r['file_path'] : undefined;
  }

  return {
    id: typeof r['id'] === 'string' ? r['id'] : randomUUID(),
    scan_id: typeof r['scan_id'] === 'string' ? r['scan_id'] : '',
    resource_id: typeof r['resource_id'] === 'string' ? r['resource_id'] : null,
    resource_type: typeof r['resource_type'] === 'string' ? r['resource_type'] : null,
    type: typeof r['type'] === 'string' ? r['type'] : 'general',
    title: typeof r['title'] === 'string' ? r['title'].slice(0, 500) : 'Untitled',
    description: typeof r['description'] === 'string' ? r['description'].slice(0, 2000) : null,
    reasoning: typeof r['reasoning'] === 'string' ? r['reasoning'].slice(0, 2000) : null,
    estimated_savings: typeof r['estimated_savings'] === 'number' ? r['estimated_savings'] : 0,
    confidence: typeof r['confidence'] === 'number' ? r['confidence'] : 0,
    quality_score: typeof r['quality_score'] === 'number' ? r['quality_score'] : 0,
    impact: typeof r['impact'] === 'string' ? r['impact'] : 'medium',
    risk: typeof r['risk'] === 'string' ? r['risk'] : 'low',
    status: 'draft',
    current_config: (() => { const v = r['current_config'] ?? r['currentConfig']; return (v !== null && v !== undefined && typeof v === 'object') ? v as Record<string, unknown> : null; })(),
    suggested_config: (() => { const v = r['suggested_config'] ?? r['suggestedConfig']; return (v !== null && v !== undefined && typeof v === 'object') ? v as Record<string, unknown> : null; })(),
    patch_content: typeof r['patch_content'] === 'string' ? r['patch_content'] : null,
    file_path: validatedFilePath ?? null,
    implementation_steps: Array.isArray(r['implementation_steps']) ? (r['implementation_steps'] as string[]) : null,
    scenario: typeof r['scenario'] === 'string' ? r['scenario'] : null,
    ai_model: typeof r['ai_model'] === 'string' ? r['ai_model'] : null,
  };
}

interface SaveScanInput {
  aws_profile?: string;
  aws_region?: string;
  terraform_path?: string;
  resources?: Record<string, unknown>[];
  costs?: Record<string, unknown>[];
  recommendations?: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
  /** ISO 8601 timestamp when the scan pipeline actually started. If omitted, falls back to current time. */
  started_at?: string;
}

export const saveScanTool: ToolDefinition = {
  name: 'save_scan',
  description:
    'Saves an AWS cost scan result (resources, costs, recommendations) to the local SQLite database. Returns the scan ID that can be used to retrieve or compare results later.',
  inputSchema: {
    type: 'object',
    properties: {
      aws_profile: { type: 'string', description: 'AWS profile used for the scan' },
      aws_region: { type: 'string', description: 'Primary AWS region scanned' },
      terraform_path: { type: 'string', description: 'Path to Terraform configuration' },
      resources: {
        type: 'array',
        description: 'Array of scanned AWS resources',
        items: { type: 'object' },
      },
      costs: {
        type: 'array',
        description: 'Array of cost entries from Cost Explorer',
        items: { type: 'object' },
      },
      recommendations: {
        type: 'array',
        description: 'Array of cost optimization recommendations',
        items: { type: 'object' },
      },
      metadata: {
        type: 'object',
        description: 'Optional metadata to store with the scan',
      },
      started_at: {
        type: 'string',
        description: 'ISO 8601 timestamp when the scan pipeline started. Defaults to current time if omitted.',
      },
    },
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/require-await -- implements Tool.handler: (args) => Promise<ToolResult>
  handler: async (args) => {
    try {
      const input = args as SaveScanInput;
      const db = getDb();

      const scanId = randomUUID();
      // Use caller-supplied started_at (real pipeline start) or fall back to current time.
      const startedAt = (typeof input.started_at === 'string' && input.started_at.length > 0)
        ? input.started_at
        : new Date().toISOString();

      const rawResources = (input.resources ?? []);
      const rawCosts = (input.costs ?? []);
      const rawRecommendations = (input.recommendations ?? []);

      const normalizedCosts = rawCosts.map(normalizeCost);
      const rawMappedCosts = normalizedCosts.map(mapCostEntry);
      const totalCost = rawMappedCosts.reduce((sum, c) => {
        const v = c.monthly_cost ?? 0;
        return sum + (Number.isFinite(v) ? v : 0);
      }, 0);
      const normalizedRecs = rawRecommendations.map(normalizeRecommendation);
      const totalSavings = normalizedRecs.reduce((sum, r) => {
        const v = r.estimated_savings ?? 0;
        return sum + (Number.isFinite(v) ? v : 0);
      }, 0);

      const resources = redactObject(rawResources.map(normalizeResource), 'moderate') as Resource[];
      const costs = redactObject(rawMappedCosts, 'moderate') as StorageCostEntry[];
      const recommendations = redactObject(normalizedRecs, 'moderate') as Recommendation[];

      const scenarioACnt = resources.filter((r) => r.scenario === 'A').length;
      const scenarioBCnt = resources.filter((r) => r.scenario === 'B').length;
      const scenarioCCnt = resources.filter((r) => r.scenario === 'C').length;

      const completedAt = new Date().toISOString();

      db.transaction(() => {
        insertScan(db, {
          id: scanId,
          started_at: startedAt,
          completed_at: completedAt,
          status: 'completed',
          terraform_path: input.terraform_path ?? null,
          aws_profile: input.aws_profile ?? null,
          aws_region: input.aws_region ?? null,
          total_resources: resources.length,
          total_cost: totalCost,
          total_recommendations: recommendations.length,
          total_savings: totalSavings,
          scenario_a_count: scenarioACnt,
          scenario_b_count: scenarioBCnt,
          scenario_c_count: scenarioCCnt,
          metadata: input.metadata ?? null,
        });

        if (resources.length > 0) insertResources(db, scanId, resources);
        if (costs.length > 0) insertCosts(db, scanId, costs);
        if (recommendations.length > 0) upsertRecommendations(db, scanId, recommendations);
      });

      return jsonResult({
        scan_id: scanId,
        resources: resources.length,
        costs: costs.length,
        recommendations: recommendations.length,
        total_cost: totalCost,
        total_savings: totalSavings,
        saved_at: completedAt,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
};
