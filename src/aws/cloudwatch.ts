import {
  GetMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import type { MetricDataQuery, CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import type { Resource, Utilization } from './types.js';
import { throttledCall } from './rate-limiter.js';
import { logger } from '../utils/logger.js';
import { redact } from '../redaction/redactor.js';

export type MetricPeriodLabel = '7d' | '14d' | '30d';

const PERIOD_MS: Record<MetricPeriodLabel, number> = {
  '7d': 7 * 24 * 60 * 60 * 1000,
  '14d': 14 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const DATA_POINTS_PER_PERIOD: Record<MetricPeriodLabel, number> = {
  '7d': 168,
  '14d': 336,
  '30d': 720,
};

const CW_MAX_DATAPOINTS_PER_CALL = 100_800; // AWS GetMetricData limit per request

function batchSize(metricsPerResource: number, periodLabel: MetricPeriodLabel): number {
  const dataPoints = DATA_POINTS_PER_PERIOD[periodLabel];
  return Math.max(1, Math.floor(CW_MAX_DATAPOINTS_PER_CALL / (metricsPerResource * dataPoints)));
}

function metricQuery(
  id: string,
  namespace: string,
  metricName: string,
  stat: string,
  dimName: string,
  dimValue: string,
  periodSec = 3600,
): MetricDataQuery {
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: [{ Name: dimName, Value: dimValue }],
      },
      Period: periodSec,
      Stat: stat,
    },
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function maxVal(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values);
}

function sumVal(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0] ?? 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.min(lower + 1, sorted.length - 1);
  const lo = sorted[lower] ?? 0;
  const hi = sorted[upper] ?? 0;
  const result = lo + (hi - lo) * (idx - lower);
  return Math.round(result * 100) / 100;
}

async function getMetricData(
  client: CloudWatchClient,
  region: string,
  queries: MetricDataQuery[],
  startTime: Date,
  endTime: Date,
  signal?: AbortSignal,
): Promise<Map<string, number[]>> {
  // Accumulate all pages keyed by metric Id before sorting
  const rawPages = new Map<string, { ts: Date; v: number }[]>();

  let nextToken: string | undefined;
  do {
    const out = await throttledCall('cloudwatch', 'GetMetricData', region, () => {
      const cmdOptions: Record<string, unknown> = {};
      if (signal) {
        cmdOptions['abortSignal'] = signal;
      }
      return client.send(
        new GetMetricDataCommand({
          MetricDataQueries: queries,
          StartTime: startTime,
          EndTime: endTime,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }),
        cmdOptions,
      );
    });
    nextToken = out.NextToken ?? undefined;

    for (const r of out.MetricDataResults ?? []) {
      if (!r.Id || !r.Values) continue;
      const existing = rawPages.get(r.Id) ?? [];
      const pairs = (r.Timestamps ?? []).map((ts, i) => ({ ts, v: (r.Values ?? [])[i] ?? 0 }));
      existing.push(...pairs);
      rawPages.set(r.Id, existing);
    }
  } while (nextToken);

  const results = new Map<string, number[]>();
  for (const [id, pairs] of rawPages) {
    // Sort ascending by Timestamp — CloudWatch returns newest-first
    pairs.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    results.set(id, pairs.map((p) => p.v));
  }
  return results;
}

// ─── EC2 Metrics ─────────────────────────────────────────────────────────────

