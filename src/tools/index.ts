import { collectAwsTool } from './collect-aws.js';
import { getCostsTool } from './get-costs.js';
import { listRulesTool } from './list-rules.js';
import { saveScanTool } from './save-scan.js';
import { getHistoryTool } from './get-history.js';
import { compareScansTool } from './compare-scans.js';
import { scanTerraformTool } from './scan-terraform.js';
import { terraformValidateTool } from './terraform-validate.js';
import { scanSecurityTool } from './scan-security.js';
import { classifyResourcesTool } from './classify-resources.js';
import { evaluateRulesTool } from './evaluate-rules.js';
import { detectAnomalesTool } from './detect-anomalies.js';
import { createPRTool } from './create-pr.js';
import { gitCommitPushTool } from './git-commit-push.js';
// Note: gitCommitPushTool is intentionally excluded from allTools — it must NOT be
// exposed via the MCP server. It is only available to the fix command agent (fixTools).
import { getRecommendationsTool } from './get-recommendations.js';
import { applyRecommendationTool } from './apply-recommendation.js';
import { getChangesTool } from './get-changes.js';
import { findIdleEc2Tool } from './find-idle-ec2.js';
import { findOrphanEbsTool } from './find-orphan-ebs.js';
import { findIdleRdsTool } from './find-idle-rds.js';
import { getRiCoverageTool } from './get-ri-coverage.js';
import { getComputeOptimizerRecommendationsTool } from './get-compute-optimizer-recommendations.js';
// Note: applyTagsRealTool is intentionally excluded from allTools — destructive write op,
// must NOT be exposed via MCP server. Only used by tags command agent (tagsWriteTools).
import { applyTagsRealTool } from './apply-tags-real.js';
import type { ToolDefinition } from './types.js';

export type { ToolDefinition, ToolResult } from './types.js';
export { jsonResult, textResult, errorResult } from './types.js';

/**
 * All registered MCP tools.
 * Shared by both agent mode (via createSdkMcpServer) and MCP server mode.
 */
export const allTools: ToolDefinition[] = [
  collectAwsTool,
  getCostsTool,
  listRulesTool,
  saveScanTool,
  getHistoryTool,
  compareScansTool,
  scanTerraformTool,
  terraformValidateTool,
  scanSecurityTool,
  classifyResourcesTool,
  evaluateRulesTool,
  detectAnomalesTool,
  createPRTool,
  getRecommendationsTool,
  applyRecommendationTool,
  getChangesTool,
  findIdleEc2Tool,
  findOrphanEbsTool,
  findIdleRdsTool,
  getRiCoverageTool,
  getComputeOptimizerRecommendationsTool,
];

/** Get a tool by name. */
export function getTool(name: string): ToolDefinition | undefined {
  return allTools.find((t) => t.name === name);
}

/** Tools needed for scan: collect, costs, rules, anomalies, terraform, security, save */
export const scanTools: ToolDefinition[] = [
  collectAwsTool,
  getCostsTool,
  evaluateRulesTool,
  detectAnomalesTool,
  scanTerraformTool,
  classifyResourcesTool,
  scanSecurityTool,
  saveScanTool,
];

/** Tools needed for costs command */
export const costsTools: ToolDefinition[] = [
  getCostsTool,
  detectAnomalesTool,
  collectAwsTool,
];

/** Tools needed for resources command */
export const resourcesTools: ToolDefinition[] = [
  collectAwsTool,
  evaluateRulesTool,
];

/** Tools needed for security command */
export const securityTools: ToolDefinition[] = [
  scanSecurityTool,
  collectAwsTool,
  scanTerraformTool,
  // classifyResourcesTool removed — security pipeline does not use it
];

/** Tools needed for history/compare */
export const historyTools: ToolDefinition[] = [
  getHistoryTool,
  compareScansTool,
];

/** Tools needed for recommend command */
export const recommendTools: ToolDefinition[] = [
  collectAwsTool,
  getCostsTool,
  evaluateRulesTool,
  detectAnomalesTool,
  saveScanTool,    // needed for --refresh mode to persist results
  findIdleEc2Tool,
  findOrphanEbsTool,
  findIdleRdsTool,
  getRiCoverageTool,
  getComputeOptimizerRecommendationsTool,
];

/** Tools needed for report command */
export const reportTools: ToolDefinition[] = [
  getCostsTool,
  getHistoryTool,
  evaluateRulesTool,
  collectAwsTool,
];

/** Tools needed for tags command */
export const tagsTools: ToolDefinition[] = [
  collectAwsTool,
  getCostsTool,
];

/** Tools needed for changes command */
export const changesTools: ToolDefinition[] = [
  getChangesTool,
];

/** Tags tools including real write capability (excluded from allTools/MCP) */
export const tagsWriteTools: ToolDefinition[] = [
  ...tagsTools,
  applyTagsRealTool,
];

/** Tools needed for fix command */
export const fixTools: ToolDefinition[] = [
  collectAwsTool,
  scanTerraformTool,
  scanSecurityTool,
  terraformValidateTool,
  evaluateRulesTool,
  createPRTool,
  gitCommitPushTool,
  getRecommendationsTool,  // step 0 in FIX_PROMPT loads rec from DB
  applyRecommendationTool,
];
