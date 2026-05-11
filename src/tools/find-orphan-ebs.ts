import { collectAll } from '../aws/collector.js';
import { loadConfig } from '../config/index.js';
import { redactObject } from '../redaction/index.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';
import type { CollectorConfig } from '../aws/types.js';

export const findOrphanEbsTool: ToolDefinition = {
  name: 'find_orphan_ebs',
  description: 'Find EBS volumes in "available" (unattached) state that have been unattached for more than N days. These are safe to delete after verification.',
  inputSchema: {
    type: 'object',
    properties: {
      profile: { type: 'string' },
      regions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      minAgeDays: { type: 'number', description: 'Minimum days unattached. Default 7.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    try {
      const profile = typeof args['profile'] === 'string' ? args['profile'] : undefined;
      const regions = Array.isArray(args['regions']) ? (args['regions'] as string[]) : [];
      const minAgeDays = typeof args['minAgeDays'] === 'number' ? args['minAgeDays'] : 7;

      let defaultRegion: string | undefined;
      try {
        const config = await loadConfig();
        defaultRegion = config.aws?.default_region;
      } catch { /* ignore */ }

      const collectConfig: CollectorConfig = {
        regions,
        skipMetrics: true,
        skipCosts: false,
      };
      if (profile) collectConfig.profile = profile;
      if (defaultRegion) collectConfig.defaultRegion = defaultRegion;

      const result = await collectAll(collectConfig);

      const now = Date.now();
      const msPerDay = 86_400_000;

      const orphans = result.resources
        .filter(r => {
          if (r.type !== 'ebs_volume') return false;
          if (r.state !== 'available') return false;
          const createTime = (r.configuration as Record<string, unknown> | undefined)?.['createTime'];
          if (!createTime) return true;
          const ageMs = now - new Date(createTime as string).getTime();
          return ageMs >= minAgeDays * msPerDay;
        })
        .map(r => {
          const config = r.configuration as Record<string, unknown> | undefined;
          const createTime = config?.['createTime'];
          const ageMs = createTime ? now - new Date(createTime as string).getTime() : 0;
          return {
            id: r.id,
            name: r.name,
            region: r.region,
            sizeGb: config?.['size_gb'],
            ageDays: Math.floor(ageMs / msPerDay),
            monthlyCost: config?.['monthlyCost'],
            arn: r.arn,
          };
        })
        .sort((a, b) => b.ageDays - a.ageDays);

      return jsonResult(redactObject({
        orphanVolumes: orphans,
        count: orphans.length,
        minAgeDays,
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
