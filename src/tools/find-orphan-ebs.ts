import { collectAll } from '../aws/collector.js';
import { redactObject } from '../redaction/index.js';
import { jsonResult, createToolHandler, getStringArg, getArrayArg, getDefaultRegion, PROFILE_SCHEMA, REGIONS_SCHEMA } from './types.js';
import type { ToolDefinition } from './types.js';
import type { CollectorConfig } from '../aws/types.js';

export const findOrphanEbsTool: ToolDefinition = {
  name: 'find_orphan_ebs',
  description: 'Find EBS volumes in "available" (unattached) state that have been unattached for more than N days. These are safe to delete after verification.',
  inputSchema: {
    type: 'object',
    properties: {
      profile: PROFILE_SCHEMA,
      regions: REGIONS_SCHEMA,
      minAgeDays: { type: 'number', description: 'Minimum days unattached. Default 7.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: createToolHandler(async (args) => {
    const profileStr = getStringArg(args, 'profile');
    const profile = profileStr || undefined;
    const regions = getArrayArg<string>(args, 'regions');
    const minAgeDays = typeof args['minAgeDays'] === 'number' ? args['minAgeDays'] : 7;

    const defaultRegion = await getDefaultRegion();

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
  }),
};
