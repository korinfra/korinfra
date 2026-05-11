/**
 * Security pipeline — no-AI deterministic security scan.
 *
 * Steps:
 *   1. scan_security  — evaluates Terraform HCL against 35 security rules
 *   2. save_security  — persists findings to DB as recommendations
 */

import type { PipelineStep, PipelineContext } from '../components/DirectPipeline.js';
import { parseToolResult } from './scan.js';
import { scanSecurityTool } from '../../tools/scan-security.js';
import { asStr } from '../../utils/coerce.js';
import { getDb, insertScan, upsertRecommendations } from '../../storage/index.js';
import type { Recommendation } from '../../storage/index.js';

interface SecurityPipelineOptions {
  terraformDir?: string | undefined;
  severity?: string | null | undefined;
}

type RawFinding = {
  ruleId: string;
  severity: string;
  resource: string;
  title: string;
  description: string;
  recommendation: string;
  filePath?: string | null;
  resource_type?: string | null;
};

type SecurityResult = {
  findings?: Record<string, RawFinding[]> | unknown[];
  resources_scanned?: number;
  total_findings?: number;
  dir?: string;
};

export function buildSecurityPipelineSteps(opts: SecurityPipelineOptions = {}): PipelineStep[] {
  const dir = opts.terraformDir ?? '.';

  return [
    {
      name: 'Scanning Terraform for security issues',
      completedName: 'Scanned Terraform for security issues',
      key: 'security',
      getDetail: (result) => {
        const r = result as SecurityResult | null | undefined;
        const count = r?.total_findings ?? 0;
        return count > 0 ? `${count} finding${count !== 1 ? 's' : ''}` : 'no findings';
      },
      run: async () => {
        const result = await scanSecurityTool.handler({ dir });
        return parseToolResult(result);
      },
    },
    {
      name: 'Saving security findings',
      completedName: 'Saved security findings',
      key: 'save_security',
      // eslint-disable-next-line @typescript-eslint/require-await -- implements PipelineStep.run: () => Promise<unknown>
      run: async (ctx) => {
        try {
          const securityResult = ctx.results.get('security') as SecurityResult | undefined;
          const rawFindings = securityResult?.findings;

          if (!rawFindings) return {};

          const allFindings: RawFinding[] = Array.isArray(rawFindings)
            ? (rawFindings as RawFinding[])
            : Object.values(rawFindings).flat();

          if (allFindings.length === 0) return {};

          const db = getDb();
          const scanId = crypto.randomUUID();
          const now = new Date().toISOString();

          insertScan(db, {
            id: scanId,
            started_at: now,
            completed_at: now,
            status: 'completed',
            terraform_path: dir,
            total_resources: securityResult?.resources_scanned ?? 0,
            total_cost: 0,
            total_recommendations: allFindings.length,
            total_savings: 0,
            scenario_a_count: 0,
            scenario_b_count: 0,
            scenario_c_count: 0,
          });

          const recs: Recommendation[] = allFindings.map((f) => ({
            id: crypto.randomUUID(),
            scan_id: scanId,
            resource_id: f.resource,
            resource_type: f.resource_type ?? null,
            type: f.ruleId,
            title: f.title,
            description: f.description,
            reasoning: f.description,
            impact: f.severity,
            risk: f.severity,
            patch_content: f.recommendation ?? null,
            file_path: f.filePath ?? null,
            estimated_savings: 0,
            confidence: 0.9,
            quality_score: 80,
          }));

          upsertRecommendations(db, scanId, recs);

          return { scan_id: scanId, saved_count: recs.length };
        } catch {
          // Silent failure — DB errors must not break the security display
          return {};
        }
      },
    },
  ];
}

/** Extract security findings from pipeline context. */
export function extractSecurityFindings(ctx: PipelineContext, severityFilter?: string | null): {
  findings: Array<{
    id: string;
    title: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    resource: string;
    description: string;
    remediation: string;
    filePath?: string | null;
  }>;
  totalCount: number;
  bySeverity: Record<string, number>;
} {
  const result = ctx.results.get('security') as {
    findings?: Record<string, Array<Record<string, unknown>>> | Array<Record<string, unknown>>;
    findingCount?: number;
  } | undefined;

  const rawFindings: Array<Record<string, unknown>> = !result?.findings
    ? []
    : Array.isArray(result.findings)
      ? result.findings
      : Object.values(result.findings).flat();
  const severityOrder = ['critical', 'high', 'medium', 'low'];

  let findings = rawFindings.map((f) => ({
    id: asStr(f['id']) || asStr(f['ruleId']),
    title: asStr(f['title']) || asStr(f['message']),
    severity: (severityOrder.includes(asStr(f['severity'])) ? f['severity'] : 'medium') as 'critical' | 'high' | 'medium' | 'low',
    resource: asStr(f['resource']) || asStr(f['resourceId']),
    description: asStr(f['description']),
    remediation: asStr(f['recommendation']) || asStr(f['remediation']),
    filePath: f['filePath'] !== null && f['filePath'] !== undefined ? asStr(f['filePath']) : f['file_path'] !== null && f['file_path'] !== undefined ? asStr(f['file_path']) : null,
  }));

  // Apply severity filter
  if (severityFilter && severityOrder.includes(severityFilter)) {
    const minIdx = severityOrder.indexOf(severityFilter);
    findings = findings.filter((f) => severityOrder.indexOf(f.severity) <= minIdx);
  }

  // Count by severity
  const bySeverity: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }

  // Sort by severity
  findings.sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity));

  return { findings, totalCount: findings.length, bySeverity };
}
