import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from '@aws-sdk/client-cost-explorer';
import type { GroupDefinition } from '@aws-sdk/client-cost-explorer';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { join } from 'node:path';
import os from 'node:os';
import type { CostEntry } from './types.js';
import { throttledCall } from './rate-limiter.js';
import { getCredentials } from './credentials.js';
import { dbg } from './debug.js';
import { logger } from '../utils/logger.js';
import { paginateAll } from '../utils/pagination.js';
import { safeReadFile, safeWriteFile } from '../utils/safe-fs.js';

/** Page cap for CE pagination. Raised from 20 to 100 to cover MONTHLY/12-mo queries on large accounts. */
const CE_MAX_PAGES = 100;

export type Granularity = 'DAILY' | 'MONTHLY';
export type GroupBy = 'SERVICE' | 'REGION' | 'USAGE_TYPE' | 'RESOURCE_ID';

interface CostQueryOptions {
  startDate?: string; // YYYY-MM-DD; defaults to 30 days ago
  endDate?: string; // YYYY-MM-DD; defaults to today
  granularity?: Granularity;
  groupBy?: GroupBy;
  includeResourceCosts?: boolean; // default false — each call costs $0.01+
  cacheTtlMs?: number; // override default 6-hour CE cache TTL
}

const CE_CACHE_DIR = join(os.homedir(), '.korinfra');
const CE_CACHE_FILE = join(CE_CACHE_DIR, 'ce_cache.json');
const CE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface CeCacheEntry {
  costs: CostEntry[];
  resourceCosts: Record<string, number>;
  expiresAt: number;
  /** True if the underlying CE pagination loop was capped before all pages were drained. */
  partial?: boolean;
}

const _ceCache = new Map<string, CeCacheEntry>();

function loadCeCache(): void {
  if (_ceCache.size > 0) return; // already loaded
  try {
    const raw = safeReadFile(CE_CACHE_FILE, { requireMode: 0o600 });
    const parsed = JSON.parse(raw) as Record<string, CeCacheEntry>;
    const now = Date.now();
    for (const [key, entry] of Object.entries(parsed)) {
      // Back-compat: entries written before the partial flag existed default to false.
      entry.partial = entry.partial ?? false;
      if (entry.expiresAt > now) _ceCache.set(key, entry);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn({ err: String(err) }, 'CE cache load failed — treating as cache miss');
    }
  }
}

function saveCeCache(): void {
  try {
    const obj: Record<string, CeCacheEntry> = {};
    for (const [k, v] of _ceCache) obj[k] = v;
    safeWriteFile(CE_CACHE_FILE, JSON.stringify(obj), { mode: 0o600, dirMode: 0o700 });
  } catch (err) {
    logger.warn({ err: String(err) }, 'CE cache save failed');
  }
}

function getCeCacheEntry(key: string): CeCacheEntry | undefined {
  loadCeCache();
  const entry = _ceCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) { _ceCache.delete(key); return undefined; }
  return entry;
}

