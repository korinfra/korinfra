/**
 * Tests for src/aws/collectors/ — EC2, RDS, S3, Lambda with mocked AWS SDK clients.
 */

import { describe, it, expect, vi } from 'vitest';
import { createMockRateLimiter } from '../../helpers/mock-rate-limiter.js';

vi.mock('@aws-sdk/client-resource-groups-tagging-api', async () => ({
  ResourceGroupsTaggingAPIClient: vi.fn().mockImplementation(function () {
    return {
      send: vi.fn().mockResolvedValue({ ResourceTagMappingList: [], PaginationToken: undefined }),
    };
  }),
  GetResourcesCommand: vi.fn(),
}));

vi.mock('../../../src/aws/rate-limiter.js', async () => createMockRateLimiter());

import { collectEC2 } from '../../../src/aws/collectors/ec2.js';
import { collectRDS } from '../../../src/aws/collectors/rds.js';
import { collectS3 } from '../../../src/aws/collectors/s3.js';
import { collectLambda } from '../../../src/aws/collectors/lambda.js';

// ---------------------------------------------------------------------------
// EC2 client factory
// ---------------------------------------------------------------------------

function makeEC2Client(responses: {
  instances?: object[];
  volumes?: object[];
  addresses?: object[];
  snapshots?: object[];
} = {}) {
  const { instances = [], volumes = [], addresses = [], snapshots = [] } = responses;

  const sendMock = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    if (name === 'DescribeInstancesCommand') return Promise.resolve({ Reservations: instances, NextToken: undefined });
    if (name === 'DescribeVolumesCommand') return Promise.resolve({ Volumes: volumes, NextToken: undefined });
    if (name === 'DescribeAddressesCommand') return Promise.resolve({ Addresses: addresses });
    if (name === 'DescribeSnapshotsCommand') return Promise.resolve({ Snapshots: snapshots, NextToken: undefined });
    return Promise.resolve({});
  });

  return { send: sendMock } as never;
}

// ---------------------------------------------------------------------------
// collectEC2 — instances
// ---------------------------------------------------------------------------

describe('collectEC2 — instances', () => {
  it('returns empty array when no reservations', async () => {
    const resources = await collectEC2(makeEC2Client(), 'us-east-1');
    expect(resources.filter(r => r.type === 'ec2_instance')).toHaveLength(0);
  });

  it('maps a running t3.medium instance with all fields correctly', async () => {
    const client = makeEC2Client({
      instances: [{
        OwnerId: '123456789012',
        Instances: [{
          InstanceId: 'i-0abcdef1234567890',
          InstanceType: 't3.medium',
          State: { Name: 'running' },
          LaunchTime: new Date('2026-01-15T08:00:00Z'),
          Tags: [{ Key: 'Name', Value: 'prod-web-01' }, { Key: 'env', Value: 'production' }],
          Platform: '', PlatformDetails: 'Linux/UNIX', Architecture: 'x86_64',
          VpcId: 'vpc-0a1b2c3d4e5f67890', SubnetId: 'subnet-0a1b2c3d4e5f67890',
          ImageId: 'ami-0abcdef1234567890', KeyName: 'prod-keypair',
          Monitoring: { State: 'disabled' }, EbsOptimized: true,
          SecurityGroups: [{ GroupId: 'sg-0abcdef1234567890' }],
          PrivateIpAddress: '10.0.1.50', PublicIpAddress: '',
          Placement: { AvailabilityZone: 'us-east-1a', Tenancy: 'default' },
          MetadataOptions: { HttpTokens: 'required' },
        }],
      }],
    });

    const resources = await collectEC2(client, 'us-east-1');
    const instance = resources.find(r => r.type === 'ec2_instance')!;
    expect(instance.id).toBe('i-0abcdef1234567890');
    expect(instance.arn).toBe('arn:aws:ec2:us-east-1:123456789012:instance/i-0abcdef1234567890');
    expect(instance.name).toBe('prod-web-01');
    expect(instance.region).toBe('us-east-1');
    expect(instance.state).toBe('running');
    expect(instance.instanceType).toBe('t3.medium');
    expect(instance.tags['env']).toBe('production');
  });

  it('splits instance family and size, detects spot lifecycle, falls back to ID when no Name tag', async () => {
    const m5Client = makeEC2Client({
      instances: [{
        OwnerId: '123456789012',
        Instances: [{
          InstanceId: 'i-0aaa0000000000001',
          InstanceType: 'm5.2xlarge',
          State: { Name: 'running' },
          LaunchTime: new Date(),
          Tags: [],
        }],
      }],
    });
    const m5Resources = await collectEC2(m5Client, 'us-east-1');
    const m5 = m5Resources.find(r => r.type === 'ec2_instance')!;
    expect(m5.configuration['instance_family']).toBe('m5');
    expect(m5.configuration['instance_size']).toBe('2xlarge');

    const spotClient = makeEC2Client({
      instances: [{
        OwnerId: '123456789012',
        Instances: [{
          InstanceId: 'i-spot0000000000001',
          InstanceType: 'c5.xlarge',
          State: { Name: 'running' },
          InstanceLifecycle: 'spot',
          LaunchTime: new Date(),
          Tags: [],
        }],
      }],
    });
    const spotResources = await collectEC2(spotClient, 'us-east-1');
    expect(spotResources.find(r => r.type === 'ec2_instance')!.configuration['lifecycle']).toBe('spot');

    const noTagClient = makeEC2Client({
      instances: [{
        OwnerId: '123456789012',
        Instances: [{
          InstanceId: 'i-notag000000000001',
          InstanceType: 't2.micro',
          State: { Name: 'stopped' },
          LaunchTime: new Date(),
          Tags: [{ Key: 'Purpose', Value: 'bastion' }],
        }],
      }],
    });
    const noTagResources = await collectEC2(noTagClient, 'us-east-1');
    expect(noTagResources.find(r => r.type === 'ec2_instance')!.name).toBe('i-notag000000000001');
  });
});

