/**
 * Lambda cost optimization rules.
 * Ported from Go internal/ai/rules.go (LAM-001 through LAM-006).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { strConfig, numConfig, sanitizeResourceName, normalizeToMonth, getMonthlyCost, confidenceFromUtilization } from './helpers.js';

// Lambda architecture optimization (Graviton2 / arm64) savings estimate: ~20% based on AWS pricing.
// Actual savings depend on invocation patterns and runtime compatibility.
const LAMBDA_ARCHITECTURE_SAVINGS_RATIO = 0.20;

// AWS Lambda GB-second price (x86_64, us-east-1). See: https://aws.amazon.com/lambda/pricing/
const LAMBDA_GB_SECOND_PRICE = 0.0000166667;

type Cfg = typeof THRESHOLDS & ThresholdsOverride;

/** LAM-001: Unused Lambda function (zero invocations). */
export function checkLAM001(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'lambda_function' || !r.utilization) return null;
  if ((r.utilization.invocations ?? 0) > 0) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'LAM-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Delete unused Lambda function ${r.name}`,
    description: `Lambda function ${r.name} has had no invocations. Unused functions create maintenance overhead.`,
    reasoning: 'Lambda functions don\'t incur costs at rest but unused functions add operational complexity and should be removed.',
    impact: 'low',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'delete_lambda',
    confidence: confidenceFromUtilization(0.75, r.utilization),
    filePath,
    currentConfig: { invocation_count: 0 },
    suggestedConfig: { action: 'delete' },
    patchContent: `# Delete unused Lambda function ${sanitizeResourceName(r.name)}\n# aws lambda delete-function --function-name ${sanitizeResourceName(r.name)}`,
    implementationSteps: [
      'Confirm the function is not invoked by any scheduled events or services',
      'Delete the function and associated CloudWatch log groups',
      filePath ? `Remove the aws_lambda_function resource block from ${filePath}` : 'Remove the aws_lambda_function resource block',
    ],
  };
}

/** LAM-002: Overprovisioned Lambda memory. */
export function checkLAM002(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'lambda_function' || !r.utilization) return null;
  const memMB = numConfig(r, 'memory_mb');
  const invocations = r.utilization.invocations ?? 0;
  if (memMB < cfg.lambdaMinMemoryMB || invocations <= 0) return null;
  let suggestedMem = memMB / 2;
  if (suggestedMem < 128) suggestedMem = 128;
  const monthlyCost = getMonthlyCost(r);

  const avgDurationMs = r.utilization?.avgDurationMs ?? 0;
  const invPerMonth = invocations > 0 && r.utilization
    ? normalizeToMonth(invocations, r.utilization.period)
    : 0;

  let savings: number;
  let confidence: number;
  if (invPerMonth > 0 && avgDurationMs > 0) {
    // Precise calculation using actual usage data
    const currentGbSeconds = (memMB / 1024) * (avgDurationMs / 1000) * invPerMonth;
    const suggestedGbSeconds = (suggestedMem / 1024) * (avgDurationMs / 1000) * invPerMonth;
    savings = Math.max(0, currentGbSeconds - suggestedGbSeconds) * LAMBDA_GB_SECOND_PRICE;
    confidence = confidenceFromUtilization(0.75, r.utilization);
  } else if (monthlyCost > 0) {
    // Tier 2: proportional estimate from reported cost
    savings = monthlyCost * (1 - suggestedMem / memMB);
    confidence = confidenceFromUtilization(0.55, r.utilization);
  } else {
    savings = 0;
    confidence = 0.45;
  }

  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'LAM-002',
    resourceId: r.id,
    resourceType: r.type,
    title: `Reduce memory for Lambda function ${r.name} (${memMB.toFixed(0)} MB → ${suggestedMem.toFixed(0)} MB)`,
    description: `Lambda ${r.name} allocates ${memMB.toFixed(0)} MB of memory. Functions with large memory allocations are often over-provisioned; halving the allocation is a safe first step. Based on configured memory only — actual peak usage not available from CloudWatch. Check CloudWatch Logs Insights (\`MAX memory used\`) before applying.`,
    reasoning: `Lambda billing is proportional to memory × duration. Functions allocated ≥ ${cfg.lambdaMinMemoryMB} MB are frequently over-provisioned. Lambda does not publish memory utilization as a standard CloudWatch metric — only configured memory is available. Halving the memory allocation may reduce cost, but actual peak usage must be verified in CloudWatch Logs Insights before applying.`,
    impact: 'medium',
    risk: 'medium',
    estimatedSavings: savings,
    suggestedAction: `reduce_memory_to_${suggestedMem.toFixed(0)}_mb`,
    confidence,
    filePath,
    currentConfig: { memory_size: Math.round(memMB) },
    suggestedConfig: { memory_size: Math.round(suggestedMem) },
    patchContent: `  memory_size = ${Math.round(suggestedMem)}  # was: ${Math.round(memMB)} MB`,
    implementationSteps: [
      `Verify peak memory usage via CloudWatch Logs Insights: \`SELECT MAX(memorySize) FROM ${sanitizeResourceName(r.name)} LIMIT 100\``,
      filePath ? `Update ${filePath}: memory_size = ${Math.round(suggestedMem)}` : `Set memory_size = ${Math.round(suggestedMem)}`,
      'Run terraform plan to verify, then terraform apply',
      'Test invocations to ensure no memory errors occur',
      'Monitor memory utilisation for 48 hours post-change',
    ],
  };
}

