import { getDb } from '../storage/db.js';
import { getScan } from '../storage/queries/scans.js';
import { listResources } from '../storage/queries/resources.js';
import { aggregateCostsByService } from '../storage/queries/costs.js';
import { listRecommendations } from '../storage/queries/recommendations.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';
import { redactObject } from '../redaction/index.js';
import type { Resource } from '../storage/queries/resources.js';
import type { Recommendation } from '../storage/queries/recommendations.js';

interface ResourceDiff {
  added: Resource[];
  removed: Resource[];
  changed: Array<{ before: Resource; after: Resource; cost_delta: number }>;
}

interface RecDiff {
  new_recommendations: Recommendation[];
  resolved_recommendations: Recommendation[];
}

export function diffResources(before: Resource[], after: Resource[]): ResourceDiff {
  let _nullIdx = 0;
  const beforeMap = new Map(before.map(r => [r.resource_id ?? `__no_id_${_nullIdx++}`, r]));
  _nullIdx = 0;
  const afterMap = new Map(after.map(r => [r.resource_id ?? `__no_id_${_nullIdx++}`, r]));

  const added = [...afterMap.entries()].filter(([k]) => !beforeMap.has(k)).map(([, r]) => r);
  const removed = [...beforeMap.entries()].filter(([k]) => !afterMap.has(k)).map(([, r]) => r);
  const changed: ResourceDiff['changed'] = [];

  for (const [id, afterRes] of afterMap) {
    const beforeRes = beforeMap.get(id);
    if (!beforeRes) continue;
    const costDelta = (afterRes.monthly_cost ?? 0) - (beforeRes.monthly_cost ?? 0);
    if (
      Math.abs(costDelta) > 0.01 ||
      afterRes.state !== beforeRes.state ||
      afterRes.instance_type !== beforeRes.instance_type
    ) {
      changed.push({ before: beforeRes, after: afterRes, cost_delta: costDelta });
    }
  }

  return { added, removed, changed };
}

export function diffRecommendations(
  before: Recommendation[],
  after: Recommendation[],
): RecDiff {
  const beforeTitles = new Set(before.map((r) => `${r.resource_id ?? 'unknown'}:${r.type}`));
  const afterTitles = new Set(after.map((r) => `${r.resource_id ?? 'unknown'}:${r.type}`));

  return {
    new_recommendations: after.filter((r) => !beforeTitles.has(`${r.resource_id ?? 'unknown'}:${r.type}`)),
    resolved_recommendations: before.filter(
      (r) => !afterTitles.has(`${r.resource_id ?? 'unknown'}:${r.type}`),
    ),
  };
}

export const compareScansTool: ToolDefinition = {
  name: 'compare_scans',
  description:
    'Compares two korinfra scans side-by-side. Shows resource changes (added/removed/modified), cost deltas by service, and new/resolved recommendations.',
  inputSchema: {
    type: 'object',
    required: ['scan_id_1', 'scan_id_2'],
    properties: {
      scan_id_1: {
        type: 'string',
        description: 'ID of the baseline (older) scan',
      },
      scan_id_2: {
        type: 'string',
        description: 'ID of the comparison (newer) scan',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  // eslint-disable-next-line @typescript-eslint/require-await -- implements Tool.handler: (args) => Promise<ToolResult>
  handler: async (args) => {
    try {
      const scanId1 = args['scan_id_1'] as string;
      const scanId2 = args['scan_id_2'] as string;

      if (!scanId1 || !scanId2) {
        return errorResult('Both scan_id_1 and scan_id_2 are required');
      }

      const db = getDb();

      const [scan1, scan2] = [getScan(db, scanId1), getScan(db, scanId2)];
      if (!scan1) return errorResult(`Scan not found: ${scanId1}`);
      if (!scan2) return errorResult(`Scan not found: ${scanId2}`);

      const [resources1, resources2] = [listResources(db, scanId1), listResources(db, scanId2)];
      const [costs1, costs2] = [
        aggregateCostsByService(db, scanId1),
        aggregateCostsByService(db, scanId2),
      ];
      const [recs1, recs2] = [
        listRecommendations(db, scanId1),
        listRecommendations(db, scanId2),
      ];

      const resourceDiff = diffResources(resources1, resources2);
      const recDiff = diffRecommendations(recs1, recs2);

      // Cost delta by service
      const costMap1 = new Map(costs1.map((c) => [c.service_name, c.total_monthly_cost]));
      const costMap2 = new Map(costs2.map((c) => [c.service_name, c.total_monthly_cost]));
      const allServices = new Set([...costMap1.keys(), ...costMap2.keys()]);
      const costDeltas = Array.from(allServices)
        .map((svc) => ({
          service_name: svc,
          scan_1_cost: costMap1.get(svc) ?? 0,
          scan_2_cost: costMap2.get(svc) ?? 0,
          delta: (costMap2.get(svc) ?? 0) - (costMap1.get(svc) ?? 0),
        }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

      return jsonResult(redactObject({
        scan_1: {
          id: scan1.id,
          started_at: scan1.started_at,
          total_resources: scan1.total_resources,
          total_cost: scan1.total_cost,
          total_savings: scan1.total_savings,
        },
        scan_2: {
          id: scan2.id,
          started_at: scan2.started_at,
          total_resources: scan2.total_resources,
          total_cost: scan2.total_cost,
          total_savings: scan2.total_savings,
        },
        summary: {
          cost_delta: (scan2.total_cost ?? 0) - (scan1.total_cost ?? 0),
          savings_delta: (scan2.total_savings ?? 0) - (scan1.total_savings ?? 0),
          resources_added: resourceDiff.added.length,
          resources_removed: resourceDiff.removed.length,
          resources_changed: resourceDiff.changed.length,
          new_recommendations: recDiff.new_recommendations.length,
          resolved_recommendations: recDiff.resolved_recommendations.length,
        },
        cost_by_service: costDeltas,
        resources: {
          added: resourceDiff.added.map((r) => ({
            resource_id: r.resource_id,
            type: r.type,
            region: r.region,
            monthly_cost: r.monthly_cost,
          })),
          removed: resourceDiff.removed.map((r) => ({
            resource_id: r.resource_id,
            type: r.type,
            region: r.region,
            monthly_cost: r.monthly_cost,
          })),
          changed: resourceDiff.changed.map((c) => ({
            resource_id: c.after.resource_id,
            type: c.after.type,
            region: c.after.region,
            cost_before: c.before.monthly_cost,
            cost_after: c.after.monthly_cost,
            cost_delta: c.cost_delta,
            state_before: c.before.state,
            state_after: c.after.state,
          })),
        },
        recommendations: {
          new: recDiff.new_recommendations.map((r) => ({
            id: r.id,
            type: r.type,
            title: r.title,
            estimated_savings: r.estimated_savings,
            impact: r.impact,
          })),
          resolved: recDiff.resolved_recommendations.map((r) => ({
            id: r.id,
            type: r.type,
            title: r.title,
            estimated_savings: r.estimated_savings,
          })),
        },
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
