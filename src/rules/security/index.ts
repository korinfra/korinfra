/**
 * Security rule registry and runner.
 * Aggregates all built-in security rules and evaluates them against
 * parsed Terraform resources.
 */

import type { SecurityFinding, TfResource } from './types.js';
import type { SecurityRule } from './types.js';

export type { SecurityFinding };

import { s3Rules } from './s3.js';
import { ec2Rules } from './ec2.js';
import { rdsRules } from './rds.js';
import { iamRules } from './iam.js';
import { networkRules } from './network.js';
import { lambdaRules } from './lambda.js';
import { encryptionRules } from './encryption.js';
import { miscRules } from './misc.js';


/** All built-in security rules — mirrors Go builtinRules slice. */
export const allSecurityRules: SecurityRule[] = [
  ...s3Rules,
  ...ec2Rules,
  ...rdsRules,
  ...iamRules,
  ...networkRules,
  ...lambdaRules,
  ...encryptionRules,
  ...miscRules,
];

/**
 * Run all security rules against a list of parsed Terraform resources.
 * Returns one SecurityFinding per rule violation found.
 */
export function evaluateSecurityRules(resources: TfResource[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const resource of resources) {
    for (const rule of allSecurityRules) {
      if (!rule.resourceTypes.includes(resource.type)) continue;
      if (!rule.evaluate(resource, resources)) continue;

      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        resource: resource.address,
        title: rule.title,
        description: rule.description,
        recommendation: rule.recommendation,
      });
    }
  }

  return findings;
}

/** Returns the total number of built-in security rules. */
export function securityRuleCount(): number {
  return allSecurityRules.length;
}