/** LAM-003: Deprecated Lambda runtime. */
export function checkLAM003(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'lambda_function') return null;
  const runtime = strConfig(r, 'runtime');
  const deprecatedRuntimes = new Set([
    // Node.js (EOL: nodejs18.x Apr 2025, nodejs20.x Apr 2026)
    'nodejs8.10', 'nodejs10.x', 'nodejs12.x', 'nodejs14.x', 'nodejs16.x', 'nodejs18.x', 'nodejs20.x',
    // Python
    'python2.7', 'python3.6', 'python3.7', 'python3.8', 'python3.9', 'python3.10', 'python3.11',
    // Ruby (ruby3.2 EOL Mar 2025)
    'ruby2.5', 'ruby2.7', 'ruby3.2',
    // Java
    'java8',
    // .NET (dotnetcore3.1 Dec 2022, dotnet5.0 May 2022, dotnet6 Nov 2024)
    'dotnetcore2.1', 'dotnetcore3.1', 'dotnet5.0', 'dotnet6',
    // Go
    'go1.x',
    // Amazon Linux (provided.al2 EOL Jun 2025)
    'provided.al2',
  ]);
  if (!deprecatedRuntimes.has(runtime)) return null;
  const runtimeSuggestions: Record<string, string> = {
    // Node.js → nodejs22.x (current LTS, EOL Apr 2027)
    'nodejs8.10': 'nodejs22.x', 'nodejs10.x': 'nodejs22.x', 'nodejs12.x': 'nodejs22.x',
    'nodejs14.x': 'nodejs22.x', 'nodejs16.x': 'nodejs22.x', 'nodejs18.x': 'nodejs22.x', 'nodejs20.x': 'nodejs22.x',
    // Python → python3.13 (supported until Oct 2029)
    'python2.7': 'python3.13', 'python3.6': 'python3.13', 'python3.7': 'python3.13',
    'python3.8': 'python3.13', 'python3.9': 'python3.13', 'python3.10': 'python3.13', 'python3.11': 'python3.13',
    // Ruby → ruby3.4 (supported until Mar 2028)
    'ruby2.5': 'ruby3.4', 'ruby2.7': 'ruby3.4', 'ruby3.2': 'ruby3.4',
    // Java
    'java8': 'java21',
    // .NET → dotnet8 (supported until Nov 2026)
    'dotnetcore2.1': 'dotnet8', 'dotnetcore3.1': 'dotnet8', 'dotnet5.0': 'dotnet8', 'dotnet6': 'dotnet8',
    // Go
    'go1.x': 'provided.al2023',
    // Amazon Linux
    'provided.al2': 'provided.al2023',
  };
  const suggestedRuntime = runtimeSuggestions[runtime] ?? runtime;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'LAM-003',
    resourceId: r.id,
    resourceType: r.type,
    title: `Update deprecated Lambda runtime ${runtime} for function ${r.name}`,
    description: `Lambda function ${r.name} uses runtime ${runtime} which is deprecated or end-of-life.`,
    reasoning: 'Deprecated runtimes no longer receive security patches and may be blocked from creation in new regions.',
    impact: 'high',
    risk: 'medium',
    estimatedSavings: 0,
    suggestedAction: `upgrade_runtime_to_${suggestedRuntime}`,
    confidence: 0.95,
    filePath,
    currentConfig: { runtime },
    suggestedConfig: { runtime: suggestedRuntime },
    patchContent: `  runtime = "${sanitizeResourceName(suggestedRuntime)}"  # was: ${sanitizeResourceName(runtime)} (deprecated/EOL)`,
    implementationSteps: [
      `Update the function code to be compatible with ${suggestedRuntime}`,
      filePath ? `Update ${filePath}: runtime = "${suggestedRuntime}"` : `Set runtime = "${suggestedRuntime}"`,
      'Run terraform plan to verify, then terraform apply',
      'Test thoroughly before deploying to production',
    ],
  };
}

