/**
 * evaluate_rules MCP tool.
 * Runs the built-in cost rules engine against a set of resources.
 */

import type { ToolDefinition } from './types.js';
import { jsonResult, errorResult } from './types.js';
import type { Resource } from '../aws/types.js';
import type { ThresholdsOverride } from '../rules/index.js';
import { evaluateRules } from '../rules/index.js';
import { redactObject } from '../redaction/redactor.js';
import { loadConfig } from '../config/index.js';
import { CostEngine } from '../pricing/engine.js';
import { getMonthlyCost } from '../rules/cost/helpers.js';

export const evaluateRulesTool: ToolDefinition = {
  name: 'evaluate_rules',
  description:
    'Runs the built-in cost optimization rules engine against AWS resources and returns prioritized recommendations with quality scores. No AI required — all logic is rule-based.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      resources: {
        type: 'array',
        description: 'Array of AWS resource objects to evaluate (from collect_aws or a saved scan).',
        items: { type: 'object' },
      },
      ruleIds: {
        type: 'array',
        description: 'Optional list of rule IDs to run (e.g. ["EC2-001","RDS-003"]). Runs all rules when omitted.',
        items: { type: 'string' },
      },
      thresholds: {
        type: 'object',
        description:
          'Optional threshold overrides (e.g. { "idleCPUThreshold": 10 }). Merged with built-in defaults.',
        additionalProperties: true,
      },
    },
    required: ['resources'],
  },
  handler: async (args) => {
    try {
      const resources = args['resources'];
      if (!Array.isArray(resources)) {
        return errorResult('resources must be an array');
      }

      const validResources = (resources as unknown[]).filter(
        (r): r is Resource =>
          r !== null && r !== undefined && typeof r === 'object' && typeof (r as Resource).type === 'string' && typeof (r as Resource).id === 'string'
      );

      const ruleIds = args['ruleIds'] as string[] | undefined;
      let thresholds = args['thresholds'] as ThresholdsOverride | undefined;

      // Load config and map savings_multipliers to thresholds
      const config = await loadConfig();
      if (config.scan.savings_multipliers) {
        const multipliers = config.scan.savings_multipliers;
        thresholds = {
          ...thresholds,
          ec2IdleStopMultiplier: multipliers.ec2_idle_stop,
          ec2StoppedEBSMultiplier: multipliers.ec2_stopped_ebs,
          ec2PreviousGenMultiplier: multipliers.ec2_previous_gen,
          ec2RightsizeMultiplier: multipliers.ec2_rightsize,
          ec2RIDiscountMultiplier: multipliers.ec2_ri_discount,
          ec2GravitonMultiplier: multipliers.ec2_graviton,
          rdsIdleMultiplier: multipliers.rds_idle,
          rdsRightsizeMultiplier: multipliers.rds_rightsize,
          rdsMultiAZMultiplier: multipliers.rds_multi_az,
          rdsGP2GP3Multiplier: multipliers.rds_gp2_gp3,
          rdsGravitonMultiplier: multipliers.rds_graviton,
        };
      }

      // Pre-enrich: set monthlyCost from pricing engine when Cost Explorer data is absent
      const engine = new CostEngine(null);
      const enrichedResources = await Promise.all(
        validResources.map(async (r) => {
          if (getMonthlyCost(r) > 0) return r;
          const estimated = await engine.estimateMonthlyCost(r);
          if (estimated <= 0) return r;
          return { ...r, configuration: { ...r.configuration, monthlyCost: estimated } };
        }),
      );

      const recommendations = evaluateRules(enrichedResources, thresholds, ruleIds, config.output.currency, config.quality);

      const impactRank = (impact: string | undefined): number =>
        impact === 'high' ? 0 : impact === 'medium' ? 1 : 2;

      // Sort by impact tier, then savings (significant diff only), then quality score
      recommendations.sort((a, b) => {
        const impactDiff = impactRank(a.impact) - impactRank(b.impact);
        if (impactDiff !== 0) return impactDiff;
        const savingsA = a.estimatedSavings ?? 0;
        const savingsB = b.estimatedSavings ?? 0;
        if (Math.abs(savingsB - savingsA) > 10) return savingsB - savingsA;
        return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
      });

      const totalSavings = recommendations.reduce((sum, r) => sum + (r.estimatedSavings ?? 0), 0);
      const highCount = recommendations.filter((r) => r.impact === 'high').length;
      const mediumCount = recommendations.filter((r) => r.impact === 'medium').length;
      const lowCount = recommendations.filter((r) => r.impact === 'low').length;

      // Keep only high-impact, plus medium if savings >= $5. Fall back to all if nothing qualifies.
      const highImpact = recommendations.filter((r) => r.impact === 'high');
      const mediumImpact = recommendations.filter(
        (r) => r.impact === 'medium' && (r.estimatedSavings ?? 0) >= 5,
      );
      const filtered = highImpact.length > 0 || mediumImpact.length > 0
        ? [...highImpact, ...mediumImpact]
        : recommendations;

      const maxRecs = config.ai.max_recommendations > 0 ? config.ai.max_recommendations : 25;
      const topRecommendations = filtered.slice(0, maxRecs);
      const slimRecs = topRecommendations.map((r) => ({
        id: r.id,
        ruleId: r.ruleId,
        resource_id: r.resourceId,
        resource_type: r.resourceType,
        title: r.title,
        description: r.description?.slice(0, 120),
        estimated_savings: r.estimatedSavings,
        qualityScore: r.qualityScore,
        confidence: r.confidence,
        impact: r.impact,
        risk: r.risk,
        patch_content: r.patchContent ?? null,
        implementation_steps: r.implementationSteps ?? null,
        current_config: r.currentConfig ?? null,
        suggested_config: r.suggestedConfig ?? null,
      }));

      return jsonResult(redactObject({
        summary: {
          resourcesEvaluated: validResources.length,
          recommendationsFound: recommendations.length,
          estimatedSavings: Math.round(totalSavings * 100) / 100,
          byImpact: { high: highCount, medium: mediumCount, low: lowCount },
        },
        recommendations: slimRecs,
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
