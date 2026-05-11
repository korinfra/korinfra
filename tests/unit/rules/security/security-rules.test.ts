import { describe, it, expect } from 'vitest';
import { ec2Rules } from '../../../../src/rules/security/ec2.js';
import { iamRules } from '../../../../src/rules/security/iam.js';
import { rdsRules } from '../../../../src/rules/security/rds.js';
import { s3Rules } from '../../../../src/rules/security/s3.js';
import { lambdaRules } from '../../../../src/rules/security/lambda.js';
import { networkRules } from '../../../../src/rules/security/network.js';
import { encryptionRules } from '../../../../src/rules/security/encryption.js';
import { miscRules } from '../../../../src/rules/security/misc.js';
import { evaluateSecurityRules, allSecurityRules, securityRuleCount } from '../../../../src/rules/security/index.js';
import type { TfResource } from '../../../../src/rules/security/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTf(
  type: string,
  configuration: Record<string, unknown>,
  overrides: Partial<TfResource> = {},
): TfResource {
  return {
    address: `${type}.test`,
    type,
    name: 'test',
    provider: 'aws',
    module: '',
    filePath: '/terraform/main.tf',
    lineNumber: 1,
    configuration,
    dependencies: [],
    ...overrides,
  };
}

function findRule(rules: typeof ec2Rules, id: string) {
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new Error(`Rule ${id} not found`);
  return rule;
}

// ─── EC2 Security Rules ───────────────────────────────────────────────────────

describe('SG-SEC-001 — ingress open to 0.0.0.0/0', () => {
  const rule = findRule(ec2Rules, 'SG-SEC-001');

  it('fires for open ingress (0.0.0.0/0 or ::/0), does not fire for restricted or egress rules', () => {
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 0, to_port: 65535, protocol: '-1', cidr_blocks: ['0.0.0.0/0'] }] }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 443, to_port: 443, protocol: 'tcp', ipv6_cidr_blocks: ['::/0'] }] }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_security_group_rule', { type: 'ingress', from_port: 80, to_port: 80, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] }))).toBe(true);
    // restricted CIDRs — no fire
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['10.0.0.0/8'] }] }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 80, to_port: 80, protocol: 'tcp', cidr_blocks: ['192.168.1.0/16'] }] }))).toBe(false);
    // egress type — no fire
    expect(rule.evaluate(makeTf('aws_security_group_rule', { type: 'egress', from_port: 0, to_port: 65535, protocol: '-1', cidr_blocks: ['0.0.0.0/0'] }))).toBe(false);
  });
});

describe('SG-SEC-002 — SSH (port 22) open to 0.0.0.0/0', () => {
  const rule = findRule(ec2Rules, 'SG-SEC-002');

  it('fires for port 22 open to internet (IPv4/IPv6), does not fire for restricted SSH or other ports', () => {
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 22, to_port: 22, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] }] }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 0, to_port: 65535, protocol: '-1', cidr_blocks: ['0.0.0.0/0'] }] }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 22, to_port: 22, protocol: 'tcp', ipv6_cidr_blocks: ['::/0'] }] }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 22, to_port: 22, protocol: 'tcp', cidr_blocks: ['203.0.113.5/32'] }] }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] }] }))).toBe(false);
  });
});

describe('SG-SEC-003 — RDP (port 3389) open to 0.0.0.0/0', () => {
  const rule = findRule(ec2Rules, 'SG-SEC-003');

  it('fires for port 3389 open to internet, does not fire for restricted or unrelated ports', () => {
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 3389, to_port: 3389, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] }] }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 3000, to_port: 4000, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] }] }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 3389, to_port: 3389, protocol: 'tcp', cidr_blocks: ['10.8.0.0/16'] }] }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_security_group', { ingress: [{ from_port: 80, to_port: 80, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] }] }))).toBe(false);
  });
});