/** LAM-004: Low-invocation Lambda with high memory. */
export function checkLAM004(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'lambda_function') return null;
  const memMB = numConfig(r, 'memory_mb');
  const rawInvocations = r.utilization ? (r.utilization.invocations ?? 0) : 0;
  const invocationsPerMonth = r.utilization ? normalizeToMonth(rawInvocations, r.utilization.period) : 0;
  if (memMB <= 512 || invocationsPerMonth <= 0 || invocationsPerMonth >= cfg.lambdaLowInvocations) return null;
  const suggestedMem = memMB <= 1024 ? 256 : 512;
  const monthlyCost = getMonthlyCost(r);

  const avgDurationMs = r.utilization?.avgDurationMs ?? 0;

  let savings: number;
  let confidence: number;
  if (invocationsPerMonth > 0 && avgDurationMs > 0) {
    // Precise calculation using actual usage data
    const currentGbSeconds = (memMB / 1024) * (avgDurationMs / 1000) * invocationsPerMonth;
    const suggestedGbSeconds = (suggestedMem / 1024) * (avgDurationMs / 1000) * invocationsPerMonth;
    savings = Math.max(0, currentGbSeconds - suggestedGbSeconds) * LAMBDA_GB_SECOND_PRICE;
    confidence = confidenceFromUtilization(0.75, r.utilization);
  } else if (monthlyCost > 0) {
    // Tier 2: proportional estimate from reported cost
    savings = monthlyCost * (1 - suggestedMem / memMB);
    confidence = confidenceFromUtilization(0.55, r.utilization);
  } else {
    savings = 0;
    confidence = 0.45;
  }

  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'LAM-004',
    resourceId: r.id,
    resourceType: r.type,
    title: `Lambda ${r.name} has low invocations (${invocationsPerMonth.toFixed(0)}/mo) but high memory (${memMB.toFixed(0)} MB)`,
    description: `Lambda function ${r.name} is invoked only ${invocationsPerMonth.toFixed(0)} times/month but allocates ${memMB.toFixed(0)} MB of memory. Consider reducing memory to ${suggestedMem} MB.`,
    reasoning: `At ${invocationsPerMonth.toFixed(0)} invocations/month the workload is very infrequent. High memory allocation (${memMB.toFixed(0)} MB) is likely over-provisioned for such rare executions.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: savings,
    suggestedAction: `reduce_memory_to_${suggestedMem}_mb`,
    confidence,
    filePath,
    currentConfig: { memory_mb: Math.round(memMB), invocations_per_month: Math.round(invocationsPerMonth) },
    suggestedConfig: { memory_size: suggestedMem },
    patchContent: `  memory_size = ${suggestedMem}  # was: ${Math.round(memMB)} MB (${Math.round(invocationsPerMonth)} invocations/month)`,
    implementationSteps: [
      filePath ? `Update ${filePath}: memory_size = ${suggestedMem}` : `Set memory_size = ${suggestedMem}`,
      'Run terraform plan to verify, then terraform apply',
      'Test a manual invocation to confirm it completes without memory errors',
    ],
  };
}

