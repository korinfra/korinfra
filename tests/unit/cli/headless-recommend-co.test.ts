/**
 * Tests the `--source compute-optimizer` wiring in src/cli/headless.ts.
 *
 * Mocks the AWS SDK + credentials + config so the call exercises the actual
 * headless code path (parse flags → call tool → format output) without any
 * network or filesystem dependency.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── AWS SDK mock ────────────────────────────────────────────────────────────

interface MockCommand { __kind: string; input: unknown }
const sendImpls: Record<string, () => Promise<unknown>> = {};

function resetMocks(): void {
  sendImpls['GetEC2InstanceRecommendationsCommand'] = () => Promise.resolve({ instanceRecommendations: [] });
  sendImpls['GetAutoScalingGroupRecommendationsCommand'] = () => Promise.resolve({ autoScalingGroupRecommendations: [] });
  sendImpls['GetEBSVolumeRecommendationsCommand'] = () => Promise.resolve({ volumeRecommendations: [] });
  sendImpls['GetLambdaFunctionRecommendationsCommand'] = () => Promise.resolve({ lambdaFunctionRecommendations: [] });
  sendImpls['GetECSServiceRecommendationsCommand'] = () => Promise.resolve({ ecsServiceRecommendations: [] });
  sendImpls['GetRDSDatabaseRecommendationsCommand'] = () => Promise.resolve({ rdsDBRecommendations: [] });
}

vi.mock('@aws-sdk/client-compute-optimizer', () => {
  const make = (kind: string) =>
    vi.fn().mockImplementation(function (this: MockCommand, input: unknown) {
      this.__kind = kind;
      this.input = input;
    });
  return {
    ComputeOptimizerClient: vi.fn().mockImplementation(function (this: unknown) {
      return {
        send: vi.fn().mockImplementation((cmd: MockCommand) => {
          const fn = sendImpls[cmd.__kind];
          if (!fn) return Promise.resolve({});
          return fn();
        }),
      };
    }),
    GetEC2InstanceRecommendationsCommand: make('GetEC2InstanceRecommendationsCommand'),
    GetAutoScalingGroupRecommendationsCommand: make('GetAutoScalingGroupRecommendationsCommand'),
    GetEBSVolumeRecommendationsCommand: make('GetEBSVolumeRecommendationsCommand'),
    GetLambdaFunctionRecommendationsCommand: make('GetLambdaFunctionRecommendationsCommand'),
    GetECSServiceRecommendationsCommand: make('GetECSServiceRecommendationsCommand'),
    GetRDSDatabaseRecommendationsCommand: make('GetRDSDatabaseRecommendationsCommand'),
  };
});

vi.mock('../../../src/aws/credentials.js', () => ({
  getCredentials: vi.fn().mockReturnValue(async () => ({ accessKeyId: 'x', secretAccessKey: 'y' })),
  resolveRegion: vi.fn().mockReturnValue('us-east-1'),
}));

// loadConfig throws when no config file exists; make it return a sane default
// so we exercise the "with config" branch.
import type * as ConfigModule from '../../../src/config/index.js';
vi.mock('../../../src/config/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModule>();
  return {
    ...real,
    loadConfig: vi.fn().mockResolvedValue({
      version: 1,
      aws: { default_profile: '', default_region: 'us-east-1', profiles: {} },
      ai: { provider: 'none' },
      terraform: {},
      github: {},
      output: {},
      storage: {},
      scan: {},
      anomaly: {},
      quality: {},
      mcp: {},
    }),
  };
});

import { runHeadlessTextCommand, runJsonCommand } from '../../../src/cli/headless.js';

// ─── Stdout / stderr capture ─────────────────────────────────────────────────

let stdoutBuf = '';
let stderrBuf = '';
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;
let origExitCode: number | string | undefined;

beforeEach(() => {
  resetMocks();
  stdoutBuf = '';
  stderrBuf = '';
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  origExitCode = process.exitCode;
  process.stdout.write = ((chunk: unknown) => {
    stdoutBuf += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrBuf += String(chunk);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.exitCode = origExitCode;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runHeadlessTextCommand("recommend", [--source compute-optimizer])', () => {
  it('writes a CO-prefixed text summary on the happy path', async () => {
    sendImpls['GetEC2InstanceRecommendationsCommand'] = () => Promise.resolve({
      instanceRecommendations: [{
        instanceArn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-1',
        currentInstanceType: 'm5.xlarge',
        finding: 'Overprovisioned',
        currentPerformanceRisk: 'VeryLow',
        lookBackPeriodInDays: 14,
        recommendationOptions: [
          { rank: 1, instanceType: 'm6i.large', savingsOpportunity: { estimatedMonthlySavings: { value: 50 } } },
        ],
      }],
    });
    const result = await runHeadlessTextCommand('recommend', ['--source', 'compute-optimizer']);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('[Source: AWS Compute Optimizer]');
    expect(stdoutBuf).toContain('Recommendations: 1');
    expect(stdoutBuf).toContain('Overprovisioned');
    expect(stdoutBuf).toContain('ec2');
  });

  it('writes a helpful "not enabled" message on opt-in failure', async () => {
    const err = new Error('not opted in');
    (err as Error & { name: string }).name = 'OptInRequiredException';
    for (const k of Object.keys(sendImpls)) {
      sendImpls[k] = () => Promise.reject(err);
    }
    await runHeadlessTextCommand('recommend', ['--source', 'compute-optimizer']);
    expect(stdoutBuf).toContain('not enabled on this account');
    expect(stdoutBuf).toContain('enable in console');
  });

  it('writes the IAM-missing message on AccessDenied', async () => {
    const err = new Error('User: arn:aws:iam::111122223333:user/x is not authorized to perform: compute-optimizer:GetEC2InstanceRecommendations');
    (err as Error & { name: string }).name = 'AccessDeniedException';
    for (const k of Object.keys(sendImpls)) {
      sendImpls[k] = () => Promise.reject(err);
    }
    await runHeadlessTextCommand('recommend', ['--source', 'compute-optimizer']);
    expect(stdoutBuf).toContain('not authorized');
    expect(stdoutBuf).toContain('compute-optimizer:GetEC2InstanceRecommendations');
  });

  it('rejects unknown --source values with a 1 exit code', async () => {
    await runHeadlessTextCommand('recommend', ['--source', 'bogus']);
    expect(stdoutBuf).toContain("unknown --source value 'bogus'");
    expect(process.exitCode).toBe(1);
  });

  it('ignores --refresh when --source is set and emits a stderr note', async () => {
    await runHeadlessTextCommand('recommend', ['--source', 'compute-optimizer', '--refresh']);
    expect(stderrBuf).toContain('--refresh is ignored when --source is set');
    expect(stdoutBuf).toContain('[Source: AWS Compute Optimizer]');
  });
});

describe('runJsonCommand("recommend", [--source compute-optimizer])', () => {
  it('conforms to the existing JSON shape with a source discriminator', async () => {
    sendImpls['GetEC2InstanceRecommendationsCommand'] = () => Promise.resolve({
      instanceRecommendations: [{
        instanceArn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-1',
        currentInstanceType: 'm5.large',
        finding: 'Overprovisioned',
        currentPerformanceRisk: 'High',
        lookBackPeriodInDays: 14,
        recommendationOptions: [
          { rank: 1, instanceType: 'm6i.small', savingsOpportunity: { estimatedMonthlySavings: { value: 100 } } },
        ],
      }],
    });
    const code = await runJsonCommand('recommend', ['--source', 'compute-optimizer']);
    expect(code).toBe(0);
    const out = JSON.parse(stdoutBuf) as {
      command: string;
      source: string;
      status: string;
      summary: { total: number; critical: number; high: number; medium: number; low: number; estimatedMonthlySavingsUsd: number; byType: Record<string, number> };
      recommendations: unknown[];
      next: unknown[];
    };
    expect(out.command).toBe('recommend');
    expect(out.source).toBe('compute-optimizer');
    expect(out.status).toBe('ok');
    expect(out.summary.total).toBe(1);
    expect(out.summary.critical).toBe(1); // performanceRisk=High → critical
    expect(out.summary.high).toBe(0);
    expect(out.summary.byType['ec2']).toBe(1);
    expect(out.summary.estimatedMonthlySavingsUsd).toBeCloseTo(100, 2);
    expect(out.recommendations).toHaveLength(1);
  });

  it('exits 1 with --fail-on critical when performanceRisk=High is present', async () => {
    sendImpls['GetEC2InstanceRecommendationsCommand'] = () => Promise.resolve({
      instanceRecommendations: [{
        instanceArn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-1',
        currentInstanceType: 'm5.large',
        finding: 'Overprovisioned',
        currentPerformanceRisk: 'High',
        lookBackPeriodInDays: 14,
        recommendationOptions: [{ rank: 1, instanceType: 'm6i.small', savingsOpportunity: { estimatedMonthlySavings: { value: 100 } } }],
      }],
    });
    const code = await runJsonCommand('recommend', ['--source', 'compute-optimizer', '--fail-on', 'critical']);
    expect(code).toBe(1);
  });

  it('exits 0 with --fail-on critical when no performanceRisk=High is present', async () => {
    sendImpls['GetEC2InstanceRecommendationsCommand'] = () => Promise.resolve({
      instanceRecommendations: [{
        instanceArn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-1',
        currentInstanceType: 'm5.large',
        finding: 'Overprovisioned',
        currentPerformanceRisk: 'Medium',
        lookBackPeriodInDays: 14,
        recommendationOptions: [{ rank: 1, instanceType: 'm6i.small', savingsOpportunity: { estimatedMonthlySavings: { value: 100 } } }],
      }],
    });
    const code = await runJsonCommand('recommend', ['--source', 'compute-optimizer', '--fail-on', 'critical']);
    expect(code).toBe(0);
  });

  it('emits status:not_enabled with exit 0 on OptInRequired', async () => {
    const err = new Error('not opted in');
    (err as Error & { name: string }).name = 'OptInRequiredException';
    for (const k of Object.keys(sendImpls)) {
      sendImpls[k] = () => Promise.reject(err);
    }
    const code = await runJsonCommand('recommend', ['--source', 'compute-optimizer']);
    expect(code).toBe(0);
    const out = JSON.parse(stdoutBuf) as { status: string; source: string };
    expect(out.status).toBe('not_enabled');
    expect(out.source).toBe('compute-optimizer');
  });

  it('sorts recommendations descending by savings', async () => {
    sendImpls['GetEC2InstanceRecommendationsCommand'] = () => Promise.resolve({
      instanceRecommendations: [
        {
          instanceArn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-low',
          currentInstanceType: 'm5.small',
          finding: 'Overprovisioned',
          currentPerformanceRisk: 'Low',
          lookBackPeriodInDays: 14,
          recommendationOptions: [{ rank: 1, instanceType: 'm6i.nano', savingsOpportunity: { estimatedMonthlySavings: { value: 10 } } }],
        },
        {
          instanceArn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-high',
          currentInstanceType: 'm5.4xlarge',
          finding: 'Overprovisioned',
          currentPerformanceRisk: 'VeryLow',
          lookBackPeriodInDays: 14,
          recommendationOptions: [{ rank: 1, instanceType: 'm6i.large', savingsOpportunity: { estimatedMonthlySavings: { value: 500 } } }],
        },
      ],
    });
    await runJsonCommand('recommend', ['--source', 'compute-optimizer']);
    const out = JSON.parse(stdoutBuf) as { recommendations: Array<{ resourceArn: string; estimatedMonthlySavingsUsd: number }> };
    expect(out.recommendations).toHaveLength(2);
    expect(out.recommendations[0]!.estimatedMonthlySavingsUsd).toBe(500);
    expect(out.recommendations[1]!.estimatedMonthlySavingsUsd).toBe(10);
  });

  it('rejects unknown --source values with exit 1 and an error payload', async () => {
    const code = await runJsonCommand('recommend', ['--source', 'bogus']);
    expect(code).toBe(1);
    const out = JSON.parse(stdoutBuf) as { command: string; status: string; error: string };
    expect(out.status).toBe('error');
    expect(out.error).toContain("unknown --source value 'bogus'");
  });
});
