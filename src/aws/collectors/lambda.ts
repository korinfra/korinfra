import type { LambdaClient} from '@aws-sdk/client-lambda';
import { ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { ResourceGroupsTaggingAPIClient, GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { Resource } from '../types.js';
import { throttledCall } from '../rate-limiter.js';
import { logger } from '../../utils/logger.js';
import { dbg } from '../debug.js';

const LAMBDA_REQUEST_HANDLER = new NodeHttpHandler({ connectionTimeout: 3_000, socketTimeout: 15_000 });

async function listAllFunctions(
  client: LambdaClient,
  region: string,
  signal?: AbortSignal,
): Promise<Resource[]> {
  const resources: Resource[] = [];
  const now = new Date().toISOString();
  let marker: string | undefined;
  let pageCount = 0;

  do {
    dbg(`    lambda ListFunctions page:${pageCount + 1} start — region:${region} soFar:${resources.length}`);
    const t_lf = Date.now();
    const out = await throttledCall('lambda', 'ListFunctions', region, () =>
      client.send(new ListFunctionsCommand({ Marker: marker }), { ...(signal ? { abortSignal: signal } : {}) }),
    );
    marker = out.NextMarker ?? undefined;
    pageCount++;
    dbg(`    lambda ListFunctions page:${pageCount} done — ${Date.now() - t_lf}ms inPage:${out.Functions?.length ?? 0} hasMore:${Boolean(marker)}`);

    for (const fn of out.Functions ?? []) {
      // Lambda returns LastModified as ISO string with offset e.g. "2024-01-15T10:30:00.000+0000"
      let lastModified = now;
      if (fn.LastModified) {
        try {
          lastModified = new Date(fn.LastModified).toISOString();
        } catch (err: unknown) {
          logger.debug({ functionName: fn.FunctionName, rawDate: fn.LastModified, err }, 'Failed to parse Lambda LastModified date, using current time');
          lastModified = now;
        }
      }

      const arch = fn.Architectures?.[0] ?? 'x86_64';

      resources.push({
        id: fn.FunctionName ?? '',
        arn: fn.FunctionArn ?? '',
        type: 'lambda_function',
        name: fn.FunctionName ?? '',
        region,
        state: 'active',
        instanceType: '',
        tags: {},
        launchTime: lastModified,
        collectedAt: now,
        configuration: {
          runtime: fn.Runtime ?? '',
          architectures: arch,
          memory_mb: fn.MemorySize ?? 0,
          timeout_sec: fn.Timeout ?? 0,
          handler: fn.Handler ?? '',
          code_size: fn.CodeSize ?? 0,
          description: fn.Description ?? '',
          package_type: fn.PackageType ?? '',
          last_modified: fn.LastModified ?? '',
        },
      });
    }
  } while (marker);

  return resources;
}

async function fetchLambdaTags(
  client: LambdaClient,
  region: string,
  signal?: AbortSignal,
): Promise<Map<string, Record<string, string>>> {
  const clientCredentials = (client as { config?: { credentials?: unknown } }).config?.credentials;
  const taggingClient = new ResourceGroupsTaggingAPIClient({
    region,
    requestHandler: LAMBDA_REQUEST_HANDLER,
    maxAttempts: 1,
    ...(clientCredentials !== undefined ? { credentials: clientCredentials as never } : {}),
  });
  const tagMap = new Map<string, Record<string, string>>();
  let paginationToken: string | undefined;
  let tagPage = 0;
  do {
    try {
      dbg(`    lambda GetResources(tags) page:${tagPage + 1} start — region:${region}`);
      const t_tg = Date.now();
      const out = await throttledCall('tagging', 'GetResources', region, () =>
        taggingClient.send(new GetResourcesCommand({
          ResourceTypeFilters: ['lambda:function'],
          PaginationToken: paginationToken,
        }), { ...(signal ? { abortSignal: signal } : {}) }),
      );
      tagPage++;
      dbg(`    lambda GetResources(tags) page:${tagPage} done — ${Date.now() - t_tg}ms resources:${out.ResourceTagMappingList?.length ?? 0} hasMore:${Boolean(out.PaginationToken)}`);
      for (const r of out.ResourceTagMappingList ?? []) {
        if (!r.ResourceARN) continue;
        tagMap.set(
          r.ResourceARN,
          Object.fromEntries((r.Tags ?? []).map((t) => [t.Key ?? '', t.Value ?? ''])),
        );
      }
      paginationToken = out.PaginationToken ?? undefined;
    } catch (err) {
      logger.debug({ err }, 'lambda bulk tag fetch: non-fatal');
      break;
    }
  } while (paginationToken);
  return tagMap;
}

export async function collectLambda(
  client: LambdaClient,
  region: string,
  signal?: AbortSignal,
): Promise<Resource[]> {
  const [resources, tagMap] = await Promise.all([
    listAllFunctions(client, region, signal),
    fetchLambdaTags(client, region, signal),
  ]);

  for (const resource of resources) {
    if (resource.arn) resource.tags = tagMap.get(resource.arn) ?? {};
  }

  return resources;
}