// ---------------------------------------------------------------------------
// collectEC2 — EBS volumes, Elastic IPs, snapshots
// ---------------------------------------------------------------------------

describe('collectEC2 — EBS volumes, Elastic IPs, snapshots', () => {
  it('maps an available gp3 volume with all fields', async () => {
    const client = makeEC2Client({
      volumes: [{
        VolumeId: 'vol-0abcdef1234567890',
        State: 'available',
        VolumeType: 'gp3',
        Size: 100,
        Iops: 3000,
        Throughput: 125,
        Encrypted: true,
        CreateTime: new Date('2025-06-01T00:00:00Z'),
        Attachments: [],
        Tags: [{ Key: 'Name', Value: 'data-volume' }],
      }],
    });
    const vol = (await collectEC2(client, 'us-east-1')).find(r => r.type === 'ebs_volume')!;
    expect(vol.id).toBe('vol-0abcdef1234567890');
    expect(vol.arn).toBe('');
    expect(vol.state).toBe('available');
    expect(vol.configuration['volume_type']).toBe('gp3');
    expect(vol.configuration['size_gb']).toBe(100);
    expect(vol.configuration['encrypted']).toBe(true);
    expect(vol.configuration['attachment_count']).toBe(0);
  });

  it('derives in-use state from attachments when State is empty', async () => {
    const client = makeEC2Client({
      volumes: [{
        VolumeId: 'vol-attached000001',
        State: '',
        VolumeType: 'gp2',
        Size: 50,
        CreateTime: new Date(),
        Attachments: [{ InstanceId: 'i-0abcdef1234567890', State: 'attached' }],
        Tags: [],
      }],
    });
    const vol = (await collectEC2(client, 'us-east-1')).find(r => r.type === 'ebs_volume')!;
    expect(vol.state).toBe('in-use');
    expect(vol.configuration['attachment_count']).toBe(1);
  });

  it('maps unassociated and associated Elastic IPs', async () => {
    const unassocClient = makeEC2Client({
      addresses: [{
        AllocationId: 'eipalloc-0abcdef1234567890',
        PublicIp: '54.23.45.67',
        Domain: 'vpc',
        Tags: [],
      }],
    });
    const eip = (await collectEC2(unassocClient, 'us-east-1')).find(r => r.type === 'elastic_ip')!;
    expect(eip.id).toBe('eipalloc-0abcdef1234567890');
    expect(eip.state).toBe('unassociated');
    expect(eip.configuration['public_ip']).toBe('54.23.45.67');

    const assocClient = makeEC2Client({
      addresses: [{
        AllocationId: 'eipalloc-associated00001',
        PublicIp: '3.14.15.92',
        Domain: 'vpc',
        AssociationId: 'eipassoc-0abcdef1234567890',
        InstanceId: 'i-0abcdef1234567890',
        Tags: [],
      }],
    });
    const assocEip = (await collectEC2(assocClient, 'us-east-1')).find(r => r.type === 'elastic_ip')!;
    expect(assocEip.state).toBe('associated');
  });

  it('maps a completed EBS snapshot', async () => {
    const client = makeEC2Client({
      snapshots: [{
        SnapshotId: 'snap-0abcdef1234567890',
        VolumeId: 'vol-0abcdef1234567890',
        VolumeSize: 100,
        State: 'completed',
        Encrypted: false,
        Description: 'Daily backup',
        StartTime: new Date('2026-02-01T00:00:00Z'),
        Tags: [{ Key: 'Name', Value: 'daily-backup' }],
      }],
    });
    const snap = (await collectEC2(client, 'us-east-1')).find(r => r.type === 'ebs_snapshot')!;
    expect(snap.id).toBe('snap-0abcdef1234567890');
    expect(snap.arn).toBe('');
    expect(snap.state).toBe('completed');
    expect(snap.configuration['volume_size']).toBe(100);
    expect(snap.configuration['description']).toBe('Daily backup');
  });
});

