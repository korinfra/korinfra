import { getDb } from '../storage/db.js';
import {
  getRecommendationById,
  updateRecommendationStatus,
} from '../storage/queries/recommendations.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';
import { redactObject } from '../redaction/index.js';

export const applyRecommendationTool: ToolDefinition = {
  name: 'apply_recommendation',
  description:
    "Marks a cost optimization recommendation as applied or dismissed in the local database. Call with status=\"applied\" after successfully applying a fix, or status=\"dismissed\" to skip a recommendation.",
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Recommendation ID to update',
      },
      status: {
        type: 'string',
        description: 'New status: "applied" or "dismissed"',
      },
      dismiss_reason: {
        type: 'string',
        description: 'Reason for dismissing (only used when status is dismissed)',
      },
    },
    required: ['id', 'status'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false },
  // eslint-disable-next-line @typescript-eslint/require-await -- implements Tool.handler: (args) => Promise<ToolResult>
  handler: async (args) => {
    try {
      if (typeof args['id'] !== 'string' || !args['id']) {
        return errorResult('id is required');
      }
      const id = args['id'];

      const status = String((args['status'] as string | null | undefined) ?? '');
      if (status !== 'applied' && status !== 'dismissed') {
        return errorResult('status must be "applied" or "dismissed"');
      }

      const db = getDb();
      const rec = getRecommendationById(db, id);
      if (!rec) return errorResult('Recommendation not found: ' + id);

      updateRecommendationStatus(
        db,
        id,
        status,
        typeof args['dismiss_reason'] === 'string' ? args['dismiss_reason'].slice(0, 1000) : undefined,
      );

      return jsonResult(redactObject({ id, status, updated_at: new Date().toISOString() }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
