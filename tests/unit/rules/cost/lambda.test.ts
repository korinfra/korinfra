import { describe, it, expect } from 'vitest';
import {
  checkLAM001,
  checkLAM002,
  checkLAM003,
  checkLAM004,
  checkLAM005,
  checkLAM006,
} from '../../../../src/rules/cost/lambda.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeLambda(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'arn:aws:lambda:us-east-1:123456789012:function:my-function',
    arn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function',
    type: 'lambda_function',
    name: 'my-function',
    region: 'us-east-1',
    state: 'active',
    instanceType: '',
    tags: { Environment: 'prod', Team: 'platform' },
    launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: {},
    ...overrides,
  };
}

function makeUtil(invocations: number) {
  return {
    period: '30d' as const,
    cpuAverage: 0,
    cpuMax: 0,
    cpuP95: 0,
    cpuP99: 0,
    memoryAverage: 40,
    memoryMax: 60,
    memoryP95: 55,
    networkInMB: 0,
    networkOutMB: 0,
    invocations,
    diskReadIOPS: 0,
    diskWriteIOPS: 0,
    connectionCount: 0,
    connectionCountMax: 0,
    dataPoints: 100,
    dataGaps: 0,
    freshnessHrs: 1,
  };
}

// ─── LAM-001: Unused Lambda ───────────────────────────────────────────────────

