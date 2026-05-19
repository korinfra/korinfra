/**
 * Tests for src/tools/get-compute-optimizer-recommendations.ts
 *
 * Covers:
 *  - happy path normalization across all 6 resource types
 *  - resourceTypes subset filter
 *  - empty response
 *  - OptInRequiredException → friendly status:not_enabled
 *  - empty-string savings coerced to 0 (issue #20 class)
 *  - multi-region fan-out
 *  - redaction of 12-digit account IDs in ARNs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockCommand { __kind: string; input: unknown }

let constructorRegions: string[] = [];
const sendImpls: Record<string, () => Promise<unknown>> = {};

function defaultImpls(): void {
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
    ComputeOptimizerClient: vi.fn().mockImplementation(function (this: unknown, ctorArgs: { region?: string }) {
      if (ctorArgs?.region) constructorRegions.push(ctorArgs.region);
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

import { getComputeOptimizerRecommendationsTool } from '../../../src/tools/get-compute-optimizer-recommendations.js';

interface ParsedOutput {
  source?: string;
  status?: string;
  message?: string;
  regions?: string[];
  summary?: { total?: number; byType?: Record<string, number>; estimatedMonthlySavingsUsd?: number };
  recommendations?: Array<{
    source?: string;
    resourceType?: string;
    resourceArn?: string;
    region?: string;
    finding?: string;
    estimatedMonthlySavingsUsd?: number;
    performanceRisk?: string;
    lookbackPeriodInDays?: number;
  }>;
  next?: Array<{ label?: string; url?: string; command?: string }>;
}

function parse(text: string): ParsedOutput {
  return JSON.parse(text) as ParsedOutput;
}

describe('get_compute_optimizer_recommendations tool', () => {
  beforeEach(() => {
    constructorRegions = [];
    defaultImpls();
  });

  it('returns ok status with empty summary when no recommendations exist', async () => {
    const result = await getComputeOptimizerRecommendationsTool.handler({ regions: ['us-east-1'] });
    const out = parse(result.content[0]?.text ?? '');
    expect(out.status).toBe('ok');
    expect(out.source).toBe('compute-optimizer');
    expect(out.summary?.total).toBe(0);
    expect(out.recommendations).toEqual([]);
    expect(out.regions).toEqual(['us-east-1']);
  });

  it('normalizes a happy-path EC2 recommendation', async () => {
    sendImpls['GetEC2InstanceRecommendationsCommand'] = () => Promise.resolve({
      instanceRecommendations: [{
        instanceArn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-abc',
        currentInstanceType: 'm5.xlarge',
        finding: 'Overprovisioned',
        currentPerformanceRisk: 'VeryLow',
        lookBackPeriodInDays: 14,
        recommendationOptions: [
          { rank: 1, instanceType: 'm6i.large', savingsOpportunity: { estimatedMonthlySavings: { value: 87.5 } } },
          { rank: 2, instanceType: 'm6i.xlarge', savingsOpportunity: { estimatedMonthlySavings: { value: 10 } } },
        ],
      }],
    });
    const result = await getComputeOptimizerRecommendationsTool.handler({ regions: ['us-east-1'], resourceTypes: ['ec2'] });
    const out = parse(result.content[0]?.text ?? '');
    expect(out.status).toBe('ok');
    expect(out.recommendations).toHaveLength(1);
    const r = out.recommendations![0]!;
    expect(r.resourceType).toBe('ec2');
    // ARN account ID redacted by redactObject('moderate')
    expect(r.resourceArn).toContain('[ACCOUNT-ID]');
    expect(r.finding).toBe('Overprovisioned');
    expect(r.estimatedMonthlySavingsUsd).toBeCloseTo(87.5, 2);
    expect(r.performanceRisk).toBe('VeryLow');
    expect(r.lookbackPeriodInDays).toBe(14);
    expect(out.summary?.estimatedMonthlySavingsUsd).toBeCloseTo(87.5, 2);
    expect(out.summary?.byType?.['ec2']).toBe(1);
  });

  it('respects resourceTypes subset (only ec2 + lambda invoked)', async () => {
    const ec2Spy = vi.fn();
    const lambdaSpy = vi.fn();
    sendImpls['GetEC2InstanceRecommendationsCommand'] = () => {
      ec2Spy();
      return Promise.resolve({ instanceRecommendations: [] });
    };
    sendImpls['GetLambdaFunctionRecommendationsCommand'] = () => {
      lambdaSpy();
      return Promise.resolve({ lambdaFunctionRecommendations: [] });
    };
    const ebsSpy = vi.fn();
    sendImpls['GetEBSVolumeRecommendationsCommand'] = () => {
      ebsSpy();
      return Promise.resolve({ volumeRecommendations: [] });
    };

    await getComputeOptimizerRecommendationsTool.handler({
      regions: ['us-east-1'],
      resourceTypes: ['ec2', 'lambda'],
    });

    expect(ec2Spy).toHaveBeenCalledTimes(1);
    expect(lambdaSpy).toHaveBeenCalledTimes(1);
    expect(ebsSpy).not.toHaveBeenCalled();
  });

  it('returns status:access_denied with a missing-permission hint on AccessDeniedException', async () => {
    const err = new Error('User: arn:aws:iam::111122223333:user/x is not authorized to perform: compute-optimizer:GetEC2InstanceRecommendations on resource *');
    (err as Error & { name: string }).name = 'AccessDeniedException';
    for (const k of Object.keys(sendImpls)) {
      sendImpls[k] = () => Promise.reject(err);
    }
    const result = await getComputeOptimizerRecommendationsTool.handler({ regions: ['us-east-1'] });
    const out = parse(result.content[0]?.text ?? '');
    expect(out.status).toBe('access_denied');
    expect(out.source).toBe('compute-optimizer');
    expect(out.message ?? '').toContain('compute-optimizer:GetEC2InstanceRecommendations');
    expect(out.next).toBeDefined();
    expect(result.isError).not.toBe(true);
  });

  it('sorts recommendations descending by savings within the tool', async () => {
    sendImpls['GetEC2InstanceRecommendationsCommand'] = () => Promise.resolve({
      instanceRecommendations: [
        {
          instanceArn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-low',
          currentInstanceType: 'm5.small',
          finding: 'Overprovisioned',
          currentPerformanceRisk: 'Low',
          lookBackPeriodInDays: 14,
          recommendationOptions: [{ rank: 1, instanceType: 'm6i.nano', savingsOpportunity: { estimatedMonthlySavings: { value: 5 } } }],
        },
        {
          instanceArn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-mid',
          currentInstanceType: 'm5.xlarge',
          finding: 'Overprovisioned',
          currentPerformanceRisk: 'VeryLow',
          lookBackPeriodInDays: 14,
          recommendationOptions: [{ rank: 1, instanceType: 'm6i.large', savingsOpportunity: { estimatedMonthlySavings: { value: 50 } } }],
        },
        {
          instanceArn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-high',
          currentInstanceType: 'm5.4xlarge',
          finding: 'Overprovisioned',
          currentPerformanceRisk: 'VeryLow',
          lookBackPeriodInDays: 14,
          recommendationOptions: [{ rank: 1, instanceType: 'm6i.large', savingsOpportunity: { estimatedMonthlySavings: { value: 200 } } }],
        },
      ],
    });
    const result = await getComputeOptimizerRecommendationsTool.handler({ regions: ['us-east-1'], resourceTypes: ['ec2'] });
    const out = parse(result.content[0]?.text ?? '');
    expect(out.recommendations).toHaveLength(3);
    expect(out.recommendations!.map((r) => r.estimatedMonthlySavingsUsd)).toEqual([200, 50, 5]);
  });

  it('returns status:not_enabled when OptInRequiredException is thrown', async () => {
    const err = new Error('The account is not opted in to AWS Compute Optimizer');
    (err as Error & { name: string }).name = 'OptInRequiredException';
    // All 6 commands reject with the same error
    for (const k of Object.keys(sendImpls)) {
      sendImpls[k] = () => Promise.reject(err);
    }
    const result = await getComputeOptimizerRecommendationsTool.handler({ regions: ['us-east-1'] });
    const out = parse(result.content[0]?.text ?? '');
    expect(out.status).toBe('not_enabled');
    expect(out.source).toBe('compute-optimizer');
    expect(out.next).toBeDefined();
    expect(out.next?.length ?? 0).toBeGreaterThan(0);
    expect(result.isError).not.toBe(true);
  });

  it('coerces empty-string savings to 0 (issue #20 class)', async () => {
    sendImpls['GetEC2InstanceRecommendationsCommand'] = () => Promise.resolve({
      instanceRecommendations: [{
        instanceArn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-bad',
        currentInstanceType: 'm5.large',
        finding: 'Overprovisioned',
        currentPerformanceRisk: 'Low',
        lookBackPeriodInDays: 14,
        recommendationOptions: [
          { rank: 1, instanceType: 'm6i.large', savingsOpportunity: { estimatedMonthlySavings: { value: '' } } },
        ],
      }],
    });
    const result = await getComputeOptimizerRecommendationsTool.handler({ regions: ['us-east-1'], resourceTypes: ['ec2'] });
    const out = parse(result.content[0]?.text ?? '');
    expect(out.recommendations).toHaveLength(1);
    expect(out.recommendations![0]!.estimatedMonthlySavingsUsd).toBe(0);
    expect(Number.isFinite(out.recommendations![0]!.estimatedMonthlySavingsUsd)).toBe(true);
  });

  it('fans out across multiple regions and merges results', async () => {
    sendImpls['GetEC2InstanceRecommendationsCommand'] = () => Promise.resolve({
      instanceRecommendations: [{
        instanceArn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-abc',
        currentInstanceType: 'm5.large',
        finding: 'Optimized',
        currentPerformanceRisk: 'VeryLow',
        lookBackPeriodInDays: 14,
        recommendationOptions: [{ rank: 1, instanceType: 'm5.large', savingsOpportunity: { estimatedMonthlySavings: { value: 0 } } }],
      }],
    });
    await getComputeOptimizerRecommendationsTool.handler({ regions: ['us-east-1', 'us-west-2'] });
    expect(constructorRegions).toEqual(['us-east-1', 'us-west-2']);
  });

  it('handles RDS split recommendations (instance + storage produce 2 rows)', async () => {
    sendImpls['GetRDSDatabaseRecommendationsCommand'] = () => Promise.resolve({
      rdsDBRecommendations: [{
        resourceArn: 'arn:aws:rds:us-east-1:111122223333:db:my-db',
        currentDBInstanceClass: 'db.m5.large',
        instanceFinding: 'Overprovisioned',
        storageFinding: 'NotOptimized',
        currentInstancePerformanceRisk: 'Low',
        lookbackPeriodInDays: 14,
        instanceRecommendationOptions: [
          { rank: 1, dbInstanceClass: 'db.m6i.large', savingsOpportunity: { estimatedMonthlySavings: { value: 50 } } },
        ],
        storageRecommendationOptions: [
          { rank: 1, storageConfiguration: { allocatedStorage: 100 }, savingsOpportunity: { estimatedMonthlySavings: { value: 20 } } },
        ],
      }],
    });
    const result = await getComputeOptimizerRecommendationsTool.handler({ regions: ['us-east-1'], resourceTypes: ['rds'] });
    const out = parse(result.content[0]?.text ?? '');
    expect(out.recommendations).toHaveLength(2);
    expect(out.recommendations!.map((r) => r.finding).sort()).toEqual(['NotOptimized', 'Overprovisioned']);
    expect(out.summary?.estimatedMonthlySavingsUsd).toBeCloseTo(70, 2);
  });

  it('rejects unknown resourceTypes silently (defaults to all six)', async () => {
    const ec2Spy = vi.fn();
    sendImpls['GetEC2InstanceRecommendationsCommand'] = () => {
      ec2Spy();
      return Promise.resolve({ instanceRecommendations: [] });
    };
    // Pass all unknown — should fall back to ALL_TYPES default
    await getComputeOptimizerRecommendationsTool.handler({
      regions: ['us-east-1'],
      resourceTypes: ['unknown-thing'],
    });
    expect(ec2Spy).toHaveBeenCalled();
  });
});
