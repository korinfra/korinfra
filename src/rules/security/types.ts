/**
 * Types for security rule evaluation.
 * Ported from Go internal/terraform/scanner.go SecurityRule struct.
 */

import type { TerraformResource } from '../../terraform/types.js';
export type { SecurityFinding } from '../../terraform/types.js';

/** A TerraformResource subset used inside rule evaluators. */
export type TfResource = TerraformResource;

/** A built-in security rule that evaluates a single Terraform resource. */
export interface SecurityRule {
  /** Unique rule identifier, e.g. "S3-SEC-001". */
  id: string;
  /** Short human-readable title. */
  title: string;
  /** Full description of the risk. */
  description: string;
  /** Severity level. */
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** Terraform resource types this rule applies to. */
  resourceTypes: string[];
  /** Returns true when the resource violates the rule.
   * allResources: full list of parsed resources in the same directory — use to check
   * for companion resources (e.g. aws_s3_bucket_versioning for an aws_s3_bucket). */
  evaluate: (resource: TfResource, allResources?: TfResource[]) => boolean;
  /** Recommended remediation. */
  recommendation: string;
}