/** LAM-005: Lambda on x86_64 — consider arm64/Graviton. */
export function checkLAM005(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'lambda_function') return null;
  let arch = strConfig(r, 'architectures');
  if (!arch) arch = strConfig(r, 'architecture');
  if (arch !== 'x86_64') return null;
  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost * LAMBDA_ARCHITECTURE_SAVINGS_RATIO;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'LAM-005',
    resourceId: r.id,
    resourceType: r.type,
    title: `Switch Lambda ${r.name} from x86_64 to arm64 (Graviton, ~20% cheaper)`,
    description: `Lambda function ${r.name} uses x86_64 architecture. Switching to arm64 (Graviton2) reduces compute cost by ~20% with no code changes required for most runtimes. Savings estimate based on AWS pricing; actual savings depend on invocation patterns and runtime compatibility.`,
    reasoning: 'AWS arm64 Lambda pricing: $0.0000133334/GB-s vs x86_64 $0.0000166667/GB-s — a 20% reduction. Supported runtimes include Node.js, Python, Java, .NET, Ruby, and custom runtimes.',
    impact: 'medium',
    risk: 'low',
    estimatedSavings: savings,
    suggestedAction: 'migrate_to_arm64',
    confidence: 0.8,
    filePath,
    currentConfig: { architectures: 'x86_64' },
    suggestedConfig: { architectures: 'arm64' },
    patchContent: '  architectures = ["arm64"]  # was: ["x86_64"] (~20% cheaper on Graviton2)',
    implementationSteps: [
      'Verify the runtime supports arm64 (Node.js, Python, Java, .NET, Ruby, Go via provided.al2)',
      filePath ? `Update ${filePath}: architectures = ["arm64"]` : 'Set architectures = ["arm64"]',
      'Run terraform plan to verify, then terraform apply',
      'Test the function with a manual invocation to confirm compatibility',
    ],
  };
}

/** LAM-006: Lambda function with high error rate (>10%). */
export function checkLAM006(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'lambda_function') return null;
  if (!('error_rate_pct' in r.configuration)) return null;
  const errorRatePct = numConfig(r, 'error_rate_pct');
  if (errorRatePct <= cfg.lambdaErrorRateThreshold) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'LAM-006',
    resourceId: r.id,
    resourceType: r.type,
    title: `Lambda function ${r.name} has a high error rate (${errorRatePct.toFixed(1)}%)`,
    description: `Lambda function ${r.name} has an error rate of ${errorRatePct.toFixed(1)}%. Functions with >${cfg.lambdaErrorRateThreshold}% errors may be misconfigured or broken.`,
    reasoning: `A ${errorRatePct.toFixed(1)}% error rate means roughly 1 in ${(100.0 / errorRatePct).toFixed(0)} invocations fails. This indicates a reliability problem. Common causes: missing environment variables, insufficient IAM permissions, memory limits, or dependency failures.`,
    impact: 'high',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'investigate_and_fix_errors',
    confidence: 0.9,
    filePath,
    currentConfig: { error_rate_pct: errorRatePct },
    suggestedConfig: { error_rate_pct: 0 },
    patchContent: `# Investigate and fix Lambda function ${sanitizeResourceName(r.name)} errors\n# aws logs tail /aws/lambda/${sanitizeResourceName(r.name)} --follow`,
    implementationSteps: [
      `Check CloudWatch Logs for function ${sanitizeResourceName(r.name)}: aws logs tail /aws/lambda/${sanitizeResourceName(r.name)} --follow`,
      'Review Lambda Insights or X-Ray traces for error patterns',
      'Check IAM role permissions, environment variables, and VPC configuration',
      'Verify memory and timeout settings are appropriate for the workload',
      'Set up a CloudWatch alarm on Errors metric to alert on high error rates',
    ],
  };
}

