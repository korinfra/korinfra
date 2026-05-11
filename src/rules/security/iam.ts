/**
 * IAM security rules.
 * Ported from Go internal/terraform/scanner.go IAM section.
 */

import type { SecurityRule } from './types.js';

export const iamRules: SecurityRule[] = [
  {
    id: 'IAM-SEC-001',
    title: 'IAM policy with wildcard actions',
    description: 'IAM policy allows all actions (*) which is overly permissive',
    severity: 'critical',
    resourceTypes: ['aws_iam_policy', 'aws_iam_role_policy', 'aws_iam_user_policy', 'aws_iam_group_policy'],
    evaluate: (res) => {
      const policy = res.configuration['policy'];
      if (typeof policy !== 'string') return false;
      try {
        const doc = JSON.parse(policy) as Record<string, unknown>;
        const stmts = Array.isArray(doc['Statement']) ? doc['Statement'] : [doc['Statement']];
        return stmts.some((s: unknown) => {
          if (s === null || typeof s !== 'object') return false;
          const stmt = s as Record<string, unknown>;
          const actions = Array.isArray(stmt['Action']) ? stmt['Action'] : [stmt['Action']];
          return actions.includes('*');
        });
      } catch {
        return false;
      }
    },
    recommendation:
      'Follow the principle of least privilege; specify only required actions',
  },
  {
    id: 'IAM-SEC-002',
    title: 'IAM policy with wildcard resources',
    description: 'IAM policy applies to all resources (*) which is overly permissive',
    severity: 'high',
    resourceTypes: ['aws_iam_policy', 'aws_iam_role_policy', 'aws_iam_user_policy', 'aws_iam_group_policy'],
    evaluate: (res) => {
      const policy = res.configuration['policy'];
      if (typeof policy !== 'string') return false;
      try {
        const doc = JSON.parse(policy) as Record<string, unknown>;
        const stmts = Array.isArray(doc['Statement']) ? doc['Statement'] : [doc['Statement']];
        return stmts.some((s: unknown) => {
          if (s === null || typeof s !== 'object') return false;
          const stmt = s as Record<string, unknown>;
          const resources = Array.isArray(stmt['Resource']) ? stmt['Resource'] : [stmt['Resource']];
          return resources.includes('*');
        });
      } catch {
        return false;
      }
    },
    recommendation: 'Scope resources to specific ARN patterns',
  },
  {
    id: 'IAM-SEC-003',
    title: 'IAM role with wildcard Principal in trust policy',
    description: 'IAM role trust policy allows any principal (*) to assume the role',
    severity: 'critical',
    resourceTypes: ['aws_iam_role'],
    evaluate: (res) => {
      const policy = res.configuration['assume_role_policy'];
      if (typeof policy !== 'string') return false;
      try {
        const doc = JSON.parse(policy) as Record<string, unknown>;
        const stmts = Array.isArray(doc['Statement']) ? doc['Statement'] : [doc['Statement']];
        return stmts.some((s: unknown) => {
          if (s === null || typeof s !== 'object') return false;
          const stmt = s as Record<string, unknown>;
          const principal = stmt['Principal'];
          if (principal === '*') return true;
          if (principal !== null && typeof principal === 'object') {
            const p = principal as Record<string, unknown>;
            const aws = Array.isArray(p['AWS']) ? p['AWS'] : [p['AWS']];
            return aws.includes('*');
          }
          return false;
        });
      } catch {
        return false;
      }
    },
    recommendation: 'Restrict Principal to specific AWS accounts, services, or ARNs',
  },
  {
    id: 'IAM-SEC-004',
    title: 'IAM policy uses NotAction (implicit allow-all)',
    description:
      'IAM policy statement uses NotAction which grants all actions except the listed ones — ' +
      'effectively an allow-all and a common path for privilege escalation',
    severity: 'critical',
    resourceTypes: ['aws_iam_policy', 'aws_iam_role_policy', 'aws_iam_user_policy', 'aws_iam_group_policy'],
    evaluate: (res) => {
      const policy = res.configuration['policy'];
      if (typeof policy !== 'string') return false;
      try {
        const doc = JSON.parse(policy) as Record<string, unknown>;
        const stmts = Array.isArray(doc['Statement']) ? doc['Statement'] : [doc['Statement']];
        return stmts.some((s: unknown) => {
          if (s === null || typeof s !== 'object') return false;
          const stmt = s as Record<string, unknown>;
          return stmt['Effect'] === 'Allow' && 'NotAction' in stmt;
        });
      } catch {
        return false;
      }
    },
    recommendation:
      'Replace NotAction with an explicit Action list; NotAction with Effect=Allow grants all actions except the excluded ones',
  },
];
