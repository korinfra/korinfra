import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDriver } from '../../../src/storage/drivers/node.js';
import { PricingCache } from '../../../src/pricing/cache.js';
import type { Driver } from '../../../src/storage/drivers/node.js';

const _dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(_dirname, '../../../src/storage/migrations');

function createTestDb(): Driver {
  const db = openDriver(':memory:');
  db.pragma('foreign_keys = ON');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  return db;
}

let db: Driver;
let cache: PricingCache;

beforeEach(() => { db = createTestDb(); cache = new PricingCache(db); });
afterEach(() => { db.close(); });

// ─── set / get ────────────────────────────────────────────────────────────────

describe('PricingCache — set and get', () => {
  it('miss returns null; set-then-get returns stored price; upsert updates existing entry', () => {
    expect(cache.getCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1')).toBeNull();

    cache.setCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1', 0.096);
    expect(cache.getCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1')).toBeCloseTo(0.096, 6);

    cache.setCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1', 0.100);
    expect(cache.getCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1')).toBeCloseTo(0.100, 6);
  });

  it('stores RDS and ElastiCache pricing data', () => {
    cache.setCachedPrice('AmazonRDS', 'db.r6g.large:MySQL', 'us-east-1', 0.1308);
    expect(cache.getCachedPrice('AmazonRDS', 'db.r6g.large:MySQL', 'us-east-1')).toBeCloseTo(0.1308, 6);

    cache.setCachedPrice('AmazonElastiCache', 'cache.r6g.large', 'us-east-1', 0.150);
    expect(cache.getCachedPrice('AmazonElastiCache', 'cache.r6g.large', 'us-east-1')).toBeCloseTo(0.150, 6);
  });

  it('keys are independent across service codes, regions, and resource keys', () => {
    cache.setCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1', 0.096);
    cache.setCachedPrice('AmazonRDS', 'm5.large:Linux', 'us-east-1', 0.171);
    expect(cache.getCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1')).toBeCloseTo(0.096, 6);
    expect(cache.getCachedPrice('AmazonRDS', 'm5.large:Linux', 'us-east-1')).toBeCloseTo(0.171, 6);

    cache.setCachedPrice('AmazonEC2', 'm5.large:Linux', 'eu-west-1', 0.107);
    expect(cache.getCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1')).toBeCloseTo(0.096, 6);
    expect(cache.getCachedPrice('AmazonEC2', 'm5.large:Linux', 'eu-west-1')).toBeCloseTo(0.107, 6);

    cache.setCachedPrice('AmazonEC2', 'm5.xlarge:Linux', 'us-east-1', 0.192);
    expect(cache.getCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1')).toBeCloseTo(0.096, 6);
    expect(cache.getCachedPrice('AmazonEC2', 'm5.xlarge:Linux', 'us-east-1')).toBeCloseTo(0.192, 6);
  });
});

// ─── TTL / purgeExpired / stats ───────────────────────────────────────────────

describe('PricingCache — TTL, purge, and stats', () => {
  it('ttlDays=0 expires immediately; positive TTL is retrievable', () => {
    cache.setCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1', 0.096, null, 0);
    expect(cache.getCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1')).toBeNull();

    cache.setCachedPrice('AmazonEC2', 't3.micro:Linux', 'us-east-1', 0.0104, null, 7);
    expect(cache.getCachedPrice('AmazonEC2', 't3.micro:Linux', 'us-east-1')).toBeCloseTo(0.0104, 6);
  });

  it('purgeExpired removes only expired entries and returns correct count', () => {
    expect(cache.purgeExpired()).toBe(0); // empty cache

    cache.setCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1', 0.096); // 7d TTL
    expect(cache.purgeExpired()).toBe(0); // nothing expired

    cache.setCachedPrice('AmazonEC2', 'expired.instance:Linux', 'us-east-1', 0.096, null, 0);
    cache.setCachedPrice('AmazonEC2', 'fresh.instance:Linux', 'us-east-1', 0.192, null, 7);
    expect(cache.purgeExpired()).toBe(1);
    expect(cache.getCachedPrice('AmazonEC2', 'fresh.instance:Linux', 'us-east-1')).toBeCloseTo(0.192, 6);
  });

  it('getCacheStats returns correct counts and timestamps', () => {
    let stats = cache.getCacheStats();
    expect(stats.count).toBe(0);
    expect(stats.total_size_bytes).toBe(0);

    cache.setCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1', 0.096);
    cache.setCachedPrice('AmazonEC2', 'm5.xlarge:Linux', 'us-east-1', 0.192);
    cache.setCachedPrice('AmazonRDS', 'db.t3.medium:MySQL', 'us-east-1', 0.068);
    stats = cache.getCacheStats();
    expect(stats.count).toBe(3);
    expect(stats.oldest_entry).toBeTruthy();
    expect(stats.newest_entry).toBeTruthy();

    // Upsert does not increase count
    cache.setCachedPrice('AmazonEC2', 'm5.large:Linux', 'us-east-1', 0.100);
    expect(cache.getCacheStats().count).toBe(3);
  });
});
