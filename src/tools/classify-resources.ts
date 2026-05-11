/**
 * MCP tool: classify_resources
 *
 * Classifies AWS and Terraform resources into the 3 scenarios (A/B/C) and generates actionable recommendations.
 */

import type { Resource } from '../aws/types.js';
import {
  classifyResources,
  deduplicateRecommendations,
  generateScenarioRecommendations,
  generateTfSecurityRecommendations,
  summarize,
} from '../classifier/index.js';
import type { StateResource } from '../classifier/types.js';
import { jsonResult, errorResult, normalizeTerraformResource } from './types.js';
import type { ToolDefinition } from './types.js';
import { redactObject } from '../redaction/redactor.js';
import { CostEngine } from '../pricing/engine.js';
import { loadConfig } from '../config/index.js';
import type { ScenarioConfidenceConfig } from '../classifier/index.js';

const TF_TYPE_TO_RESOURCE_TYPE: Record<string, string> = {
  aws_instance: 'ec2_instance',
  aws_db_instance: 'rds_instance',
  aws_ebs_volume: 'ebs_volume',
  aws_s3_bucket: 's3_bucket',
  aws_lambda_function: 'lambda_function',
  aws_lb: 'load_balancer',
  aws_alb: 'load_balancer',
  aws_elb: 'load_balancer',
  aws_elasticache_cluster: 'elasticache_cluster',
  aws_elasticache_replication_group: 'elasticache_cluster',
  aws_dynamodb_table: 'dynamodb_table',
  aws_nat_gateway: 'nat_gateway',
  aws_ecs_service: 'ecs_service',
};

export const classifyResourcesTool: ToolDefinition = {
  name: 'classify_resources',
  description:
    'Classifies AWS and Terraform resources into three scenarios (A: TF-only, B: matched TF+AWS, C: AWS-only) and generates actionable security and cost recommendations. Input comes from collect_aws (awsResources) and scan_terraform (terraformResources, stateResources).',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      awsResources: {
        type: 'array',
        description: 'AWS resources from collect_aws tool output.',
        items: { type: 'object' },
      },
      terraformResources: {
        type: 'array',
        description: 'Terraform resources parsed from HCL files.',
        items: { type: 'object' },
      },
      stateResources: {
        type: 'array',
        description: 'Resources parsed from Terraform state file (optional, improves match accuracy).',
        items: { type: 'object' },
      },
      fuzzyMatchThreshold: {
        type: 'number',
        description:
          'Minimum config similarity (0.0-1.0) for fuzzy matching. Higher = fewer false positives. Default: 0.7.',
        default: 0.7,
      },
    },
    required: ['awsResources', 'terraformResources'],
  },
  handler: async (args) => {
    try {
      const awsResources = (args['awsResources'] as Resource[]) ?? [];
      const terraformResourcesRaw = (args['terraformResources'] as Record<string, unknown>[]) ?? [];
      const terraformResources = terraformResourcesRaw.map(
        (r) => normalizeTerraformResource(r),
      );
      const stateResources = (args['stateResources'] as StateResource[]) ?? [];
      const rawThreshold = args['fuzzyMatchThreshold'];
      const fuzzyMatchThreshold =
        typeof rawThreshold === 'number' && Number.isFinite(rawThreshold) && rawThreshold >= 0 && rawThreshold <= 1
          ? rawThreshold
          : 0.7;

      // Step 1: Classify resources (4-pass matching).
      const classification = classifyResources(
        awsResources,
        terraformResources,
        stateResources,
        { fuzzyMatchThreshold },
      );

      // Step 1b: Enrich TF-only resources with fallback Pricing API estimates (no HTTP, uses hardcoded rates).
      const tfCostEngine = new CostEngine(null);
      await Promise.all(
        classification.terraformOnly.map(async (tf) => {
          const resourceType = TF_TYPE_TO_RESOURCE_TYPE[tf.type];
          if (!resourceType) return;
          try {
            const syntheticResource: Resource = {
              id: tf.address,
              arn: '',
              type: resourceType,
              name: tf.name,
              region: (tf.configuration['region'] as string | undefined) ?? 'us-east-1',
              state: 'running',
              instanceType: (tf.configuration['instance_type'] as string | undefined)
                ?? (tf.configuration['node_type'] as string | undefined)
                ?? '',
              tags: {},
              launchTime: new Date().toISOString(),
              collectedAt: new Date().toISOString(),
              configuration: tf.configuration,
            };
            const estimated = await tfCostEngine.estimateMonthlyCost(syntheticResource);
            if (estimated > 0) tf.estimatedCost = estimated;
          } catch {
            // non-fatal — estimatedCost remains undefined, scenarios.ts falls back to 0
          }
        }),
      );

      // Step 2: Generate recommendations for all scenarios.
      // Scenario A+C: cost/awareness recs. Scenario A+B: TF security recs.
      const cfg = await loadConfig().catch(() => null);
      const scanCfg = cfg?.scan;
      const confidenceCfg: ScenarioConfidenceConfig = {
        base: scanCfg?.scenario_confidence_base ?? 0.50,
        step: scanCfg?.scenario_confidence_step ?? 0.075,
        max: scanCfg?.scenario_confidence_max ?? 0.95,
        stateBase: scanCfg?.scenario_confidence_state_base ?? 0.80,
      };
      const scenarioRecs = generateScenarioRecommendations(classification, confidenceCfg);
      const securityRecs = generateTfSecurityRecommendations(classification, confidenceCfg);
      const allRecs = deduplicateRecommendations([...scenarioRecs, ...securityRecs]);

      // Step 3: Compute aggregate summary.
      const summary = summarize(classification);

      return jsonResult(redactObject({
        summary,
        classification: {
          matched: classification.matched.map((p) => ({
            terraform: {
              address: p.terraform.address,
              type: p.terraform.type,
              filePath: p.terraform.filePath,
              lineNumber: p.terraform.lineNumber,
            },
            aws: {
              id: p.aws.id,
              arn: p.aws.arn,
              type: p.aws.type,
              name: p.aws.name,
              region: p.aws.region,
            },
            confidence: p.confidence,
            matchType: p.matchType,
          })),
          terraformOnly: classification.terraformOnly.map((tf) => ({
            address: tf.address,
            type: tf.type,
            filePath: tf.filePath,
            estimatedCost: tf.estimatedCost,
          })),
          awsOnly: classification.awsOnly.map((r) => ({
            id: r.id,
            arn: r.arn,
            type: r.type,
            name: r.name,
            region: r.region,
          })),
        },
        recommendations: allRecs,
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