export async function collectEC2MetricsBatched(
  client: CloudWatchClient,
  region: string,
  resources: Resource[],
  periodLabel: MetricPeriodLabel,
  signal?: AbortSignal,
): Promise<void> {
  const now = new Date();
  const startTime = new Date(now.getTime() - PERIOD_MS[periodLabel]);
  const eligible = resources.filter(
    (r) => r.type === 'ec2_instance' && r.state === 'running' && r.region === region,
  );

  const ec2Batch = batchSize(6, periodLabel);
  const ec2BatchResults = await Promise.all(
    Array.from({ length: Math.ceil(eligible.length / ec2Batch) }, (_, i) => {
      const batch = eligible.slice(i * ec2Batch, (i + 1) * ec2Batch);
      const queries: MetricDataQuery[] = [];
      for (let slot = 0; slot < batch.length; slot++) {
        const resource = batch[slot];
        if (!resource) continue;
        const id = resource.id;
        const p = `e${slot}`;
        queries.push(
          metricQuery(`${p}_cpuavg`, 'AWS/EC2', 'CPUUtilization', 'Average', 'InstanceId', id),
          metricQuery(`${p}_cpumax`, 'AWS/EC2', 'CPUUtilization', 'Maximum', 'InstanceId', id),
          metricQuery(`${p}_netin`, 'AWS/EC2', 'NetworkIn', 'Sum', 'InstanceId', id),
          metricQuery(`${p}_netout`, 'AWS/EC2', 'NetworkOut', 'Sum', 'InstanceId', id),
          metricQuery(`${p}_dread`, 'AWS/EC2', 'DiskReadOps', 'Average', 'InstanceId', id),
          metricQuery(`${p}_dwrite`, 'AWS/EC2', 'DiskWriteOps', 'Average', 'InstanceId', id),
        );
      }

      return getMetricData(client, region, queries, startTime, now, signal).catch((err: unknown) => {
        logger.warn(
          {
            err: {
              message: redact(err instanceof Error ? err.message : String(err), 'moderate'),
              code: (err as { name?: string }).name,
            },
            resourceCount: batch.length,
          },
          'CloudWatch getMetricData batch failed',
        );
        return null;
      }).then((results) => ({ batch, results }));
    }),
  );

  const expectedPoints = Math.floor((PERIOD_MS[periodLabel] ?? 0) / (86400 * 1000));
  for (const { batch, results } of ec2BatchResults) {
    if (!results) continue;

    for (let slot = 0; slot < batch.length; slot++) {
      const resource = batch[slot];
      if (!resource) continue;
      const p = `e${slot}`;
      const cpuAvg = results.get(`${p}_cpuavg`) ?? [];
      const util: Utilization = {
        period: periodLabel,
        cpuAverage: average(cpuAvg),
        cpuMax: maxVal(results.get(`${p}_cpumax`) ?? []),
        cpuP95: percentile(cpuAvg, 95),
        cpuP99: percentile(cpuAvg, 99),
        memoryAverage: 0,
        memoryMax: 0,
        memoryP95: 0,
        networkInMB: sumVal(results.get(`${p}_netin`) ?? []) / (1024 * 1024),
        networkOutMB: sumVal(results.get(`${p}_netout`) ?? []) / (1024 * 1024),
        diskReadIOPS: average(results.get(`${p}_dread`) ?? []),
        diskWriteIOPS: average(results.get(`${p}_dwrite`) ?? []),
        connectionCount: 0,
        connectionCountMax: 0,
        dataPoints: cpuAvg.length,
        dataGaps: cpuAvg.length > 0 ? Math.max(0, expectedPoints - cpuAvg.length) : 0,
        freshnessHrs: 0,
      };
      resource.utilization = util;
    }
  }
}

// ─── RDS Metrics ─────────────────────────────────────────────────────────────

