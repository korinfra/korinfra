import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseStateFromString, parseStateFile, findStateFile } from '../../../src/terraform/state.js';

// ─── v4 state format (current standard) ──────────────────────────────────────

describe('parseStateFromString — v4 format', () => {
  it('parses a single managed resource with correct fields', () => {
    const state = JSON.stringify({
      version: 4,
      terraform_version: '1.5.7',
      serial: 1,
      lineage: 'abc-123',
      outputs: {},
      resources: [
        {
          mode: 'managed',
          type: 'aws_instance',
          name: 'web',
          provider: 'provider["registry.terraform.io/hashicorp/aws"]',
          instances: [{
            attributes: {
              id: 'i-0abc123def456',
              ami: 'ami-0abcdef1234567890',
              instance_type: 't3.micro',
              arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123def456',
            },
          }],
        },
      ],
    });

    const resources = parseStateFromString(state);
    expect(resources).toHaveLength(1);
    const inst = resources[0]!;
    expect(inst.type).toBe('aws_instance');
    expect(inst.name).toBe('web');
    expect(inst.id).toBe('i-0abc123def456');
    expect(inst.arn).toBe('arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123def456');
    expect(inst.address).toBe('aws_instance.web');
    expect(inst.provider).toBe('aws');
    expect(inst.attributes['instance_type']).toBe('t3.micro');
  });

  it('parses multiple resource types, skips data sources, handles empty/missing resources array', () => {
    const stateMulti = JSON.stringify({
      version: 4, terraform_version: '1.6.3', serial: 42, lineage: 'xyz', outputs: {},
      resources: [
        { mode: 'managed', type: 'aws_instance', name: 'app', provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [{ attributes: { id: 'i-0abc', arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0abc', instance_type: 'm5.large' } }] },
        { mode: 'managed', type: 'aws_s3_bucket', name: 'logs', provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [{ attributes: { id: 'my-logs', arn: 'arn:aws:s3:::my-logs' } }] },
        { mode: 'data', type: 'aws_ami', name: 'ubuntu', provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [{ attributes: { id: 'ami-skip' } }] },
      ],
    });
    const r = parseStateFromString(stateMulti);
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.type)).toContain('aws_instance');
    expect(r.map((x) => x.type)).toContain('aws_s3_bucket');

    // empty resources array
    expect(parseStateFromString(JSON.stringify({ version: 4, terraform_version: '1.5.7', serial: 0, lineage: 'x', outputs: {}, resources: [] }))).toHaveLength(0);

    // missing resources key
    expect(parseStateFromString(JSON.stringify({ version: 4, terraform_version: '1.5.7', serial: 0, lineage: 'x', outputs: {} }))).toHaveLength(0);
  });

  it('builds module-nested address and normalizes provider', () => {
    const state = JSON.stringify({
      version: 4, terraform_version: '1.5.7', serial: 10, lineage: 'mod-abc', outputs: {},
      resources: [{
        module: 'module.networking',
        mode: 'managed',
        type: 'aws_vpc',
        name: 'main',
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [{ attributes: { id: 'vpc-0123456789abcdef0' } }],
      }],
    });
    const r = parseStateFromString(state);
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe('module.networking.main');
    expect(r[0]!.address).toBe('aws_vpc.module.networking.main');
    expect(r[0]!.provider).toBe('aws');
  });
});

// ─── v3 state format (legacy) ────────────────────────────────────────────────

describe('parseStateFromString — v3 format', () => {
  it('parses v3 root-level and module-nested resources', () => {
    const stateRoot = JSON.stringify({
      version: 3, terraform_version: '0.12.31', serial: 5, lineage: 'v3',
      modules: [{
        path: ['root'],
        resources: {
          'aws_instance.web': {
            type: 'aws_instance', provider: 'provider.aws',
            primary: { id: 'i-0v3abc123', attributes: { id: 'i-0v3abc123', arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0v3abc123' } },
          },
          'aws_s3_bucket.static': {
            type: 'aws_s3_bucket', provider: 'provider.aws',
            primary: { id: 'my-static-bucket', attributes: { id: 'my-static-bucket' } },
          },
        },
      }],
    });
    const r = parseStateFromString(stateRoot);
    expect(r).toHaveLength(2);
    const inst = r.find((x) => x.type === 'aws_instance')!;
    expect(inst.id).toBe('i-0v3abc123');
    expect(inst.address).toBe('aws_instance.web');
    const bucket = r.find((x) => x.type === 'aws_s3_bucket')!;
    expect(bucket.id).toBe('my-static-bucket');

    // module-nested path
    const stateMod = JSON.stringify({
      version: 3, terraform_version: '0.12.31', serial: 3, lineage: 'v3-mod',
      modules: [{
        path: ['root', 'compute'],
        resources: {
          'aws_instance.db': { type: 'aws_instance', provider: 'provider.aws', primary: { id: 'i-0db111', attributes: { id: 'i-0db111' } } },
        },
      }],
    });
    const rm = parseStateFromString(stateMod);
    expect(rm).toHaveLength(1);
    expect(rm[0]!.address).toContain('aws_instance');
    expect(rm[0]!.address).toContain('module.');
  });
});

// ─── Version validation and error handling ────────────────────────────────────

describe('parseStateFromString — version validation and error handling', () => {
  it('throws for unsupported versions and accepts v3/v4', () => {
    for (const version of [1, 2, 5, 99]) {
      expect(() => parseStateFromString(JSON.stringify({ version, terraform_version: '0.1.0', resources: [] }))).toThrow(/v3\/v4|Only Terraform/i);
    }
    expect(() => parseStateFromString(JSON.stringify({ version: 3, terraform_version: '0.12.31', modules: [] }))).not.toThrow();
    expect(() => parseStateFromString(JSON.stringify({ version: 4, terraform_version: '1.5.7', serial: 0, lineage: 'x', outputs: {}, resources: [] }))).not.toThrow();
  });

  it('throws on invalid JSON or empty string', () => {
    expect(() => parseStateFromString('{ not valid json }')).toThrow();
    expect(() => parseStateFromString('')).toThrow();
  });
});

// ─── parseStateFile and findStateFile ────────────────────────────────────────

describe('parseStateFile and findStateFile', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'korinfra-state-test-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reads and parses a .tfstate file from disk, throws for missing file', async () => {
    const content = JSON.stringify({
      version: 4, terraform_version: '1.5.7', serial: 1, lineage: 'disk-test', outputs: {},
      resources: [{
        mode: 'managed', type: 'aws_instance', name: 'prod',
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [{ attributes: { id: 'i-0prod000', instance_type: 't3.large' } }],
      }],
    });
    const stateFile = join(tmpDir, 'terraform.tfstate');
    await writeFile(stateFile, content, 'utf8');

    const resources = await parseStateFile(stateFile);
    expect(resources).toHaveLength(1);
    expect(resources[0]!.id).toBe('i-0prod000');

    await expect(parseStateFile(join(tmpDir, 'nonexistent.tfstate'))).rejects.toThrow();
  });

  it('finds terraform.tfstate when present, returns null when absent', async () => {
    const stateContent = JSON.stringify({ version: 4, terraform_version: '1.5.7', serial: 0, lineage: 'x', outputs: {}, resources: [] });
    await writeFile(join(tmpDir, 'terraform.tfstate'), stateContent, 'utf8');

    const found = await findStateFile(tmpDir);
    expect(found).not.toBeNull();
    expect(found).toContain('terraform.tfstate');

    const emptyDir = await mkdtemp(join(tmpdir(), 'korinfra-no-state-'));
    try {
      expect(await findStateFile(emptyDir)).toBeNull();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});
