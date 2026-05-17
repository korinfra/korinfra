import {
  ListBucketsCommand,
  GetBucketLocationCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketEncryptionCommand,
  ListBucketIntelligentTieringConfigurationsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { Resource } from '../types.js';
import { throttledCall } from '../rate-limiter.js';
import pLimit from 'p-limit';
import { tagsToMap } from '../utils.js';
import { logger } from '../../utils/logger.js';
import { LruTtl } from '../../utils/lru-ttl.js';
import { dbg } from '../debug.js';

const S3_REQUEST_HANDLER = new NodeHttpHandler({ connectionTimeout: 3_000, socketTimeout: 15_000 });
// Bounded so long-running mcp serve sessions don't accrete one entry per ever-seen bucket name.
const _bucketRegionCache = new LruTtl<string, string>(1000, 6 * 60 * 60 * 1000);

async function getBucketLocation(
  client: S3Client,
  region: string,
  bucket: string,
  signal?: AbortSignal,
): Promise<string> {
  const cached = _bucketRegionCache.get(bucket);
  if (cached) return cached;

  try {
    const out = await throttledCall('s3', 'GetBucketLocation', region, () =>
      client.send(new GetBucketLocationCommand({ Bucket: bucket }), { ...(signal ? { abortSignal: signal } : {}) }),
    );
    // AWS returns empty string or undefined for us-east-1
    const rawLoc = out.LocationConstraint ?? '';
    const result = rawLoc !== '' ? rawLoc : 'us-east-1';
    _bucketRegionCache.set(bucket, result);
    return result;
  } catch (err) {
    logger.debug({ err, bucket }, 's3 GetBucketLocation: non-fatal');
    _bucketRegionCache.delete(bucket);
    return region;
  }
}

/**
 * Sentinel returned by S3 sub-collectors when the API call fails transiently
 * (5xx / throttle / missing IAM). Distinct from definitive "feature absent"
 * errors (e.g. NoSuchLifecycleConfiguration), which map to `false`/`0`.
 */
type Unknown = 'unknown';
const UNKNOWN: Unknown = 'unknown';

/** AWS S3 error names that mean "feature absent" rather than "API failed". */
const S3_FEATURE_ABSENT_ERROR_NAMES = new Set<string>([
  'NoSuchLifecycleConfiguration',
  'NoSuchBucketPolicy',
  'NoSuchTagSet',
  'NoSuchTagSetError',
  'NoSuchTagConfiguration',
  'ServerSideEncryptionConfigurationNotFoundError',
  'NoSuchPublicAccessBlockConfiguration',
  'NoSuchCORSConfiguration',
  'NoSuchWebsiteConfiguration',
  'NoSuchReplicationConfiguration',
]);

function isFeatureAbsentError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  const code = (err as { Code?: unknown }).Code;
  return (typeof name === 'string' && S3_FEATURE_ABSENT_ERROR_NAMES.has(name))
    || (typeof code === 'string' && S3_FEATURE_ABSENT_ERROR_NAMES.has(code));
}

async function getBucketTags(
  client: S3Client,
  region: string,
  bucket: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  try {
    const out = await throttledCall('s3', 'GetBucketTagging', region, () =>
      client.send(new GetBucketTaggingCommand({ Bucket: bucket }), { ...(signal ? { abortSignal: signal } : {}) }),
    );
    return tagsToMap(out.TagSet);
  } catch (err) {
    logger.debug({ err, bucket }, 's3 GetBucketTagging: non-fatal');
    return {};
  }
}

async function getBucketVersioning(
  client: S3Client,
  region: string,
  bucket: string,
  signal?: AbortSignal,
): Promise<boolean | Unknown> {
  try {
    const out = await throttledCall('s3', 'GetBucketVersioning', region, () =>
      client.send(new GetBucketVersioningCommand({ Bucket: bucket }), { ...(signal ? { abortSignal: signal } : {}) }),
    );
    return out.Status === 'Enabled';
  } catch (err) {
    logger.debug({ err, bucket }, 's3 GetBucketVersioning: non-fatal');
    // GetBucketVersioning has no "feature absent" error — every bucket has a
    // versioning state. A failure here is genuinely unknown.
    return UNKNOWN;
  }
}

