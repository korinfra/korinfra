import { EC2Client } from '@aws-sdk/client-ec2';
import { RDSClient } from '@aws-sdk/client-rds';
import { S3Client } from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { ECSClient } from '@aws-sdk/client-ecs';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { writeFileSync } from 'fs';
import { dbg, dbgInit, TIMING_FILE } from './debug.js';
import { logger } from '../utils/logger.js';
import pLimit from 'p-limit';
import type { CollectorConfig, CollectorResult, Resource, CostEntry } from './types.js';
import type { Driver } from '../storage/drivers/node.js';
import { getCredentials, resolveRegion } from './credentials.js';
import { redact } from '../redaction/index.js';
import { throttledCall, isAuthError, flushApiCallLog } from './rate-limiter.js';
import { collectEC2 } from './collectors/ec2.js';
import { collectRDS } from './collectors/rds.js';
import { collectS3 } from './collectors/s3.js';
import { collectLambda } from './collectors/lambda.js';
import { collectECS } from './collectors/ecs.js';
import { collectELB } from './collectors/elb.js';
import { collectElastiCache } from './collectors/elasticache.js';
import { collectDynamoDB } from './collectors/dynamodb.js';
import { collectNATGateways } from './collectors/nat.js';
import {
  collectEC2MetricsBatched,
  collectRDSMetricsBatched,
  collectElastiCacheMetricsBatched,
  collectLambdaMetricsBatched,
} from './cloudwatch.js';
import type { MetricPeriodLabel } from './cloudwatch.js';
import { getCostsCached } from './cost-explorer.js';
import { insertApiCall } from '../storage/queries/api-log.js';

interface SvcTiming {
  svc: string;
  region: string;
  ms: number;
  count?: number;
  error?: string;
}

interface CollectError {
  collector: string;
  region?: string;
  message: string;
  code?: string;
}

const COLLECTOR_TIMEOUT_MS = 30_000;
const MAX_RESOURCES_PER_COLLECTOR = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const h = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      // Unref so the timer doesn't prevent process exit if the collector is orphaned
      if (typeof h === 'object' && h !== null && 'unref' in h) {
        (h as { unref(): void }).unref();
      }
    }),
  ]);
}

function toCollectError(err: unknown, collector: string, region?: string): CollectError {
  const message = redact(err instanceof Error ? err.message : String(err), 'moderate');
  const code =
    err !== null &&
    typeof err === 'object' &&
    ('Code' in err || 'name' in err)
      ? String((err as Record<string, unknown>)['Code'] ?? (err as Record<string, unknown>)['name'])
      : undefined;
  const result: CollectError = { collector, message };
  if (region) {
    result.region = region;
  }
  if (code) {
    result.code = code;
  }
  return result;
}

interface MetricsResourceBuckets {
  ec2RunningByRegion: Map<string, Resource[]>;
  rdsAvailableByRegion: Map<string, Resource[]>;
  elasticacheByRegion: Map<string, Resource[]>;
  lambdaByRegion: Map<string, Resource[]>;
}

function pushResource(map: Map<string, Resource[]>, region: string, resource: Resource): void {
  const existing = map.get(region);
  if (existing) {
    existing.push(resource);
    return;
  }
  map.set(region, [resource]);
}

function enforcResourceLimit(collectedResources: Resource[], svc: string): void {
  if (collectedResources.length > MAX_RESOURCES_PER_COLLECTOR) {
    logger.warn({ count: collectedResources.length, limit: MAX_RESOURCES_PER_COLLECTOR, service: svc }, 'Resource count exceeds limit — truncating');
    collectedResources.splice(MAX_RESOURCES_PER_COLLECTOR);
  }
}

interface StsCache { accountId: string; expiresAt: number; }
const _stsCache = new Map<string, StsCache>();

function buildMetricsResourceBuckets(resources: Resource[]): MetricsResourceBuckets {
  const buckets: MetricsResourceBuckets = {
    ec2RunningByRegion: new Map<string, Resource[]>(),
    rdsAvailableByRegion: new Map<string, Resource[]>(),
    elasticacheByRegion: new Map<string, Resource[]>(),
    lambdaByRegion: new Map<string, Resource[]>(),
  };

  for (const resource of resources) {
    if (resource.type === 'ec2_instance' && resource.state === 'running') {
      pushResource(buckets.ec2RunningByRegion, resource.region, resource);
      continue;
    }
    if (resource.type === 'rds_instance' && resource.state === 'available') {
      pushResource(buckets.rdsAvailableByRegion, resource.region, resource);
      continue;
    }
    if (resource.type === 'elasticache_cluster') {
      pushResource(buckets.elasticacheByRegion, resource.region, resource);
      continue;
    }
    if (resource.type === 'lambda_function') {
      pushResource(buckets.lambdaByRegion, resource.region, resource);
    }
  }

  return buckets;
}

