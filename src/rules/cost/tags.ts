/**
 * Tag cost allocation rules.
 * Ported from Go internal/ai/rules.go (TAG-001, TAG-002).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { strConfig, missingRequiredTags } from './helpers.js';
import { clampConfidence } from '../../utils/numeric-guards.js';

type Cfg = typeof THRESHOLDS & ThresholdsOverride;

/** TAG-001: Missing cost allocation tags. */
export function checkTAG001(r: Resource, cfg: Cfg): Recommendation | null {
  // Skip completely untagged resources — TAG-002 handles those
  if (!r.tags) return null;
  if (Object.keys(r.tags).length === 0) return null;
  const required = cfg.requiredTags as readonly string[];
  const missing = missingRequiredTags(r, required);
  if (missing.length === 0) return null;
  const filePath = strConfig(r, 'file_path');
  const tagPairs = missing.map((k) => `${k} = "<value>"`).join('\n    ');
  return {
    ruleId: 'TAG-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Add missing cost allocation tags to ${r.type} ${r.name}`,
    description: `Resource ${r.name} is missing required tags: ${missing.join(', ')}. Without these tags, costs cannot be allocated to teams or projects.`,
    reasoning: 'Cost allocation tags are required for accurate FinOps reporting. Resources without tags cannot be attributed to business units.',
    impact: 'low',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'add_required_tags',
    confidence: clampConfidence(0.99),
    filePath,
    currentConfig: { missing_tags: missing },
    suggestedConfig: {
      tags: {
        Environment: '<dev|staging|production>',
        Team: '<team-name>',
        Project: '<project-name>',
      },
    },
    patchContent: `  tags = {\n    ${tagPairs}\n  }`,
    implementationSteps: [
      filePath
        ? `Add tags: ${missing.join(', ')} to the resource in ${filePath}`
        : `Add tags: ${missing.join(', ')} to the resource`,
      'Run terraform plan to verify, then terraform apply',
      'Consider using AWS Tag Policies to enforce tagging going forward',
    ],
  };
}

/** TAG-002: Completely untagged resource. */
export function checkTAG002(r: Resource, _cfg: Cfg): Recommendation | null {
  if (!r.tags) return null;
  if (Object.keys(r.tags).length > 0) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'TAG-002',
    resourceId: r.id,
    resourceType: r.type,
    title: `Resource ${r.type} ${r.name} has no tags at all`,
    description: `Resource ${r.name} (${r.type}) has zero tags. Without any tags there is no cost attribution, team ownership, or lifecycle tracking.`,
    reasoning: 'Completely untagged resources cannot be attributed to any team, project, or environment. This blocks FinOps reporting and makes cleanup difficult.',
    impact: 'low',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'add_tags',
    confidence: clampConfidence(1.0),
    filePath,
    currentConfig: { tag_count: 0 },
    suggestedConfig: {
      tags: {
        Environment: '<dev|staging|production>',
        Team: '<team-name>',
        Project: '<project-name>',
      },
    },
    patchContent: '  tags = {\n    Environment = "<dev|staging|production>"\n    Team        = "<team-name>"\n    Project     = "<project-name>"\n  }',
    implementationSteps: [
      filePath
        ? `Add at minimum Environment, Team, and Project tags to ${r.name} in ${filePath}`
        : `Add at minimum Environment, Team, and Project tags to ${r.name}`,
      'Run terraform plan to verify, then terraform apply',
      'Consider enforcing tagging with AWS Tag Policies or a Terraform module',
    ],
  };
}

export const tagsRules = [checkTAG001, checkTAG002];
