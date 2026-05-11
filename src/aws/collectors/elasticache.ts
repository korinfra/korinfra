import type { ElastiCacheClient, CacheCluster } from '@aws-sdk/client-elasticache';
import { DescribeCacheClustersCommand, ListTagsForResourceCommand } from '@aws-sdk/client-elasticache';
import type { Resource } from '../types.js';
import { throttledCall } from '../rate-limiter.js';
import pLimit from 'p-limit';
import { logger } from '../../utils/logger.js';
import { dbg } from '../debug.js';

async function fetchTags(
  client: ElastiCacheClient,
  region: string,
  arn: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  try {
    const tagsOut = await throttledCall('elasticache', 'ListTagsForResource', region, () =>
      client.send(new ListTagsForResourceCommand({ ResourceName: arn }), { ...(signal ? { abortSignal: signal } : {}) }),
    );
    return Object.fromEntries((tagsOut.TagList ?? []).map((t) => [t.Key ?? '', t.Value ?? '']));
  } catch (err) {
    logger.debug({ err, arn }, 'elasticache ListTagsForResource: non-fatal');
    return {};
  }
}

export async function collectElastiCache(
  client: ElastiCacheClient,
  region: string,
  signal?: AbortSignal,
): Promise<Resource[]> {
  const now = new Date().toISOString();

  const clusters: CacheCluster[] = [];
  let token: string | undefined;
  let pageNum = 0;
  do {
    dbg(`    elasticache DescribeCacheClusters page:${pageNum + 1} start — region:${region} soFar:${clusters.length}`);
    const t_cc = Date.now();
    const out = await throttledCall('elasticache', 'DescribeCacheClusters', region, () =>
      client.send(
        new DescribeCacheClustersCommand({ ShowCacheNodeInfo: true, Marker: token }),
        { ...(signal ? { abortSignal: signal } : {}) },
      ),
    );
    pageNum++;
    clusters.push(...(out.CacheClusters ?? []));
    token = out.Marker ?? undefined;
    dbg(`    elasticache DescribeCacheClusters page:${pageNum} done — ${Date.now() - t_cc}ms inPage:${out.CacheClusters?.length ?? 0} hasMore:${Boolean(token)}`);
  } while (token !== undefined);

  // Fetch all tags in parallel, capped at 10 concurrent calls
  const tagLimit = pLimit(10);
  const tagResults = await Promise.all(
    clusters.map((cluster) =>
      cluster.ARN
        ? tagLimit(() => fetchTags(client, region, cluster.ARN ?? '', signal))
        : Promise.resolve({} as Record<string, string>),
    ),
  );

  return clusters.map((cluster, i) => ({
    id: cluster.CacheClusterId ?? '',
    arn: cluster.ARN ?? '',
    type: 'elasticache_cluster',
    name: cluster.CacheClusterId ?? '',
    region,
    state: cluster.CacheClusterStatus ?? '',
    instanceType: cluster.CacheNodeType ?? '',
    tags: tagResults[i] ?? {},
    launchTime: cluster.CacheClusterCreateTime?.toISOString() ?? now,
    collectedAt: now,
    configuration: {
      engine: cluster.Engine ?? '',
      engine_version: cluster.EngineVersion ?? '',
      num_cache_nodes: cluster.NumCacheNodes ?? 0,
      preferred_az: cluster.PreferredAvailabilityZone ?? '',
      auto_minor_version_upgrade: cluster.AutoMinorVersionUpgrade ?? false,
      snapshot_retention_limit: cluster.SnapshotRetentionLimit ?? 0,
      transit_encryption_enabled: cluster.TransitEncryptionEnabled ?? false,
      at_rest_encryption_enabled: cluster.AtRestEncryptionEnabled ?? false,
    },
  }));
}