function setCeCacheEntry(key: string, costs: CostEntry[], resourceCosts: Map<string, number>, partial: boolean, ttlMs?: number): void {
  _ceCache.set(key, {
    costs,
    resourceCosts: Object.fromEntries(resourceCosts),
    expiresAt: Date.now() + (ttlMs ?? CE_CACHE_TTL_MS),
    // Conditional spread keeps the JSON small for the common partial=false case.
    ...(partial ? { partial: true } : {}),
  });
  saveCeCache();
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Queries AWS Cost Explorer. Cost Explorer is a global service — always uses us-east-1.
 * Each call costs $0.01 and is logged to the API call log.
 */
async function getCosts(
  config: { profile?: string; roleArn?: string; externalId?: string },
  options: CostQueryOptions = {},
  signal?: AbortSignal,
): Promise<{ entries: CostEntry[]; partial: boolean }> {
  const now = new Date();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 30);

  const startDate = options.startDate ?? isoDate(defaultStart);
  // AWS Cost Explorer excludes the end date, so today returns data up to yesterday (last complete day).
  const endDate = options.endDate ?? isoDate(now);
  const granularity: Granularity = options.granularity ?? 'DAILY';
  const groupBy: GroupBy = options.groupBy ?? 'SERVICE';

  const credentialsConfig: Record<string, unknown> = { regions: ['us-east-1'] };
  if (config.profile !== undefined) credentialsConfig['profile'] = config.profile;
  if (config.roleArn !== undefined) credentialsConfig['roleArn'] = config.roleArn;
  if (config.externalId !== undefined) credentialsConfig['externalId'] = config.externalId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const credentials = getCredentials(credentialsConfig as any);

  // Cost Explorer only works in us-east-1
  const requestHandler = new NodeHttpHandler({ connectionTimeout: 3_000, socketTimeout: 15_000 });
  signal?.addEventListener('abort', () => requestHandler.destroy(), { once: true });
  const client = new CostExplorerClient({ credentials, region: 'us-east-1', requestHandler, maxAttempts: 1 });

  const groupDef: GroupDefinition = { Type: 'DIMENSION', Key: groupBy };
  const num = (s: string | undefined): number => {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  };

  try {
    const { items: entries, partial, pagesFetched } = await paginateAll<CostEntry>(
      async (token) => {
        const out = await throttledCall('costexplorer', 'GetCostAndUsage', 'us-east-1', () => {
          const sendOptions: Record<string, unknown> = {};
          if (signal !== undefined) sendOptions['abortSignal'] = signal;
          return client.send(
            new GetCostAndUsageCommand({
              TimePeriod: { Start: startDate, End: endDate },
              Granularity: granularity,
              Metrics: ['UnblendedCost', 'UsageQuantity'],
              GroupBy: [groupDef],
              ...(token !== undefined ? { NextPageToken: token } : {}),
            }),
            sendOptions as Parameters<typeof client.send>[1],
          );
        },
        0.01); // Cost Explorer is $0.01/request

        const pageEntries: CostEntry[] = [];
        for (const result of out.ResultsByTime ?? []) {
          const periodStart = result.TimePeriod?.Start ?? startDate;
          const periodEnd = result.TimePeriod?.End ?? endDate;

          if ((result.Groups ?? []).length === 0) {
            const amount = num(result.Total?.['UnblendedCost']?.Amount);
            const usageQuantity = num(result.Total?.['UsageQuantity']?.Amount);
            pageEntries.push({
              service: 'Total',
              amount,
              unit: result.Total?.['UnblendedCost']?.Unit ?? 'USD',
              startDate: periodStart,
              endDate: periodEnd,
              granularity,
              ...(usageQuantity !== 0 ? { usageQuantity } : {}),
            });
            continue;
          }

          for (const group of result.Groups ?? []) {
            const service = group.Keys?.[0] ?? 'Unknown';
            const amount = num(group.Metrics?.['UnblendedCost']?.Amount);
            const usageQuantity = num(group.Metrics?.['UsageQuantity']?.Amount);
            pageEntries.push({
              service,
              amount,
              unit: group.Metrics?.['UnblendedCost']?.Unit ?? 'USD',
              startDate: periodStart,
              endDate: periodEnd,
              granularity,
              ...(usageQuantity !== 0 ? { usageQuantity } : {}),
            });
          }
        }

        return { items: pageEntries, ...(out.NextPageToken !== undefined ? { nextToken: out.NextPageToken } : {}) };
      },
      {
        maxPages: CE_MAX_PAGES,
        onPartial: () => logger.warn(
          { pageCount: CE_MAX_PAGES, service: 'costexplorer', operation: 'GetCostAndUsage' },
          'CE pagination limit reached — truncating results (partial=true)',
        ),
        ...(signal !== undefined ? { signal } : {}),
      },
    );

    dbg(`CE getCosts done — pages:${pagesFetched} partial:${String(partial)} entries:${entries.length}`);
    return { entries, partial };
  } finally {
    requestHandler.destroy();
  }
}

