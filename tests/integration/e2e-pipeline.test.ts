/**
 * End-to-end pipeline test — realistic AWS account data flowing through:
 *   1. Rules engine (cost rules fire on realistic resources)
 *   2. Classifier (match AWS ↔ Terraform resources)
 *   3. Drift detection (detect config differences)
 *   4. Anomaly detection (spot cost spikes)
 *   5. MCP tools (evaluate_rules, detect_cost_anomalies)
 *
 * Uses shared realistic fixtures — no AWS calls, no AI calls.
 */

import { describe, it, expect } from 'vitest';
import {
  makeRealisticAccount,
  ec2Production,
  ec2Idle,
  rdsProduction,
  rdsIdle,
  s3DataLake,
  s3Unencrypted,
} from '../fixtures/realistic-data.js';

// Rules
import { THRESHOLDS } from '../../src/rules/config.js';
import { checkEC2001, checkEC2003, checkEC2006, checkEC2012 } from '../../src/rules/cost/ec2.js';
import { checkRDS001, checkRDS002, checkRDS004, checkRDS005, checkRDS009, checkRDS013 } from '../../src/rules/cost/rds.js';
import { checkS3001, checkS3002, checkS3003, checkS3004 } from '../../src/rules/cost/s3.js';

// Classifier
import { classifyResources } from '../../src/classifier/matcher.js';
import { detectConfigDiffs } from '../../src/classifier/config-diff.js';
import { deduplicateRecommendations } from '../../src/classifier/dedup.js';
import { summarize } from '../../src/classifier/scenarios.js';

// Anomaly
import { detectAnomalies } from '../../src/anomaly/detector.js';
import { analyzeTrend } from '../../src/anomaly/trend.js';

// MCP tools
import { evaluateRulesTool } from '../../src/tools/evaluate-rules.js';
import { detectAnomalesTool } from '../../src/tools/detect-anomalies.js';

const cfg = THRESHOLDS;

// ─── Phase 1: Rules Engine ───────────────────────────────────────────────────

