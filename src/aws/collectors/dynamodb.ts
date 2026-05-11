import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ListTablesCommand, DescribeTableCommand, ListTagsOfResourceCommand } from '@aws-sdk/client-dynamodb';
import pLimit from 'p-limit';
import type { Resource } from '../types.js';
import { throttledCall } from '../rate-limiter.js';
import { dbg } from '../debug.js';

async function listTables(
  client: DynamoDBClient,
  region: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const acc: string[] = [];
  let token: string | undefined;
  let pageNum = 0;
  do {
    dbg(`    dynamodb ListTables page:${pageNum + 1} start — region:${region} soFar:${acc.length}`);
    const t_lt = Date.now();
    const cmdOptions: Record<string, unknown> = {};
    if (signal) {
      cmdOptions['abortSignal'] = signal;
    }
    const out = await throttledCall('dynamodb', 'ListTables', region, () =>
      client.send(
        new ListTablesCommand({ ExclusiveStartTableName: token }),
        cmdOptions,
      ),
    );
    pageNum++;
    acc.push(...(out.TableNames ?? []));
    token = out.LastEvaluatedTableName ?? undefined;
    dbg(`    dynamodb ListTables page:${pageNum} done — ${Date.now() - t_lt}ms inPage:${out.TableNames?.length ?? 0} hasMore:${Boolean(token)}`);
  } while (token !== undefined);
  return acc;
}

interface TableDescribeResult {
  name: string;
  arn: string;
  tableStatus: string;
  billingMode: string;
  itemCount: number;
  tableSizeBytes: number;
  globalSecondaryIndexCount: number;
  localSecondaryIndexCount: number;
  readCapacityUnits?: number;
  writeCapacityUnits?: number;
  creationDateTime?: string;
}

async function describeTableOnly(
  client: DynamoDBClient,
  region: string,
  name: string,
  signal?: AbortSignal,
): Promise<TableDescribeResult> {
  const cmdOptions: Record<string, unknown> = {};
  if (signal) {
    cmdOptions['abortSignal'] = signal;
  }
  const out = await throttledCall('dynamodb', 'DescribeTable', region, () =>
    client.send(new DescribeTableCommand({ TableName: name }), cmdOptions),
  );

  if (!out.Table) throw new Error(`DescribeTable returned no data for table ${name}`);
  const table = out.Table;
  const result: TableDescribeResult = {
    name: table.TableName ?? name,
    arn: table.TableArn ?? '',
    tableStatus: table.TableStatus ?? '',
    billingMode: table.BillingModeSummary?.BillingMode ?? 'PROVISIONED',
    itemCount: table.ItemCount ?? 0,
    tableSizeBytes: table.TableSizeBytes ?? 0,
    globalSecondaryIndexCount: (table.GlobalSecondaryIndexes ?? []).length,
    localSecondaryIndexCount: (table.LocalSecondaryIndexes ?? []).length,
  };
  if (table.CreationDateTime) {
    result.creationDateTime = table.CreationDateTime.toISOString();
  }
  if (table.ProvisionedThroughput) {
    result.readCapacityUnits = table.ProvisionedThroughput.ReadCapacityUnits ?? 0;
    result.writeCapacityUnits = table.ProvisionedThroughput.WriteCapacityUnits ?? 0;
  }
  return result;
}

async function fetchTableTags(
  client: DynamoDBClient,
  region: string,
  arn: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  try {
    const cmdOptions: Record<string, unknown> = {};
    if (signal) {
      cmdOptions['abortSignal'] = signal;
    }
    const tagsOut = await throttledCall('dynamodb', 'ListTagsOfResource', region, () =>
      client.send(new ListTagsOfResourceCommand({ ResourceArn: arn }), cmdOptions),
    );
    return Object.fromEntries((tagsOut.Tags ?? []).map((t) => [t.Key ?? '', t.Value ?? '']));
  } catch {
    return {};
  }
}

export async function collectDynamoDB(
  client: DynamoDBClient,
  region: string,
  signal?: AbortSignal,
): Promise<Resource[]> {
  const names = await listTables(client, region, signal);
  const limit = pLimit(10);
  const now = new Date().toISOString();

  // Pass 1: describe all tables
  const describeSettled = await Promise.allSettled(
    names.map((name) => limit(() => describeTableOnly(client, region, name, signal))),
  );

  const described: TableDescribeResult[] = [];
  for (const result of describeSettled) {
    if (result.status === 'fulfilled') described.push(result.value);
    // Non-fatal: skip tables we can't describe
  }

  // Pass 2: fetch tags for all described tables
  const tagsSettled = await Promise.allSettled(
    described.map((t) => limit(() => (t.arn ? fetchTableTags(client, region, t.arn, signal) : Promise.resolve({} as Record<string, string>)))),
  );

  const resources: Resource[] = [];
  for (let i = 0; i < described.length; i++) {
    const t = described[i];
    if (!t) continue;
    const tagsResult = tagsSettled[i];
    const tags = tagsResult?.status === 'fulfilled' ? tagsResult.value : {};

    const cfg: Record<string, unknown> = {
      billing_mode: t.billingMode,
      item_count: t.itemCount,
      table_size_bytes: t.tableSizeBytes,
      table_status: t.tableStatus,
      global_secondary_index_count: t.globalSecondaryIndexCount,
      local_secondary_index_count: t.localSecondaryIndexCount,
    };
    if (t.readCapacityUnits !== undefined) cfg['read_capacity_units'] = t.readCapacityUnits;
    if (t.writeCapacityUnits !== undefined) cfg['write_capacity_units'] = t.writeCapacityUnits;

    resources.push({
      id: t.name,
      arn: t.arn,
      type: 'dynamodb_table',
      name: t.name,
      region,
      state: t.tableStatus,
      instanceType: '',
      tags,
      launchTime: t.creationDateTime ?? now,
      collectedAt: now,
      configuration: cfg,
    });
  }

  return resources;
}
