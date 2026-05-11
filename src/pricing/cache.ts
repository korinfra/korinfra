/**
 * SQLite-backed pricing cache.
 * Default TTL matches scan.pricing_cache_ttl_days config default (7 days).
 * Wraps the storage layer queries from src/storage/queries/pricing.ts.
 */

import type { Driver } from '../storage/drivers/node.js';
import {
  getPrice,
  upsertPrice,
  purgeExpired as storagePurgeExpired,
  getCacheStats as storageGetCacheStats,
} from '../storage/queries/pricing.js';
import type { CacheStats } from '../storage/queries/pricing.js';

export type { CacheStats };

const DEFAULT_TTL_DAYS = 7;

export class PricingCache {
  constructor(
    private readonly db: Driver,
    private readonly defaultTtlDays = DEFAULT_TTL_DAYS,
  ) {}

  /**
   * Retrieves a cached hourly price. Returns null if not found or expired.
   */
  getCachedPrice(serviceCode: string, resourceKey: string, region: string): number | null {
    const entry = getPrice(this.db, serviceCode, resourceKey, region);
    return entry ? entry.hourly_price : null;
  }

  /**
   * Stores or updates a pricing entry in the cache.
   */
  setCachedPrice(
    serviceCode: string,
    resourceKey: string,
    region: string,
    hourlyPrice: number,
    attributes?: Record<string, unknown> | null,
    ttlDays?: number,
  ): void {
    const effectiveTtl = ttlDays ?? this.defaultTtlDays;
    upsertPrice(this.db, serviceCode, resourceKey, region, hourlyPrice, attributes, effectiveTtl);
  }

  /**
   * Removes all expired entries. Returns the number of rows deleted.
   */
  purgeExpired(): number {
    return storagePurgeExpired(this.db);
  }

  /**
   * Removes every pricing entry from the cache. Returns the number of rows deleted.
   */
  clearAll(): number {
    const result = this.db.prepare('DELETE FROM pricing_cache').run();
    return (result as { changes: number }).changes;
  }

  /**
   * Returns basic statistics about the pricing cache.
   */
  getCacheStats(): CacheStats {
    return storageGetCacheStats(this.db);
  }

  /**
   * Returns the number of expired entries.
   */
  getExpiredCount(): number {
    const now = new Date().toISOString();
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM pricing_cache WHERE expires_at <= ?')
      .get(now) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /**
   * Returns per-region breakdown of active cache entries.
   */
  getRegionBreakdown(): Array<{ region: string; count: number; oldest: string; newest: string }> {
    const now = new Date().toISOString();
    return this.db.prepare(`
      SELECT region, COUNT(*) AS count, MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest
      FROM pricing_cache
      WHERE expires_at > ?
      GROUP BY region
      ORDER BY region
    `).all(now) as Array<{ region: string; count: number; oldest: string; newest: string }>;
  }
}
