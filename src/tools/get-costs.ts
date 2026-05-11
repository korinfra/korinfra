import { getCostsCached } from '../aws/cost-explorer.js';
import { redactObject } from '../redaction/index.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';
import type { Granularity, GroupBy } from '../aws/cost-explorer.js';

export const getCostsTool: ToolDefinition = {
  name: 'get_costs',
  description:
    'Query AWS Cost Explorer for cost and usage data. Grouped by service by default. Each call costs $0.01 — results are cached 6h. Call once per analysis; do not re-call with different groupBy parameters.',
  inputSchema: {
    type: 'object',
    properties: {
      profile: {
        type: 'string',
        description: 'AWS CLI profile name.',
      },
      days: {
        type: 'number',
        description: 'Number of days to query. Defaults to 30. Overrides startDate/endDate if provided.',
      },
      startDate: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format. Defaults to 30 days ago.',
      },
      endDate: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format. Defaults to today.',
      },
      granularity: {
        type: 'string',
        enum: ['DAILY', 'MONTHLY'],
        description: 'Cost granularity. Default DAILY.',
      },
      groupBy: {
        type: 'string',
        enum: ['SERVICE', 'REGION', 'USAGE_TYPE'],
        description: 'Group costs by this dimension. Default SERVICE.',
      },
    },
  },
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    try {
      const profile = typeof args['profile'] === 'string' ? args['profile'] : undefined;

      // Handle days parameter — if provided, override startDate/endDate
      let startDate: string | undefined;
      let endDate: string | undefined;

      const days = typeof args['days'] === 'number' ? args['days'] : undefined;
      if (days !== undefined && days > 0) {
        const now = new Date();
        const start = new Date(now);
        start.setDate(start.getDate() - days);
        startDate = start.toISOString().slice(0, 10);
        endDate = now.toISOString().slice(0, 10);
      } else {
        startDate = typeof args['startDate'] === 'string' ? args['startDate'] : undefined;
        endDate = typeof args['endDate'] === 'string' ? args['endDate'] : undefined;
      }

      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (startDate !== undefined && !dateRegex.test(startDate)) {
        return errorResult('Dates must be in YYYY-MM-DD format');
      }
      if (endDate !== undefined && !dateRegex.test(endDate)) {
        return errorResult('Dates must be in YYYY-MM-DD format');
      }
      const VALID_GRANULARITIES = ['DAILY', 'MONTHLY'] as const;
      const VALID_GROUP_BY = ['SERVICE', 'REGION', 'USAGE_TYPE'] as const;

      const rawGranularity = typeof args['granularity'] === 'string' ? args['granularity'] : undefined;
      if (rawGranularity && !VALID_GRANULARITIES.includes(rawGranularity as typeof VALID_GRANULARITIES[number])) {
        return errorResult('granularity must be DAILY or MONTHLY');
      }
      const granularity = rawGranularity as Granularity | undefined;

      const rawGroupBy = typeof args['groupBy'] === 'string' ? args['groupBy'] : undefined;
      if (rawGroupBy && !VALID_GROUP_BY.includes(rawGroupBy as typeof VALID_GROUP_BY[number])) {
        return errorResult('groupBy must be SERVICE, REGION, or USAGE_TYPE');
      }
      const groupBy = rawGroupBy as GroupBy | undefined;

      const profileConfig: { profile?: string } = profile !== undefined ? { profile } : {};
      const costOptions = {
        ...(startDate !== undefined ? { startDate } : {}),
        ...(endDate !== undefined ? { endDate } : {}),
        ...(granularity !== undefined ? { granularity } : {}),
        ...(groupBy !== undefined ? { groupBy } : {}),
      };
      const { costs: allEntries } = await getCostsCached(profileConfig, costOptions);

      const truncated = allEntries.length > 50;
      const entries = allEntries.slice(0, 50);
      return jsonResult(redactObject({
        costs: entries,
        count: allEntries.length,
        truncated,
        ...(truncated ? { warning: `Results truncated to 50 of ${allEntries.length} entries.` } : {}),
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
