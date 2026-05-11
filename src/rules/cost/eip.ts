/**
 * Elastic IP cost rules.
 * Ported from Go internal/ai/rules.go (EIP-001).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { strConfig } from './helpers.js';
import { EIP_HOURLY, HOURS_PER_MONTH } from '../../pricing/resources.js';

type Cfg = typeof THRESHOLDS & ThresholdsOverride;

// AWS charges $0.005/hr for ALL public IPv4 addresses since Feb 2024 (730 hr/month)
const EIP_MONTHLY_USD = EIP_HOURLY * HOURS_PER_MONTH;

/** EIP-001: Unused Elastic IP — release to avoid unnecessary IPv4 charges. */
export function checkEIP001(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'elastic_ip' || r.state === 'associated') return null;
  const filePath = strConfig(r, 'file_path');
  const monthlyCostStr = EIP_MONTHLY_USD.toFixed(2);
  return {
    ruleId: 'EIP-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Release unused Elastic IP ${r.name}`,
    description: `Elastic IP ${r.name} is not associated with any running instance (${monthlyCostStr} USD/mo).`,
    reasoning: `AWS charges $${EIP_HOURLY}/hr for all public IPv4 addresses. Releasing this idle EIP saves $${monthlyCostStr}/month.`,
    impact: 'low',
    risk: 'low',
    estimatedSavings: EIP_MONTHLY_USD,
    suggestedAction: 'release_eip',
    confidence: 0.99,
    filePath,
    currentConfig: { state: 'unassociated' },
    suggestedConfig: { action: 'release' },
    patchContent: `# Release unused EIP ${r.name}\n# aws ec2 release-address --allocation-id ${r.id}`,
    implementationSteps: [
      'Verify the IP is not needed for DNS or allowlisting purposes',
      'Release the Elastic IP via the AWS Console or CLI',
    ],
  };
}

export const eipRules = [checkEIP001];
