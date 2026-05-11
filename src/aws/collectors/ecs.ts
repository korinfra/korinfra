import {
  ListClustersCommand,
  DescribeClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import type { Cluster, ECSClient, DescribeServicesCommandOutput } from '@aws-sdk/client-ecs';
import pLimit from 'p-limit';
import type { Resource } from '../types.js';
import { throttledCall } from '../rate-limiter.js';
import { tagsToMapLower } from '../utils.js';
import { dbg } from '../debug.js';

async function listClusters(
  client: ECSClient,
  region: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const acc: string[] = [];
  let token: string | undefined;
  let pageNum = 0;
  do {
    dbg(`    ecs ListClusters page:${pageNum + 1} start — region:${region} soFar:${acc.length}`);
    const t_lc = Date.now();
    const out = await throttledCall('ecs', 'ListClusters', region, () =>
      client.send(new ListClustersCommand({ nextToken: token }), { ...(signal ? { abortSignal: signal } : {}) }),
    );
    pageNum++;
    acc.push(...(out.clusterArns ?? []));
    token = out.nextToken ?? undefined;
    dbg(`    ecs ListClusters page:${pageNum} done — ${Date.now() - t_lc}ms inPage:${out.clusterArns?.length ?? 0} hasMore:${Boolean(token)}`);
  } while (token !== undefined);
  return acc;
}

async function collectServices(
  client: ECSClient,
  region: string,
  clusterArn: string,
  signal?: AbortSignal,
): Promise<Resource[]> {
  const serviceArns: string[] = [];
  let token: string | undefined;
  let pageNum = 0;
  do {
    dbg(`    ecs ListServices page:${pageNum + 1} start — region:${region} soFar:${serviceArns.length}`);
    const t_ls = Date.now();
    const out = await throttledCall('ecs', 'ListServices', region, () =>
      client.send(new ListServicesCommand({ cluster: clusterArn, nextToken: token }), { ...(signal ? { abortSignal: signal } : {}) }),
    );
    pageNum++;
    serviceArns.push(...(out.serviceArns ?? []));
    token = out.nextToken ?? undefined;
    dbg(`    ecs ListServices page:${pageNum} done — ${Date.now() - t_ls}ms inPage:${out.serviceArns?.length ?? 0} hasMore:${Boolean(token)}`);
  } while (token !== undefined);

  if (serviceArns.length === 0) return [];

  const resources: Resource[] = [];
  const now = new Date().toISOString();

  // DescribeServices accepts at most 10 ARNs per call — issue all batches in parallel
  const batchPromises: Promise<DescribeServicesCommandOutput>[] = [];
  for (let i = 0; i < serviceArns.length; i += 10) {
    const batch = serviceArns.slice(i, i + 10);
    batchPromises.push(
      throttledCall('ecs', 'DescribeServices', region, () =>
        client.send(
          new DescribeServicesCommand({
            cluster: clusterArn,
            services: batch,
            include: ['TAGS'],
          }),
          { ...(signal ? { abortSignal: signal } : {}) },
        ),
      ),
    );
  }

  const batchResults = await Promise.allSettled(batchPromises);
  for (const result of batchResults) {
    if (result.status === 'rejected') continue;
    const out = result.value;

    for (const svc of out.services ?? []) {
      resources.push({
        id: svc.serviceName ?? '',
        arn: svc.serviceArn ?? '',
        type: 'ecs_service',
        name: svc.serviceName ?? '',
        region,
        state: svc.status ?? '',
        instanceType: '',
        tags: tagsToMapLower(svc.tags),
        launchTime: svc.createdAt?.toISOString() ?? now,
        collectedAt: now,
        configuration: {
          cluster_arn: clusterArn,
          launch_type: svc.launchType ?? '',
          desired_count: svc.desiredCount ?? 0,
          running_count: svc.runningCount ?? 0,
          pending_count: svc.pendingCount ?? 0,
          task_definition: svc.taskDefinition ?? '',
          platform_version: svc.platformVersion ?? '',
          scheduling_strategy: svc.schedulingStrategy ?? '',
          // Number of load balancer target group registrations — 0 means no LB attachment
          load_balancer_count: svc.loadBalancers?.length ?? 0,
        },
      });
    }
  }

  return resources;
}

export async function collectECS(
  client: ECSClient,
  region: string,
  signal?: AbortSignal,
): Promise<Resource[]> {
  const clusterArns = await listClusters(client, region, signal);
  if (clusterArns.length === 0) return [];

  const now = new Date().toISOString();
  const all: Resource[] = [];

  // Describe clusters in batches of 100 (AWS limit per DescribeClusters call)
  const allClusters: Cluster[] = [];
  for (let i = 0; i < clusterArns.length; i += 100) {
    const batchArns = clusterArns.slice(i, i + 100);
    const descOut = await throttledCall('ecs', 'DescribeClusters', region, () =>
      client.send(
        new DescribeClustersCommand({ clusters: batchArns, include: ['TAGS'] }),
        { ...(signal ? { abortSignal: signal } : {}) },
      ),
    );
    allClusters.push(...(descOut.clusters ?? []));
  }

  for (const cluster of allClusters) {
    all.push({
      id: cluster.clusterName ?? '',
      arn: cluster.clusterArn ?? '',
      type: 'ecs_cluster',
      name: cluster.clusterName ?? '',
      region,
      state: cluster.status ?? '',
      instanceType: '',
      tags: tagsToMapLower(cluster.tags),
      launchTime: now,
      collectedAt: now,
      configuration: {
        active_services_count: cluster.activeServicesCount ?? 0,
        running_tasks_count: cluster.runningTasksCount ?? 0,
        pending_tasks_count: cluster.pendingTasksCount ?? 0,
        registered_container_instances: cluster.registeredContainerInstancesCount ?? 0,
      },
    });
  }

  // Collect services for all clusters in parallel (non-fatal per cluster)
  const clusterLimit = pLimit(5);
  const serviceResults = await Promise.allSettled(
    clusterArns.map((arn) => clusterLimit(() => collectServices(client, region, arn, signal))),
  );
  for (const result of serviceResults) {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    }
    // Non-fatal: continue with next cluster
  }

  return all;
}
