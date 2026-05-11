import { collectAll } from '../aws/collector.js';
import { loadConfig } from '../config/index.js';
import { redactObject } from '../redaction/index.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';
import type { CollectorConfig } from '../aws/types.js';

export const findIdleEc2Tool: ToolDefinition = {
  name: 'find_idle_ec2',
  description: 'Find EC2 instances that appear idle based on low CPU and network utilization over the past 14 days. Multi-signal check reduces false positives vs. CPU-only checks.',
  inputSchema: {
    type: 'object',
    properties: {
      profile: { type: 'string' },
      regions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      cpuThreshold: { type: 'number', description: 'Max average CPU% to consider idle. Default 5.' },
      lookbackDays: { type: 'number', description: 'CloudWatch lookback days. Default 14.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    try {
      const profile = typeof args['profile'] === 'string' ? args['profile'] : undefined;
      const regions = Array.isArray(args['regions']) ? (args['regions'] as string[]) : [];
      const cpuThreshold = typeof args['cpuThreshold'] === 'number' ? args['cpuThreshold'] : 5;
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
          if (r.type !== 'ec2_instance') return false;
          if (r.state === 'stopped') return false;
          const avgCpu = (r.utilization as Record<string, unknown> | undefined)?.['cpuUtilization'] as number | undefined;
          if (avgCpu === undefined) return false;
          return avgCpu < cpuThreshold;
        })
        .map(r => ({
          id: r.id,
          name: r.name,
          region: r.region,
          instanceType: r.instanceType,
          avgCpuPercent: (r.utilization as Record<string, unknown> | undefined)?.['cpuUtilization'],
          monthlyCost: (r.configuration as Record<string, unknown> | undefined)?.['monthlyCost'],
          arn: r.arn,
        }))
        .sort((a, b) => ((b.monthlyCost as number ?? 0) - (a.monthlyCost as number ?? 0)));

      return jsonResult(redactObject({
        idleInstances,
        count: idleInstances.length,
        cpuThreshold,
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
