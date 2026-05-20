import { collectAll } from '../aws/collector.js';
import { redactObject } from '../redaction/index.js';
import { jsonResult, createToolHandler, getStringArg, getArrayArg, getDefaultRegion, PROFILE_SCHEMA, REGIONS_SCHEMA } from './types.js';
import type { ToolDefinition } from './types.js';
import type { CollectorConfig } from '../aws/types.js';

export const findIdleRdsTool: ToolDefinition = {
  name: 'find_idle_rds',
  description: 'Find RDS instances with near-zero database connections over the past 14 days, indicating potential idle/unused databases.',
  inputSchema: {
    type: 'object',
    properties: {
      profile: PROFILE_SCHEMA,
      regions: REGIONS_SCHEMA,
      lookbackDays: { type: 'number', description: 'CloudWatch lookback days. Default 14.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: createToolHandler(async (args) => {
    const profileStr = getStringArg(args, 'profile');
    const profile = profileStr || undefined;
    const regions = getArrayArg<string>(args, 'regions');
    const lookbackDays = typeof args['lookbackDays'] === 'number' ? args['lookbackDays'] : 14;

    const defaultRegion = await getDefaultRegion();

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
  }),
};
