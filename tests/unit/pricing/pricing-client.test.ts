import { describe, it, expect } from 'vitest';
import { regionToLocation, extractOnDemandPrice, buildCacheKeyFromAttributes } from '../../../src/pricing/client.js';

// ─── regionToLocation ─────────────────────────────────────────────────────────

describe('regionToLocation', () => {
  it('maps known regions and falls back to region code for unknown', () => {
    expect(regionToLocation('us-east-1')).toBe('US East (N. Virginia)');
    expect(regionToLocation('eu-west-1')).toBe('EU (Ireland)');
    expect(regionToLocation('ap-northeast-1')).toBe('Asia Pacific (Tokyo)');
    expect(regionToLocation('unknown-region-99')).toBe('unknown-region-99');
  });
});

// ─── buildCacheKeyFromAttributes tests ────────────────────────────────────────

describe('buildCacheKeyFromAttributes', () => {
  it('returns null when required attributes are missing', () => {
    expect(buildCacheKeyFromAttributes('AmazonEC2', {})).toBeNull();
    expect(buildCacheKeyFromAttributes('AmazonRDS', {})).toBeNull();
    expect(buildCacheKeyFromAttributes('AmazonElastiCache', {})).toBeNull();
  });

  it('EC2 compute: builds key from instanceType and operatingSystem, defaults to Linux', () => {
    expect(buildCacheKeyFromAttributes('AmazonEC2', { instanceType: 'm5.large' })).toBe('m5.large:Linux');
    expect(buildCacheKeyFromAttributes('AmazonEC2', { instanceType: 'm5.large', operatingSystem: 'Windows' })).toBe('m5.large:Windows');
  });

  it('EC2 storage: returns volumeApiName if present and productFamily is Storage', () => {
    expect(buildCacheKeyFromAttributes('AmazonEC2', { volumeApiName: 'gp3' }, 'Storage')).toBe('gp3');
    expect(buildCacheKeyFromAttributes('AmazonEC2', { volumeApiName: 'gp3' })).toBeNull();
  });

  it('RDS: builds key from instanceType and databaseEngine, includes Multi-AZ suffix', () => {
    const attrs = { instanceType: 'db.r6g.large', databaseEngine: 'MySQL', deploymentOption: 'Single-AZ' };
    expect(buildCacheKeyFromAttributes('AmazonRDS', attrs)).toBe('db.r6g.large:MySQL');
    expect(buildCacheKeyFromAttributes('AmazonRDS', { ...attrs, deploymentOption: 'Multi-AZ' })).toBe('db.r6g.large:MySQL|multi-az');
  });

  it('ElastiCache: includes cacheEngine in key, defaults to Redis', () => {
    expect(buildCacheKeyFromAttributes('AmazonElastiCache', { instanceType: 'cache.r6g.large' })).toBe('cache.r6g.large|Redis');
    expect(buildCacheKeyFromAttributes('AmazonElastiCache', { instanceType: 'cache.r6g.large', cacheEngine: 'Memcached' })).toBe('cache.r6g.large|Memcached');
  });

  it('S3: returns volumeType or falls back to storageClass', () => {
    expect(buildCacheKeyFromAttributes('AmazonS3', { volumeType: 'Standard' })).toBe('Standard');
    expect(buildCacheKeyFromAttributes('AmazonS3', { storageClass: 'GLACIER' })).toBe('GLACIER');
    expect(buildCacheKeyFromAttributes('AmazonS3', {})).toBeNull();
  });

  it('ELB, DynamoDB, VPC: returns usagetype or null', () => {
    expect(buildCacheKeyFromAttributes('AWSELB', { usagetype: 'LoadBalancerUsage' })).toBe('LoadBalancerUsage');
    expect(buildCacheKeyFromAttributes('AmazonDynamoDB', { usagetype: 'WriteCapacityUnits' })).toBe('WriteCapacityUnits');
    expect(buildCacheKeyFromAttributes('AmazonVPC', { usagetype: 'NAT-Gateway-Hours' })).toBe('NAT-Gateway-Hours');
    expect(buildCacheKeyFromAttributes('AWSELB', {})).toBeNull();
  });

  it('handles undefined values gracefully', () => {
    expect(buildCacheKeyFromAttributes('AmazonEC2', { instanceType: 'm5.large', operatingSystem: undefined })).toBe('m5.large:Linux');
  });

  it('handles special characters in attribute values', () => {
    expect(buildCacheKeyFromAttributes('AmazonEC2', { instanceType: 'm5.large-special', operatingSystem: 'Linux-Custom' })).toBe('m5.large-special:Linux-Custom');
  });
});