describe('protocol -1 (all traffic) — SG-SEC-002 and SG-SEC-003', () => {
  const sshRule = findRule(ec2Rules, 'SG-SEC-002');
  const rdpRule = findRule(ec2Rules, 'SG-SEC-003');

  it('aws_security_group with protocol -1 and open CIDR triggers SSH and RDP rules', () => {
    const cfg = makeTf('aws_security_group', {
      ingress: [{ protocol: '-1', cidr_blocks: ['0.0.0.0/0'] }],
    });
    expect(sshRule.evaluate(cfg)).toBe(true);
    expect(rdpRule.evaluate(cfg)).toBe(true);
  });

  it('aws_security_group_rule ingress with protocol -1, open CIDR, no from_port/to_port triggers SSH and RDP rules', () => {
    const cfg = makeTf('aws_security_group_rule', {
      type: 'ingress',
      protocol: '-1',
      cidr_blocks: ['0.0.0.0/0'],
    });
    expect(sshRule.evaluate(cfg)).toBe(true);
    expect(rdpRule.evaluate(cfg)).toBe(true);
  });

  it('protocol -1 with restricted CIDR does not trigger SSH or RDP rules', () => {
    const cfg = makeTf('aws_security_group_rule', {
      type: 'ingress',
      protocol: '-1',
      cidr_blocks: ['10.0.0.0/8'],
    });
    expect(sshRule.evaluate(cfg)).toBe(false);
    expect(rdpRule.evaluate(cfg)).toBe(false);
  });
});

