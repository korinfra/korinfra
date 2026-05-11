/** Classifier module — re-exports all public APIs. */

export type {
  Classification,
  ConfigDiffField,
  MatchedPair,
  MatchType,
  Recommendation,
  ScenarioSummary,
  StateResource,
  TerraformResource,
} from './types.js';

export { classifyResources } from './matcher.js';
export type { MatcherOptions } from './matcher.js';

export { detectConfigDiffs, filterConfigDiffsBySeverity, severityLevel } from './config-diff.js';

export {
  attributeConfidence,
  countMeaningfulAttributes,
  confidenceLevel,
  generateConfigDiffRecommendations,
  generateScenarioRecommendations,
  generateTfSecurityRecommendations,
  summarize,
} from './scenarios.js';
export type { ScenarioConfidenceConfig } from './scenarios.js';

export {
  analyzeRightsizing,
  defaultThresholds,
  instanceSizeOrder,
  suggestGravitonEquivalent,
  suggestSmallerInstance,
  suggestSmallerRDS,
} from './rightsize.js';
export type { RightsizeThresholds } from './rightsize.js';

export { deduplicateRecommendations } from './dedup.js';