describe('checkLAM001 — unused Lambda function (zero invocations)', () => {
  it('fires when invocations are zero', () => {
    const r = makeLambda({ utilization: makeUtil(0) });
    const rec = checkLAM001(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('LAM-001');
    expect(rec!.suggestedAction).toBe('delete_lambda');
    expect(rec!.currentConfig).toMatchObject({ invocation_count: 0 });
  });

  it('does not fire when invocations are above zero', () => {
    expect(checkLAM001(makeLambda({ utilization: makeUtil(100) }), cfg)).toBeNull();
    expect(checkLAM001(makeLambda({ utilization: makeUtil(1) }), cfg)).toBeNull();
  });

  it('does not fire when utilization is missing (conservative)', () => {
    expect(checkLAM001(makeLambda(), cfg)).toBeNull();
  });

  it('does not fire for non-lambda resource types', () => {
    const r = makeLambda({ type: 'ec2_instance', utilization: makeUtil(0) });
    expect(checkLAM001(r, cfg)).toBeNull();
  });
});

// ─── LAM-006: High error rate ─────────────────────────────────────────────────

describe('checkLAM006 — Lambda function with high error rate', () => {
  it('fires when error_rate_pct exceeds threshold', () => {
    const threshold = cfg.lambdaErrorRateThreshold; // 10.0
    const r = makeLambda({ configuration: { error_rate_pct: threshold + 5 } });
    const rec = checkLAM006(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('LAM-006');
    expect(rec!.suggestedAction).toBe('investigate_and_fix_errors');
    expect(rec!.currentConfig).toMatchObject({ error_rate_pct: threshold + 5 });
    expect(rec!.suggestedConfig).toMatchObject({ error_rate_pct: 0 });
  });

  it('does not fire when error_rate_pct is below threshold', () => {
    const r = makeLambda({ configuration: { error_rate_pct: 2.5 } });
    expect(checkLAM006(r, cfg)).toBeNull();
  });

  it('does not fire when error_rate_pct is missing from configuration (conservative)', () => {
    expect(checkLAM006(makeLambda({ configuration: {} }), cfg)).toBeNull();
    expect(checkLAM006(makeLambda({ configuration: { memory_mb: 512 } }), cfg)).toBeNull();
  });

  it('does not fire at exact threshold value (not strictly greater)', () => {
    const r = makeLambda({ configuration: { error_rate_pct: cfg.lambdaErrorRateThreshold } });
    expect(checkLAM006(r, cfg)).toBeNull();
  });

  it('does not fire for non-lambda resource types', () => {
    const r = makeLambda({ type: 'rds_instance', configuration: { error_rate_pct: 50 } });
    expect(checkLAM006(r, cfg)).toBeNull();
  });
});

// ─── LAM-005: ARM64 migration ─────────────────────────────────────────────────

describe('checkLAM005 — switch x86_64 to arm64 (Graviton)', () => {
  it('fires for x86_64 (plural or singular architecture field) with 20% savings', () => {
    const r1 = makeLambda({ configuration: { architectures: 'x86_64', memory_mb: 512, monthlyCost: 200 } });
    const rec1 = checkLAM005(r1, cfg);
    expect(rec1).not.toBeNull();
    expect(rec1!.ruleId).toBe('LAM-005');
    expect(rec1!.suggestedConfig).toMatchObject({ architectures: 'arm64' });
    expect(rec1!.estimatedSavings).toBeCloseTo(40, 1);

    const r2 = makeLambda({ configuration: { architecture: 'x86_64', memory_mb: 1024, monthlyCost: 80 } });
    expect(checkLAM005(r2, cfg)).not.toBeNull();
  });

  it('does not fire for arm64, no architecture, or already Graviton', () => {
    expect(checkLAM005(makeLambda({ configuration: { architectures: 'arm64', memory_mb: 512 } }), cfg)).toBeNull();
    expect(checkLAM005(makeLambda({ configuration: { memory_mb: 512, runtime: 'python3.12' } }), cfg)).toBeNull();
  });
});

// ─── LAM-002: Memory overprovisioning ─────────────────────────────────────────

describe('checkLAM002 — overprovisioned Lambda memory', () => {
  it('fires for high-memory functions with active invocations, halves memory', () => {
    const r1 = makeLambda({ configuration: { memory_mb: 1024, monthlyCost: 60 }, utilization: makeUtil(500) });
    const rec1 = checkLAM002(r1, cfg);
    expect(rec1).not.toBeNull();
    expect(rec1!.ruleId).toBe('LAM-002');
    expect(rec1!.suggestedConfig).toMatchObject({ memory_size: 512 });

    const r2 = makeLambda({ configuration: { memory_mb: 3008, monthlyCost: 300 }, utilization: makeUtil(1000) });
    const rec2 = checkLAM002(r2, cfg);
    expect(rec2!.currentConfig).toMatchObject({ memory_size: 3008 });
    expect(rec2!.suggestedConfig).toMatchObject({ memory_size: 1504 });

    // 10240 MB max → 5120
    const r3 = makeLambda({ configuration: { memory_mb: 10240, monthlyCost: 1000 }, utilization: makeUtil(100) });
    expect(checkLAM002(r3, cfg)!.suggestedConfig).toMatchObject({ memory_size: 5120 });

    // suggested memory >= 128 minimum
    const r4 = makeLambda({ configuration: { memory_mb: 512, monthlyCost: 20 }, utilization: makeUtil(200) });
    expect(checkLAM002(r4, cfg)!.suggestedConfig.memory_size).toBeGreaterThanOrEqual(128);
  });

  it('does not fire below 512 MB threshold, zero invocations, or missing utilization', () => {
    expect(checkLAM002(makeLambda({ configuration: { memory_mb: 256 }, utilization: makeUtil(5000) }), cfg)).toBeNull();
    expect(checkLAM002(makeLambda({ configuration: { memory_mb: 128 }, utilization: makeUtil(10000) }), cfg)).toBeNull();
    expect(checkLAM002(makeLambda({ configuration: { memory_mb: 2048 }, utilization: makeUtil(0) }), cfg)).toBeNull();
    expect(checkLAM002(makeLambda({ configuration: { memory_mb: 1024 } }), cfg)).toBeNull();
  });
});

// ─── LAM-003: Deprecated runtimes ─────────────────────────────────────────────

describe('checkLAM003 — deprecated Lambda runtime', () => {
  it('fires for all known deprecated runtimes and provides upgrade suggestion', () => {
    const deprecated = [
      'nodejs14.x', 'nodejs16.x', 'nodejs18.x', 'nodejs20.x', 'python3.8', 'python3.9', 'python3.10', 'python3.11', 'ruby2.7', 'ruby3.2',
      'go1.x', 'python2.7', 'nodejs12.x', 'nodejs10.x', 'python3.6',
      'python3.7', 'ruby2.5', 'java8', 'dotnetcore2.1', 'dotnetcore3.1', 'dotnet5.0', 'dotnet6', 'nodejs8.10', 'provided.al2',
    ] as const;
    for (const runtime of deprecated) {
      const r = makeLambda({ configuration: { runtime, memory_mb: 512 } });
      const rec = checkLAM003(r, cfg);
      expect(rec, `expected ${runtime} to fire`).not.toBeNull();
      expect(rec!.ruleId).toBe('LAM-003');
      expect(rec!.currentConfig).toMatchObject({ runtime });
      expect(rec!.suggestedConfig.runtime).toBeDefined();
    }
    // specific mapping: go1.x → provided.al2023
    expect(checkLAM003(makeLambda({ configuration: { runtime: 'go1.x', memory_mb: 512 } }), cfg)!
      .suggestedConfig).toMatchObject({ runtime: 'provided.al2023' });
  });

  it('does not fire for current runtimes or missing runtime key', () => {
    const current = [
      'nodejs22.x', 'python3.12', 'python3.13', 'ruby3.4',
      'java21', 'dotnet8', 'provided.al2023', 'java17', 'java11',
    ] as const;
    for (const runtime of current) {
      expect(checkLAM003(makeLambda({ configuration: { runtime, memory_mb: 512 } }), cfg)).toBeNull();
    }
    expect(checkLAM003(makeLambda({ configuration: { memory_mb: 512 } }), cfg)).toBeNull();
  });
});

// ─── LAM-004: Low-invocation functions ────────────────────────────────────────

describe('checkLAM004 — low-invocation Lambda with high memory', () => {
  it('fires for high-memory functions with low invocations and suggests reduced memory', () => {
    // <= 1024 MB → 256 MB suggestion
    const r1 = makeLambda({ configuration: { memory_mb: 1024, monthlyCost: 30 }, utilization: makeUtil(50) });
    const rec1 = checkLAM004(r1, cfg);
    expect(rec1).not.toBeNull();
    expect(rec1!.ruleId).toBe('LAM-004');
    expect(rec1!.suggestedConfig).toMatchObject({ memory_size: 256 });

    // > 1024 MB → 512 MB suggestion
    const r2 = makeLambda({ configuration: { memory_mb: 2048, monthlyCost: 50 }, utilization: makeUtil(10) });
    expect(checkLAM004(r2, cfg)!.suggestedConfig).toMatchObject({ memory_size: 512 });
  });

  it('does not fire when invocations >= threshold, memory <= 512, invocations = 0, or no utilization', () => {
    expect(checkLAM004(makeLambda({ configuration: { memory_mb: 1536 }, utilization: makeUtil(100) }), cfg)).toBeNull();
    expect(checkLAM004(makeLambda({ configuration: { memory_mb: 512 }, utilization: makeUtil(5) }), cfg)).toBeNull();
    expect(checkLAM004(makeLambda({ configuration: { memory_mb: 1024 }, utilization: makeUtil(0) }), cfg)).toBeNull();
    expect(checkLAM004(makeLambda({ configuration: { memory_mb: 2048 } }), cfg)).toBeNull();
    // High traffic — no fire
    expect(checkLAM004(makeLambda({ configuration: { memory_mb: 3008 }, utilization: makeUtil(200) }), cfg)).toBeNull();
  });

  it('normalizes invocations to monthly rate — 50 invocations in 7d = ~214/month, above 100 threshold → no fire', () => {
    // 50 raw invocations × (30/7) ≈ 214/month — well above cfg.lambdaLowInvocations (100)
    const r = makeLambda({
      configuration: { memory_mb: 1024 },
      utilization: { ...makeUtil(50), period: '7d' as const },
    });
    expect(checkLAM004(r, cfg)).toBeNull();
  });

  it('normalizes invocations to monthly rate — 20 invocations in 7d = ~86/month, below 100 threshold → fires', () => {
    // 20 raw × (30/7) ≈ 86/month — below threshold
    const r = makeLambda({
      configuration: { memory_mb: 1024 },
      utilization: { ...makeUtil(20), period: '7d' as const },
    });
    expect(checkLAM004(r, cfg)).not.toBeNull();
  });
});
