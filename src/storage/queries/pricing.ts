import type { Driver } from '../drivers/node.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PricingCacheEntry {
  id?: number;
  service_code: string;
  resource_key: string;
  region: string;
  hourly_price: number;
  price_unit?: string;
  attributes?: Record<string, unknown> | null;
  fetched_at: string;
  expires_at: string;
  created_at?: string;
}

export interface CacheStats {
  count: number;
  total_size_bytes: number;
  oldest_entry?: string | null;
  newest_entry?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeParse(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw as string) as Record<string, unknown>; } catch { return null; }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function upsertPrice(
  db: Driver,
  serviceCode: string,
  resourceKey: string,
  region: string,
  hourlyPrice: number,
  attributes?: Record<string, unknown> | null,
  ttlDays = 30,
): void {
  const now = new Date();
  const fetchedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000).toISOString();

  db.prepare(`
    INSERT INTO pricing_cache (service_code, resource_key, region, hourly_price, attributes, fetched_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(service_code, resource_key, region) DO UPDATE SET
      hourly_price = excluded.hourly_price,
      attributes   = excluded.attributes,
      fetched_at   = excluded.fetched_at,
      expires_at   = excluded.expires_at
  `).run(
    serviceCode,
    resourceKey,
    region,
    hourlyPrice,
    attributes ? JSON.stringify(attributes) : null,
    fetchedAt,
    expiresAt,
  );
}

export function getPrice(
  db: Driver,
  serviceCode: string,
  resourceKey: string,
  region: string,
): PricingCacheEntry | null {
  const now = new Date().toISOString();
  const row = db.prepare(`
    SELECT id, service_code, resource_key, region, hourly_price, price_unit,
      attributes, fetched_at, expires_at, created_at
    FROM pricing_cache
    WHERE service_code = ? AND resource_key = ? AND region = ? AND expires_at > ?
  `).get(serviceCode, resourceKey, region, now) as Record<string, unknown> | undefined;

  if (!row) return null;

  const id = row['id'] as number | undefined;
  const created_at = row['created_at'] as string | undefined;
  const result: Record<string, unknown> = {
    service_code: row['service_code'],
    resource_key: row['resource_key'],
    region: row['region'],
    hourly_price: row['hourly_price'],
    price_unit: (row['price_unit']) ?? 'Hrs',
    attributes: safeParse(row['attributes']),
    fetched_at: row['fetched_at'],
    expires_at: row['expires_at'],
  };
  if (id !== undefined) result['id'] = id;
  if (created_at !== undefined) result['created_at'] = created_at;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result as any as PricingCacheEntry;
}

export function purgeExpired(db: Driver): number {
  const now = new Date().toISOString();
  const result = db.prepare("DELETE FROM pricing_cache WHERE expires_at <= ?").run(now);
  return (result as { changes: number }).changes;
}

export function getCacheStats(db: Driver): CacheStats {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS count,
      SUM(LENGTH(COALESCE(attributes, ''))) AS total_size_bytes,
      MIN(fetched_at) AS oldest_entry,
      MAX(fetched_at) AS newest_entry
    FROM pricing_cache
  `).get() as Record<string, unknown>;

  return {
    count: (row['count'] as number) ?? 0,
    total_size_bytes: (row['total_size_bytes'] as number) ?? 0,
    oldest_entry: row['oldest_entry'] as string | null,
    newest_entry: row['newest_entry'] as string | null,
  };
}
