import { describe, it, expect } from 'vitest';

import {
  resolveAction,
  synthesizeResource,
} from '../../../src/terraform/plan-resource.js';
import type { TerraformResourceChange } from '../../../src/terraform/plan-parser.js';

function makeChange(overrides: Partial<TerraformResourceChange> & {
  change?: Partial<TerraformResourceChange['change']>;
}): TerraformResourceChange {
  return {
    address: overrides.address ?? 'aws_instance.foo',
    type: overrides.type ?? 'aws_instance',
    ...(overrides.module_address !== undefined ? { module_address: overrides.module_address } : {}),
    change: {
      actions: overrides.change?.actions ?? ['create'],
      before: overrides.change?.before ?? null,
      after: overrides.change?.after ?? null,
      ...(overrides.change?.after_unknown !== undefined ? { after_unknown: overrides.change.after_unknown } : {}),
    },
  };
}

describe('resolveAction', () => {
  it('returns no-op for empty array', () => {
    expect(resolveAction([])).toBe('no-op');
  });
  it('returns no-op for ["no-op"]', () => {
    expect(resolveAction(['no-op'])).toBe('no-op');
  });
  it('returns read for ["read"]', () => {
    expect(resolveAction(['read'])).toBe('read');
  });
  it('returns create for ["create"]', () => {
    expect(resolveAction(['create'])).toBe('create');
  });
  it('returns update for ["update"]', () => {
    expect(resolveAction(['update'])).toBe('update');
  });
  it('returns destroy for ["delete"]', () => {
    expect(resolveAction(['delete'])).toBe('destroy');
  });
  it('returns replace for ["delete","create"]', () => {
    expect(resolveAction(['delete', 'create'])).toBe('replace');
  });
  it('returns replace for ["create","delete"] (create_before_destroy)', () => {
    expect(resolveAction(['create', 'delete'])).toBe('replace');
  });
  it('falls back to no-op for unknown action patterns', () => {
    expect(resolveAction(['mystery'])).toBe('no-op');
  });
});