/**
 * Queries AWS Cost Explorer for per-resource costs.
 * Returns a Map keyed by resource ID/ARN with monthly cost in USD.
 * Non-fatal — returns empty Map if the account doesn't have resource-level CE data enabled.
 */
async function getCostsByResource(
  config: { profile?: string; roleArn?: string; externalId?: string },
  options: CostQueryOptions = {},
  signal?: AbortSignal,
): Promise<{ resourceMap: Map<string, number>; partial: boolean }> {
  const now = new Date();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 30);

  const startDate = options.startDate ?? isoDate(defaultStart);
  // AWS Cost Explorer excludes the end date, so today returns data up to yesterday (last complete day).
  const endDate = options.endDate ?? isoDate(now);
  const granularity: Granularity = options.granularity ?? 'MONTHLY';

  const credentialsConfig: Record<string, unknown> = { regions: ['us-east-1'] };
  if (config.profile !== undefined) credentialsConfig['profile'] = config.profile;
  if (config.roleArn !== undefined) credentialsConfig['roleArn'] = config.roleArn;
  if (config.externalId !== undefined) credentialsConfig['externalId'] = config.externalId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const credentials = getCredentials(credentialsConfig as any);

  // Cost Explorer only works in us-east-1
  const requestHandler = new NodeHttpHandler({ connectionTimeout: 3_000, socketTimeout: 15_000 });
  signal?.addEventListener('abort', () => requestHandler.destroy(), { once: true });
  const client = new CostExplorerClient({ credentials, region: 'us-east-1', requestHandler, maxAttempts: 1 });

  const resourceMap = new Map<string, number>();
  const groupDef: GroupDefinition = { Type: 'DIMENSION', Key: 'RESOURCE_ID' };

  try {
    const { partial, pagesFetched } = await paginateAll<never>(
      async (token) => {
        const out = await throttledCall('costexplorer', 'GetCostAndUsage', 'us-east-1', () => {
          const sendOptions: Record<string, unknown> = {};
          if (signal !== undefined) sendOptions['abortSignal'] = signal;
          return client.send(
            new GetCostAndUsageCommand({
              TimePeriod: { Start: startDate, End: endDate },
              Granularity: granularity,
              Metrics: ['UnblendedCost'],
              GroupBy: [groupDef],
              ...(token !== undefined ? { NextPageToken: token } : {}),
            }),
            sendOptions as Parameters<typeof client.send>[1],
          );
        },
        0.01); // Cost Explorer is $0.01/request

        for (const result of out.ResultsByTime ?? []) {
          for (const group of result.Groups ?? []) {
            const resourceId = group.Keys?.[0];
            const amount = Number(group.Metrics?.['UnblendedCost']?.Amount ?? '0');

            if (resourceId !== undefined && resourceId !== '' && Number.isFinite(amount) && amount > 0) {
              // Aggregate costs across time periods for the same resource
              const existing = resourceMap.get(resourceId) ?? 0;
              resourceMap.set(resourceId, existing + amount);
            }
          }
        }

        // The aggregation above writes straight into resourceMap; we don't push items into paginateAll.
        return { items: [], ...(out.NextPageToken !== undefined ? { nextToken: out.NextPageToken } : {}) };
      },
      {
        maxPages: CE_MAX_PAGES,
        onPartial: () => logger.warn(
          { pageCount: CE_MAX_PAGES, service: 'costexplorer', operation: 'GetCostAndUsageByResource' },
          'CE pagination limit reached — truncating results (partial=true)',
        ),
        ...(signal !== undefined ? { signal } : {}),
      },
    );

    dbg(`CE getCostsByResource done — pages:${pagesFetched} partial:${String(partial)} resources:${resourceMap.size}`);
    return { resourceMap, partial };
  } catch {
    // Non-fatal — account may not have resource-level CE data enabled.
    // Error path is distinct from truncation: return empty map with partial=false.
    return { resourceMap: new Map(), partial: false };
  } finally {
    requestHandler.destroy();
  }
}