/** LAM-007: Proactive runtime deprecation warning — runtime will enter unsupported state within 180 days. */
function checkLAM007(r: Resource, _cfg: Cfg): Recommendation | null {
  if (r.type !== 'lambda_function') return null;
  const runtime = strConfig(r, 'runtime');
  if (!runtime) return null;

  // Runtimes with known upcoming deprecation dates (within potential warning window)
  const UPCOMING_LAMBDA_DEPRECATIONS: Record<string, { deprecationDate: Date; suggestedRuntime: string }> = {
    'python3.12': { deprecationDate: new Date('2026-10-01'), suggestedRuntime: 'python3.13' },
    'ruby3.3': { deprecationDate: new Date('2025-12-31'), suggestedRuntime: 'ruby3.4' },
  };
  const LAMBDA_DEPRECATION_WARN_DAYS = 180;

  const upcoming = UPCOMING_LAMBDA_DEPRECATIONS[runtime];
  if (!upcoming) return null;

  const now = new Date();
  const daysUntil = Math.floor((upcoming.deprecationDate.getTime() - now.getTime()) / 86_400_000);
  if (daysUntil > LAMBDA_DEPRECATION_WARN_DAYS || daysUntil <= 0) return null;

  const filePath = strConfig(r, 'file_path');
  const dateStr = upcoming.deprecationDate.toISOString().slice(0, 10);

  return {
    ruleId: 'LAM-007',
    resourceId: r.id,
    resourceType: r.type,
    title: `Lambda function ${r.name} uses ${runtime} which is deprecated in ${daysUntil} days`,
    description: `Runtime ${runtime} will be deprecated on ${dateStr}. After deprecation, AWS blocks new deployments and eventually blocks updates. Upgrade to ${upcoming.suggestedRuntime} before ${dateStr} to avoid disruption.`,
    reasoning: 'Deprecated Lambda runtimes stop receiving security patches. AWS blocks creating new functions and eventually blocks updating existing ones. Proactive migration avoids forced emergency upgrades.',
    impact: 'high',
    risk: 'medium',
    estimatedSavings: 0,
    suggestedAction: `upgrade_runtime_to_${upcoming.suggestedRuntime}`,
    confidence: 0.95,
    filePath,
    currentConfig: { runtime, days_until_deprecation: daysUntil },
    suggestedConfig: { runtime: upcoming.suggestedRuntime },
    patchContent: `  runtime = "${upcoming.suggestedRuntime}"  # was: ${runtime} (deprecated ${dateStr})`,
    implementationSteps: [
      `Update the function code to be compatible with ${upcoming.suggestedRuntime}`,
      filePath ? `Update ${filePath}: runtime = "${upcoming.suggestedRuntime}"` : `Set runtime = "${upcoming.suggestedRuntime}"`,
      'Run terraform plan to verify, then terraform apply',
      `Complete migration before ${dateStr} to avoid deployment blocks`,
    ],
  };
}

/** LAM-008: Lambda function with high timeout (≥300s). */
function checkLAM008(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'lambda_function') return null;
  const timeoutSec = numConfig(r, 'timeout_sec');
  if (timeoutSec < 300) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'LAM-008',
    resourceId: r.id,
    resourceType: r.type,
    title: `Lambda function ${r.name} has a very high timeout (${timeoutSec}s)`,
    description: `Lambda function ${r.name} is configured with a ${timeoutSec}s timeout. Timeouts ≥300s mask latency bugs, inflate worst-case billing, and delay error detection. AWS maximum is 900s.`,
    reasoning: 'Lambda billing is duration × memory. A high timeout means a hung invocation waits the full duration before failing, running up cost with no useful work. It also hides performance regressions that would otherwise surface as errors.',
    impact: 'medium',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'reduce_timeout',
    confidence: 0.8,
    filePath,
    currentConfig: { timeout_sec: timeoutSec },
    suggestedConfig: { timeout_sec: 60 },
    patchContent: `  timeout = 60  # was: ${timeoutSec}s — review actual p99 duration first`,
    implementationSteps: [
      `Check p99 duration in CloudWatch: aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Duration --dimensions Name=FunctionName,Value=${sanitizeResourceName(r.name)} --statistics p99`,
      'Set timeout to p99 duration + 20% headroom (minimum 10s)',
      filePath ? `Update ${filePath}: timeout = <new_value>` : 'Update Terraform: timeout = <new_value>',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

export const lambdaRules = [
  checkLAM001,
  checkLAM002,
  checkLAM003,
  checkLAM004,
  checkLAM005,
  checkLAM006,
  checkLAM007,
  checkLAM008,
];
