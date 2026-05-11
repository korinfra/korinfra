import { getDb } from '../storage/db.js';
import {
  getRecommendationById,
  listRecommendations,
  listPendingRecommendations,
} from '../storage/queries/recommendations.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';
import { redactObject } from '../redaction/index.js';

export const getRecommendationsTool: ToolDefinition = {
  name: 'get_recommendations',
  description:
    'Retrieves cost optimization recommendations from the local database. Use to load a specific recommendation by ID before applying a fix, or to list all pending recommendations from the most recent scan.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Fetch a single recommendation by ID',
      },
      scan_id: {
        type: 'string',
        description: 'Fetch all recommendations from a specific scan',
      },
      status: {
        type: 'string',
        description: 'Filter by status (default: draft)',
        default: 'draft',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 20, max: 100)',
        default: 20,
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  // eslint-disable-next-line @typescript-eslint/require-await -- implements Tool.handler: (args) => Promise<ToolResult>
  handler: async (args) => {
    try {
      const db = getDb();

      if (typeof args['id'] === 'string' && args['id']) {
        const rec = getRecommendationById(db, args['id']);
        if (!rec) return errorResult('Recommendation not found: ' + args['id']);
        return jsonResult(redactObject({ recommendations: [rec], count: 1 }, 'moderate'));
      }

      if (typeof args['scan_id'] === 'string' && args['scan_id']) {
        const scan_id = args['scan_id'];
        const recs = listRecommendations(db, scan_id, { status: String((args['status'] as string | null | undefined) ?? 'draft') });
        return jsonResult(redactObject({ recommendations: recs, count: recs.length, scan_id }, 'moderate'));
      }

      const rawLimit = Number(args['limit'] ?? 20);
      const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20, 100);
      const recs = listPendingRecommendations(db, limit);
      return jsonResult(redactObject({ recommendations: recs, count: recs.length }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
