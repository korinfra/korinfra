import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseTerraformFile,
  parseTerraformDir,
  normalizeResourceType,
  filterManagedTerraformResources,
  filterAWSResources,
  isTerraformDir,
} from '../../../src/terraform/parser.js';

// ─── normalizeResourceType ────────────────────────────────────────────────────

describe('normalizeResourceType', () => {
  it('maps known types and falls back correctly', () => {
    const cases: Array<[string, string]> = [
      ['aws_instance', 'ec2_instance'],
      ['aws_db_instance', 'rds_instance'],
      ['aws_lambda_function', 'lambda_function'],
      ['aws_s3_bucket', 's3_bucket'],
      ['aws_lb', 'load_balancer'],
      ['aws_alb', 'load_balancer'],
      ['aws_nat_gateway', 'nat_gateway'],
      ['aws_dynamodb_table', 'dynamodb_table'],
      ['aws_elasticache_cluster', 'elasticache_cluster'],
      ['aws_eks_cluster', 'eks_cluster'],
      // aws_ prefix stripped for unmapped
      ['aws_cloudwatch_alarm', 'cloudwatch_alarm'],
      // non-aws prefix unchanged
      ['google_compute_instance', 'google_compute_instance'],
    ];
    for (const [input, expected] of cases) {
      expect(normalizeResourceType(input)).toBe(expected);
    }
  });
});

// ─── parseTerraformFile ───────────────────────────────────────────────────────

describe('parseTerraformFile', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'korinfra-parser-test-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses aws_instance, aws_s3_bucket, aws_security_group, and module blocks', async () => {
    const hclInstance = `
resource "aws_instance" "web" {
  ami           = "ami-0abcdef1234567890"
  instance_type = "t3.micro"
  vpc_security_group_ids = ["sg-12345678"]
  subnet_id              = "subnet-0bb1c79de3EXAMPLE"
  tags = { Name = "web-server", Environment = "production" }
}
`;
    await writeFile(join(tmpDir, 'instance.tf'), hclInstance, 'utf8');
    const resources = await parseTerraformFile(join(tmpDir, 'instance.tf'));
    const instance = resources.find((r) => r.address === 'aws_instance.web');
    expect(instance).toBeDefined();
    expect(instance!.type).toBe('aws_instance');
    expect(instance!.name).toBe('web');
    expect(instance!.provider).toBe('aws');
    expect(instance!.configuration['instance_type']).toBe('t3.micro');
    expect(instance!.configuration['ami']).toBe('ami-0abcdef1234567890');

    const hclS3 = `
resource "aws_s3_bucket" "data_lake" {
  bucket = "my-company-data-lake-prod"
  tags = { Name = "data-lake", Environment = "prod" }
}
`;
    await writeFile(join(tmpDir, 's3.tf'), hclS3, 'utf8');
    const s3Resources = await parseTerraformFile(join(tmpDir, 's3.tf'));
    const bucket = s3Resources.find((r) => r.address === 'aws_s3_bucket.data_lake');
    expect(bucket).toBeDefined();
    expect(bucket!.configuration['bucket']).toBe('my-company-data-lake-prod');

    const hclSG = `
resource "aws_security_group" "web_sg" {
  name   = "web-server-sg"
  vpc_id = "vpc-0123456789abcdef0"
}
`;
    await writeFile(join(tmpDir, 'sg.tf'), hclSG, 'utf8');
    const sgResources = await parseTerraformFile(join(tmpDir, 'sg.tf'));
    const sg = sgResources.find((r) => r.address === 'aws_security_group.web_sg');
    expect(sg).toBeDefined();
    expect(sg!.configuration['name']).toBe('web-server-sg');
    expect(sg!.configuration['vpc_id']).toBe('vpc-0123456789abcdef0');

    const hclModule = `
module "network" {
  source = "terraform-aws-modules/vpc/aws"
  name   = "main-vpc"
  cidr   = "10.0.0.0/16"
}
`;
    await writeFile(join(tmpDir, 'module.tf'), hclModule, 'utf8');
    const modResources = await parseTerraformFile(join(tmpDir, 'module.tf'));
    const mod = modResources.find((r) => r.address === 'module.network');
    expect(mod).toBeDefined();
    expect(mod!.type).toBe('module');
    expect(mod!.configuration['name']).toBe('main-vpc');
  });

  it('returns empty array for malformed HCL or non-existent file — no crash', async () => {
    const badHcl = `resource "aws_instance" "broken" { this is not valid HCL syntax {{{ ami =`;
    await writeFile(join(tmpDir, 'broken.tf'), badHcl, 'utf8');
    await expect(parseTerraformFile(join(tmpDir, 'broken.tf'))).resolves.toEqual([]);
    await expect(parseTerraformFile(join(tmpDir, 'nonexistent.tf'))).resolves.toEqual([]);
  });
});