async function getLifecycleRulesCount(
  client: S3Client,
  region: string,
  bucket: string,
  signal?: AbortSignal,
): Promise<number | Unknown> {
  try {
    const out = await throttledCall('s3', 'GetBucketLifecycleConfiguration', region, () =>
      client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
        { ...(signal ? { abortSignal: signal } : {}) },
      ),
    );
    return (out.Rules ?? []).length;
  } catch (err) {
    logger.debug({ err, bucket }, 's3 GetBucketLifecycleConfiguration: non-fatal');
    if (isFeatureAbsentError(err)) return 0;
    return UNKNOWN;
  }
}

async function getBucketEncryption(
  client: S3Client,
  region: string,
  bucket: string,
  signal?: AbortSignal,
): Promise<boolean | Unknown> {
  try {
    const out = await throttledCall('s3', 'GetBucketEncryption', region, () =>
      client.send(new GetBucketEncryptionCommand({ Bucket: bucket }), { ...(signal ? { abortSignal: signal } : {}) }),
    );
    return (out.ServerSideEncryptionConfiguration?.Rules ?? []).length > 0;
  } catch (err) {
    logger.debug({ err, bucket }, 's3 GetBucketEncryption: non-fatal');
    if (isFeatureAbsentError(err)) return false;
    return UNKNOWN;
  }
}

async function getBucketIntelligentTiering(
  client: S3Client,
  region: string,
  bucket: string,
  signal?: AbortSignal,
): Promise<boolean | Unknown> {
  try {
    const result = await throttledCall('s3', 'ListBucketIntelligentTieringConfigurations', region, () =>
      client.send(
        new ListBucketIntelligentTieringConfigurationsCommand({ Bucket: bucket }),
        { ...(signal ? { abortSignal: signal } : {}) },
      ),
    );
    return (result?.IntelligentTieringConfigurationList ?? []).length > 0;
  } catch (err) {
    logger.debug({ err, bucket }, 's3 ListBucketIntelligentTieringConfigurations: non-fatal');
    // ListBucketIntelligentTieringConfigurations returns an empty list when
    // there are no configurations — it does not throw "feature absent".
    return UNKNOWN;
  }
}

async function getBucketSizeBytes(
  client: CloudWatchClient,
  bucket: string,
  region: string,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 2 * 24 * 60 * 60 * 1000);
    const out = await throttledCall('cloudwatch', 'GetMetricStatistics', region, () =>
      client.send(new GetMetricStatisticsCommand({
        Namespace: 'AWS/S3',
        MetricName: 'BucketSizeBytes',
        Dimensions: [
          { Name: 'BucketName', Value: bucket },
          { Name: 'StorageType', Value: 'StandardStorage' },
        ],
        StartTime: startTime,
        EndTime: endTime,
        Period: 86400,
        Statistics: ['Average'],
      }), { ...(signal ? { abortSignal: signal } : {}) }),
    );
    const points = (out.Datapoints ?? []).sort(
      (a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0),
    );
    return points[0]?.Average ?? 0;
  } catch {
    return 0;
  }
}

/**
 * S3 is a global service — collect once from the primary region, then determine
 * each bucket's actual region via GetBucketLocation.
 *
 * DEBUG optimisation: Phase 1 resolves all bucket regions in parallel (up to S3
 * rate limit) before starting per-bucket metadata fetches. This avoids the serial
 * GetBucketLocation → metadata chain that was the main S3 bottleneck on accounts
 * with many buckets.
 */
