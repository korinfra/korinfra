import { ResourceGroupsTaggingAPIClient, TagResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import { getCredentials } from './credentials.js';
import { throttledCall } from './rate-limiter.js';

export interface TagWriteResult {
  arn: string;
  success: boolean;
  error?: string;
}

export async function writeTagsToResources(opts: {
  profile?: string;
  region: string;
  arns: string[];
  tags: Record<string, string>;
}): Promise<TagWriteResult[]> {
  const config = opts.profile ? { profile: opts.profile, regions: [opts.region] } : { regions: [opts.region] };
  const creds = getCredentials(config);
  const client = new ResourceGroupsTaggingAPIClient({ region: opts.region, credentials: creds });

  const chunks = chunkArray(opts.arns, 20);
  const results: TagWriteResult[] = [];

  for (const chunk of chunks) {
    const res = await throttledCall('tagging', 'TagResources', opts.region, () =>
      client.send(new TagResourcesCommand({ ResourceARNList: chunk, Tags: opts.tags }))
    );
    for (const arn of chunk) {
      const failed = res.FailedResourcesMap?.[arn];
      const result: TagWriteResult = {
        arn,
        success: !failed,
      };
      if (failed?.ErrorMessage) result.error = failed.ErrorMessage;
      results.push(result);
    }
  }
  return results;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