// ─── parseTerraformDir ────────────────────────────────────────────────────────

describe('parseTerraformDir', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'korinfra-dir-test-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('scans directory for all .tf files and skips .terraform hidden directories', async () => {
    await writeFile(join(tmpDir, 'main.tf'), `resource "aws_instance" "app" {\n  ami           = "ami-0abc"\n  instance_type = "t3.small"\n}\n`, 'utf8');
    await writeFile(join(tmpDir, 'vpc.tf'), `resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }\n`, 'utf8');

    // .terraform hidden dir should be skipped
    const dotTfDir = join(tmpDir, '.terraform');
    await mkdir(dotTfDir, { recursive: true });
    await writeFile(join(dotTfDir, 'providers.tf'), `resource "aws_instance" "hidden" { ami = "ami-hidden" }`, 'utf8');

    const resources = await parseTerraformDir(tmpDir);
    const types = resources.map((r) => r.type);
    expect(types).toContain('aws_instance');
    expect(types).toContain('aws_vpc');
    expect(resources.find((r) => r.name === 'hidden')).toBeUndefined();
  });
});

// ─── filterManagedTerraformResources ─────────────────────────────────────────

describe('filterManagedTerraformResources', () => {
  it('removes data sources, modules, and variable blocks', () => {
    const resources = [
      { address: 'data.aws_ami.ubuntu', type: 'aws_ami', name: 'ubuntu', provider: 'aws', module: '', filePath: 'main.tf', lineNumber: 1, configuration: {}, dependencies: [] },
      { address: 'module.network', type: 'module', name: 'network', provider: '', module: '', filePath: 'main.tf', lineNumber: 1, configuration: {}, dependencies: [] },
      { address: 'var.region', type: 'variable', name: 'region', provider: '', module: '', filePath: 'variables.tf', lineNumber: 1, configuration: {}, dependencies: [] },
      { address: 'aws_instance.web', type: 'aws_instance', name: 'web', provider: 'aws', module: '', filePath: 'main.tf', lineNumber: 10, configuration: {}, dependencies: [] },
      { address: 'aws_s3_bucket.logs', type: 'aws_s3_bucket', name: 'logs', provider: 'aws', module: '', filePath: 'main.tf', lineNumber: 20, configuration: {}, dependencies: [] },
    ];
    const filtered = filterManagedTerraformResources(resources);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((r) => r.type)).toEqual(['aws_instance', 'aws_s3_bucket']);
  });
});

// ─── filterAWSResources ───────────────────────────────────────────────────────

describe('filterAWSResources', () => {
  it('keeps only aws-provider resources', () => {
    const resources = [
      { address: 'aws_instance.web', type: 'aws_instance', name: 'web', provider: 'aws', module: '', filePath: 'main.tf', lineNumber: 1, configuration: {}, dependencies: [] },
      { address: 'google_compute_instance.vm', type: 'google_compute_instance', name: 'vm', provider: 'google', module: '', filePath: 'main.tf', lineNumber: 10, configuration: {}, dependencies: [] },
      { address: 'random_pet.name', type: 'random_pet', name: 'name', provider: 'random', module: '', filePath: 'main.tf', lineNumber: 20, configuration: {}, dependencies: [] },
    ];
    const filtered = filterAWSResources(resources);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.type).toBe('aws_instance');
  });
});

// ─── isTerraformDir ───────────────────────────────────────────────────────────

describe('isTerraformDir', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'korinfra-isTfDir-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns true for dir with .tf, false for dir without, file path, or non-existent path', async () => {
    await writeFile(join(tmpDir, 'main.tf'), `# terraform`, 'utf8');
    expect(await isTerraformDir(tmpDir)).toBe(true);

    const emptyDir = await mkdtemp(join(tmpdir(), 'korinfra-empty-'));
    try {
      expect(await isTerraformDir(emptyDir)).toBe(false);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }

    expect(await isTerraformDir(join(tmpDir, 'main.tf'))).toBe(false);
    expect(await isTerraformDir('/definitely/does/not/exist')).toBe(false);
  });
});
