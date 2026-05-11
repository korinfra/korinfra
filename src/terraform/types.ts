/**
 * Terraform-related types for korinfra.
 * Ported from Go internal/terraform/types.go (via models package).
 */

/** A resource extracted from .tf source files. */
export interface TerraformResource {
  /** Full Terraform address, e.g. "aws_instance.web" or "module.vpc". */
  address: string;
  /** Terraform resource type, e.g. "aws_instance". */
  type: string;
  /** Resource name label, e.g. "web". */
  name: string;
  /** Provider prefix, e.g. "aws". */
  provider: string;
  /** Module path, empty string for root module. */
  module: string;
  /** Absolute path to the .tf file. */
  filePath: string;
  /** Line number where the block starts (1-based). */
  lineNumber: number;
  /** Parsed attribute values from the block body. */
  configuration: Record<string, unknown>;
  /** From PricingEngine enrichment */
  estimatedCost?: number;
  /**
   * True when a Terraform state entry existed for this resource (meaning it was
   * previously applied) but the corresponding AWS resource could no longer be
   * found.  Distinct from "never applied" where no state entry exists at all.
   */
  destroyedInAws?: boolean;
  /** Explicit depends_on references. */
  dependencies: string[];
}

/** A resource extracted from a terraform.tfstate file. */
export interface StateResource {
  /** Full Terraform address including module prefix if present. */
  address: string;
  /** Terraform resource type, e.g. "aws_instance". */
  type: string;
  /** Resource name label (may include module prefix). */
  name: string;
  /** Short provider name, e.g. "aws". */
  provider: string;
  /** AWS ARN, empty string if not present. */
  arn: string;
  /** Resource ID (e.g. instance-id, bucket name). */
  id: string;
  /** All attributes from the state instance. */
  attributes: Record<string, unknown>;
}

/** A parsed Terraform module (directory). */
export interface TerraformModule {
  /** Managed resource blocks. */
  resources: TerraformResource[];
  /** Variable blocks. */
  variables: TerraformResource[];
  /** Output blocks (stored as TerraformResource for uniformity). */
  outputs: TerraformResource[];
  /** Data source blocks. */
  dataSources: TerraformResource[];
}

/** Severity levels for security findings. */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/** A security finding from the scanner. */
export interface SecurityFinding {
  /** Rule identifier, e.g. "TF001". */
  ruleId: string;
  /** Severity level. */
  severity: FindingSeverity;
  /** Resource address the finding applies to. */
  resource: string;
  /** Short title for the finding. */
  title: string;
  /** Full description of the issue. */
  description: string;
  /** Recommended remediation. */
  recommendation: string;
}
