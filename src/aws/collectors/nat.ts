import { DescribeNatGatewaysCommand } from '@aws-sdk/client-ec2';
import type { EC2Client} from '@aws-sdk/client-ec2';
import type { Resource } from '../types.js';
import { throttledCall } from '../rate-limiter.js';
import { tagsToMap } from '../utils.js';
import { logger } from '../../utils/logger.js';
import { dbg } from '../debug.js';

/** Validate account ID is a non-empty string. */
function isValidAccountId(accountId: string | undefined): accountId is string {
  return typeof accountId === 'string' && accountId.length > 0;
}

export async function collectNATGateways(
  client: EC2Client,
  region: string,
  signal?: AbortSignal,
  accountId?: string,
): Promise<Resource[]> {
  const resources: Resource[] = [];
  const now = new Date().toISOString();
  let nextToken: string | undefined;
  let pageNum = 0;

  do {
    dbg(`    nat DescribeNatGateways page:${pageNum + 1} start — region:${region} soFar:${resources.length}`);
    const t_nat = Date.now();
    const out = await throttledCall('ec2', 'DescribeNatGateways', region, () =>
      client.send(new DescribeNatGatewaysCommand({ NextToken: nextToken }), { ...(signal ? { abortSignal: signal } : {}) }),
    );
    nextToken = out.NextToken ?? undefined;
    pageNum++;
    dbg(`    nat DescribeNatGateways page:${pageNum} done — ${Date.now() - t_nat}ms inPage:${out.NatGateways?.length ?? 0} hasMore:${Boolean(nextToken)}`);

    for (const ngw of out.NatGateways ?? []) {
      const allocationIds = (ngw.NatGatewayAddresses ?? [])
        .map((a) => a.AllocationId)
        .filter(Boolean) as string[];

      const connectivityType = ngw.ConnectivityType ?? 'public';
      const tags = tagsToMap(ngw.Tags);
      const name = tags['Name'] ?? (ngw.NatGatewayId ?? '');

      let arn = '';
      if (ngw.NatGatewayId) {
        if (isValidAccountId(accountId)) {
          arn = `arn:aws:ec2:${region}:${accountId}:natgateway/${ngw.NatGatewayId}`;
        } else {
          logger.warn({ region, natGatewayId: ngw.NatGatewayId, accountId }, 'nat gateway: cannot construct ARN due to missing/invalid account ID');
        }
      }

      resources.push({
        id: ngw.NatGatewayId ?? '',
        arn,
        type: 'nat_gateway',
        name,
        region,
        state: ngw.State ?? '',
        instanceType: '',
        tags,
        launchTime: ngw.CreateTime?.toISOString() ?? now,
        collectedAt: now,
        configuration: {
          state: ngw.State ?? '',
          vpc_id: ngw.VpcId ?? '',
          subnet_id: ngw.SubnetId ?? '',
          connectivity_type: connectivityType,
          allocation_ids: allocationIds,
        },
      });
    }
  } while (nextToken);

  return resources;
}