export async function collectRDSMetricsBatched(
  client: CloudWatchClient,
  region: string,
  resources: Resource[],
  periodLabel: MetricPeriodLabel,
  signal?: AbortSignal,
): Promise<void> {
  const now = new Date();
  const startTime = new Date(now.getTime() - PERIOD_MS[periodLabel]);
  const eligible = resources.filter(
    (r) => r.type === 'rds_instance' && r.state === 'available' && r.region === region,
  );

  const rdsBatch = batchSize(11, periodLabel);
  const rdsBatchResults = await Promise.all(
    Array.from({ length: Math.ceil(eligible.length / rdsBatch) }, (_, i) => {
      const batch = eligible.slice(i * rdsBatch, (i + 1) * rdsBatch);
      const queries: MetricDataQuery[] = [];
      for (let slot = 0; slot < batch.length; slot++) {
        const resource = batch[slot];
        if (!resource) continue;
        const id = resource.id;
        const p = `r${slot}`;
        queries.push(
          metricQuery(`${p}_cpuavg`, 'AWS/RDS', 'CPUUtilization', 'Average', 'DBInstanceIdentifier', id),
          metricQuery(`${p}_cpumax`, 'AWS/RDS', 'CPUUtilization', 'Maximum', 'DBInstanceIdentifier', id),
          metricQuery(`${p}_riops`, 'AWS/RDS', 'ReadIOPS', 'Average', 'DBInstanceIdentifier', id),
          metricQuery(`${p}_wiops`, 'AWS/RDS', 'WriteIOPS', 'Average', 'DBInstanceIdentifier', id),
          metricQuery(`${p}_netin`, 'AWS/RDS', 'NetworkReceiveThroughput', 'Sum', 'DBInstanceIdentifier', id),
          metricQuery(`${p}_netout`, 'AWS/RDS', 'NetworkTransmitThroughput', 'Sum', 'DBInstanceIdentifier', id),
          metricQuery(`${p}_memfree`, 'AWS/RDS', 'FreeableMemory', 'Average', 'DBInstanceIdentifier', id),
          metricQuery(`${p}_memfmax`, 'AWS/RDS', 'FreeableMemory', 'Maximum', 'DBInstanceIdentifier', id),
          metricQuery(`${p}_dbconn`, 'AWS/RDS', 'DatabaseConnections', 'Average', 'DBInstanceIdentifier', id),
          metricQuery(`${p}_dbcmax`, 'AWS/RDS', 'DatabaseConnections', 'Maximum', 'DBInstanceIdentifier', id),
          metricQuery(`${p}_freestor`, 'AWS/RDS', 'FreeStorageSpace', 'Average', 'DBInstanceIdentifier', id),
        );
      }

      return getMetricData(client, region, queries, startTime, now, signal).catch((err: unknown) => {
        logger.warn(
          {
            err: {
              message: redact(err instanceof Error ? err.message : String(err), 'moderate'),
              code: (err as { name?: string }).name,
            },
            resourceCount: batch.length,
          },
          'CloudWatch getMetricData batch failed',
        );
        return null;
      }).then((results) => ({ batch, results }));
    }),
  );

  const rdsExpectedPoints = Math.floor((PERIOD_MS[periodLabel] ?? 0) / (86400 * 1000));
  for (const { batch, results } of rdsBatchResults) {
    if (!results) continue;

    for (let slot = 0; slot < batch.length; slot++) {
      const resource = batch[slot];
      if (!resource) continue;
      const p = `r${slot}`;
      const cpuAvg = results.get(`${p}_cpuavg`) ?? [];
      const util: Utilization = {
        period: periodLabel,
        cpuAverage: average(cpuAvg),
        cpuMax: maxVal(results.get(`${p}_cpumax`) ?? []),
        cpuP95: percentile(cpuAvg, 95),
        cpuP99: percentile(cpuAvg, 99),
        memoryAverage: average(results.get(`${p}_memfree`) ?? []) / (1024 * 1024),
        memoryMax: maxVal(results.get(`${p}_memfmax`) ?? []) / (1024 * 1024),
        memoryP95: 0,
        networkInMB: sumVal(results.get(`${p}_netin`) ?? []) / (1024 * 1024),
        networkOutMB: sumVal(results.get(`${p}_netout`) ?? []) / (1024 * 1024),
        diskReadIOPS: average(results.get(`${p}_riops`) ?? []),
        diskWriteIOPS: average(results.get(`${p}_wiops`) ?? []),
        connectionCount: average(results.get(`${p}_dbconn`) ?? []),
        connectionCountMax: maxVal(results.get(`${p}_dbcmax`) ?? []),
        dataPoints: cpuAvg.length,
        dataGaps: cpuAvg.length > 0 ? Math.max(0, rdsExpectedPoints - cpuAvg.length) : 0,
        freshnessHrs: 0,
      };
      resource.utilization = util;

      // Populate free_storage_gb in configuration for RDS-013 rule
      const freeStorageBytes = average(results.get(`${p}_freestor`) ?? []);
      if (freeStorageBytes > 0) {
        if (!resource.configuration) resource.configuration = {};
        resource.configuration['free_storage_gb'] = freeStorageBytes / (1024 * 1024 * 1024);
      }
    }
  }
}

// ─── ElastiCache Metrics ─────────────────────────────────────────────────────

export async function collectElastiCacheMetricsBatched(
  client: CloudWatchClient,
  region: string,
  resources: Resource[],
  periodLabel: MetricPeriodLabel,
  signal?: AbortSignal,
): Promise<void> {
  const now = new Date();
  const startTime = new Date(now.getTime() - PERIOD_MS[periodLabel]);
  const eligible = resources.filter(
    (r) => r.type === 'elasticache_cluster' && r.region === region,
  );

  const ecBatch = batchSize(4, periodLabel);
  const ecBatchResults = await Promise.all(
    Array.from({ length: Math.ceil(eligible.length / ecBatch) }, (_, i) => {
      const batch = eligible.slice(i * ecBatch, (i + 1) * ecBatch);
      const queries: MetricDataQuery[] = [];
      for (let slot = 0; slot < batch.length; slot++) {
        const resource = batch[slot];
        if (!resource) continue;
        const id = resource.id;
        const p = `c${slot}`;
        queries.push(
          metricQuery(`${p}_cpuavg`, 'AWS/ElastiCache', 'CPUUtilization', 'Average', 'CacheClusterId', id),
          metricQuery(`${p}_cpup95`, 'AWS/ElastiCache', 'CPUUtilization', 'p95', 'CacheClusterId', id),
          metricQuery(`${p}_memused`, 'AWS/ElastiCache', 'DatabaseMemoryUsagePercentage', 'Average', 'CacheClusterId', id),
          metricQuery(`${p}_conns`, 'AWS/ElastiCache', 'CurrConnections', 'Average', 'CacheClusterId', id),
        );
      }

      return getMetricData(client, region, queries, startTime, now, signal).catch((err: unknown) => {
        logger.warn(
          {
            err: {
              message: redact(err instanceof Error ? err.message : String(err), 'moderate'),
              code: (err as { name?: string }).name,
            },
            resourceCount: batch.length,
          },
          'CloudWatch getMetricData batch failed',
        );
        return null;
      }).then((results) => ({ batch, results }));
    }),
  );

  const ecExpectedPoints = Math.floor((PERIOD_MS[periodLabel] ?? 0) / (86400 * 1000));
  for (const { batch, results } of ecBatchResults) {
    if (!results) continue;

    for (let slot = 0; slot < batch.length; slot++) {
      const resource = batch[slot];
      if (!resource) continue;
      const p = `c${slot}`;
      const cpuAvg = results.get(`${p}_cpuavg`) ?? [];
      const memUsed = results.get(`${p}_memused`) ?? [];
      const util: Utilization = {
        period: periodLabel,
        cpuAverage: average(cpuAvg),
        // Maximum CPU stat not collected for ElastiCache — would require additional CloudWatch query. Using 0 as placeholder.
        cpuMax: 0,
        cpuP95: maxVal(results.get(`${p}_cpup95`) ?? []),
        cpuP99: percentile(cpuAvg, 99),
        memoryAverage: average(memUsed),
        memoryMax: maxVal(memUsed),
        memoryP95: percentile(memUsed, 95),
        networkInMB: 0,
        networkOutMB: 0,
        diskReadIOPS: 0,
        diskWriteIOPS: 0,
        connectionCount: average(results.get(`${p}_conns`) ?? []),
        connectionCountMax: 0,
        dataPoints: cpuAvg.length,
        dataGaps: cpuAvg.length > 0 ? Math.max(0, ecExpectedPoints - cpuAvg.length) : 0,
        freshnessHrs: 0,
      };
      resource.utilization = util;
    }
  }
}

