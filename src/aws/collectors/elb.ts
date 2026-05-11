import type {
  ElasticLoadBalancingV2Client,
  LoadBalancer,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  DescribeTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import pLimit from 'p-limit';
import type { Resource } from '../types.js';
import { throttledCall } from '../rate-limiter.js';
import { logger } from '../../utils/logger.js';
import { dbg } from '../debug.js';

async function getTargetCounts(
  client: ElasticLoadBalancingV2Client,
  region: string,
  lbArn: string,
  signal?: AbortSignal,
): Promise<{ healthy: number; total: number }> {
  let healthy = 0;
  let total = 0;

  try {
    const allTgs: string[] = [];
    let token: string | undefined;
    let pageNum = 0;
    do {
      dbg(`    elb DescribeTargetGroups page:${pageNum + 1} start — region:${region} soFar:${allTgs.length}`);
      const t_tg = Date.now();
      const out = await throttledCall('elb', 'DescribeTargetGroups', region, () =>
        client.send(
          new DescribeTargetGroupsCommand({ LoadBalancerArn: lbArn, Marker: token }),
          { ...(signal ? { abortSignal: signal } : {}) },
        ),
      );
      pageNum++;
      for (const tg of out.TargetGroups ?? []) {
        if (tg.TargetGroupArn) allTgs.push(tg.TargetGroupArn);
      }
      token = out.NextMarker ?? undefined;
      dbg(`    elb DescribeTargetGroups page:${pageNum} done — ${Date.now() - t_tg}ms inPage:${out.TargetGroups?.length ?? 0} hasMore:${Boolean(token)}`);
    } while (token !== undefined);

    const healthLimit = pLimit(5);
    await Promise.all(
      allTgs.map((tgArn) =>
        healthLimit(async () => {
          try {
            const healthOut = await throttledCall('elb', 'DescribeTargetHealth', region, () =>
              client.send(
                new DescribeTargetHealthCommand({ TargetGroupArn: tgArn }),
                { ...(signal ? { abortSignal: signal } : {}) },
              ),
            );
            for (const desc of healthOut.TargetHealthDescriptions ?? []) {
              total++;
              if (desc.TargetHealth?.State === 'healthy') healthy++;
            }
          } catch (err) {
            logger.debug({ err, tgArn, lbArn }, 'elb DescribeTargetHealth: non-fatal');
          }
        }),
      ),
    );
  } catch (err) {
    logger.debug({ err, lbArn }, 'elb getTargetCounts: non-fatal');
  }

  return { healthy, total };
}

export async function collectELB(
  client: ElasticLoadBalancingV2Client,
  region: string,
  signal?: AbortSignal,
): Promise<Resource[]> {
  const now = new Date().toISOString();

  const allLbs: LoadBalancer[] = [];
  let token: string | undefined;
  let pageNum = 0;
  do {
    dbg(`    elb DescribeLoadBalancers page:${pageNum + 1} start — region:${region} soFar:${allLbs.length}`);
    const t_dlb = Date.now();
    const out = await throttledCall('elb', 'DescribeLoadBalancers', region, () =>
      client.send(new DescribeLoadBalancersCommand({ Marker: token }), { ...(signal ? { abortSignal: signal } : {}) }),
    );
    pageNum++;
    allLbs.push(...(out.LoadBalancers ?? []));
    token = out.NextMarker ?? undefined;
    dbg(`    elb DescribeLoadBalancers page:${pageNum} done — ${Date.now() - t_dlb}ms inPage:${out.LoadBalancers?.length ?? 0} hasMore:${Boolean(token)}`);
  } while (token !== undefined);

  const resources: Resource[] = [];

  const allLbArns = allLbs.map((lb) => lb.LoadBalancerArn ?? '').filter(Boolean);
  const outerLimit = pLimit(5);
  const [targetCounts, tagsResults] = await Promise.all([
    Promise.all(allLbs.map((lb) => outerLimit(() => getTargetCounts(client, region, lb.LoadBalancerArn ?? '', signal)))),
    (async (): Promise<Record<string, string>[]> => {
      const tagsByArn = new Map<string, Record<string, string>>();
      try {
        const BATCH_SIZE = 20;
        for (let b = 0; b < allLbArns.length; b += BATCH_SIZE) {
          const batch = allLbArns.slice(b, b + BATCH_SIZE);
          const tagsOut = await throttledCall('elb', 'DescribeTags', region, () =>
            client.send(
              new DescribeTagsCommand({ ResourceArns: batch }),
              { ...(signal ? { abortSignal: signal } : {}) },
            ),
          );
          for (const desc of tagsOut.TagDescriptions ?? []) {
            const arn = desc.ResourceArn ?? '';
            const tagList = desc.Tags ?? [];
            tagsByArn.set(arn, Object.fromEntries(tagList.map((t) => [t.Key ?? '', t.Value ?? ''])));
          }
        }
      } catch (err) {
        logger.debug({ err }, 'elb DescribeTags: non-fatal');
      }
      return allLbs.map((lb) => tagsByArn.get(lb.LoadBalancerArn ?? '') ?? {});
    })(),
  ]);

  for (let i = 0; i < allLbs.length; i++) {
    const lb = allLbs[i];
    if (!lb) continue;
    const tc = targetCounts[i];
    if (!tc) continue;
    const tags = tagsResults[i];
    if (!tags) continue;
    const lbType = lb.Type ?? '';
    const lbArn = lb.LoadBalancerArn ?? '';
    const { healthy, total } = tc;

    resources.push({
      id: lb.LoadBalancerName ?? '',
      arn: lbArn,
      type: 'load_balancer',
      name: lb.LoadBalancerName ?? '',
      region,
      state: lb.State?.Code ?? 'unknown',
      instanceType: '',
      tags,
      launchTime: lb.CreatedTime?.toISOString() ?? now,
      collectedAt: now,
      configuration: {
        lb_type: lbType,
        scheme: lb.Scheme ?? '',
        dns_name: lb.DNSName ?? '',
        vpc_id: lb.VpcId ?? '',
        ip_address_type: lb.IpAddressType ?? '',
        availability_zones: (lb.AvailabilityZones ?? []).length,
        healthy_target_count: healthy,
        total_target_count: total,
      },
    });
  }

  return resources;
}
