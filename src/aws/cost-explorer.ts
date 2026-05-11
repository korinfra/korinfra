import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from '@aws-sdk/client-cost-explorer';
import type { GroupDefinition } from '@aws-sdk/client-cost-explorer';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import type { CostEntry } from './types.js';
import { throttledCall } from './rate-limiter.js';
import { getCredentials } from './credentials.js';
import { dbg } from './debug.js';
import { logger } from '../utils/logger.js';

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
}

const _ceCache = new Map<string, CeCacheEntry>();

function loadCeCache(): void {
  if (_ceCache.size > 0) return; // already loaded
  try {
    const raw = readFileSync(CE_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, CeCacheEntry>;
    const now = Date.now();
    for (const [key, entry] of Object.entries(parsed)) {
      if (entry.expiresAt > now) _ceCache.set(key, entry);
    }
  } catch {
    // no cache file yet — ignore
  }
}

function saveCeCache(): void {
  try {
    mkdirSync(CE_CACHE_DIR, { recursive: true });
    const obj: Record<string, CeCacheEntry> = {};
    for (const [k, v] of _ceCache) obj[k] = v;
    writeFileSync(CE_CACHE_FILE, JSON.stringify(obj), 'utf8');
  } catch {
    // non-fatal
  }
}

function getCeCacheEntry(key: string): CeCacheEntry | undefined {
  loadCeCache();
  const entry = _ceCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) { _ceCache.delete(key); return undefined; }
  return entry;
}