// ---------------------------------------------------------------------------
// collectRDS
// ---------------------------------------------------------------------------

function makeRDSClient(dbInstances: object[] = []) {
  const sendMock = vi.fn().mockResolvedValue({ DBInstances: dbInstances, Marker: undefined });
  return { send: sendMock } as never;
}

describe('collectRDS', () => {
  it('returns empty array when no DB instances', async () => {
    expect(await collectRDS(makeRDSClient(), 'us-east-1')).toHaveLength(0);
  });

  it('maps a MySQL RDS instance with all fields and handles multiple instances', async () => {
    const client = makeRDSClient([{
      DBInstanceIdentifier: 'prod-mysql-01',
      DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:prod-mysql-01',
      DBInstanceClass: 'db.r5.2xlarge',
      DBInstanceStatus: 'available',
      Engine: 'mysql',
      EngineVersion: '8.0.35',
      MultiAZ: true,
      StorageType: 'gp3',
      AllocatedStorage: 500,
      StorageEncrypted: true,
      PubliclyAccessible: false,
      AutoMinorVersionUpgrade: true,
      BackupRetentionPeriod: 7,
      DeletionProtection: true,
      PerformanceInsightsEnabled: true,
      LicenseModel: 'general-public-license',
      DBName: 'proddb',
      AvailabilityZone: 'us-east-1a',
      InstanceCreateTime: new Date('2025-01-10T12:00:00Z'),
      TagList: [{ Key: 'env', Value: 'production' }],
      ReadReplicaDBInstanceIdentifiers: ['replica-01'],
      CACertificateIdentifier: 'rds-ca-2019',
    }]);

    const resources = await collectRDS(client, 'us-east-1');
    expect(resources).toHaveLength(1);
    const db = resources[0]!;
    expect(db.id).toBe('prod-mysql-01');
    expect(db.arn).toBe('arn:aws:rds:us-east-1:123456789012:db:prod-mysql-01');
    expect(db.type).toBe('rds_instance');
    expect(db.instanceType).toBe('db.r5.2xlarge');
    expect(db.state).toBe('available');
    expect(db.tags['env']).toBe('production');
    expect(db.configuration['engine']).toBe('mysql');
    expect(db.configuration['engine_version']).toBe('8.0.35');
    expect(db.configuration['multi_az']).toBe(true);
    expect(db.configuration['allocated_storage']).toBe(500);
    expect(db.configuration['deletion_protection']).toBe(true);
    expect(db.configuration['read_replica_count']).toBe(1);

    // Multiple instances
    const makeDb = (id: string) => ({
      DBInstanceIdentifier: id,
      DBInstanceArn: `arn:aws:rds:us-east-1:123456789012:db:${id}`,
      DBInstanceClass: 'db.t3.medium',
      DBInstanceStatus: 'available',
      Engine: 'postgres',
      TagList: [],
      ReadReplicaDBInstanceIdentifiers: [],
    });
    const multi = await collectRDS(makeRDSClient([makeDb('db-alpha'), makeDb('db-beta'), makeDb('db-gamma')]), 'us-east-1');
    expect(multi).toHaveLength(3);
    expect(multi.map(r => r.id)).toEqual(['db-alpha', 'db-beta', 'db-gamma']);
  });
});

