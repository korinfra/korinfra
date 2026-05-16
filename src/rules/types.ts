/** Static metadata for a built-in cost optimization rule. */
export interface RuleInfo {
  id: string;
  category: string;
  title: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
}

/** Per-resource diagnostic emitted by a rule when it skips evaluation. */
export interface RuleWarning {
  ruleId: string;
  resourceId: string;
  resourceType: string;
  reason: string;
}

/** Context passed to rule functions for accumulating warnings. */
export interface RuleContext {
  warn(ruleId: string, resourceId: string, resourceType: string, reason: string): void;
}

export type { Recommendation } from '../classifier/types.js';