describe('EC2-SEC-002 — hardcoded credentials in user_data', () => {
  const rule = findRule(ec2Rules, 'EC2-SEC-002');

  it('fires for AKIA keys, secret patterns, valid ASIA keys, and password= in user_data', () => {
    expect(rule.evaluate(makeTf('aws_instance', { user_data: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nexport AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_instance', { user_data: 'echo "aws_secret_access_key=mysecret" >> /etc/environment' }))).toBe(true);
    // ASIA + exactly 16 uppercase alphanumeric chars = valid STS key
    expect(rule.evaluate(makeTf('aws_instance', { user_data: 'export TEMP_KEY=ASIAJ3HRXVF2ABCDEF12' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_instance', { user_data: 'echo password=supersecret123 | sudo chpasswd' }))).toBe(true);
  });

  it('does not fire for clean user_data, region names with "asia", or absent user_data', () => {
    expect(rule.evaluate(makeTf('aws_instance', { user_data: '#!/bin/bash\nyum update -y\naws s3 cp s3://mybucket/config.json /etc/myapp/config.json' }))).toBe(false);
    // "asia-pacific" should NOT match ASIA key pattern
    expect(rule.evaluate(makeTf('aws_instance', { user_data: '#!/bin/bash\n# Deploy to asia-pacific region\naws configure set region ap-southeast-1' }))).toBe(false);
    // ASIAIOSFODNN7EXAMP has only 14 chars after ASIA
    expect(rule.evaluate(makeTf('aws_instance', { user_data: 'export TEMP_KEY=ASIAIOSFODNN7EXAMP' }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_instance', { instance_type: 't3.micro' }))).toBe(false);
  });
});

describe('EC2-SEC-001 — EC2 instance without IMDSv2', () => {
  const rule = ec2Rules.find((r) => r.id === 'EC2-SEC-001')!;

  it('fires when metadata_options absent or http_tokens=optional, does not fire when required or null vpc_config', () => {
    expect(rule.evaluate(makeTf('aws_instance', { instance_type: 't3.micro', ami: 'ami-12345678' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_instance', { metadata_options: { http_tokens: 'optional', http_endpoint: 'enabled' } }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_instance', { metadata_options: null }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_instance', { metadata_options: { http_tokens: 'required', http_endpoint: 'enabled' } }))).toBe(false);
  });
});

describe('SG-SEC-004 — Security group allows all egress', () => {
  const rule = ec2Rules.find((r) => r.id === 'SG-SEC-004')!;

  it('fires for unrestricted egress (0.0.0.0/0 or ::/0), does not fire for restricted or absent egress', () => {
    expect(rule.evaluate(makeTf('aws_security_group', { egress: [{ from_port: 0, to_port: 0, protocol: '-1', cidr_blocks: ['0.0.0.0/0'] }] }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_security_group', { egress: [{ from_port: 0, to_port: 0, protocol: '-1', ipv6_cidr_blocks: ['::/0'] }] }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_security_group', { egress: [{ from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['10.0.0.0/8'] }] }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_security_group', { name: 'my-sg' }))).toBe(false);
  });
});

describe('hasOpenCIDR — plain-object ingress/egress branch', () => {
  const sgSec001 = findRule(ec2Rules, 'SG-SEC-001');
  const sgSec004 = ec2Rules.find((r) => r.id === 'SG-SEC-004')!;

  it('fires when ingress is a single object (not array) with open CIDR', () => {
    expect(
      sgSec001.evaluate(
        makeTf('aws_security_group', {
          ingress: { from_port: 80, to_port: 80, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] },
        }),
      ),
    ).toBe(true);
  });

  it('does not fire when ingress plain-object has restricted CIDR', () => {
    expect(
      sgSec001.evaluate(
        makeTf('aws_security_group', {
          ingress: { from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['10.0.0.0/8'] },
        }),
      ),
    ).toBe(false);
  });

  it('fires when egress is a single object (not array) with open CIDR', () => {
    expect(
      sgSec004.evaluate(
        makeTf('aws_security_group', {
          egress: { from_port: 0, to_port: 0, protocol: '-1', cidr_blocks: ['0.0.0.0/0'] },
        }),
      ),
    ).toBe(true);
  });
});

describe('hasOpenPort — plain-object ingress branch (aws_security_group_rule flat format)', () => {
  const sgSec002 = findRule(ec2Rules, 'SG-SEC-002');

  it('fires when ingress is a single object (not array) exposing port 22', () => {
    expect(
      sgSec002.evaluate(
        makeTf('aws_security_group', {
          ingress: { from_port: 22, to_port: 22, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] },
        }),
      ),
    ).toBe(true);
  });

  it('fires for aws_security_group_rule with type=ingress, SSH port, open CIDR (flat format)', () => {
    expect(
      sgSec002.evaluate(
        makeTf('aws_security_group_rule', {
          type: 'ingress',
          from_port: 22,
          to_port: 22,
          protocol: 'tcp',
          cidr_blocks: ['0.0.0.0/0'],
        }),
      ),
    ).toBe(true);
  });

  it('fires for aws_security_group_rule with type=ingress, protocol=-1, open CIDR, no from_port/to_port', () => {
    expect(
      sgSec002.evaluate(
        makeTf('aws_security_group_rule', {
          type: 'ingress',
          protocol: '-1',
          cidr_blocks: ['0.0.0.0/0'],
        }),
      ),
    ).toBe(true);
  });
});

describe('containsCredentialPatterns — ASIA regex path', () => {
  const rule = findRule(ec2Rules, 'EC2-SEC-002');

  it('fires for a valid ASIA STS key (exactly 16 uppercase alphanumeric after ASIA)', () => {
    expect(
      rule.evaluate(
        makeTf('aws_instance', { user_data: 'export TEMP_KEY=ASIAZ3HRXVF2ABCDEF12' }),
      ),
    ).toBe(true);
  });

  it('does not fire for "asia" as part of a region name (lowercase, no word boundary match)', () => {
    expect(
      rule.evaluate(
        makeTf('aws_instance', { user_data: '#!/bin/bash\n# Deploy to asia-pacific\necho done' }),
      ),
    ).toBe(false);
  });
});

describe('EC2-SEC-004 — EC2 instance uses deprecated instance type', () => {
  const rule = miscRules.find((r) => r.id === 'EC2-SEC-004')!;

  it('fires for t2/m1/c4/r4 instance types, does not fire for t3/m5 or absent type', () => {
    for (const type of ['t2.micro', 'm1.small', 'c4.large', 'r4.xlarge']) {
      expect(rule.evaluate(makeTf('aws_instance', { instance_type: type })), `expected ${type} to fire`).toBe(true);
    }
    expect(rule.evaluate(makeTf('aws_instance', { instance_type: 't3.micro' }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_instance', { instance_type: 'm5.large' }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_instance', { ami: 'ami-12345678' }))).toBe(false);
  });
});

// ─── IAM Rules ────────────────────────────────────────────────────────────────

describe('IAM-SEC-001 — wildcard actions in IAM policy', () => {
  const rule = findRule(iamRules, 'IAM-SEC-001');

  it('fires for Action: "*" (string or array, single or multi-statement), does not fire for specific actions', () => {
    expect(rule.evaluate(makeTf('aws_iam_policy', { policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] }) }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_iam_policy', { policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['*'], Resource: '*' }] }) }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_iam_role_policy', { policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }, { Effect: 'Allow', Action: '*', Resource: '*' }] }) }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_iam_policy', { policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: '*' }] }) }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_iam_policy', { policy: { Statement: [{ Action: '*' }] } }))).toBe(false); // non-string policy
    expect(rule.evaluate(makeTf('aws_iam_user_policy', { policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['ec2:Describe*', 'cloudwatch:Get*'], Resource: '*' }] }) }))).toBe(false);
  });
});

describe('IAM-SEC-002 — wildcard resources in IAM policy', () => {
  const rule = findRule(iamRules, 'IAM-SEC-002');

  it('fires for Resource: "*" (string or in array), does not fire for specific ARNs', () => {
    expect(rule.evaluate(makeTf('aws_iam_policy', { policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }] }) }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_iam_policy', { policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 's3:DeleteBucket', Resource: ['arn:aws:s3:::my-bucket', '*'] }] }) }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_iam_policy', { policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: 'arn:aws:s3:::my-data-bucket/*' }] }) }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_iam_role_policy', { policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 'dynamodb:GetItem', Resource: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table' }] }) }))).toBe(false);
  });
});

