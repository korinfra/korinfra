/**
 * Lambda security rules.
 * Ported from Go internal/terraform/scanner.go Lambda section.
 */

import type { SecurityRule } from './types.js';
import { containsCredentialPatterns } from './helpers.js';

const credentialKeys = [
  'aws_access_key',
  'aws_secret',
  'aws_secret_access_key',
  'access_key_id',
  'secret_access_key',
];

export const lambdaRules: SecurityRule[] = [
  {
    id: 'LAMBDA-SEC-001',
    title: 'Lambda function without dead letter queue',
    description: 'Lambda function does not have a dead letter queue configured',
    severity: 'medium',
    resourceTypes: ['aws_lambda_function'],
    evaluate: (res) => !('dead_letter_config' in res.configuration),
    recommendation: 'Configure dead_letter_config to capture failed invocations',
  },
  {
    id: 'LAMBDA-SEC-002',
    title: 'Lambda function in VPC without security group',
    description:
      'Lambda function configured with VPC but may have open network access',
    severity: 'medium',
    resourceTypes: ['aws_lambda_function'],
    evaluate: (res) => {
      const vpc = res.configuration['vpc_config'];
      if (vpc === undefined) return false;
      const vpcObj: unknown = Array.isArray(vpc) ? vpc[0] : vpc;
      if (vpcObj !== null && typeof vpcObj === 'object') {
        const sgs = (vpcObj as Record<string, unknown>)['security_group_ids'];
        return Array.isArray(sgs) && sgs.length === 0;
      }
      return false;
    },
    recommendation: 'Specify security_group_ids in vpc_config',
  },
  {
    id: 'LAM-SEC-001',
    title: 'Lambda function without VPC configuration',
    description: 'Lambda function is not configured to run inside a VPC',
    severity: 'medium',
    resourceTypes: ['aws_lambda_function'],
    evaluate: (res) => !('vpc_config' in res.configuration),
    recommendation:
      'Add vpc_config block to run Lambda in a VPC for private resource access',
  },
  {
    id: 'LAM-SEC-002',
    title: 'Lambda function with hardcoded credentials in environment variables',
    description:
      'Lambda function environment variables may contain hardcoded AWS credentials',
    severity: 'critical',
    resourceTypes: ['aws_lambda_function'],
    evaluate: (res) => {
      const envRaw = res.configuration['environment'];
      if (envRaw === undefined || envRaw === null) return false;
      // hcl2json parses nested blocks as arrays
      const envObj: unknown = Array.isArray(envRaw) ? envRaw[0] : envRaw;
      if (envObj === null || typeof envObj !== 'object') return false;
      const envMap = envObj as Record<string, unknown>;
      const vars = envMap['variables'];
      if (vars === null || typeof vars !== 'object' || Array.isArray(vars)) return false;
      const varMap = vars as Record<string, unknown>;
      for (const [k, v] of Object.entries(varMap)) {
        const kLower = k.toLowerCase();
        if (credentialKeys.some((ck) => kLower.includes(ck))) return true;
        if (typeof v === 'string' && containsCredentialPatterns(v)) return true;
      }
      return false;
    },
    recommendation:
      'Use IAM execution role instead of hardcoded credentials in environment variables',
  },
];