function setCeCacheEntry(key: string, costs: CostEntry[], resourceCosts: Map<string, number>, ttlMs?: number): void {
  _ceCache.set(key, {
    costs,
    resourceCosts: Object.fromEntries(resourceCosts),
    expiresAt: Date.now() + (ttlMs ?? CE_CACHE_TTL_MS),
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
): Promise<CostEntry[]> {
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
  const entries: CostEntry[] = [];
  let nextPageToken: string | undefined;
  let pageCount = 0;
  const MAX_PAGES = 20;

  try {
    do {
      const out = await throttledCall('costexplorer', 'GetCostAndUsage', 'us-east-1', () => {
        const options: Record<string, unknown> = {};
        if (signal !== undefined) options['abortSignal'] = signal;
        return client.send(
          new GetCostAndUsageCommand({
            TimePeriod: { Start: startDate, End: endDate },
            Granularity: granularity,
            Metrics: ['UnblendedCost', 'UsageQuantity'],
            GroupBy: [groupDef],
            ...(nextPageToken ? { NextPageToken: nextPageToken } : {}),
          }),
          options as Parameters<typeof client.send>[1],
        );
      },
      0.01); // Cost Explorer is $0.01/request

      nextPageToken = out.NextPageToken;
      pageCount++;
      if (pageCount >= MAX_PAGES && nextPageToken) {
        logger.warn({ pageCount, service: 'costexplorer', operation: 'GetCostAndUsage' }, 'CE pagination limit reached — truncating results');
        break;
      }

      for (const result of out.ResultsByTime ?? []) {
        const periodStart = result.TimePeriod?.Start ?? startDate;
        const periodEnd = result.TimePeriod?.End ?? endDate;

        if ((result.Groups ?? []).length === 0) {
          const amount = parseFloat(result.Total?.['UnblendedCost']?.Amount ?? '0');
          const usageAmountStr = result.Total?.['UsageQuantity']?.Amount;
          const usageQuantity = (usageAmountStr !== null && usageAmountStr !== undefined && usageAmountStr !== '')
            ? (Number.isFinite(Number(usageAmountStr)) ? Number(usageAmountStr) : 0)
            : 0;
          entries.push({
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
          const amount = parseFloat(group.Metrics?.['UnblendedCost']?.Amount ?? '0');
          const groupUsageStr = group.Metrics?.['UsageQuantity']?.Amount;
          const usageQuantity = (groupUsageStr !== null && groupUsageStr !== undefined && groupUsageStr !== '')
            ? (Number.isFinite(Number(groupUsageStr)) ? Number(groupUsageStr) : 0)
            : 0;
          entries.push({
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
    } while (nextPageToken);
  } finally {
    requestHandler.destroy();
  }

  return entries;
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
): Promise<Map<string, number>> {
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
  let nextPageToken: string | undefined;
  let pageCount = 0;
  const MAX_PAGES = 20;

  try {
    do {
      const out = await throttledCall('costexplorer', 'GetCostAndUsage', 'us-east-1', () => {
        const options: Record<string, unknown> = {};
        if (signal !== undefined) options['abortSignal'] = signal;
        return client.send(
          new GetCostAndUsageCommand({
            TimePeriod: { Start: startDate, End: endDate },
            Granularity: granularity,
            Metrics: ['UnblendedCost'],
            GroupBy: [groupDef],
            ...(nextPageToken ? { NextPageToken: nextPageToken } : {}),
          }),
          options as Parameters<typeof client.send>[1],
        );
      },
      0.01); // Cost Explorer is $0.01/request

      nextPageToken = out.NextPageToken;
      pageCount++;
      if (pageCount >= MAX_PAGES && nextPageToken) {
        logger.warn({ pageCount, service: 'costexplorer', operation: 'GetCostAndUsageByResource' }, 'CE pagination limit reached — truncating results');
        break;
      }

      for (const result of out.ResultsByTime ?? []) {
        for (const group of result.Groups ?? []) {
          const resourceId = group.Keys?.[0];
          const amount = Number(group.Metrics?.['UnblendedCost']?.Amount ?? '0');

          if (resourceId && Number.isFinite(amount) && amount > 0) {
            // Aggregate costs across time periods for the same resource
            const existing = resourceMap.get(resourceId) ?? 0;
            resourceMap.set(resourceId, existing + amount);
          }
        }
      }
    } while (nextPageToken);
  } catch {
    // Non-fatal — account may not have resource-level CE data enabled
    // Return empty map so pricing estimates are used as fallback
    return new Map();
  } finally {
    requestHandler.destroy();
  }

  return resourceMap;
}

// In-flight dedup: prevents concurrent callers from all missing cache simultaneously
const _ceInFlight = new Map<string, Promise<{ costs: CostEntry[]; resourceCosts: Map<string, number> }>>();

/**
 * Queries AWS Cost Explorer with 6-hour file-backed cache + in-process module singleton.
 * In-flight dedup prevents concurrent callers from all missing cache simultaneously.
 * `includeResourceCosts` defaults to false — each RESOURCE_ID groupBy query costs $0.01+.
 * Cache key = `${startDate}:${endDate}:${granularity}:${groupBy}:${includeResourceCosts}`.
 */
export async function getCostsCached(
  config: { profile?: string; roleArn?: string; externalId?: string },
  options: CostQueryOptions = {},
  signal?: AbortSignal,
): Promise<{ costs: CostEntry[]; resourceCosts: Map<string, number> }> {
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
    };
  }

  // Superset reuse: if caller only needs costs (not resource breakdown), check if a richer
  // includeResourceCosts=true entry already exists — costs array is identical, skip the extra call.
  if (!includeResourceCosts) {
    const supersetKey = `${startDate}:${endDate}:${granularity}:${groupBy}:true`;
    const supersetCached = getCeCacheEntry(supersetKey);
    if (supersetCached) {
      dbg('CE superset cache hit — reusing true entry for costs-only request');
      return { costs: supersetCached.costs, resourceCosts: new Map() };
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

  const fetchPromise = (async () => {
    try {
      const [costs, resourceCosts] = await Promise.all([
        getCosts(config, { ...options, startDate, endDate }, signal),
        includeResourceCosts
          ? getCostsByResource(config, { ...options, startDate, endDate }, signal).catch(() => new Map<string, number>())
          : Promise.resolve(new Map<string, number>()),
      ]);
      setCeCacheEntry(cacheKey, costs, resourceCosts, options.cacheTtlMs);
      dbg(`CE cache saved — ${Date.now() - t_ce}ms`);
      return { costs, resourceCosts };
    } finally {
      _ceInFlight.delete(cacheKey);
    }
  })();

  _ceInFlight.set(cacheKey, fetchPromise);
  return fetchPromise;
}
