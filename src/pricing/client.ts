/**
 * AWS Pricing API client.
 * The Pricing API is only available in us-east-1 (and ap-south-1); we always use us-east-1.
 */

import {
  PricingClient,
  GetProductsCommand,
  type Filter,
} from '@aws-sdk/client-pricing';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { throttledCall } from '../aws/rate-limiter.js';
import { logger } from '../utils/logger.js';
import { retryWithBackoff } from '../utils/retry.js';
import type { PricingCache } from './cache.js';

// ─── Region → human-readable location ────────────────────────────────────────

const REGION_TO_LOCATION: Record<string, string> = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'eu-west-1': 'EU (Ireland)',
  'eu-west-2': 'EU (London)',
  'eu-west-3': 'EU (Paris)',
  'eu-central-1': 'EU (Frankfurt)',
  'eu-north-1': 'EU (Stockholm)',
  'eu-south-1': 'EU (Milan)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'ap-east-1': 'Asia Pacific (Hong Kong)',
  'sa-east-1': 'South America (Sao Paulo)',
  'ca-central-1': 'Canada (Central)',
  'me-south-1': 'Middle East (Bahrain)',
  'af-south-1': 'Africa (Cape Town)',
  'eu-central-2': 'Europe (Zurich)',
  'eu-south-2': 'Europe (Spain)',
  'ap-southeast-3': 'Asia Pacific (Jakarta)',
  'ap-southeast-4': 'Asia Pacific (Melbourne)',
  'ap-south-2': 'Asia Pacific (Hyderabad)',
  'me-central-1': 'Middle East (UAE)',
  'il-central-1': 'Israel (Tel Aviv)',
  'ca-west-1': 'Canada West (Calgary)',
  'ap-southeast-5': 'Asia Pacific (Malaysia)',
  'ap-southeast-7': 'Asia Pacific (Thailand)',
  'mx-central-1': 'Mexico (Central)',
};

export function regionToLocation(region: string): string {
  return REGION_TO_LOCATION[region] ?? region;
}

// ─── Filter builder ───────────────────────────────────────────────────────────