// ─── Cache key collision tests ────────────────────────────────────────────────

describe('cache key construction — no collisions', () => {
  it('multiAZ, engine suffix, and colon vs pipe separators all produce distinct keys', () => {
    // EC2 composite key uses colon separator
    const ec2Key = buildCacheKeyFromAttributes('AmazonEC2', { instanceType: 'm5.large', operatingSystem: 'Linux' });
    expect(ec2Key).toBe('m5.large:Linux');

    // RDS with Multi-AZ uses pipe separator
    const rdsKey = buildCacheKeyFromAttributes('AmazonRDS', { instanceType: 'db.r6g.large', databaseEngine: 'MySQL', deploymentOption: 'Single-AZ' });
    const rdsMultiAZ = buildCacheKeyFromAttributes('AmazonRDS', { instanceType: 'db.r6g.large', databaseEngine: 'MySQL', deploymentOption: 'Multi-AZ' });
    expect(rdsKey).toBe('db.r6g.large:MySQL');
    expect(rdsMultiAZ).toBe('db.r6g.large:MySQL|multi-az');
    expect(rdsKey).not.toBe(rdsMultiAZ);

    // ElastiCache engine variants are distinct
    const redisKey = buildCacheKeyFromAttributes('AmazonElastiCache', { instanceType: 'cache.r6g.large', cacheEngine: 'Redis' });
    const memcachedKey = buildCacheKeyFromAttributes('AmazonElastiCache', { instanceType: 'cache.r6g.large', cacheEngine: 'Memcached' });
    expect(redisKey).toBe('cache.r6g.large|Redis');
    expect(memcachedKey).toBe('cache.r6g.large|Memcached');
    expect(redisKey).not.toBe(memcachedKey);
  });
});

// ─── extractOnDemandPrice ─────────────────────────────────────────────────────

describe('extractOnDemandPrice', () => {
  it('parses realistic AWS price payloads for EC2 and RDS', () => {
    const make = (usd: string) =>
      JSON.stringify({
        terms: { OnDemand: { offer: { priceDimensions: { d1: { pricePerUnit: { USD: usd } } } } } },
      });

    expect(extractOnDemandPrice(make('0.096'))).toBeCloseTo(0.096, 6);
    expect(extractOnDemandPrice(make('0.0104'))).toBeCloseTo(0.0104, 6);
    expect(extractOnDemandPrice(make('0.1308'))).toBeCloseTo(0.1308, 6);
  });

  it('returns null for invalid or missing data', () => {
    expect(extractOnDemandPrice('not-json')).toBeNull();
    expect(extractOnDemandPrice(JSON.stringify({ product: {} }))).toBeNull();
    expect(extractOnDemandPrice(JSON.stringify({ terms: { Reserved: {} } }))).toBeNull();
    expect(
      extractOnDemandPrice(
        JSON.stringify({ terms: { OnDemand: { offer: { priceDimensions: {} } } } }),
      ),
    ).toBeNull();
  });

  it('skips zero prices and returns first non-zero; returns 0 when all zeros', () => {
    const withZero = JSON.stringify({
      terms: {
        OnDemand: {
          offer: {
            priceDimensions: {
              dim1: { pricePerUnit: { USD: '0.0000000000' } },
              dim2: { pricePerUnit: { USD: '0.096' } },
            },
          },
        },
      },
    });
    expect(extractOnDemandPrice(withZero)).toBeCloseTo(0.096, 6);

    const allZero = JSON.stringify({
      terms: {
        OnDemand: { offer: { priceDimensions: { d1: { pricePerUnit: { USD: '0.0000000000' } } } } },
      },
    });
    expect(extractOnDemandPrice(allZero)).toBe(0);
  });

  it('handles multiple offers and returns the first non-zero price encountered', () => {
    const payload = JSON.stringify({
      terms: {
        OnDemand: {
          offerA: { priceDimensions: { d1: { pricePerUnit: { USD: '0.192' } } } },
          offerB: { priceDimensions: { d2: { pricePerUnit: { USD: '0.384' } } } },
        },
      },
    });
    const price = extractOnDemandPrice(payload);
    // extractPriceFromObject returns the first non-zero price found across offers
    expect(price).toBeCloseTo(0.192, 6);
  });
});
