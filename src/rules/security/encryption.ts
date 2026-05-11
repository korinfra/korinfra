/**
 * Encryption-at-rest security rules.
 * Ported from Go internal/terraform/scanner.go EBS, KMS, SNS, SQS, DDB, EC sections.
 */

import type { SecurityRule } from './types.js';

export const encryptionRules: SecurityRule[] = [
  {
    id: 'EBS-SEC-001',
    title: 'EBS volume not encrypted',
    description: 'EBS volume does not have encryption enabled',
    severity: 'high',
    resourceTypes: ['aws_ebs_volume'],
    evaluate: (res) => res.configuration['encrypted'] === false,
    recommendation: 'Set encrypted = true on the EBS volume',
  },
  {
    id: 'KMS-SEC-001',
    title: 'KMS key without rotation',
    description: 'KMS key does not have automatic key rotation enabled',
    severity: 'medium',
    resourceTypes: ['aws_kms_key'],
    evaluate: (res) => res.configuration['enable_key_rotation'] !== true,
    recommendation: 'Set enable_key_rotation = true',
  },
  {
    id: 'SNS-SEC-001',
    title: 'SNS topic without encryption',
    description: 'SNS topic does not have server-side encryption configured',
    severity: 'medium',
    resourceTypes: ['aws_sns_topic'],
    evaluate: (res) => !('kms_master_key_id' in res.configuration),
    recommendation: 'Set kms_master_key_id to encrypt messages at rest',
  },
  {
    id: 'SQS-SEC-001',
    title: 'SQS queue without encryption',
    description: 'SQS queue does not have server-side encryption configured',
    severity: 'medium',
    resourceTypes: ['aws_sqs_queue'],
    evaluate: (res) =>
      !('kms_master_key_id' in res.configuration) && !('sqs_managed_sse_enabled' in res.configuration),
    recommendation: 'Set kms_master_key_id or sqs_managed_sse_enabled = true',
  },
  {
    id: 'DDB-SEC-001',
    title: 'DynamoDB table without point-in-time recovery',
    description:
      'DynamoDB table does not have point-in-time recovery (PITR) enabled',
    severity: 'high',
    resourceTypes: ['aws_dynamodb_table'],
    evaluate: (res) => {
      const pitr = res.configuration['point_in_time_recovery'];
      if (pitr === undefined || pitr === null) return true;
      const pitrObj: unknown = Array.isArray(pitr) ? pitr[0] : pitr;
      if (pitrObj !== null && typeof pitrObj === 'object') {
        return (pitrObj as Record<string, unknown>)['enabled'] !== true;
      }
      return true;
    },
    recommendation: 'Enable point_in_time_recovery { enabled = true }',
  },
  {
    id: 'DDB-SEC-002',
    title: 'DynamoDB table without encryption at rest using CMK',
    description: 'DynamoDB table does not have server-side encryption configured',
    severity: 'medium',
    resourceTypes: ['aws_dynamodb_table'],
    evaluate: (res) => {
      const sse = res.configuration['server_side_encryption'];
      if (sse === undefined || sse === null) return true;
      const sseObj: unknown = Array.isArray(sse) ? sse[0] : sse;
      if (sseObj !== null && typeof sseObj === 'object') {
        return (sseObj as Record<string, unknown>)['enabled'] !== true;
      }
      return true;
    },
    recommendation:
      'Add server_side_encryption { enabled = true } with optional kms_key_arn',
  },
  {
    id: 'EC-SEC-001',
    title: 'ElastiCache replication group without encryption in transit',
    description:
      'ElastiCache replication group does not have TLS encryption in transit enabled',
    severity: 'high',
    resourceTypes: ['aws_elasticache_replication_group'],
    evaluate: (res) => res.configuration['transit_encryption_enabled'] !== true,
    recommendation: 'Set transit_encryption_enabled = true',
  },
  {
    id: 'EC-SEC-002',
    title: 'ElastiCache replication group without encryption at rest',
    description:
      'ElastiCache replication group does not have encryption at rest enabled',
    severity: 'high',
    resourceTypes: ['aws_elasticache_replication_group'],
    evaluate: (res) => res.configuration['at_rest_encryption_enabled'] !== true,
    recommendation: 'Set at_rest_encryption_enabled = true',
  },
  {
    id: 'SM-SEC-001',
    title: 'Secrets Manager secret without customer-managed KMS key',
    description:
      'aws_secretsmanager_secret does not specify kms_key_id — the secret is encrypted with the AWS managed default key which cannot have a custom key policy or be audited separately',
    severity: 'medium',
    resourceTypes: ['aws_secretsmanager_secret'],
    evaluate: (res) => !res.configuration['kms_key_id'],
    recommendation:
      'Set kms_key_id to a customer-managed KMS key ARN for granular access control and auditability',
  },
];