describe('Rules engine with realistic data', () => {
  it('detects idle EC2 instance', () => {
    const rec = checkEC2001(ec2Idle, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-001');
  });

  it('does NOT flag production EC2 as idle', () => {
    expect(checkEC2001(ec2Production, cfg)).toBeNull();
  });

  it('flags t3 as Graviton-eligible (m5/m6i are prev-gen, handled by EC2-003)', () => {
    // m5, m6i are in previousGenFamilies → EC2-003. Use t3 for Graviton test.
    const r = {
      ...ec2Production,
      instanceType: 't3.xlarge',
      configuration: { ...ec2Production.configuration, instance_family: 't3', instance_size: 'xlarge' },
    };
    const rec = checkEC2006(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-006');
  });

  it('flags IMDSv2 not enforced on production', () => {
    const rec = checkEC2012(ec2Production, cfg);
    expect(rec).not.toBeNull();
  });

  it('flags idle RDS by connections', () => {
    const rec = checkRDS009(rdsIdle, cfg);
    expect(rec).not.toBeNull();
  });

  it('flags RDS with excess storage', () => {
    const rec = checkRDS013(rdsProduction, cfg);
    expect(rec).not.toBeNull();
  });

  it('flags publicly accessible RDS', () => {
    const rec = checkRDS005(rdsIdle, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-005');
  });

  it('flags unencrypted RDS', () => {
    const rec = checkRDS004(rdsIdle, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-004');
  });

  it('flags production RDS without Multi-AZ', () => {
    // RDS-002 requires multi_az=false AND Environment=production
    const r = {
      ...rdsIdle,
      tags: { Environment: 'production' },
      configuration: { ...rdsIdle.configuration, multi_az: false },
    };
    expect(checkRDS002(r, cfg)).not.toBeNull();
  });

  it('flags S3 without encryption', () => {
    const rec = checkS3004(s3Unencrypted, cfg);
    expect(rec).not.toBeNull();
  });

  it('flags S3 without lifecycle', () => {
    const rec = checkS3001(s3Unencrypted, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('S3-001');
  });

  it('flags S3 without Intelligent-Tiering (has lifecycle)', () => {
    const rec = checkS3002(s3DataLake, cfg);
    expect(rec).not.toBeNull();
  });

  it('flags S3 without versioning', () => {
    const rec = checkS3003(s3Unencrypted, cfg);
    expect(rec).not.toBeNull();
  });

  it('runs multiple rules and produces unique recommendations', () => {
    const account = makeRealisticAccount();
    const allRecs = [];

    for (const r of account.resources) {
      for (const check of [checkEC2001, checkEC2003, checkEC2006, checkEC2012]) {
        const rec = check(r, cfg);
        if (rec) allRecs.push(rec);
      }
      for (const check of [checkRDS001, checkRDS002, checkRDS004, checkRDS005, checkRDS009, checkRDS013]) {
        const rec = check(r, cfg);
        if (rec) allRecs.push(rec);
      }
      for (const check of [checkS3001, checkS3002, checkS3003, checkS3004]) {
        const rec = check(r, cfg);
        if (rec) allRecs.push(rec);
      }
    }

    expect(allRecs.length).toBeGreaterThan(5);

    const deduped = deduplicateRecommendations(
      allRecs.map((r) => ({
        ...r,
        qualityScore: 0.8,
        alternatives: [],
      })),
    );
    // Dedup should reduce count but keep the best per resource
    expect(deduped.length).toBeLessThanOrEqual(allRecs.length);
    expect(deduped.length).toBeGreaterThan(0);

    // Verify unique rule per resource (no exact duplicates)
    const keys = deduped.map((r) => `${r.resourceId}:${r.ruleId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ─── Phase 2: Classifier ─────────────────────────────────────────────────────

describe('Classifier with realistic data', () => {
  it('classifies resources into scenarios A/B/C', () => {
    const account = makeRealisticAccount();
    const classification = classifyResources(
      account.resources,
      account.terraform,
      account.state,
    );

    // EC2 prod + RDS prod should match TF (Scenario B)
    expect(classification.matched.length).toBeGreaterThanOrEqual(2);

    // Some TF resources may not match any AWS resource (Scenario A = terraformOnly)
    // Some AWS resources may not match any TF resource (Scenario C = awsOnly)
    const totalClassified =
      classification.terraformOnly.length +
      classification.matched.length +
      classification.awsOnly.length;
    expect(totalClassified).toBeGreaterThan(0);
  });

  it('generates scenario recommendations', () => {
    const account = makeRealisticAccount();
    const classification = classifyResources(
      account.resources,
      account.terraform,
      account.state,
    );

    // Scenario recommendations only handle destroyed-in-AWS resources (edge case)
    // Normal Scenario A security recs come from generateTfSecurityRecommendations
    // Scenario C recs come from evaluate_rules cost recs via cost anomalies

    const summary = summarize(classification);
    expect(summary.totalResources).toBeGreaterThan(0);
    expect(summary.scenarioACount + summary.scenarioBCount + summary.scenarioCCount).toBeGreaterThan(0);
  });

  it('detects config diffs in matched pairs', () => {
    const account = makeRealisticAccount();
    const classification = classifyResources(
      account.resources,
      account.terraform,
      account.state,
    );

    // EC2 prod + RDS prod + S3 data-lake all match via ARN/name → guaranteed ≥1 matched pair
    expect(classification.matched.length).toBeGreaterThan(0);
    const withDiffs = detectConfigDiffs(classification.matched);
    // Each matched pair should have a configDiffs array (possibly empty)
    for (const pair of withDiffs) {
      expect(pair).toHaveProperty('configDiffs');
      expect(Array.isArray(pair.configDiffs)).toBe(true);
    }
  });
});

// ─── Phase 3: Anomaly Detection ──────────────────────────────────────────────

describe('Anomaly detection with realistic cost data', () => {
  it('detects the cost spike on day 22-23', () => {
    const data = makeRealisticAccount().costTimeSeries;
    const anomalies = detectAnomalies(data);

    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    // The $340 spike should be detected
    const spike = anomalies.find((a) => a.amount > 300);
    expect(spike).toBeDefined();
    expect(spike!.direction).toBe('spike');
  });

  it('analyzes upward trend from the spike', () => {
    const data = makeRealisticAccount().costTimeSeries;
    const trend = analyzeTrend(data.map((p) => ({ date: p.date, amount: p.amount })));

    expect(trend).toHaveProperty('slope');
    expect(trend).toHaveProperty('direction');
    expect(trend).toHaveProperty('r2');
    expect(trend.r2).toBeGreaterThanOrEqual(0);
    expect(trend.r2).toBeLessThanOrEqual(1);
  });
});

// ─── Phase 4: MCP Tools ─────────────────────────────────────────────────────

describe('MCP tools with realistic data', () => {
  it('evaluate_rules returns findings for realistic resources', async () => {
    const account = makeRealisticAccount();
    const result = await evaluateRulesTool.handler({
      resources: account.resources,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.recommendations).toBeDefined();
    expect(data.recommendations.length).toBeGreaterThan(0);
    expect(data.summary.resourcesEvaluated).toBe(account.resources.length);
    expect(data.summary.estimatedSavings).toBeGreaterThan(0);

    // Should find EC2-001 (idle), EC2-012 (IMDSv2), RDS-009, S3-004, etc.
    const ruleIds = data.recommendations.map((f: { ruleId: string }) => f.ruleId);
    expect(ruleIds).toContain('EC2-001');
    expect(ruleIds).toContain('S3-004');
  });

  // #44 Item 1: warnings emitted by strict-gated rules flow through evaluate_rules
  // to the JSON output, so dashboards and CI can surface skipped resources.
  it('evaluate_rules surfaces warnings for resources that strict-gated rules skipped', async () => {
    // An old EBS snapshot with no monthly_cost AND no size should trigger SNAP-001's
    // strict gate. Snapshots without size_gb let the pricing engine compute $0 and
    // skip enrichment (vs. ebs_volume which gets a baseline gp3 estimate).
    const orphanSnapshot = {
      id: 'snap-orphan-no-cost-no-size',
      arn: 'arn:aws:ec2:us-east-1:123456789012:snapshot/snap-orphan-no-cost-no-size',
      type: 'ebs_snapshot',
      name: 'orphan-no-cost-no-size',
      region: 'us-east-1',
      state: 'available',
      instanceType: '',
      tags: {},
      launchTime: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      collectedAt: new Date().toISOString(),
      configuration: { volume_id: 'vol-source-deleted' }, // no monthlyCost, no size_gb
    };
    const result = await evaluateRulesTool.handler({ resources: [orphanSnapshot] });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.warnings).toBeDefined();
    expect(data.warnings.length).toBeGreaterThanOrEqual(1);
    // EBS-002 emits the MISSING_COST warning; SNAP-001/002 emit MISSING_COST_AND_SIZE.
    const warningReasons = (data.warnings as Array<{ ruleId: string; reason: string }>).map((w) => w.reason);
    expect(warningReasons).toEqual(
      expect.arrayContaining(['monthly_cost missing or invalid']),
    );
    expect(warningReasons).toEqual(
      expect.arrayContaining(['monthly_cost missing and size_gb unavailable']),
    );
    expect(data.summary.warningCount).toBeGreaterThanOrEqual(1);
  });

  it('detect_cost_anomalies returns anomalies for realistic cost data', async () => {
    const data = makeRealisticAccount().costTimeSeries;
    const result = await detectAnomalesTool.handler({
      costData: data,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.anomalies).toBeDefined();
    expect(parsed.anomalies.length).toBeGreaterThanOrEqual(1);
    expect(parsed.trend).toBeDefined();
  });
});
