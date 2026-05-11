import { getDb } from '../storage/db.js';
import { listScans, getScan } from '../storage/queries/scans.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';
import { redactObject } from '../redaction/index.js';

export const getHistoryTool: ToolDefinition = {
  name: 'get_history',
  description:
    'Lists past korinfra scans stored in the local database, ordered by most recent first. Returns summary info including scan ID, date, resource count, total cost, and savings identified.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Optional scan ID to retrieve a specific scan. When provided, limit and offset are ignored.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of scans to return (default: 20, max: 100)',
        default: 20,
      },
      offset: {
        type: 'number',
        description: 'Number of scans to skip for pagination (default: 0)',
        default: 0,
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  // eslint-disable-next-line @typescript-eslint/require-await -- implements Tool.handler: (args) => Promise<ToolResult>
  handler: async (args) => {
    try {
      const db = getDb();

      if (typeof args['id'] === 'string' && args['id'].length > 0) {
        const scan = getScan(db, args['id']);
        if (scan === null) {
          return errorResult(new Error(`Scan not found: ${args['id']}`));
        }
        return jsonResult(redactObject({
          scans: [{
            id: scan.id,
            started_at: scan.started_at,
            completed_at: scan.completed_at,
            status: scan.status,
            aws_profile: scan.aws_profile,
            aws_region: scan.aws_region,
            terraform_path: scan.terraform_path,
            total_resources: scan.total_resources,
            total_cost: scan.total_cost,
            total_recommendations: scan.total_recommendations,
            total_savings: scan.total_savings,
            scenario_a_count: scan.scenario_a_count,
            scenario_b_count: scan.scenario_b_count,
            scenario_c_count: scan.scenario_c_count,
          }],
          count: 1,
        }, 'moderate'));
      }

      const raw = Number(args['limit'] ?? 20);
      const limit = Math.min(Number.isFinite(raw) ? raw : 20, 100);
      const rawOffset = Number(args['offset'] ?? 0);
      const offset = Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0);

      const scans = listScans(db, limit, offset);

      return jsonResult(redactObject({
        scans: scans.map((s) => ({
          id: s.id,
          started_at: s.started_at,
          completed_at: s.completed_at,
          status: s.status,
          aws_profile: s.aws_profile,
          aws_region: s.aws_region,
          terraform_path: s.terraform_path,
          total_resources: s.total_resources,
          total_cost: s.total_cost,
          total_recommendations: s.total_recommendations,
          total_savings: s.total_savings,
          scenario_a_count: s.scenario_a_count,
          scenario_b_count: s.scenario_b_count,
          scenario_c_count: s.scenario_c_count,
        })),
        count: scans.length,
        limit,
        offset,
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