function buildFilters(serviceCode: string, productKey: string, region: string, multiAZ = false, options?: { engine?: string }): Filter[] {
  const filters: Filter[] = [
    { Type: 'TERM_MATCH', Field: 'location', Value: regionToLocation(region) },
  ];

  switch (serviceCode) {
    case 'AmazonEC2': {
      // productKey may be "instanceType:platform" (composite cache key)
      let instanceType = productKey;
      let operatingSystem = 'Linux';
      const colonIdx = productKey.indexOf(':');
      if (colonIdx !== -1) {
        instanceType = productKey.slice(0, colonIdx);
        const os = productKey.slice(colonIdx + 1);
        if (os) operatingSystem = os;
      }
      filters.push(
        { Type: 'TERM_MATCH', Field: 'instanceType', Value: instanceType },
        { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: operatingSystem },
        { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
        { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
        { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
      );
      break;
    }
    case 'AmazonRDS': {
      // productKey may be "instanceClass:dbEngine"
      let instanceClass = productKey;
      let databaseEngine = 'MySQL';
      const colonIdx = productKey.indexOf(':');
      if (colonIdx !== -1) {
        instanceClass = productKey.slice(0, colonIdx);
        const eng = productKey.slice(colonIdx + 1);
        if (eng) databaseEngine = eng;
      }
      filters.push(
        { Type: 'TERM_MATCH', Field: 'instanceType', Value: instanceClass },
        { Type: 'TERM_MATCH', Field: 'databaseEngine', Value: databaseEngine },
        { Type: 'TERM_MATCH', Field: 'deploymentOption', Value: multiAZ ? 'Multi-AZ' : 'Single-AZ' },
      );
      break;
    }
    case 'AmazonElastiCache': {
      const engine = options?.engine ?? 'Redis';
      filters.push(
        { Type: 'TERM_MATCH', Field: 'cacheEngine', Value: engine },
        { Type: 'TERM_MATCH', Field: 'instanceType', Value: productKey },
      );
      break;
    }
    case 'AmazonS3': {
      // productKey is the API volumeType value (e.g. 'Standard', 'Amazon Glacier')
      filters.push(
        { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Storage' },
        { Type: 'TERM_MATCH', Field: 'volumeType', Value: productKey },
      );
      break;
    }
    default:
      break;
  }

  return filters;
}

// ─── Bulk filter builder ──────────────────────────────────────────────────────

function buildBulkFilters(serviceCode: string, region: string, productFamily?: string): Filter[] {
  const filters: Filter[] = [
    { Type: 'TERM_MATCH', Field: 'location', Value: regionToLocation(region) },
  ];

  switch (serviceCode) {
    case 'AmazonEC2':
      if (productFamily === 'Storage') {
        filters.push({ Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Storage' });
      } else {
        filters.push(
          { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Compute Instance' },
          { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
          { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
          { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
        );
      }
      break;
    case 'AmazonRDS':
      filters.push({ Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Database Instance' });
      break;
    case 'AmazonElastiCache':
      filters.push({ Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Cache Instance' });
      break;
    case 'AmazonS3':
      filters.push({ Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Storage' });
      break;
    case 'AWSELB':
      // No productFamily filter — we want all LB types (Classic, ALB, NLB, GWLB)
      break;
    case 'AmazonDynamoDB':
      // No productFamily filter needed — we want WCU/RCU unit prices + storage
      break;
    case 'AmazonVPC':
      filters.push({ Type: 'TERM_MATCH', Field: 'productFamily', Value: 'NAT Gateway' });
      break;
  }

  return filters;
}

// ─── Cache key builder from attributes ───────────────────────────────────────

/**
 * Builds a cache key from product attributes.
 * @internal
 */
export function buildCacheKeyFromAttributes(
  serviceCode: string,
  attrs: Record<string, string>,
  productFamily?: string,
): string | null {
  switch (serviceCode) {
    case 'AmazonEC2':
      if (productFamily === 'Storage') {
        return attrs['volumeApiName'] ?? null;
      }
      if (!attrs['instanceType']) return null;
      return `${attrs['instanceType']}:${attrs['operatingSystem'] ?? 'Linux'}`;
    case 'AmazonRDS': {
      if (!attrs['instanceType']) return null;
      const engine = attrs['databaseEngine'] ?? 'MySQL';
      const deploy = attrs['deploymentOption'] ?? 'Single-AZ';
      const base = `${attrs['instanceType']}:${engine}`;
      return deploy === 'Multi-AZ' ? `${base}|multi-az` : base;
    }
    case 'AmazonElastiCache': {
      if (!attrs['instanceType']) return null;
      const cacheEngine = attrs['cacheEngine'] ?? 'Redis';
      return `${attrs['instanceType']}|${cacheEngine}`;
    }
    case 'AmazonS3':
      return attrs['volumeType'] ?? attrs['storageClass'] ?? null;
    case 'AWSELB':
      return attrs['usagetype'] ?? null;
    case 'AmazonDynamoDB':
      return attrs['usagetype'] ?? null;
    case 'AmazonVPC':
      return attrs['usagetype'] ?? null;
    default:
      return null;
  }
}

// ─── Price extractor ──────────────────────────────────────────────────────────

function extractPriceFromObject(product: Record<string, unknown>): number | null {
  const terms = product['terms'];
  if (typeof terms !== 'object' || terms === null) return null;

  const onDemand = (terms as Record<string, unknown>)['OnDemand'];
  if (typeof onDemand !== 'object' || onDemand === null) return null;

  let firstNonZero: number | null = null;
  let hasAnyPrice = false;

  for (const termData of Object.values(onDemand)) {
    if (typeof termData !== 'object' || termData === null) continue;
    const termMap = termData as Record<string, unknown>;
    const priceDimensions = termMap['priceDimensions'];
    if (typeof priceDimensions !== 'object' || priceDimensions === null) continue;

    for (const pd of Object.values(priceDimensions)) {
      if (typeof pd !== 'object' || pd === null) continue;
      const pdMap = pd as Record<string, unknown>;
      const pricePerUnit = pdMap['pricePerUnit'];
      if (typeof pricePerUnit !== 'object' || pricePerUnit === null) continue;
      const usdStr = (pricePerUnit as Record<string, unknown>)['USD'];
      if (typeof usdStr === 'string') {
        const price = parseFloat(usdStr);
        if (!isNaN(price)) {
          hasAnyPrice = true;
          if (price > 0 && firstNonZero === null) firstNonZero = price;
        }
      }
    }
  }

  return firstNonZero ?? (hasAnyPrice ? 0 : null);
}

export function extractOnDemandPrice(priceJson: string): number | null {
  let product: Record<string, unknown>;
  try {
    product = JSON.parse(priceJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  return extractPriceFromObject(product);
}

// ─── Client ───────────────────────────────────────────────────────────────────

export interface BulkPriceEntry {
  key: string;
  hourlyPrice: number;
  attributes: Record<string, string>;
}

export interface PricingClientOptions {
  credentials?: AwsCredentialIdentityProvider;
  cache?: PricingCache;
}

export class AwsPricingClient {
  private readonly client: PricingClient;
  private readonly cache?: PricingCache;

  constructor(options: PricingClientOptions = {}) {
    // Pricing API is global — always us-east-1
    const config: Record<string, unknown> = {
      region: 'us-east-1',
      requestHandler: new NodeHttpHandler({ connectionTimeout: 3_000, socketTimeout: 15_000 }),
      maxAttempts: 1,
    };
    if (options.credentials !== undefined) config['credentials'] = options.credentials;
     
    this.client = new PricingClient(config);
    if (options.cache !== undefined) this.cache = options.cache;
  }

  /**
   * Returns the on-demand hourly price for a service/product in a region.
   * Checks cache first; falls back to AWS Pricing API.
   * Returns null if the price cannot be determined.
   * @param multiAZ - For AmazonRDS: query Multi-AZ deploymentOption instead of Single-AZ.
   */
  async getOnDemandPrice(
    serviceCode: string,
    productKey: string,
    region: string,
    multiAZ = false,
    signal?: AbortSignal,
    options?: { engine?: string },
  ): Promise<number | null> {
    // Include multiAZ and engine in the cache key to avoid collisions.
    // Use '|' as separator (not ':') since productKey itself uses ':' for composite keys
    // like "instanceType:platform" or "instanceClass:dbEngine".
    let cacheKey = multiAZ ? `${productKey}|multi-az` : productKey;
    if (options?.engine) cacheKey += `|${options.engine}`;

    if (this.cache) {
      const cached = this.cache.getCachedPrice(serviceCode, cacheKey, region);
      if (cached !== null) return cached;
    }

    const price = await this.queryApi(serviceCode, productKey, region, multiAZ, signal, options);
    if (price !== null && this.cache) {
      this.cache.setCachedPrice(serviceCode, cacheKey, region, price);
    }
    return price;
  }

  async fetchAllPrices(
    serviceCode: string,
    region: string,
    productFamily?: string,
    signal?: AbortSignal,
  ): Promise<BulkPriceEntry[]> {
    const filters = buildBulkFilters(serviceCode, region, productFamily);
    const results: BulkPriceEntry[] = [];
    let nextToken: string | undefined;
    const seenTokens = new Set<string>();

    do {
      if (signal?.aborted) break;

      const output = await throttledCall('pricing', 'GetProducts', 'us-east-1', () => {
        const options: Record<string, unknown> = {};
        if (signal !== undefined) options['abortSignal'] = signal;
        return this.client.send(
          new GetProductsCommand({
            ServiceCode: serviceCode,
            Filters: filters,
            MaxResults: 100,
            ...(nextToken ? { NextToken: nextToken } : {}),
          }),
          options as Parameters<typeof this.client.send>[1],
        );
      },
      );

      for (const priceItem of output.PriceList ?? []) {
        if (typeof priceItem !== 'string') continue;

        let product: Record<string, unknown>;
        try {
          product = JSON.parse(priceItem) as Record<string, unknown>;
        } catch {
          continue;
        }

        const price = extractPriceFromObject(product);
        if (price === null) continue;

        const productData = product['product'] as Record<string, unknown> | undefined;
        const attrs = (productData?.['attributes'] as Record<string, string>) ?? {};

        const key = buildCacheKeyFromAttributes(serviceCode, attrs, productFamily);
        if (key) {
          results.push({ key, hourlyPrice: price, attributes: attrs });
        }
      }

      nextToken = output.NextToken;
      if (nextToken && seenTokens.has(nextToken)) break;
      if (nextToken) seenTokens.add(nextToken);
    } while (nextToken);

    return results;
  }

  private async queryApi(
    serviceCode: string,
    productKey: string,
    region: string,
    multiAZ = false,
    signal?: AbortSignal,
    options?: { engine?: string },
  ): Promise<number | null> {
    const filters = buildFilters(serviceCode, productKey, region, multiAZ, options);

    const output = await retryWithBackoff(
      () => throttledCall('pricing', 'GetProducts', 'us-east-1', () => {
        const options: Record<string, unknown> = {};
        if (signal !== undefined) options['abortSignal'] = signal;
        return this.client.send(
          new GetProductsCommand({
            ServiceCode: serviceCode,
            Filters: filters,
            MaxResults: 1,
          }),
          options as Parameters<typeof this.client.send>[1],
        );
      },
      ),
      { maxAttempts: 3, initialWaitMs: 500 },
      signal,
    );

    const priceList = (output.PriceList ?? []) as string[];
    if (priceList.length === 0) {
      logger.warn({ service: serviceCode, region }, 'pricing data missing, using $0 fallback');
      return 0;
    }

    const price = extractOnDemandPrice(priceList[0] ?? '');
    if (price === null) {
      logger.warn({ service: serviceCode, region, productKey }, 'pricing data missing, using $0 fallback');
      return 0;
    }
    return price;
  }
}