export async function collectS3(
  client: S3Client,
  region: string,
  signal?: AbortSignal,
  skipMetrics?: boolean,
): Promise<Resource[]> {
  // ListBucketsCommand (v1 API) returns all buckets in a single response with no pagination.
  // AWS supports a maximum of 1000 S3 buckets per account, all returned in one call.
  const out = await throttledCall('s3', 'ListBuckets', region, () =>
    client.send(new ListBucketsCommand({}), { ...(signal ? { abortSignal: signal } : {}) }),
  );

  const now = new Date().toISOString();
  const buckets = out.Buckets ?? [];

  // Reuse S3 clients per region to avoid allocating one per cross-region bucket.
  const regionalClients = new Map<string, S3Client>();
  const getRegionalClient = (bucketRegion: string): S3Client => {
    if (bucketRegion === region) return client;
    let c = regionalClients.get(bucketRegion);
    if (!c) {
      c = new S3Client({ region: bucketRegion, credentials: client.config.credentials, requestHandler: S3_REQUEST_HANDLER, maxAttempts: 1 });
      regionalClients.set(bucketRegion, c);
    }
    return c;
  };

  // Reuse CloudWatch clients per region
  const cwClients = new Map<string, CloudWatchClient>();
  const getCWClient = (bucketRegion: string): CloudWatchClient => {
    let c = cwClients.get(bucketRegion);
    if (!c) {
      c = new CloudWatchClient({ region: bucketRegion, credentials: client.config.credentials, requestHandler: S3_REQUEST_HANDLER, maxAttempts: 1 });
      cwClients.set(bucketRegion, c);
    }
    return c;
  };

  // DEBUG Phase 1: resolve all bucket regions in parallel before metadata fetches.
  // Previously each bucket did GetBucketLocation serially within its pLimit(10) slot,
  // blocking the 5 parallel metadata calls. Batching this phase cuts S3 time significantly
  // on accounts with many buckets.
  dbg(`  s3 phase1 GetBucketLocation start — ${buckets.length} buckets`);
  const t_phase1 = Date.now();
  const locationLimit = pLimit(30); // S3 rate limit is 30/sec
  const bucketRegions = await Promise.all(
    buckets.map((b) => locationLimit(() => getBucketLocation(client, region, b.Name ?? '', signal))),
  );
  dbg(`  s3 phase1 GetBucketLocation done — ${Date.now() - t_phase1}ms`);

  // Phase 2: fetch metadata per bucket using the correct regional client.
  // Cap at 10 concurrent; each slot fires 5 parallel sub-calls → ~50 peak concurrency.
  dbg(`  s3 phase2 metadata start — ${buckets.length} buckets pLimit:10`);
  const t_phase2 = Date.now();
  const metadataLimit = pLimit(10);

  const resources = await Promise.all(
    buckets.map((bucket, i) =>
      metadataLimit(async () => {
        if (signal?.aborted) return null;
        const name = bucket.Name ?? '';
        const bucketRegion = bucketRegions[i] ?? region;
        const bucketClient = getRegionalClient(bucketRegion);
        const cwClient = getCWClient(bucketRegion);

        const [tags, versioningEnabled, lifecycleCount, encryptionEnabled, hasIntelligentTiering, sizeBytes] = await Promise.all([
          getBucketTags(bucketClient, bucketRegion, name, signal),
          getBucketVersioning(bucketClient, bucketRegion, name, signal),
          getLifecycleRulesCount(bucketClient, bucketRegion, name, signal),
          getBucketEncryption(bucketClient, bucketRegion, name, signal),
          getBucketIntelligentTiering(bucketClient, bucketRegion, name, signal),
          skipMetrics ? Promise.resolve(0) : getBucketSizeBytes(cwClient, name, bucketRegion, signal),
        ]);

        // Track which collector calls failed transiently so downstream rules
        // can skip them and JSON consumers can surface `_checkFailed`.
        const checkFailed: string[] = [];
        if (versioningEnabled === UNKNOWN) checkFailed.push('versioning');
        if (lifecycleCount === UNKNOWN) checkFailed.push('lifecycle');
        if (encryptionEnabled === UNKNOWN) checkFailed.push('encryption');
        if (hasIntelligentTiering === UNKNOWN) checkFailed.push('intelligent_tiering');

        const hasLifecycle: boolean | Unknown = lifecycleCount === UNKNOWN
          ? UNKNOWN
          : lifecycleCount > 0;

        const resource: Resource = {
          id: name,
          arn: `arn:aws:s3:::${name}`,
          type: 's3_bucket',
          name,
          region: bucketRegion,
          state: 'active',
          instanceType: '',
          tags,
          launchTime: bucket.CreationDate?.toISOString() ?? now,
          collectedAt: now,
          configuration: {
            versioning_enabled: versioningEnabled,
            lifecycle_rules_count: lifecycleCount,
            has_lifecycle: hasLifecycle,
            encryption_enabled: encryptionEnabled,
            has_intelligent_tiering: hasIntelligentTiering,
            size_bytes: sizeBytes,
            size_gb: sizeBytes / (1024 ** 3),
            ...(checkFailed.length > 0 ? { _checkFailed: checkFailed } : {}),
          },
        };
        return resource;
      }),
    ),
  );

  const filtered = (resources).filter((r): r is Resource => r !== null);
  dbg(`  s3 phase2 metadata done — ${Date.now() - t_phase2}ms count:${filtered.length}`);
  return filtered;
}
