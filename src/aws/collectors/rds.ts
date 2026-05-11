import { DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import type { RDSClient} from '@aws-sdk/client-rds';
import type { Resource } from '../types.js';
import { throttledCall } from '../rate-limiter.js';
import { tagsToMap } from '../utils.js';
import { dbg } from '../debug.js';

export async function collectRDS(
  client: RDSClient,
  region: string,
  signal?: AbortSignal,
): Promise<Resource[]> {
  const resources: Resource[] = [];
  const now = new Date().toISOString();
  let marker: string | undefined;
  let pageNum = 0;

  do {
    dbg(`    rds DescribeDBInstances page:${pageNum + 1} start — region:${region} soFar:${resources.length}`);
    const t_rds = Date.now();
    const out = await throttledCall('rds', 'DescribeDBInstances', region, () =>
      client.send(new DescribeDBInstancesCommand({ Marker: marker }), { ...(signal ? { abortSignal: signal } : {}) }),
    );
    marker = out.Marker ?? undefined;
    pageNum++;
    dbg(`    rds DescribeDBInstances page:${pageNum} done — ${Date.now() - t_rds}ms inPage:${out.DBInstances?.length ?? 0} hasMore:${Boolean(marker)}`);

    for (const db of out.DBInstances ?? []) {
      resources.push({
        id: db.DBInstanceIdentifier ?? '',
        arn: db.DBInstanceArn ?? '',
        type: db.DBClusterIdentifier ? 'rds_cluster_instance' : 'rds_instance',
        name: db.DBInstanceIdentifier ?? '',
        region,
        state: db.DBInstanceStatus ?? '',
        instanceType: db.DBInstanceClass ?? '',
        tags: tagsToMap(db.TagList),
        launchTime: db.InstanceCreateTime?.toISOString() ?? now,
        collectedAt: now,
        configuration: {
          instance_class: db.DBInstanceClass ?? '',
          cluster_identifier: db.DBClusterIdentifier ?? '',
          engine: db.Engine ?? '',
          engine_version: db.EngineVersion ?? '',
          multi_az: db.MultiAZ ?? false,
          storage_type: db.StorageType ?? '',
          allocated_storage: db.AllocatedStorage ?? 0,
          max_allocated_storage: db.MaxAllocatedStorage ?? null,
          storage_encrypted: db.StorageEncrypted ?? false,
          publicly_accessible: db.PubliclyAccessible ?? false,
          auto_minor_version_upgrade: db.AutoMinorVersionUpgrade ?? false,
          backup_retention_period: db.BackupRetentionPeriod ?? 0,
          deletion_protection: db.DeletionProtection ?? false,
          performance_insights_enabled: db.PerformanceInsightsEnabled ?? false,
          license_model: db.LicenseModel ?? '',
          db_name: db.DBName ?? '',
          availability_zone: db.AvailabilityZone ?? '',
          secondary_az: db.SecondaryAvailabilityZone ?? '',
          read_replica_count: (db.ReadReplicaDBInstanceIdentifiers ?? []).length,
          ca_certificate: db.CACertificateIdentifier ?? '',
        },
      });
    }
  } while (marker);

  return resources;
}
