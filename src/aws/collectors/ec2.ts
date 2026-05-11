import {
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeAddressesCommand,
  DescribeSnapshotsCommand,
} from '@aws-sdk/client-ec2';
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

/** Extract stop date string from AWS StateTransitionReason field.
 * Handles both:
 *   "User initiated (YYYY-MM-DD HH:MM:SS GMT)"
 *   "Client.UserInitiatedShutdown: User initiated shutdown (YYYY-MM-DD HH:MM:SS UTC)"
 */
function parseStopDate(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const m = reason.match(/\((\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
}

function daysSince(isoDate: string): number {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function splitInstanceType(t: string): { family: string; size: string } {
  const dot = t.indexOf('.');
  if (dot === -1) return { family: t, size: '' };
  return { family: t.slice(0, dot), size: t.slice(dot + 1) };
}

export async function collectEC2(
  client: EC2Client,
  region: string,
  signal?: AbortSignal,
  accountId?: string,
): Promise<Resource[]> {
  dbg(`    ec2 sub-tasks start — instances/volumes/addresses/snapshots region:${region}`);
  const t0 = Date.now();
  const [instances, volumes, addresses, snapshots] = await Promise.all([
    collectInstances(client, region, signal).then(r => { dbg(`    ec2 instances done ${Date.now()-t0}ms count:${r.length}`); return r; }),
    collectVolumes(client, region, signal, accountId).then(r => { dbg(`    ec2 volumes done ${Date.now()-t0}ms count:${r.length}`); return r; }),
    collectAddresses(client, region, signal, accountId).then(r => { dbg(`    ec2 addresses done ${Date.now()-t0}ms count:${r.length}`); return r; }),
    collectSnapshots(client, region, signal, accountId).then(r => { dbg(`    ec2 snapshots done ${Date.now()-t0}ms count:${r.length}`); return r; }),
  ]);
  return [...instances, ...volumes, ...addresses, ...snapshots];
}

async function collectInstances(
  client: EC2Client,
  region: string,
  signal?: AbortSignal,
): Promise<Resource[]> {
  const resources: Resource[] = [];
  const now = new Date().toISOString();
  let nextToken: string | undefined;

  do {
    const cmdOptions: Record<string, unknown> = {};
    if (signal) {
      cmdOptions['abortSignal'] = signal;
    }
    const out = await throttledCall('ec2', 'DescribeInstances', region, () =>
      client.send(new DescribeInstancesCommand({ NextToken: nextToken }), cmdOptions),
    );
    nextToken = typeof out.NextToken === 'string' && out.NextToken.trim() !== ''
      ? out.NextToken : undefined;

    for (const reservation of out.Reservations ?? []) {
      for (const inst of reservation.Instances ?? []) {
        const state = inst.State?.Name ?? '';
        const instType = inst.InstanceType ?? '';
        const { family, size } = splitInstanceType(instType);
        const sgIds = (inst.SecurityGroups ?? []).map((sg) => sg.GroupId ?? '');

        let lifecycle = 'on-demand';
        if (inst.InstanceLifecycle === 'spot') lifecycle = 'spot';
        else if (inst.InstanceLifecycle === 'scheduled') lifecycle = 'scheduled';

        const platformDetails =
          inst.PlatformDetails ??
          (inst.Platform ? String(inst.Platform) : 'Linux/UNIX');

        // OwnerId from DescribeInstances; validate it before constructing ARN
        let arn = '';
        const ownerId = reservation.OwnerId;
        if (inst.InstanceId) {
          if (isValidAccountId(ownerId)) {
            arn = `arn:aws:ec2:${region}:${ownerId}:instance/${inst.InstanceId}`;
          } else {
            logger.warn({ region, instanceId: inst.InstanceId, ownerId }, 'ec2 instance: cannot construct ARN due to missing/invalid account ID');
          }
        }

        const tags = tagsToMap(inst.Tags);
        const stoppedAt = state === 'stopped'
          ? parseStopDate(inst.StateTransitionReason)
          : undefined;

        const r: Resource = {
          id: inst.InstanceId ?? '',
          arn,
          type: 'ec2_instance',
          name: tags['Name'] ?? (inst.InstanceId ?? ''),
          region,
          state,
          instanceType: instType,
          tags,
          launchTime: inst.LaunchTime?.toISOString() ?? now,
          collectedAt: now,
          configuration: {
            platform: inst.Platform ?? '',
            platform_details: platformDetails,
            architecture: inst.Architecture ?? '',
            instance_family: family,
            instance_size: size,
            lifecycle,
            vpc_id: inst.VpcId ?? '',
            subnet_id: inst.SubnetId ?? '',
            image_id: inst.ImageId ?? '',
            key_name: inst.KeyName ?? '',
            monitoring_state: inst.Monitoring?.State ?? '',
            ebs_optimized: inst.EbsOptimized ?? false,
            security_group_ids: sgIds,
            security_group_count: sgIds.length,
            private_ip: inst.PrivateIpAddress ?? '',
            public_ip: inst.PublicIpAddress ?? '',
            availability_zone: inst.Placement?.AvailabilityZone ?? '',
            tenancy: inst.Placement?.Tenancy ?? '',
            metadata_options_http_tokens: inst.MetadataOptions?.HttpTokens ?? '',
            ...(stoppedAt !== undefined ? {
              stopped_at: stoppedAt,
              state_transition_days: daysSince(stoppedAt),
            } : {}),
          },
        };
        resources.push(r);
      }
    }
  } while (nextToken);

  return resources;
}

async function collectVolumes(
  client: EC2Client,
  region: string,
  signal?: AbortSignal,
  accountId?: string,
): Promise<Resource[]> {
  const resources: Resource[] = [];
  const now = new Date().toISOString();
  let nextToken: string | undefined;

  do {
    const cmdOptions: Record<string, unknown> = {};
    if (signal) {
      cmdOptions['abortSignal'] = signal;
    }
    const out = await throttledCall('ec2', 'DescribeVolumes', region, () =>
      client.send(new DescribeVolumesCommand({ NextToken: nextToken }), cmdOptions),
    );
    nextToken = typeof out.NextToken === 'string' && out.NextToken.trim() !== ''
      ? out.NextToken : undefined;

    for (const vol of out.Volumes ?? []) {
      let state = vol.State ?? '';
      if (!state) {
        state = (vol.Attachments ?? []).length > 0 ? 'in-use' : 'available';
      }
      const tags = tagsToMap(vol.Tags);

      let arn = '';
      if (vol.VolumeId) {
        if (isValidAccountId(accountId)) {
          arn = `arn:aws:ec2:${region}:${accountId}:volume/${vol.VolumeId}`;
        } else {
          logger.warn({ region, volumeId: vol.VolumeId, accountId }, 'ebs volume: cannot construct ARN due to missing/invalid account ID');
        }
      }

      resources.push({
        id: vol.VolumeId ?? '',
        arn,
        type: 'ebs_volume',
        name: tags['Name'] ?? (vol.VolumeId ?? ''),
        region,
        state,
        instanceType: '',
        tags,
        launchTime: vol.CreateTime?.toISOString() ?? now,
        collectedAt: now,
        configuration: {
          volume_type: vol.VolumeType ?? '',
          size_gb: vol.Size ?? 0,
          iops: vol.Iops ?? 0,
          throughput: vol.Throughput ?? 0,
          encrypted: vol.Encrypted ?? false,
          attachment_count: (vol.Attachments ?? []).length,
        },
      });
    }
  } while (nextToken);

  return resources;
}

async function collectAddresses(
  client: EC2Client,
  region: string,
  signal?: AbortSignal,
  accountId?: string,
): Promise<Resource[]> {
  const cmdOptions: Record<string, unknown> = {};
  if (signal) {
    cmdOptions['abortSignal'] = signal;
  }
  const out = await throttledCall('ec2', 'DescribeAddresses', region, () =>
    client.send(new DescribeAddressesCommand({}), cmdOptions),
  );

  const now = new Date().toISOString();
  return (out.Addresses ?? []).map((addr) => {
    const state = addr.AssociationId ? 'associated' : 'unassociated';
    const tags = tagsToMap(addr.Tags);

    let arn = '';
    if (addr.AllocationId) {
      if (isValidAccountId(accountId)) {
        arn = `arn:aws:ec2:${region}:${accountId}:eip/${addr.AllocationId}`;
      } else {
        logger.warn({ region, allocationId: addr.AllocationId, accountId }, 'elastic IP: cannot construct ARN due to missing/invalid account ID');
      }
    }

    return {
      id: addr.AllocationId ?? '',
      arn,
      type: 'elastic_ip',
      name: tags['Name'] ?? (addr.PublicIp ?? ''),
      region,
      state,
      instanceType: '',
      tags,
      launchTime: now,
      collectedAt: now,
      configuration: {
        public_ip: addr.PublicIp ?? '',
        domain: addr.Domain ?? '',
        instance_id: addr.InstanceId ?? '',
        association_id: addr.AssociationId ?? '',
        network_interface_id: addr.NetworkInterfaceId ?? '',
      },
    };
  });
}

async function collectSnapshots(
  client: EC2Client,
  region: string,
  signal?: AbortSignal,
  accountId?: string,
): Promise<Resource[]> {
  const resources: Resource[] = [];
  const now = new Date().toISOString();
  const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let nextToken: string | undefined;
  let pageCount = 0;

  do {
    const cmdOptions: Record<string, unknown> = {};
    if (signal) {
      cmdOptions['abortSignal'] = signal;
    }
    dbg(`    ec2 snapshots page:${pageCount + 1} start — region:${region} soFar:${resources.length}`);
    const t_snap = Date.now();
    const out = await throttledCall('ec2', 'DescribeSnapshots', region, () =>
      client.send(
        new DescribeSnapshotsCommand({
          OwnerIds: ['self'],
          Filters: [{ Name: 'start-time', Values: [`>=${cutoffDate}`] }],
          NextToken: nextToken,
          MaxResults: 1000,
        }),
        cmdOptions,
      ),
    );
    nextToken = typeof out.NextToken === 'string' && out.NextToken.trim() !== ''
      ? out.NextToken : undefined;
    pageCount++;
    dbg(`    ec2 snapshots page:${pageCount} done — ${Date.now() - t_snap}ms inPage:${out.Snapshots?.length ?? 0} hasMore:${Boolean(nextToken)}`);

    for (const snap of out.Snapshots ?? []) {
      const tags = tagsToMap(snap.Tags);

      let arn = '';
      if (snap.SnapshotId) {
        if (isValidAccountId(accountId)) {
          arn = `arn:aws:ec2:${region}:${accountId}:snapshot/${snap.SnapshotId}`;
        } else {
          logger.warn({ region, snapshotId: snap.SnapshotId, accountId }, 'ebs snapshot: cannot construct ARN due to missing/invalid account ID');
        }
      }

      resources.push({
        id: snap.SnapshotId ?? '',
        arn,
        type: 'ebs_snapshot',
        name: tags['Name'] ?? (snap.SnapshotId ?? ''),
        region,
        state: snap.State ?? '',
        instanceType: '',
        tags,
        launchTime: snap.StartTime?.toISOString() ?? now,
        collectedAt: now,
        configuration: {
          volume_id: snap.VolumeId ?? '',
          volume_size: snap.VolumeSize ?? 0,
          encrypted: snap.Encrypted ?? false,
          description: snap.Description ?? '',
        },
      });
    }
  } while (nextToken);

  return resources;
}