// ─── RDS Rules ────────────────────────────────────────────────────────────────

describe('RDS security rules — public access, encryption, backups', () => {
  it('RDS-SEC-001 fires when publicly_accessible=true, does not fire otherwise', () => {
    const rule = findRule(rdsRules, 'RDS-SEC-001');
    expect(rule.evaluate(makeTf('aws_db_instance', { publicly_accessible: true }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_db_instance', { publicly_accessible: false }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_db_instance', { identifier: 'prod-mysql' }))).toBe(false);
  });

  it('RDS-SEC-002 fires when storage_encrypted=false, does not fire for true or absent', () => {
    const rule = findRule(rdsRules, 'RDS-SEC-002');
    expect(rule.evaluate(makeTf('aws_db_instance', { storage_encrypted: false }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_db_instance', { storage_encrypted: true }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_db_instance', { identifier: 'legacy-db' }))).toBe(false);
  });

  it('RDS-SEC-003 fires when backup_retention_period=0 or absent, does not fire when >= 1', () => {
    const rule = findRule(rdsRules, 'RDS-SEC-003');
    expect(rule.evaluate(makeTf('aws_db_instance', { backup_retention_period: 0 }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_db_instance', { identifier: 'no-backup-config' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_db_instance', { backup_retention_period: 7 }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_db_instance', { backup_retention_period: 35 }))).toBe(false);
  });
});

// ─── S3 Rules ─────────────────────────────────────────────────────────────────

describe('S3 security rules — public ACL, encryption, versioning, logging', () => {
  it('S3-SEC-001 fires for public ACL values, does not fire for private/authenticated-read/absent', () => {
    const rule = findRule(s3Rules, 'S3-SEC-001');
    expect(rule.evaluate(makeTf('aws_s3_bucket', { acl: 'public-read' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_s3_bucket', { acl: 'public-read-write' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_s3_bucket', { acl: 'private' }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_s3_bucket', { acl: 'authenticated-read' }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_s3_bucket', { bucket: 'no-acl' }))).toBe(false);
  });

  it('S3-SEC-002 fires when SSE absent, does not fire for AES256 or aws:kms', () => {
    const rule = findRule(s3Rules, 'S3-SEC-002');
    expect(rule.evaluate(makeTf('aws_s3_bucket', { bucket: 'unencrypted' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_s3_bucket', { server_side_encryption_configuration: { rule: { apply_server_side_encryption_by_default: { sse_algorithm: 'AES256' } } } }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_s3_bucket', { server_side_encryption_configuration: { rule: { apply_server_side_encryption_by_default: { sse_algorithm: 'aws:kms' } } } }))).toBe(false);
  });

  it('S3-SEC-003 fires when versioning absent or disabled, does not fire when enabled', () => {
    const rule = findRule(s3Rules, 'S3-SEC-003');
    expect(rule.evaluate(makeTf('aws_s3_bucket', { bucket: 'no-versioning' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_s3_bucket', { versioning: { enabled: false } }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_s3_bucket', { versioning: { enabled: true } }))).toBe(false);
  });

  it('S3-SEC-004 fires when logging absent, does not fire when logging configured', () => {
    const rule = s3Rules.find((r) => r.id === 'S3-SEC-004')!;
    expect(rule.evaluate(makeTf('aws_s3_bucket', { bucket: 'my-bucket' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_s3_bucket', { logging: { target_bucket: 'my-log-bucket', target_prefix: 'access-logs/' } }))).toBe(false);
  });
});

// ─── Lambda Rules ─────────────────────────────────────────────────────────────

describe('Lambda security rules — VPC, DLQ, hardcoded credentials, SG', () => {
  it('LAM-SEC-001 fires when vpc_config absent, does not fire when vpc_config present', () => {
    const rule = findRule(lambdaRules, 'LAM-SEC-001');
    expect(rule.evaluate(makeTf('aws_lambda_function', { function_name: 'my-api-handler', runtime: 'nodejs20.x' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_lambda_function', { vpc_config: { subnet_ids: ['subnet-abc'], security_group_ids: ['sg-12345678'] } }))).toBe(false);
  });

  it('LAMBDA-SEC-001 fires when DLQ absent, does not fire when present', () => {
    const rule = lambdaRules.find((r) => r.id === 'LAMBDA-SEC-001')!;
    expect(rule.evaluate(makeTf('aws_lambda_function', { function_name: 'my-func', runtime: 'nodejs20.x' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_lambda_function', { dead_letter_config: {} }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_lambda_function', { dead_letter_config: { target_arn: 'arn:aws:sqs:us-east-1:123456789012:my-dlq' } }))).toBe(false);
  });

  it('LAMBDA-SEC-002 fires when VPC but no security group, does not fire when SGs present or no VPC', () => {
    const rule = lambdaRules.find((r) => r.id === 'LAMBDA-SEC-002')!;
    expect(rule.evaluate(makeTf('aws_lambda_function', { vpc_config: { subnet_ids: ['subnet-abc'], security_group_ids: [] } }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_lambda_function', { vpc_config: { subnet_ids: ['subnet-abc'], security_group_ids: ['sg-12345678'] } }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_lambda_function', { function_name: 'no-vpc' }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_lambda_function', { vpc_config: 'invalid' }))).toBe(false);
  });

  it('LAM-SEC-002 fires for credential patterns in env vars, does not fire for safe vars or absent env', () => {
    const rule = lambdaRules.find((r) => r.id === 'LAM-SEC-002')!;
    expect(rule.evaluate(makeTf('aws_lambda_function', { environment: { variables: { AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI' } } }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_lambda_function', { environment: { variables: { ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE' } } }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_lambda_function', { environment: { variables: { CONFIG: 'aws_access_key_id=AKIAIOSFODNN7EXAMPLE' } } }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_lambda_function', { environment: { variables: { DB_URL: 'postgres://admin:password=secret@localhost/mydb' } } }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_lambda_function', { environment: { variables: { REGION: 'us-east-1', LOG_LEVEL: 'info' } } }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_lambda_function', { function_name: 'no-env' }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_lambda_function', { environment: {} }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_lambda_function', { environment: null }))).toBe(false);
  });
});

// ─── Network Rules ────────────────────────────────────────────────────────────

describe('Network security rules — VPC flow logs, subnet public IP', () => {
  it('NET-SEC-001 fires when flow logs absent or disabled, does not fire when enabled', () => {
    const rule = findRule(networkRules, 'NET-SEC-001');
    expect(rule.evaluate(makeTf('aws_vpc', { cidr_block: '10.0.0.0/16' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_vpc', { flow_log_enabled: false }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_vpc', { flow_log_enabled: true }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_vpc', { has_flow_log: true }))).toBe(false);
  });

  it('NET-SEC-002 fires when map_public_ip_on_launch=true, does not fire for false or absent', () => {
    const rule = networkRules.find((r) => r.id === 'NET-SEC-002')!;
    expect(rule.evaluate(makeTf('aws_subnet', { vpc_id: 'vpc-abc', cidr_block: '10.0.1.0/24', map_public_ip_on_launch: true }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_subnet', { vpc_id: 'vpc-abc', map_public_ip_on_launch: false }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_subnet', { vpc_id: 'vpc-abc', cidr_block: '10.0.3.0/24' }))).toBe(false);
  });
});

// ─── Encryption Rules ─────────────────────────────────────────────────────────

describe('Encryption security rules — KMS, SNS, SQS, EBS, DynamoDB, ElastiCache', () => {
  it('KMS-SEC-001 fires when key rotation absent or disabled, does not fire when enabled', () => {
    const rule = findRule(encryptionRules, 'KMS-SEC-001');
    expect(rule.evaluate(makeTf('aws_kms_key', { enable_key_rotation: false }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_kms_key', { description: 'S3 encryption key' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_kms_key', { enable_key_rotation: true }))).toBe(false);
  });

  it('SNS-SEC-001 fires when kms_master_key_id absent, does not fire when set', () => {
    const rule = findRule(encryptionRules, 'SNS-SEC-001');
    expect(rule.evaluate(makeTf('aws_sns_topic', { name: 'order-events' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_sns_topic', { kms_master_key_id: 'arn:aws:kms:us-east-1:123456789012:key/mrk-abc123' }))).toBe(false);
  });

  it('SQS-SEC-001 fires when no encryption configured, does not fire for KMS or managed SSE', () => {
    const rule = findRule(encryptionRules, 'SQS-SEC-001');
    expect(rule.evaluate(makeTf('aws_sqs_queue', { name: 'job-queue' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_sqs_queue', { kms_master_key_id: 'arn:aws:kms:us-east-1:123456789012:key/abc' }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_sqs_queue', { sqs_managed_sse_enabled: true }))).toBe(false);
  });

  it('EBS-SEC-001 fires when encrypted=false, does not fire for true or absent field', () => {
    const rule = encryptionRules.find((r) => r.id === 'EBS-SEC-001')!;
    expect(rule.evaluate(makeTf('aws_ebs_volume', { encrypted: false }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_ebs_volume', { encrypted: true }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_ebs_volume', { size: 100 }))).toBe(false);
  });

  it('DDB-SEC-001/002 fire when PITR/SSE absent, disabled, or null', () => {
    const pitr = encryptionRules.find((r) => r.id === 'DDB-SEC-001')!;
    expect(pitr.evaluate(makeTf('aws_dynamodb_table', { name: 'orders' }))).toBe(true);
    expect(pitr.evaluate(makeTf('aws_dynamodb_table', { point_in_time_recovery: { enabled: false } }))).toBe(true);
    expect(pitr.evaluate(makeTf('aws_dynamodb_table', { point_in_time_recovery: null }))).toBe(true);
    expect(pitr.evaluate(makeTf('aws_dynamodb_table', { point_in_time_recovery: { enabled: true } }))).toBe(false);

    const sse = encryptionRules.find((r) => r.id === 'DDB-SEC-002')!;
    expect(sse.evaluate(makeTf('aws_dynamodb_table', { name: 'sessions' }))).toBe(true);
    expect(sse.evaluate(makeTf('aws_dynamodb_table', { server_side_encryption: { enabled: false } }))).toBe(true);
    expect(sse.evaluate(makeTf('aws_dynamodb_table', { server_side_encryption: null }))).toBe(true);
    expect(sse.evaluate(makeTf('aws_dynamodb_table', { server_side_encryption: { enabled: true } }))).toBe(false);
  });

  it('EC-SEC-001/002 fire when ElastiCache transit/rest encryption absent or disabled', () => {
    const transit = encryptionRules.find((r) => r.id === 'EC-SEC-001')!;
    expect(transit.evaluate(makeTf('aws_elasticache_replication_group', { transit_encryption_enabled: false }))).toBe(true);
    expect(transit.evaluate(makeTf('aws_elasticache_replication_group', { replication_group_id: 'my-redis' }))).toBe(true);
    expect(transit.evaluate(makeTf('aws_elasticache_replication_group', { transit_encryption_enabled: true }))).toBe(false);

    const rest = encryptionRules.find((r) => r.id === 'EC-SEC-002')!;
    expect(rest.evaluate(makeTf('aws_elasticache_replication_group', { at_rest_encryption_enabled: false }))).toBe(true);
    expect(rest.evaluate(makeTf('aws_elasticache_replication_group', { replication_group_id: 'my-redis' }))).toBe(true);
    expect(rest.evaluate(makeTf('aws_elasticache_replication_group', { at_rest_encryption_enabled: true }))).toBe(false);
  });
});

// ─── Misc Rules ───────────────────────────────────────────────────────────────

describe('Misc security rules — ECS, EKS, CloudWatch, LB, tags', () => {
  it('ECS-SEC-001 fires when readonlyRootFilesystem absent or false, does not fire when all true', () => {
    const rule = findRule(miscRules, 'ECS-SEC-001');
    const falseFs = JSON.stringify([{ name: 'web', readonlyRootFilesystem: false }]);
    const trueFs = JSON.stringify([{ name: 'api', readonlyRootFilesystem: true }, { name: 'metrics', readonlyRootFilesystem: true }]);
    const mixed = JSON.stringify([{ name: 'app', readonlyRootFilesystem: true }, { name: 'sidecar', readonlyRootFilesystem: false }]);
    expect(rule.evaluate(makeTf('aws_ecs_task_definition', { container_definitions: falseFs }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_ecs_task_definition', { container_definitions: mixed }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_ecs_task_definition', { family: 'my-task' }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_ecs_task_definition', { container_definitions: trueFs }))).toBe(false);
  });

  it('EKS-SEC-001 fires when endpoint_public_access=true, does not fire when false or vpc_config absent', () => {
    const rule = findRule(miscRules, 'EKS-SEC-001');
    expect(rule.evaluate(makeTf('aws_eks_cluster', { vpc_config: { endpoint_public_access: true, endpoint_private_access: false } }))).toBe(true);
    expect(rule.evaluate(makeTf('aws_eks_cluster', { vpc_config: { endpoint_public_access: false, endpoint_private_access: true } }))).toBe(false);
    expect(rule.evaluate(makeTf('aws_eks_cluster', { name: 'no-vpc-config' }))).toBe(false);
  });

  it('CW-SEC-001/002 fire for missing KMS key and missing/zero retention', () => {
    const cwEnc = miscRules.find((r) => r.id === 'CW-SEC-001')!;
    expect(cwEnc.evaluate(makeTf('aws_cloudwatch_log_group', { name: '/aws/lambda/my-func' }))).toBe(true);
    expect(cwEnc.evaluate(makeTf('aws_cloudwatch_log_group', { kms_key_id: 'arn:aws:kms:us-east-1:123456789012:key/abc-def' }))).toBe(false);

    const cwRet = miscRules.find((r) => r.id === 'CW-SEC-002')!;
    expect(cwRet.evaluate(makeTf('aws_cloudwatch_log_group', { name: '/my/logs' }))).toBe(true);
    expect(cwRet.evaluate(makeTf('aws_cloudwatch_log_group', { retention_in_days: 0 }))).toBe(true);
    expect(cwRet.evaluate(makeTf('aws_cloudwatch_log_group', { retention_in_days: 90 }))).toBe(false);
    expect(cwRet.evaluate(makeTf('aws_cloudwatch_log_group', { retention_in_days: 365 }))).toBe(false);
  });

  it('LB-SEC-001/002 fire for missing access logs and HTTP protocol', () => {
    const lbLog = miscRules.find((r) => r.id === 'LB-SEC-001')!;
    expect(lbLog.evaluate(makeTf('aws_lb', { name: 'my-alb' }))).toBe(true);
    expect(lbLog.evaluate(makeTf('aws_lb', { access_logs: { enabled: false, bucket: 'my-logs' } }))).toBe(true);
    expect(lbLog.evaluate(makeTf('aws_lb', { access_logs: { enabled: true, bucket: 'my-logs', prefix: 'alb/' } }))).toBe(false);
    expect(lbLog.evaluate(makeTf('aws_alb', { name: 'my-alb' }))).toBe(true);

    const lbHttp = miscRules.find((r) => r.id === 'LB-SEC-002')!;
    expect(lbHttp.evaluate(makeTf('aws_lb_listener', { port: 80, protocol: 'HTTP' }))).toBe(true);
    expect(lbHttp.evaluate(makeTf('aws_lb_listener', { port: 80, protocol: 'http' }))).toBe(true);
    expect(lbHttp.evaluate(makeTf('aws_lb_listener', { port: 443, protocol: 'HTTPS' }))).toBe(false);
    expect(lbHttp.evaluate(makeTf('aws_alb_listener', { port: 443, protocol: 'HTTPS' }))).toBe(false);
    expect(lbHttp.evaluate(makeTf('aws_lb_listener', { port: 443 }))).toBe(false);
  });

  it('TAG-SEC-001 fires when Environment/Team/Project tags missing; GEN-SEC-001 fires when tags absent', () => {
    const tagSec = miscRules.find((r) => r.id === 'TAG-SEC-001')!;
    expect(tagSec.evaluate(makeTf('aws_instance', { instance_type: 't3.micro' }))).toBe(true);
    expect(tagSec.evaluate(makeTf('aws_instance', { tags: { Environment: 'prod' } }))).toBe(true); // missing Team + Project
    expect(tagSec.evaluate(makeTf('aws_instance', { tags: { Environment: 'prod', Team: 'platform' } }))).toBe(true); // missing Project
    expect(tagSec.evaluate(makeTf('aws_instance', { tags: { Environment: 'prod', Team: 'platform', Project: 'web' } }))).toBe(false);
    expect(tagSec.evaluate(makeTf('aws_instance', { tags: null }))).toBe(true);

    const genSec = miscRules.find((r) => r.id === 'GEN-SEC-001')!;
    expect(genSec.evaluate(makeTf('aws_instance', { instance_type: 't3.micro' }))).toBe(true);
    expect(genSec.evaluate(makeTf('aws_lambda_function', { function_name: 'my-func' }))).toBe(true);
    expect(genSec.evaluate(makeTf('aws_instance', { tags: {} }))).toBe(false);
    expect(genSec.evaluate(makeTf('aws_s3_bucket', { tags: { Name: 'my-bucket' } }))).toBe(false);
  });
});

// ─── evaluateSecurityRules integration ───────────────────────────────────────

describe('evaluateSecurityRules — integration', () => {
  it('handles empty input, multi-violation resources, type filtering, and compliant resources', () => {
    expect(evaluateSecurityRules([])).toEqual([]);

    // S3 with public ACL — multiple findings
    const badBucket = [makeTf('aws_s3_bucket', { bucket: 'bad-bucket', acl: 'public-read' })];
    const bucketFindings = evaluateSecurityRules(badBucket);
    expect(bucketFindings.map((f) => f.ruleId)).toContain('S3-SEC-001');
    expect(bucketFindings.length).toBeGreaterThan(1);

    // EC2 without IMDSv2
    const ec2Findings = evaluateSecurityRules([makeTf('aws_instance', { instance_type: 't3.micro', ami: 'ami-12345678' })]);
    expect(ec2Findings.map((f) => f.ruleId)).toContain('EC2-SEC-001');

    // VPC — S3 rules must not apply, NET-SEC-001 must apply
    const vpcFindings = evaluateSecurityRules([makeTf('aws_vpc', { cidr_block: '10.0.0.0/16' })]);
    expect(vpcFindings.map((f) => f.ruleId).some((id) => id.startsWith('S3-'))).toBe(false);
    expect(vpcFindings.map((f) => f.ruleId)).toContain('NET-SEC-001');

    // Fully compliant KMS key — no findings
    expect(evaluateSecurityRules([makeTf('aws_kms_key', { description: 'Compliant key', enable_key_rotation: true })])).toHaveLength(0);
  });

  it('populates all SecurityFinding fields correctly', () => {
    const findings = evaluateSecurityRules([makeTf('aws_s3_bucket', { bucket: 'unencrypted' })]);
    const s3Enc = findings.find((f) => f.ruleId === 'S3-SEC-002');
    expect(s3Enc).toBeDefined();
    expect(s3Enc!.severity).toBe('high');
    expect(s3Enc!.resource).toBe('aws_s3_bucket.test');
    expect(typeof s3Enc!.title).toBe('string');
    expect(typeof s3Enc!.description).toBe('string');
    expect(typeof s3Enc!.recommendation).toBe('string');
  });
});

// ─── allSecurityRules and securityRuleCount ───────────────────────────────────

describe('allSecurityRules and securityRuleCount', () => {
  it('has non-empty rule array, count matches, all rules have required fields and unique IDs', () => {
    expect(Array.isArray(allSecurityRules)).toBe(true);
    expect(allSecurityRules.length).toBeGreaterThan(0);
    expect(securityRuleCount()).toBe(allSecurityRules.length);

    for (const rule of allSecurityRules) {
      expect(typeof rule.id).toBe('string');
      expect(rule.id.length).toBeGreaterThan(0);
      expect(typeof rule.title).toBe('string');
      expect(['critical', 'high', 'medium', 'low']).toContain(rule.severity);
      expect(Array.isArray(rule.resourceTypes)).toBe(true);
      expect(rule.resourceTypes.length).toBeGreaterThan(0);
      expect(typeof rule.evaluate).toBe('function');
      expect(typeof rule.recommendation).toBe('string');
    }

    const ids = allSecurityRules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
