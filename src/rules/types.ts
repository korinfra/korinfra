/** Static metadata for a built-in cost optimization rule. */
export interface RuleInfo {
  id: string;
  category: string;
  title: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
}

export type { Recommendation } from '../classifier/types.js';