/** Return shape for the public CE entry point. `partial` is true when EITHER the costs or the resource-cost pagination loop was capped. */
export interface CostsCachedResult {
  costs: CostEntry[];
  resourceCosts: Map<string, number>;
  partial: boolean;
}

// In-flight dedup: prevents concurrent callers from all missing cache simultaneously
const _ceInFlight = new Map<string, Promise<CostsCachedResult>>();

/**
 * Queries AWS Cost Explorer with 6-hour file-backed cache + in-process module singleton.
 * In-flight dedup prevents concurrent callers from all missing cache simultaneously.
 * `includeResourceCosts` defaults to false — each RESOURCE_ID groupBy query costs $0.01+.
 * Cache key = `${startDate}:${endDate}:${granularity}:${groupBy}:${includeResourceCosts}`.
 * `partial` is set when the pagination cap is reached so downstream consumers can flag dashboards.
 */
export async function getCostsCached(
  config: { profile?: string; roleArn?: string; externalId?: string },
  options: CostQueryOptions = {},
  signal?: AbortSignal,
): Promise<CostsCachedResult> {
  const now = new Date();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 30);
  const startDate = options.startDate ?? isoDate(defaultStart);
  const endDate = options.endDate ?? isoDate(now);
  const granularity: Granularity = options.granularity ?? 'DAILY';
  const groupBy: GroupBy = options.groupBy ?? 'SERVICE';
  const includeResourceCosts = options.includeResourceCosts ?? false;
  const cacheKey = `${startDate}:${endDate}:${granularity}:${groupBy}:${includeResourceCosts}`;

  const cached = getCeCacheEntry(cacheKey);
  if (cached) {
    dbg('CE cache hit — skipping API calls');
    return {
      costs: cached.costs,
      resourceCosts: new Map(Object.entries(cached.resourceCosts)),
      partial: cached.partial ?? false,
    };
  }

  // Superset reuse: if caller only needs costs (not resource breakdown), check if a richer
  // includeResourceCosts=true entry already exists — costs array is identical, skip the extra call.
  if (!includeResourceCosts) {
    const supersetKey = `${startDate}:${endDate}:${granularity}:${groupBy}:true`;
    const supersetCached = getCeCacheEntry(supersetKey);
    if (supersetCached) {
      dbg('CE superset cache hit — reusing true entry for costs-only request');
      return { costs: supersetCached.costs, resourceCosts: new Map(), partial: supersetCached.partial ?? false };
    }
  }

  // In-flight dedup: if a concurrent caller is already fetching the same key, share its promise
  const inflight = _ceInFlight.get(cacheKey);
  if (inflight) {
    dbg('CE in-flight hit — reusing pending fetch');
    return inflight;
  }

  dbg('CE cache miss — fetching from API');
  const t_ce = Date.now();

  const fetchPromise = (async (): Promise<CostsCachedResult> => {
    try {
      const [costsResult, resourceResult] = await Promise.all([
        getCosts(config, { ...options, startDate, endDate }, signal),
        includeResourceCosts
          ? getCostsByResource(config, { ...options, startDate, endDate }, signal)
              .catch(() => ({ resourceMap: new Map<string, number>(), partial: false }))
          : Promise.resolve({ resourceMap: new Map<string, number>(), partial: false }),
      ]);
      const partial = costsResult.partial || resourceResult.partial;
      setCeCacheEntry(cacheKey, costsResult.entries, resourceResult.resourceMap, partial, options.cacheTtlMs);
      dbg(`CE cache saved — ${Date.now() - t_ce}ms partial:${String(partial)}`);
      return { costs: costsResult.entries, resourceCosts: resourceResult.resourceMap, partial };
    } finally {
      _ceInFlight.delete(cacheKey);
    }
  })();

  _ceInFlight.set(cacheKey, fetchPromise);
  return fetchPromise;
}
