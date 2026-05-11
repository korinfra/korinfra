import { collectAll } from '../aws/collector.js';
import { loadConfig } from '../config/index.js';
import { redactObject } from '../redaction/index.js';
import type { RedactionLevel } from '../redaction/index.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';
import { CostEngine } from '../pricing/engine.js';
import { AwsPricingClient } from '../pricing/client.js';
import { PricingCache } from '../pricing/cache.js';
import { getDb } from '../storage/db.js';
import { isAuthError } from '../aws/rate-limiter.js';

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/g;
const PROMPT_DELIM_REGEX = /<\||\|>/g;

/**
 * Sanitize a single tag value to prevent prompt injection.
 * Removes control characters and prompt delimiters, limits length.
 */
function sanitizeTagValue(value: unknown): string {
  if (typeof value !== 'string') {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }
  return value
    .replace(CONTROL_CHAR_REGEX, '?')  // control chars
    .replace(PROMPT_DELIM_REGEX, '??')           // prompt injection delimiters
    .slice(0, 256);
}

/**
 * Sanitize AWS tags (object form: { Key: Value }).
 */
function sanitizeTags(tags: unknown): unknown {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return tags;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags as Record<string, unknown>)) {
    const safeKey = k.slice(0, 128).replace(CONTROL_CHAR_REGEX, '?');
    result[safeKey] = sanitizeTagValue(v);
  }
  return result;
}

/**
 * Sanitize AWS tags (array form: [{ Key, Value }]).
 */
function sanitizeAwsTags(tags: unknown): unknown {
  if (!Array.isArray(tags)) return sanitizeTags(tags);
  return tags.map((t: unknown) => {
    if (t && typeof t === 'object' && 'Key' in t && 'Value' in t) {
      const tag = t;
      return {
        Key: String((tag as Record<string, unknown>)['Key'] !== null && (tag as Record<string, unknown>)['Key'] !== undefined ? (tag as Record<string, unknown>)['Key'] as string : '').slice(0, 128).replace(CONTROL_CHAR_REGEX, '?'),
        Value: sanitizeTagValue((tag as Record<string, unknown>)['Value']),
      };
    }
    return t;
  });
}

/**
 * Deep sanitize tags in a resource object.
 */
function sanitizeResourceTags(resource: unknown): unknown {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    return resource;
  }
  const obj = resource as Record<string, unknown>;
  const result = { ...obj };

  // Sanitize both 'tags' and 'Tags' fields (AWS uses both conventions)
  if ('tags' in result && result['tags'] !== undefined) {
    result['tags'] = sanitizeAwsTags(result['tags']);
  }
  if ('Tags' in result && result['Tags'] !== undefined) {
    result['Tags'] = sanitizeAwsTags(result['Tags']);
  }

  return result;
}

// Singleton pricing instances — avoids re-creating DB connections on every tool call.
let _costEnginePromise: Promise<CostEngine> | null = null;

function getOrCreateCostEngine(): Promise<CostEngine> {
  if (!_costEnginePromise) {
    _costEnginePromise = (async () => {
      const db = getDb();
      // Thread the user-configured TTL through; fall back to PricingCache default if config unavailable.
      const ttlDays = await loadConfig()
        .then(c => c.scan.pricing_cache_ttl_days)
        .catch(() => undefined);
      const cache = new PricingCache(db, ttlDays);
      const client = new AwsPricingClient({ cache });
      return new CostEngine(client);
    })();
    // Reset on failure so the next call retries instead of caching a rejected promise.
    _costEnginePromise.catch(() => { _costEnginePromise = null; });
  }
  return _costEnginePromise;
}

