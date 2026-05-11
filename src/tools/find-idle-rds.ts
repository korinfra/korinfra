import { collectAll } from '../aws/collector.js';
import { loadConfig } from '../config/index.js';
import { redactObject } from '../redaction/index.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';
import type { CollectorConfig } from '../aws/types.js';

export const findIdleRdsTool: ToolDefinition = {
  name: 'find_idle_rds',
  description: 'Find RDS instances with near-zero database connections over the past 14 days, indicating potential idle/unused databases.',
  inputSchema: {
    type: 'object',
    properties: {
      profile: { type: 'string' },
      regions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      lookbackDays: { type: 'number', description: 'CloudWatch lookback days. Default 14.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    try {
      const profile = typeof args['profile'] === 'string' ? args['profile'] : undefined;
      const regions = Array.isArray(args['regions']) ? (args['regions'] as string[]) : [];
      const lookbackDays = typeof args['lookbackDays'] === 'number' ? args['lookbackDays'] : 14;

      let defaultRegion: string | undefined;
      try {
        const config = await loadConfig();
        defaultRegion = config.aws?.default_region;
      } catch { /* ignore */ }

      const collectConfig: CollectorConfig = {
        regions,
        skipMetrics: false,
        skipCosts: false,
        lookbackDays,
      };
      if (profile) collectConfig.profile = profile;
      if (defaultRegion) collectConfig.defaultRegion = defaultRegion;

      const result = await collectAll(collectConfig);

      const idleInstances = result.resources
        .filter(r => {
          if (r.type !== 'rds_instance') return false;
          const connections = (r.utilization as Record<string, unknown> | undefined)?.['databaseConnections'] as number | undefined;
          if (connections === undefined) return false;
          return connections < 1;
        })
        .map(r => {
          const config = r.configuration as Record<string, unknown> | undefined;
          const util = r.utilization as Record<string, unknown> | undefined;
          return {
            id: r.id,
            name: r.name,
            region: r.region,
            engine: config?.['engine'],
            instanceClass: r.instanceType,
            avgConnections: util?.['databaseConnections'],
            monthlyCost: config?.['monthlyCost'],
            arn: r.arn,
          };
        })
        .sort((a, b) => ((b.monthlyCost as number ?? 0) - (a.monthlyCost as number ?? 0)));

      return jsonResult(redactObject({
        idleInstances,
        count: idleInstances.length,
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
