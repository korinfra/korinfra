/**
 * Classifier types — mirrors Go internal/models/terraform.go and recommendation.go.
 * These are the core types for the 3-scenario classification system.
 */

import type { Resource } from '../aws/types.js';
import type { TerraformResource } from '../terraform/types.js';
export type { TerraformResource };

/** A resource parsed from a Terraform state file. */
export interface StateResource {
  /** e.g. "aws_instance" */
  type: string;
  /** e.g. "web" */
  name: string;
  provider: string;
  /** e.g. "i-0abc123def456789" */
  id: string;
  /** e.g. "arn:aws:ec2:..." */
  arn: string;
  /** Full config from state after interpolation */
  attributes: Record<string, unknown>;
}

/** How a TF resource was matched to an AWS resource. */
export type MatchType = 'arn' | 'id' | 'name' | 'fuzzy';

/** A single config diff field between Terraform and AWS configuration. */
export interface ConfigDiffField {
  field: string;
  /** What Terraform says */
  tfValue: string;
  /** What AWS has */
  awsValue: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** Optional human-readable context for why this mismatch may be expected. */
  note?: string;
}

/** A pair of matched Terraform + AWS resources (Scenario B). */
export interface MatchedPair {
  terraform: TerraformResource;
  aws: Resource;
  state?: StateResource;
  /** 0.0 - 1.0 */
  confidence: number;
  matchType: MatchType;
  configDiffs: ConfigDiffField[];
}

/** Result of classifyResources() — the 3-scenario classification. */
export interface Classification {
  /** Scenario B: exists in both TF and AWS */
  matched: MatchedPair[];
  /** Scenario A: defined in .tf but not found in AWS */
  terraformOnly: TerraformResource[];
  /** Scenario C: in AWS but not in Terraform */
  awsOnly: Resource[];
}

/** A cost optimization or config mismatch recommendation — canonical shared type. */
export interface Recommendation {
  id?: string;
  resourceId: string;
  resourceType: string;
  /** rightsize | unused | upgrade | config_diff | security | tag — set by classifier */
  type?: string;
  /** A | B | C — set by classifier */
  scenario?: string;
  title: string;
  description: string;
  /** Rule ID e.g. "EC2-001" — set by rules engine */
  ruleId?: string;
  /** Estimated monthly savings in USD — canonical name (replaces estimatedMonthlySavings) */
  estimatedSavings?: number;
  confidence?: number;
  qualityScore?: number;
  impact: string;
  risk: string;
  /** Narrative reasoning — set by rules engine */
  reasoning?: string;
  /** Current monthly cost in USD — set by rules engine */
  currentCost?: number;
  /** Suggested remediation action e.g. "stop_or_terminate" — set by rules engine */
  suggestedAction?: string;
  /** HCL patch content — set by rules engine */
  patchContent?: string;
  currentConfig?: Record<string, unknown>;
  suggestedConfig?: Record<string, unknown>;
  filePath?: string;
  implementationSteps?: string[];
  alternatives?: string[];
}

/** Aggregate statistics for a classification result. */
export interface ScenarioSummary {
  totalResources: number;
  scenarioACount: number;
  scenarioBCount: number;
  scenarioCCount: number;
  configDiffCount: number;
  highConfidence: number;
  lowConfidence: number;
}