// ─── Lambda Metrics ───────────────────────────────────────────────────────────

export async function collectLambdaMetricsBatched(
  client: CloudWatchClient,
  region: string,
  resources: Resource[],
  periodLabel: MetricPeriodLabel,
  signal?: AbortSignal,
): Promise<void> {
  const now = new Date();
  const startTime = new Date(now.getTime() - PERIOD_MS[periodLabel]);
  const eligible = resources.filter(
    (r) => r.type === 'lambda_function' && r.region === region,
  );

  const lambdaBatch = batchSize(3, periodLabel);
  const lambdaBatchResults = await Promise.all(
    Array.from({ length: Math.ceil(eligible.length / lambdaBatch) }, (_, i) => {
      const batch = eligible.slice(i * lambdaBatch, (i + 1) * lambdaBatch);
      const queries: MetricDataQuery[] = [];
      for (let slot = 0; slot < batch.length; slot++) {
        const resource = batch[slot];
        if (!resource) continue;
        const id = resource.id;
        const p = `l${slot}`;
        queries.push(
          { Id: `${p}_inv`, MetricStat: { Metric: { Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [{ Name: 'FunctionName', Value: id }] }, Period: 86400, Stat: 'Sum' } },
          metricQuery(`${p}_davg`, 'AWS/Lambda', 'Duration', 'Average', 'FunctionName', id),
          metricQuery(`${p}_dp95`, 'AWS/Lambda', 'Duration', 'p95', 'FunctionName', id),
        );
      }

      return getMetricData(client, region, queries, startTime, now, signal).catch((err: unknown) => {
        logger.warn(
          {
            err: {
              message: redact(err instanceof Error ? err.message : String(err), 'moderate'),
              code: (err as { name?: string }).name,
            },
            resourceCount: batch.length,
          },
          'CloudWatch getMetricData batch failed',
        );
        return null;
      }).then((results) => ({ batch, results }));
    }),
  );

  const lambdaExpectedPoints = Math.floor((PERIOD_MS[periodLabel] ?? 0) / (86400 * 1000));
  for (const { batch, results } of lambdaBatchResults) {
    if (!results) continue;

    for (let slot = 0; slot < batch.length; slot++) {
      const resource = batch[slot];
      if (!resource) continue;
      const p = `l${slot}`;
      const inv = results.get(`${p}_inv`) ?? [];
      const totalInvocations = inv.reduce((a, b) => a + b, 0);
      const util: Utilization = {
        period: periodLabel,
        cpuAverage: 0, // Lambda has no CPU metric
        cpuMax: 0,
        cpuP95: 0,
        avgDurationMs: average(results.get(`${p}_davg`) ?? []),
        cpuP99: 0,
        memoryAverage: 0,
        memoryMax: 0,
        memoryP95: 0,
        invocations: totalInvocations,
        networkInMB: 0,
        networkOutMB: 0,
        diskReadIOPS: 0,
        diskWriteIOPS: 0,
        connectionCount: 0,
        connectionCountMax: 0,
        dataPoints: inv.length,
        dataGaps: inv.length > 0 ? Math.max(0, lambdaExpectedPoints - inv.length) : 0,
        freshnessHrs: 0,
      };
      resource.utilization = util;
    }
  }
}