describe('synthesizeResource — aws_instance', () => {
  it('builds a Resource with instanceType from change.after', () => {
    const change = makeChange({
      change: { actions: ['create'], after: { instance_type: 't3.micro', platform: 'Linux' } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth).not.toBeNull();
    expect(synth!.resource.type).toBe('ec2_instance');
    expect(synth!.resource.instanceType).toBe('t3.micro');
    expect(synth!.resource.configuration['platform']).toBe('Linux');
    expect(synth!.costStatus).toBe('known');
  });

  it('marks instance_type unknown as costStatus="unknown"', () => {
    const change = makeChange({
      change: {
        actions: ['create'],
        after: { instance_type: null },
        after_unknown: { instance_type: true },
      },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.costStatus).toBe('unknown');
  });

  it('returns null for no-op', () => {
    const change = makeChange({
      change: { actions: ['no-op'], before: { foo: 'bar' }, after: { foo: 'bar' } },
    });
    expect(synthesizeResource(change, 'after', 'us-east-1')).toBeNull();
  });

  it('returns null when side is null (e.g. before for create)', () => {
    const change = makeChange({
      change: { actions: ['create'], before: null, after: { instance_type: 't3.micro' } },
    });
    expect(synthesizeResource(change, 'before', 'us-east-1')).toBeNull();
  });

  it('returns null for data sources', () => {
    const change = makeChange({
      address: 'data.aws_ami.latest',
      type: 'aws_ami',
      change: { actions: ['read'], after: {} },
    });
    expect(synthesizeResource(change, 'after', 'us-east-1')).toBeNull();
  });

  it('sets metadata_options_http_tokens for EC2-012 when present', () => {
    const change = makeChange({
      change: {
        actions: ['create'],
        after: {
          instance_type: 't3.micro',
          metadata_options: [{ http_tokens: 'optional' }],
        },
      },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.configuration['metadata_options_http_tokens']).toBe('optional');
  });
});

describe('synthesizeResource — aws_db_instance', () => {
  it('maps instance_class to top-level instanceType and surfaces security fields', () => {
    const change = makeChange({
      address: 'aws_db_instance.api',
      type: 'aws_db_instance',
      change: {
        actions: ['create'],
        after: {
          instance_class: 'db.r5.large',
          engine: 'postgres',
          allocated_storage: 100,
          multi_az: true,
          storage_encrypted: false,
          publicly_accessible: true,
          backup_retention_period: 0,
        },
      },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.type).toBe('rds_instance');
    expect(synth!.resource.instanceType).toBe('db.r5.large');
    expect(synth!.resource.configuration['multi_az']).toBe(true);
    expect(synth!.resource.configuration['storage_encrypted']).toBe(false);
    expect(synth!.resource.configuration['publicly_accessible']).toBe(true);
    expect(synth!.resource.configuration['backup_retention_period']).toBe(0);
    // TerraformResource is exposed for security rules and uses the raw TF type.
    expect(synth!.tfResource.type).toBe('aws_db_instance');
    expect(synth!.tfResource.configuration['publicly_accessible']).toBe(true);
  });
});

describe('synthesizeResource — aws_ebs_volume rename', () => {
  it('maps after.type → cfg.volume_type and after.size → cfg.size_gb', () => {
    const change = makeChange({
      address: 'aws_ebs_volume.data',
      type: 'aws_ebs_volume',
      change: { actions: ['create'], after: { type: 'gp3', size: 200, iops: 5000, throughput: 250 } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.configuration['volume_type']).toBe('gp3');
    expect(synth!.resource.configuration['size_gb']).toBe(200);
    expect(synth!.resource.configuration['iops']).toBe(5000);
  });
});

describe('synthesizeResource — aws_lambda_function rename', () => {
  it('maps after.memory_size → cfg.memory_mb and marks costStatus=variable', () => {
    const change = makeChange({
      address: 'aws_lambda_function.api',
      type: 'aws_lambda_function',
      change: { actions: ['create'], after: { memory_size: 256 } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.configuration['memory_mb']).toBe(256);
    expect(synth!.costStatus).toBe('variable');
  });
});

describe('synthesizeResource — aws_lb', () => {
  it('maps after.load_balancer_type → cfg.lb_type with "application" default', () => {
    const change = makeChange({
      address: 'aws_lb.web',
      type: 'aws_lb',
      change: { actions: ['create'], after: {} },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.configuration['lb_type']).toBe('application');
  });
});

describe('synthesizeResource — region resolution', () => {
  it('uses after.region when present', () => {
    const change = makeChange({
      change: { actions: ['create'], after: { instance_type: 't3.micro', region: 'eu-west-2' } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.region).toBe('eu-west-2');
  });
  it('falls back to defaultRegion when after.region is missing', () => {
    const change = makeChange({
      change: { actions: ['create'], after: { instance_type: 't3.micro' } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-2');
    expect(synth!.resource.region).toBe('us-east-2');
  });
});

describe('synthesizeResource — tag merge precedence', () => {
  it('user-defined tags override tags_all keys', () => {
    const change = makeChange({
      change: {
        actions: ['create'],
        after: {
          instance_type: 't3.micro',
          tags_all: { Env: 'prod', Owner: 'default' },
          tags: { Owner: 'override' },
        },
      },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.tags).toEqual({ Env: 'prod', Owner: 'override' });
  });
});

describe('synthesizeResource — for_each addresses with special chars', () => {
  it('preserves the full address as TerraformResource.name (avoids brittle parsing)', () => {
    const change = makeChange({
      address: 'aws_instance.foo["a.b"]',
      type: 'aws_instance',
      change: { actions: ['create'], after: { instance_type: 't3.micro' } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.tfResource.address).toBe('aws_instance.foo["a.b"]');
    expect(synth!.tfResource.name).toBe('aws_instance.foo["a.b"]');
    expect(synth!.resource.id).toBe('aws_instance.foo["a.b"]');
  });
});

describe('synthesizeResource — unpriced fallback', () => {
  it('marks unsupported types as unpriced', () => {
    const change = makeChange({
      address: 'aws_sqs_queue.events',
      type: 'aws_sqs_queue',
      change: { actions: ['create'], after: { name: 'events' } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.costStatus).toBe('unpriced');
    expect(synth!.resource.type).toBe('sqs_queue');
  });
});

describe('synthesizeResource — module address', () => {
  it('keeps the full address from the plan (no double-prefix)', () => {
    const change = makeChange({
      address: 'module.network.aws_instance.web',
      type: 'aws_instance',
      module_address: 'module.network',
      change: { actions: ['create'], after: { instance_type: 't3.micro' } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.id).toBe('module.network.aws_instance.web');
    expect(synth!.tfResource.module).toBe('module.network');
  });
});

describe('synthesizeResource — aws_s3_bucket', () => {
  it('marks costStatus=variable (no size info in plan)', () => {
    const change = makeChange({
      address: 'aws_s3_bucket.data',
      type: 'aws_s3_bucket',
      change: { actions: ['create'], after: { bucket: 'my-bucket' } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.type).toBe('s3_bucket');
    expect(synth!.costStatus).toBe('variable');
    expect(synth!.resource.configuration['storage_class']).toBe('STANDARD');
    expect(synth!.resource.configuration['size_gb']).toBe(0);
  });
});

describe('synthesizeResource — aws_ebs_snapshot', () => {
  it('maps volume_size correctly', () => {
    const change = makeChange({
      address: 'aws_ebs_snapshot.weekly',
      type: 'aws_ebs_snapshot',
      change: { actions: ['create'], after: { volume_size: 500 } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.type).toBe('ebs_snapshot');
    expect(synth!.resource.configuration['volume_size']).toBe(500);
    expect(synth!.costStatus).toBe('known');
  });
});

describe('synthesizeResource — aws_nat_gateway', () => {
  it('produces a known costStatus with an empty configuration', () => {
    const change = makeChange({
      address: 'aws_nat_gateway.public',
      type: 'aws_nat_gateway',
      change: { actions: ['create'], after: { allocation_id: 'eipalloc-123', subnet_id: 'subnet-abc' } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.type).toBe('nat_gateway');
    expect(synth!.costStatus).toBe('known');
  });
});

describe('synthesizeResource — aws_eip', () => {
  it('marks state="associated" when network_interface is set', () => {
    const change = makeChange({
      address: 'aws_eip.api',
      type: 'aws_eip',
      change: { actions: ['create'], after: { network_interface: 'eni-1234' } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.type).toBe('elastic_ip');
    expect(synth!.resource.state).toBe('associated');
  });

  it('marks state="available" when no association is set', () => {
    const change = makeChange({
      address: 'aws_eip.unused',
      type: 'aws_eip',
      change: { actions: ['create'], after: {} },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.state).toBe('available');
  });
});

describe('synthesizeResource — aws_elasticache_cluster', () => {
  it('maps node_type to instanceType and surfaces num_cache_nodes', () => {
    const change = makeChange({
      address: 'aws_elasticache_cluster.cache',
      type: 'aws_elasticache_cluster',
      change: {
        actions: ['create'],
        after: { node_type: 'cache.r6g.large', num_cache_nodes: 3 },
      },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.type).toBe('elasticache_cluster');
    expect(synth!.resource.instanceType).toBe('cache.r6g.large');
    expect(synth!.resource.configuration['num_cache_nodes']).toBe(3);
    expect(synth!.costStatus).toBe('known');
  });

  it('defaults num_cache_nodes to 1', () => {
    const change = makeChange({
      address: 'aws_elasticache_cluster.cache',
      type: 'aws_elasticache_cluster',
      change: { actions: ['create'], after: { node_type: 'cache.t3.micro' } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.configuration['num_cache_nodes']).toBe(1);
  });

  it('marks unknown when node_type is masked by after_unknown', () => {
    const change = makeChange({
      address: 'aws_elasticache_cluster.cache',
      type: 'aws_elasticache_cluster',
      change: {
        actions: ['create'],
        after: { node_type: null },
        after_unknown: { node_type: true },
      },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.costStatus).toBe('unknown');
  });
});

describe('synthesizeResource — aws_dynamodb_table', () => {
  it('maps PROVISIONED billing with read/write capacity', () => {
    const change = makeChange({
      address: 'aws_dynamodb_table.api',
      type: 'aws_dynamodb_table',
      change: {
        actions: ['create'],
        after: { billing_mode: 'PROVISIONED', read_capacity: 5, write_capacity: 5 },
      },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.type).toBe('dynamodb_table');
    expect(synth!.resource.configuration['billing_mode']).toBe('PROVISIONED');
    expect(synth!.resource.configuration['read_capacity_units']).toBe(5);
    expect(synth!.resource.configuration['write_capacity_units']).toBe(5);
    expect(synth!.costStatus).toBe('known');
  });

  it('marks PAY_PER_REQUEST as variable', () => {
    const change = makeChange({
      address: 'aws_dynamodb_table.events',
      type: 'aws_dynamodb_table',
      change: { actions: ['create'], after: { billing_mode: 'PAY_PER_REQUEST' } },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.costStatus).toBe('variable');
  });
});

describe('synthesizeResource — aws_ecs_service', () => {
  it('maps desired_count and marks costStatus=partial-unknown (task def not resolved in v1)', () => {
    const change = makeChange({
      address: 'aws_ecs_service.api',
      type: 'aws_ecs_service',
      change: {
        actions: ['create'],
        after: {
          desired_count: 5,
          launch_type: 'FARGATE',
          task_definition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/api:1',
        },
      },
    });
    const synth = synthesizeResource(change, 'after', 'us-east-1');
    expect(synth!.resource.type).toBe('ecs_service');
    expect(synth!.resource.configuration['desired_count']).toBe(5);
    expect(synth!.costStatus).toBe('partial-unknown');
  });
});
