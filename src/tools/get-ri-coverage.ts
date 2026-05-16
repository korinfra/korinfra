import { CostExplorerClient, GetReservationCoverageCommand } from '@aws-sdk/client-cost-explorer';
import { getCredentials } from '../aws/credentials.js';
import { redactObject } from '../redaction/index.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';

export const getRiCoverageTool: ToolDefinition = {
  name: 'get_ri_coverage',
  description: 'Get Reserved Instance coverage percentage by service and region. Identifies where On-Demand spend could be replaced with Reserved Instances for up to 75% savings.',
  inputSchema: {
    type: 'object',
    properties: {
      profile: { type: 'string', description: 'AWS CLI profile.' },
      days: { type: 'number', description: 'Look-back window in days. Default 30, max 365.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    try {
      const profile = typeof args['profile'] === 'string' ? args['profile'] : undefined;
      const days = typeof args['days'] === 'number' ? Math.min(args['days'], 365) : 30;

      const config = profile ? { profile, regions: ['us-east-1'] } : { regions: ['us-east-1'] };
      const creds = getCredentials(config);
      // Cost Explorer API is global but must be called against us-east-1
      const client = new CostExplorerClient({ region: 'us-east-1', credentials: creds });

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - days * 86_400_000);
      const fmt = (d: Date): string => d.toISOString().slice(0, 10);

      const result = await client.send(new GetReservationCoverageCommand({
        TimePeriod: { Start: fmt(startDate), End: fmt(endDate) },
        GroupBy: [
          { Type: 'DIMENSION', Key: 'SERVICE' },
          { Type: 'DIMENSION', Key: 'REGION' },
        ],
        Granularity: 'MONTHLY',
      }));

      const num = (s: string | undefined): number => {
        const n = Number(s);
        return Number.isFinite(n) ? n : 0;
      };
      const coverageByService = (result.CoveragesByTime ?? []).flatMap(t =>
        (t.Groups ?? []).map(g => ({
          service: g.Attributes?.['SERVICE'] ?? 'Unknown',
          region: g.Attributes?.['REGION'] ?? 'global',
          coveragePercent: num(g.Coverage?.CoverageHours?.CoverageHoursPercentage),
          onDemandHours: num(g.Coverage?.CoverageHours?.OnDemandHours),
          reservedHours: num(g.Coverage?.CoverageHours?.ReservedHours),
        }))
      ).filter(c => c.onDemandHours > 0)
       .sort((a, b) => a.coveragePercent - b.coveragePercent);

      return jsonResult(redactObject({
        coverageByService,
        count: coverageByService.length,
        days,
        lowCoverageCount: coverageByService.filter(c => c.coveragePercent < 50).length,
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