export const collectAwsTool: ToolDefinition = {
  name: 'collect_aws_resources',
  description:
    'Collect AWS resources across all configured services and regions (EC2, RDS, S3, Lambda, ECS, ELB, ElastiCache, DynamoDB, NAT Gateways). Returns a full inventory with utilization metrics.',
  inputSchema: {
    type: 'object',
    properties: {
      profile: { type: 'string', description: 'AWS CLI profile.' },
      regions: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'Regions to scan. Defaults to the region configured in korinfra config (aws.default_region), then AWS_REGION env, then us-east-1.' },
      typeFilter: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'Filter by type e.g. ["ec2_instance"].' },
      skipMetrics: { type: 'boolean', description: 'Skip CloudWatch metrics collection. Defaults to true — set false only when utilization data is explicitly needed.' },
      skipCosts: { type: 'boolean', description: 'Skip Cost Explorer. Default false.' },
      compact: { type: 'boolean', description: 'Slim output (id/type/name/region/state/cost only). Default true.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    try {
      const profile = typeof args['profile'] === 'string' ? args['profile'] : undefined;
      const regions = Array.isArray(args['regions'])
        ? (args['regions'] as string[])
        : [];
      const typeFilter = Array.isArray(args['typeFilter'])
        ? (args['typeFilter'] as string[])
        : undefined;
      // Default skipMetrics=true — CloudWatch calls (especially S3 BucketSizeBytes) are slow
      // and should only run when utilization data is explicitly needed.
      const skipMetrics = args['skipMetrics'] !== false;
      const skipCosts = args['skipCosts'] === true;
      // compact=true by default — strips heavy fields (configuration, utilization, tags) to reduce tokens
      const compact = args['compact'] !== false;

      let configDefaultRegion: string | undefined;
      let redactionLevelFromConfig: RedactionLevel = 'moderate';
      let serviceTimeoutMs: number | undefined;
      let collectionTimeoutMs: number | undefined;
      let maxParallelRegions: number | undefined;
      let costExplorerCacheTtlMs: number | undefined;
      try {
        const korinfraConfig = await loadConfig();
        configDefaultRegion = korinfraConfig.aws?.default_region;
        redactionLevelFromConfig = (korinfraConfig.ai?.redaction_level) ?? 'moderate';
        serviceTimeoutMs = korinfraConfig.scan?.service_timeout_ms;
        collectionTimeoutMs = korinfraConfig.scan?.collection_timeout_ms;
        maxParallelRegions = korinfraConfig.scan?.max_parallel_regions;
        const ttlHours = korinfraConfig.scan?.cost_explorer_cache_ttl_hours;
        if (ttlHours !== undefined) costExplorerCacheTtlMs = ttlHours * 60 * 60 * 1000;
      } catch {
        // config not found — use env fallback
      }

      const onServiceComplete = typeof args['_onProgress'] === 'function'
        ? (args['_onProgress'] as (svc: string, region: string, ms: number, count: number) => void)
        : undefined;

      let result;
      try {
        const collectConfig: Record<string, unknown> = {
          regions,
          defaultRegion: configDefaultRegion,
          skipMetrics,
          skipCosts,
          ...(serviceTimeoutMs !== undefined && { serviceTimeoutMs }),
          ...(collectionTimeoutMs !== undefined && { collectionTimeoutMs }),
          ...(maxParallelRegions !== undefined && { maxParallelRegions }),
          ...(costExplorerCacheTtlMs !== undefined && { costExplorerCacheTtlMs }),
        };
        if (profile !== undefined) collectConfig['profile'] = profile;
        if (onServiceComplete !== undefined) collectConfig['onServiceComplete'] = onServiceComplete;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await collectAll(collectConfig as any);
      } catch (err) {
        if (isAuthError(err)) {
          return errorResult('AWS credentials expired or invalid. Re-authenticate (e.g. aws sso login, aws configure, or refresh your session) then retry.');
        }
        throw err;
      }

      // Surface auth errors from within collectAll (errors array)
      const authErrors = result.errors.filter((e) => isAuthError({ name: e.code }));
      if (authErrors.length > 0 && result.resources.length === 0) {
        return errorResult('AWS credentials expired or invalid. Re-authenticate (e.g. aws sso login, aws configure, or refresh your session) then retry.');
      }

      const resources =
        typeFilter && typeFilter.length > 0
          ? result.resources.filter((r) => typeFilter.includes(r.type))
          : result.resources;

      if (!skipCosts) {
        const costEngine = await getOrCreateCostEngine();

        // Group by pricing key to avoid redundant API calls for same resource type/size/region
        const keyToResources = new Map<string, typeof resources>();
        for (const resource of resources) {
          const key = `${resource.type}:${resource.instanceType ?? ''}:${resource.region}`;
          const group = keyToResources.get(key) ?? [];
          group.push(resource);
          keyToResources.set(key, group);
        }

        // Estimate once per unique key, apply to all in group
        await Promise.all(
          Array.from(keyToResources.entries()).map(async ([, group]) => {
            const representative = group[0] as (typeof group)[0];
            try {
              // Skip if already enriched from Cost Explorer (more accurate than pricing estimate)
              if (representative.configuration?.['monthlyCostSource'] === 'cost_explorer') {
                // Apply same cost to whole group
                const existingCost = representative.configuration['monthlyCost'] as number;
                for (const resource of group) {
                  if (!resource.configuration) resource.configuration = {};
                  resource.configuration['monthlyCost'] = existingCost;
                  resource.configuration['monthlyCostSource'] = 'cost_explorer';
                }
                return;
              }

              if (!representative.configuration) representative.configuration = {};
              const cost = await costEngine.estimateMonthlyCost(representative);
              if (cost !== null && cost > 0) {
                for (const resource of group) {
                  if (!resource.configuration) resource.configuration = {};
                  resource.configuration['monthlyCost'] = cost;
                  resource.configuration['monthlyCostSource'] = 'pricing_api';
                }
              }
            } catch {
              // Non-fatal — continue without pricing for this resource
            }
          })
        );
      }

      const redactionLevel: RedactionLevel = redactionLevelFromConfig;

      const resourcePayload = compact
        ? resources.map((r) => ({
            id: sanitizeTagValue(r.id),
            type: r.type,
            name: sanitizeTagValue(r.name),
            region: r.region,
            state: r.state,
            instance_type: r.instanceType,
            monthly_cost: typeof r.configuration?.['monthlyCost'] === 'number'
              ? (r.configuration['monthlyCost'])
              : 0,
            monthly_cost_source: (r.configuration?.['monthlyCostSource'] as 'cost_explorer' | 'pricing_api' | undefined) ?? null,
            arn: sanitizeTagValue(r.arn),
            // Per-service display fields for tabbed resource browser (§5.2.2–3)
            engine: typeof r.configuration?.['engine'] === 'string' ? r.configuration['engine'] : undefined,
            size_gb: typeof r.configuration?.['size_gb'] === 'number' ? r.configuration['size_gb'] : undefined,
            collected_at: r.collectedAt,
          }))
        : resources.map((r) => sanitizeResourceTags(r));

      // Limit cost entries to 60 most recent to reduce payload size
      const costsTruncated = result.costs.length > 60;
      const costPayload = result.costs.slice(0, 60);

      return jsonResult({
        resources: redactObject(resourcePayload, redactionLevel),
        resourceCount: resources.length,
        costs: redactObject(costPayload, redactionLevel),
        costs_truncated: costsTruncated,
        costs_total_count: result.costs.length,
        errors: result.errors.map((e) => redactObject(e, redactionLevel)),
        durationMs: result.durationMs,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
};