export async function collectAll(
  config: CollectorConfig,
  signal?: AbortSignal,
  db?: Driver,
  scanId?: string,
): Promise<CollectorResult> {
  const start = Date.now();
  dbgInit();
  dbg(`collectAll start — regions: ${config.regions.join(',') || 'auto'} skipCosts:${config.skipCosts} skipMetrics:${config.skipMetrics}`);
  const credentials = getCredentials(config);
  const primaryRegion = resolveRegion(config);
  const regions = config.regions.length > 0 ? config.regions : [primaryRegion];
  const metricPeriod: MetricPeriodLabel = config.metricPeriod ?? '14d';

  const serviceTimeout = config.serviceTimeoutMs ?? COLLECTOR_TIMEOUT_MS;

  const resources: Resource[] = [];
  const costs: CostEntry[] = [];
  const errors: CollectError[] = [];
  // DEBUG: per-service timing — written to korinfra-timing.json after collection
  const timings: SvcTiming[] = [];

  // Resolve account ID once via STS for accurate ARN construction
  const requestHandler = new NodeHttpHandler({ connectionTimeout: 3_000, socketTimeout: 15_000, requestTimeout: 30_000 });
  // Destroy open TCP keep-alive sockets when the caller aborts so Node can exit cleanly.
  signal?.addEventListener('abort', () => { requestHandler.destroy(); }, { once: true });

  let accountId: string | undefined;
  const cacheKey = `${config.profile ?? 'default'}:${primaryRegion}`;
  const cached = _stsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    accountId = cached.accountId;
    dbg('STS cache hit');
  } else {
    try {
      dbg(`STS GetCallerIdentity start — region:${primaryRegion}`);
      const t_sts = Date.now();
      const stsClient = new STSClient({ credentials, region: primaryRegion, requestHandler, maxAttempts: 1 });
      const cmdOptions: Record<string, unknown> = {};
      if (signal) {
        cmdOptions['abortSignal'] = signal;
      }
      const identity = await throttledCall('sts', 'GetCallerIdentity', primaryRegion, () =>
        stsClient.send(new GetCallerIdentityCommand({}), cmdOptions),
      );
      accountId = identity.Account;
      if (accountId) {
        _stsCache.set(cacheKey, { accountId, expiresAt: Date.now() + 3_600_000 });
      }
      dbg(`STS GetCallerIdentity done — ${Date.now() - t_sts}ms account:${accountId}`);
    } catch (err: unknown) {
      dbg(`STS GetCallerIdentity ERROR — ${String(err)}`);
      if (isAuthError(err)) {
        // Credential loading failed before any network call — bail early.
        // All service tasks would fail with the same error; no point launching them.
        dbg(`Credential load error detected — bailing early`);
        errors.push({ collector: 'credentials', message: 'AWS credentials could not be loaded. Re-authenticate: aws sso login (or aws configure / refresh session).', code: 'CredentialLoadError' });
        if (process.env['KORINFRA_DEBUG'] === '1') {
          try { writeFileSync(TIMING_FILE, JSON.stringify({ total_ms: Date.now() - start, error: 'credential_load_failure', regions: regions.join(','), timings: [] }, null, 2)); } catch { /* non-fatal */ }
        }
        return { resources: [], costs: [], errors, durationMs: Date.now() - start };
      }
      errors.push(toCollectError(err, 'sts', 'GetCallerIdentity'));
    }
  }
  const regionLimit = pLimit(config.maxParallelRegions ?? 4);

  const regionTasks: Promise<void>[] = [];
  let s3Collected = false;

  for (const region of regions) {
    const clientCfg = { credentials, region, requestHandler, maxAttempts: 1 };
    const collectS3ThisRegion = !s3Collected;
    if (!s3Collected) s3Collected = true;

    regionTasks.push(
      regionLimit(async () => {
        const serviceTasks: Array<Promise<void>> = [];
        const serviceNames: string[] = [];
        const serviceLimit = pLimit(5);

        dbg(`region:${region} — launching all service tasks`);
        // Add standard service collectors
        {
          const t = Date.now();
          dbg(`  START ec2 region:${region}`);
          serviceTasks.push(
            serviceLimit(() =>
              withTimeout(collectEC2(new EC2Client(clientCfg), region, signal, accountId), serviceTimeout, `ec2:${region}`)
                .then((r) => { enforcResourceLimit(r, 'ec2'); timings.push({ svc: 'ec2', region, ms: Date.now() - t, count: r.length }); config.onServiceComplete?.('ec2', region, Date.now() - t, r.length); dbg(`  DONE  ec2 region:${region} ${Date.now() - t}ms count:${r.length}`); resources.push(...r); }),
            ),
          );
          serviceNames.push('ec2');
        }

        {
          const t = Date.now();
          dbg(`  START rds region:${region}`);
          serviceTasks.push(
            serviceLimit(() =>
              withTimeout(collectRDS(new RDSClient(clientCfg), region, signal), serviceTimeout, `rds:${region}`)
                .then((r) => { enforcResourceLimit(r, 'rds'); timings.push({ svc: 'rds', region, ms: Date.now() - t, count: r.length }); config.onServiceComplete?.('rds', region, Date.now() - t, r.length); dbg(`  DONE  rds region:${region} ${Date.now() - t}ms count:${r.length}`); resources.push(...r); }),
            ),
          );
          serviceNames.push('rds');
        }

        {
          const t = Date.now();
          dbg(`  START lambda region:${region}`);
          serviceTasks.push(
            serviceLimit(() =>
              withTimeout(collectLambda(new LambdaClient(clientCfg), region, signal), serviceTimeout, `lambda:${region}`)
                .then((r) => { enforcResourceLimit(r, 'lambda'); timings.push({ svc: 'lambda', region, ms: Date.now() - t, count: r.length }); config.onServiceComplete?.('lambda', region, Date.now() - t, r.length); dbg(`  DONE  lambda region:${region} ${Date.now() - t}ms count:${r.length}`); resources.push(...r); }),
            ),
          );
          serviceNames.push('lambda');
        }

        {
          const t = Date.now();
          dbg(`  START ecs region:${region}`);
          serviceTasks.push(
            serviceLimit(() =>
              withTimeout(collectECS(new ECSClient(clientCfg), region, signal), serviceTimeout, `ecs:${region}`)
                .then((r) => { enforcResourceLimit(r, 'ecs'); timings.push({ svc: 'ecs', region, ms: Date.now() - t, count: r.length }); config.onServiceComplete?.('ecs', region, Date.now() - t, r.length); dbg(`  DONE  ecs region:${region} ${Date.now() - t}ms count:${r.length}`); resources.push(...r); }),
            ),
          );
          serviceNames.push('ecs');
        }

        {
          const t = Date.now();
          dbg(`  START elb region:${region}`);
          serviceTasks.push(
            serviceLimit(() =>
              withTimeout(collectELB(new ElasticLoadBalancingV2Client(clientCfg), region, signal), serviceTimeout, `elb:${region}`)
                .then((r) => { enforcResourceLimit(r, 'elb'); timings.push({ svc: 'elb', region, ms: Date.now() - t, count: r.length }); config.onServiceComplete?.('elb', region, Date.now() - t, r.length); dbg(`  DONE  elb region:${region} ${Date.now() - t}ms count:${r.length}`); resources.push(...r); }),
            ),
          );
          serviceNames.push('elb');
        }

        {
          const t = Date.now();
          dbg(`  START elasticache region:${region}`);
          serviceTasks.push(
            serviceLimit(() =>
              withTimeout(collectElastiCache(new ElastiCacheClient(clientCfg), region, signal), serviceTimeout, `elasticache:${region}`)
                .then((r) => { enforcResourceLimit(r, 'elasticache'); timings.push({ svc: 'elasticache', region, ms: Date.now() - t, count: r.length }); config.onServiceComplete?.('elasticache', region, Date.now() - t, r.length); dbg(`  DONE  elasticache region:${region} ${Date.now() - t}ms count:${r.length}`); resources.push(...r); }),
            ),
          );
          serviceNames.push('elasticache');
        }

        {
          const t = Date.now();
          dbg(`  START dynamodb region:${region}`);
          serviceTasks.push(
            serviceLimit(() =>
              withTimeout(collectDynamoDB(new DynamoDBClient(clientCfg), region, signal), serviceTimeout, `dynamodb:${region}`)
                .then((r) => { enforcResourceLimit(r, 'dynamodb'); timings.push({ svc: 'dynamodb', region, ms: Date.now() - t, count: r.length }); config.onServiceComplete?.('dynamodb', region, Date.now() - t, r.length); dbg(`  DONE  dynamodb region:${region} ${Date.now() - t}ms count:${r.length}`); resources.push(...r); }),
            ),
          );
          serviceNames.push('dynamodb');
        }

        {
          const t = Date.now();
          dbg(`  START nat_gateway region:${region}`);
          serviceTasks.push(
            serviceLimit(() =>
              withTimeout(collectNATGateways(new EC2Client(clientCfg), region, signal, accountId), serviceTimeout, `nat_gateway:${region}`)
                .then((r) => { enforcResourceLimit(r, 'nat_gateway'); timings.push({ svc: 'nat_gateway', region, ms: Date.now() - t, count: r.length }); config.onServiceComplete?.('nat_gateway', region, Date.now() - t, r.length); dbg(`  DONE  nat_gateway region:${region} ${Date.now() - t}ms count:${r.length}`); resources.push(...r); }),
            ),
          );
          serviceNames.push('nat_gateway');
        }

        // S3 is global — collect once (first region only)
        if (collectS3ThisRegion) {
          const t = Date.now();
          dbg(`  START s3 (global) region:${region}`);
          serviceTasks.push(
            serviceLimit(() =>
              withTimeout(collectS3(new S3Client(clientCfg), region, signal, config.skipMetrics), serviceTimeout, `s3:${region}`)
                .then((r) => { enforcResourceLimit(r, 's3'); timings.push({ svc: 's3', region, ms: Date.now() - t, count: r.length }); config.onServiceComplete?.('s3', region, Date.now() - t, r.length); dbg(`  DONE  s3 region:${region} ${Date.now() - t}ms count:${r.length}`); resources.push(...r); }),
            ),
          );
          serviceNames.push('s3');
        }

        dbg(`region:${region} — awaiting Promise.allSettled for ${serviceTasks.length} tasks`);
        const settled = await Promise.allSettled(serviceTasks);
        dbg(`region:${region} — allSettled done`);
        for (let i = 0; i < settled.length; i++) {
          const result = settled[i];
          if (!result) continue;
          if (result.status === 'rejected') {
            const svcName = serviceNames[i] ?? 'unknown';
            dbg(`  ERROR ${svcName} region:${region} — ${String(result.reason)}`);
            errors.push(toCollectError(result.reason, svcName, region));
          }
        }
      }),
    );
  }

  dbg(`all region tasks — awaiting completion`);
  let timeoutFired = false;
  const collectionTimeout = config.collectionTimeoutMs ?? 60_000;
  const timeoutPromise = new Promise<void>((resolve) => {
    const h = setTimeout(() => { timeoutFired = true; resolve(); }, collectionTimeout);
    signal?.addEventListener('abort', () => clearTimeout(h), { once: true });
  });

  await Promise.race([
    Promise.allSettled(regionTasks),
    timeoutPromise,
  ]);
  if (timeoutFired) {
    dbg(`global timeout fired after 60s — partial results`);
    errors.push({ collector: 'global_timeout', message: `Scan timed out after ${collectionTimeout / 1000}s — partial results returned`, code: 'ScanTimeout' });
  }
  dbg(`all region tasks done — total resources so far:${resources.length}`);

  if (!timeoutFired && !config.skipCosts) {
    try {
      const costOptions: Record<string, string> = {};
      if (config.lookbackDays !== null && config.lookbackDays !== undefined) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - config.lookbackDays);
        costOptions['startDate'] = startDate.toISOString().slice(0, 10);
      }
      const credOptions: Record<string, string | undefined> = {};
      if (config.profile) {
        credOptions['profile'] = config.profile;
      }
      if (config.roleArn) {
        credOptions['roleArn'] = config.roleArn;
      }
      if (config.externalId) {
        credOptions['externalId'] = config.externalId;
      }
      const t_ce = Date.now();
      dbg('CE start (cached parallel)');
      const { costs: costEntries, resourceCosts: resourceCostMap, partial: cePartial } = await getCostsCached(
        credOptions,
        { ...costOptions, includeResourceCosts: config.includeResourceCosts ?? false, ...(config.costExplorerCacheTtlMs !== undefined ? { cacheTtlMs: config.costExplorerCacheTtlMs } : {}) },
        signal,
      );
      timings.push({ svc: 'cost_explorer', region: 'us-east-1', ms: Date.now() - t_ce, count: costEntries.length });
      dbg(`CE done — ${Date.now() - t_ce}ms costs:${costEntries.length} resourceCosts:${resourceCostMap.size} partial:${String(cePartial)}`);
      costs.push(...costEntries);

      // Surface CE pagination truncation through the standard error channel so downstream
      // dashboards / reporters see it. Code constant: 'CostExplorerTruncated'.
      if (cePartial) {
        errors.push({
          collector: 'cost_explorer',
          region: 'us-east-1',
          message: 'Cost Explorer pagination capped — results are partial',
          code: 'CostExplorerTruncated',
        });
      }

      // Enrich resources with actual Cost Explorer per-resource spend
      for (const resource of resources) {
        const actualCost = resourceCostMap.get(resource.id) ?? resourceCostMap.get(resource.arn ?? '');
        if (actualCost && actualCost > 0) {
          if (!resource.configuration) resource.configuration = {};
          resource.configuration['monthlyCost'] = actualCost;
          resource.configuration['monthlyCostSource'] = 'cost_explorer';
        }
      }
    } catch (err: unknown) {
      errors.push(toCollectError(err, 'cost_explorer'));
    }
  }

  if (!timeoutFired && !config.skipMetrics && resources.length > 0) {
    const buckets = buildMetricsResourceBuckets(resources);
    const regionSet = new Set<string>([
      ...buckets.ec2RunningByRegion.keys(),
      ...buckets.rdsAvailableByRegion.keys(),
      ...buckets.elasticacheByRegion.keys(),
      ...buckets.lambdaByRegion.keys(),
    ]);
    const metricTasks: Promise<void>[] = [];

    const metricLimit = pLimit(10);

    for (const region of regionSet) {
      const cwClient = new CloudWatchClient({ credentials, region, requestHandler });

      const ec2Resources = buckets.ec2RunningByRegion.get(region) ?? [];
      if (ec2Resources.length > 0) {
        metricTasks.push(
          metricLimit(() =>
            collectEC2MetricsBatched(cwClient, region, ec2Resources, metricPeriod, signal).catch(
              (err: unknown) => { errors.push(toCollectError(err, 'cloudwatch_ec2', region)); },
            ),
          ),
        );
      }

      const rdsResources = buckets.rdsAvailableByRegion.get(region) ?? [];
      if (rdsResources.length > 0) {
        metricTasks.push(
          metricLimit(() =>
            collectRDSMetricsBatched(cwClient, region, rdsResources, metricPeriod, signal).catch(
              (err: unknown) => { errors.push(toCollectError(err, 'cloudwatch_rds', region)); },
            ),
          ),
        );
      }

      const elasticacheResources = buckets.elasticacheByRegion.get(region) ?? [];
      if (elasticacheResources.length > 0) {
        metricTasks.push(
          metricLimit(() =>
            collectElastiCacheMetricsBatched(cwClient, region, elasticacheResources, metricPeriod, signal).catch(
              (err: unknown) => { errors.push(toCollectError(err, 'cloudwatch_elasticache', region)); },
            ),
          ),
        );
      }

      const lambdaResources = buckets.lambdaByRegion.get(region) ?? [];
      if (lambdaResources.length > 0) {
        metricTasks.push(
          metricLimit(() =>
            collectLambdaMetricsBatched(cwClient, region, lambdaResources, metricPeriod, signal).catch(
              (err: unknown) => { errors.push(toCollectError(err, 'cloudwatch_lambda', region)); },
            ),
          ),
        );
      }
    }

    await Promise.allSettled(metricTasks);
  }

  // Destroy the shared HTTP connection pool so Node.js can exit cleanly.
  // Without this, NodeHttpHandler keep-alive sockets ref the event loop and
  // the process lingers indefinitely after the scan completes.
  requestHandler.destroy();

  // Write per-service timing to ~/.korinfra/debug/ for analysis when KORINFRA_DEBUG=1
  if (process.env['KORINFRA_DEBUG'] === '1') {
    try {
      const sortedTimings = [...timings].sort((a, b) => b.ms - a.ms);
      writeFileSync(
        TIMING_FILE,
        JSON.stringify({ total_ms: Date.now() - start, regions: regions.join(','), timings: sortedTimings }, null, 2),
      );
    } catch { /* non-fatal */ }
  }

  // Flush API call log to SQLite database if db handle and scanId are provided
  if (db !== undefined && scanId !== undefined) {
    try {
      const apiLogs = flushApiCallLog();
      if (apiLogs.length > 0) {
        for (const record of apiLogs) {
          try {
            insertApiCall(db, {
              scan_id: scanId,
              service: record.service,
              operation: record.operation,
              region: record.region,
              estimated_cost: record.estimatedCost ?? 0,
              duration_ms: record.durationMs,
              status: record.error !== undefined ? 'error' : 'success',
              error_message: record.error ?? null,
            });
          } catch { /* non-fatal */ }
        }
      }
    } catch { /* non-fatal */ }
  } else if (db === undefined || scanId === undefined) {
    // Ensure API logs are flushed from memory even if not persisted to DB
    flushApiCallLog();
  }

  return { resources, costs, errors, durationMs: Date.now() - start };
}