// ---------------------------------------------------------------------------
// collectLambda
// ---------------------------------------------------------------------------

function makeLambdaClient(functions: object[] = []) {
  const sendMock = vi.fn().mockResolvedValue({ Functions: functions, NextMarker: undefined });
  return { send: sendMock } as never;
}

describe('collectLambda', () => {
  it('returns empty array when no functions', async () => {
    expect(await collectLambda(makeLambdaClient(), 'us-east-1')).toHaveLength(0);
  });

  it('maps a Node.js Lambda function, arm64 architecture, and default architecture fallback', async () => {
    const client = makeLambdaClient([{
      FunctionName: 'process-cost-events',
      FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:process-cost-events',
      Runtime: 'nodejs20.x',
      Architectures: ['x86_64'],
      MemorySize: 512,
      Timeout: 30,
      Handler: 'index.handler',
      CodeSize: 8192000,
      Description: 'Processes cost events from SNS',
      PackageType: 'Zip',
      LastModified: '2026-02-15T14:30:00.000+0000',
    }]);

    const resources = await collectLambda(client, 'us-east-1');
    expect(resources).toHaveLength(1);
    const fn = resources[0]!;
    expect(fn.id).toBe('process-cost-events');
    expect(fn.arn).toBe('arn:aws:lambda:us-east-1:123456789012:function:process-cost-events');
    expect(fn.type).toBe('lambda_function');
    expect(fn.state).toBe('active');
    expect(fn.configuration['runtime']).toBe('nodejs20.x');
    expect(fn.configuration['memory_mb']).toBe(512);
    expect(fn.configuration['timeout_sec']).toBe(30);
    expect(fn.configuration['handler']).toBe('index.handler');

    // arm64 architecture
    const arm64Client = makeLambdaClient([{
      FunctionName: 'arm-function',
      FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:arm-function',
      Runtime: 'python3.12',
      Architectures: ['arm64'],
      MemorySize: 256,
      Timeout: 15,
      LastModified: '2026-01-01T00:00:00.000+0000',
    }]);
    const arm64Resources = await collectLambda(arm64Client, 'us-east-1');
    expect(arm64Resources[0]!.configuration['architectures']).toBe('arm64');

    // Default architecture fallback
    const defaultClient = makeLambdaClient([{
      FunctionName: 'default-arch-fn',
      FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:default-arch-fn',
      Runtime: 'go1.x',
      MemorySize: 128,
      Timeout: 5,
      LastModified: '2025-12-01T00:00:00.000+0000',
    }]);
    const defaultResources = await collectLambda(defaultClient, 'us-east-1');
    expect(defaultResources[0]!.configuration['architectures']).toBe('x86_64');
  });

  it('handles invalid LastModified date gracefully', async () => {
    const client = makeLambdaClient([{
      FunctionName: 'bad-date-fn',
      FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:bad-date-fn',
      Runtime: 'nodejs18.x',
      MemorySize: 128,
      Timeout: 10,
      LastModified: 'not-a-date',
    }]);
    const resources = await collectLambda(client, 'us-east-1');
    expect(resources[0]!.launchTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// collectS3
// ---------------------------------------------------------------------------

vi.mock('@aws-sdk/client-s3', async () => {
  const original = await import('@aws-sdk/client-s3');
  return { ...original };
});

describe('collectS3', () => {
  function makeS3Client(
    buckets: Array<{ Name: string; CreationDate?: Date }> = [],
    bucketMeta: Record<string, {
      location?: string;
      tags?: Array<{ Key: string; Value: string }>;
      versioning?: string;
      lifecycleRules?: number;
      encrypted?: boolean;
    }> = {},
  ) {
    const sendMock = vi.fn().mockImplementation((command: { constructor: { name: string }; input?: { Bucket?: string } }) => {
      const name = command.constructor.name;
      const bucket = (command as { input?: { Bucket?: string } }).input?.Bucket ?? '';
      if (name === 'ListBucketsCommand') return Promise.resolve({ Buckets: buckets });
      if (name === 'GetBucketLocationCommand') return Promise.resolve({ LocationConstraint: bucketMeta[bucket]?.location ?? '' });
      if (name === 'GetBucketTaggingCommand') {
        const tags = bucketMeta[bucket]?.tags;
        if (!tags) throw Object.assign(new Error('NoSuchTagConfiguration'), { name: 'NoSuchTagConfiguration' });
        return Promise.resolve({ TagSet: tags });
      }
      if (name === 'GetBucketVersioningCommand') return Promise.resolve({ Status: bucketMeta[bucket]?.versioning });
      if (name === 'GetBucketLifecycleConfigurationCommand') {
        const count = bucketMeta[bucket]?.lifecycleRules ?? 0;
        if (count === 0) throw Object.assign(new Error('NoSuchLifecycleConfiguration'), { name: 'NoSuchLifecycleConfiguration' });
        return Promise.resolve({ Rules: Array.from({ length: count }, (_, i) => ({ ID: `rule-${i}` })) });
      }
      if (name === 'GetBucketEncryptionCommand') {
        const enc = bucketMeta[bucket]?.encrypted;
        if (!enc) throw Object.assign(new Error('ServerSideEncryptionConfigurationNotFoundError'), { name: 'ServerSideEncryptionConfigurationNotFoundError' });
        return Promise.resolve({ ServerSideEncryptionConfiguration: { Rules: [{}] } });
      }
      if (name === 'ListBucketIntelligentTieringConfigurationsCommand') return Promise.resolve({ IntelligentTieringConfigurationList: [] });
      return Promise.resolve({});
    });
    return { send: sendMock, config: { credentials: undefined } } as never;
  }

  it('returns empty array when no buckets', async () => {
    expect(await collectS3(makeS3Client(), 'us-east-1')).toHaveLength(0);
  });

  it('maps a bucket with all metadata', async () => {
    const client = makeS3Client(
      [{ Name: 'korinfra-prod-data', CreationDate: new Date('2025-01-01T00:00:00Z') }],
      { 'korinfra-prod-data': { location: 'us-east-1', tags: [{ Key: 'team', Value: 'platform' }], versioning: 'Enabled', lifecycleRules: 2, encrypted: true } },
    );
    const resources = await collectS3(client, 'us-east-1');
    expect(resources).toHaveLength(1);
    const bucket = resources[0]!;
    expect(bucket.id).toBe('korinfra-prod-data');
    expect(bucket.arn).toBe('arn:aws:s3:::korinfra-prod-data');
    expect(bucket.type).toBe('s3_bucket');
    expect(bucket.state).toBe('active');
    expect(bucket.region).toBe('us-east-1');
    expect(bucket.tags['team']).toBe('platform');
    expect(bucket.configuration['versioning_enabled']).toBe(true);
    expect(bucket.configuration['lifecycle_rules_count']).toBe(2);
    expect(bucket.configuration['has_lifecycle']).toBe(true);
    expect(bucket.configuration['encryption_enabled']).toBe(true);
  });

  it('handles untagged bucket, no versioning, empty LocationConstraint, and multiple buckets', async () => {
    const untaggedResources = await collectS3(
      makeS3Client([{ Name: 'untagged-bucket', CreationDate: new Date() }], { 'untagged-bucket': { location: 'us-east-1' } }),
      'us-east-1',
    );
    expect(untaggedResources[0]!.tags).toEqual({});

    const noVersionResources = await collectS3(
      makeS3Client([{ Name: 'no-versioning-bucket', CreationDate: new Date() }], { 'no-versioning-bucket': { location: 'us-east-1', versioning: undefined } }),
      'us-east-1',
    );
    expect(noVersionResources[0]!.configuration['versioning_enabled']).toBe(false);

    const emptyLocResources = await collectS3(
      makeS3Client([{ Name: 'us-east-1-bucket', CreationDate: new Date() }], { 'us-east-1-bucket': { location: '' } }),
      'us-east-1',
    );
    expect(emptyLocResources[0]!.region).toBe('us-east-1');

    const multiResources = await collectS3(
      makeS3Client([
        { Name: 'bucket-alpha', CreationDate: new Date() },
        { Name: 'bucket-beta', CreationDate: new Date() },
        { Name: 'bucket-gamma', CreationDate: new Date() },
      ]),
      'us-east-1',
    );
    expect(multiResources).toHaveLength(3);
    expect(multiResources.map(r => r.name).sort()).toEqual(['bucket-alpha', 'bucket-beta', 'bucket-gamma']);
  });
});
