/**
 * Tests for src/aws/credentials.ts — credential resolution and region logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockRateLimiter } from '../../helpers/mock-rate-limiter.js';

const mockCredentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'test' };

const fromIniMock = vi.fn().mockReturnValue(mockCredentials);
const fromNodeProviderChainMock = vi.fn().mockReturnValue(mockCredentials);
const fromTemporaryCredentialsMock = vi.fn().mockReturnValue(mockCredentials);

vi.mock('@aws-sdk/credential-providers', () => ({
  fromIni: (...args: unknown[]) => fromIniMock(...args),
  fromNodeProviderChain: (...args: unknown[]) => fromNodeProviderChainMock(...args),
  fromTemporaryCredentials: (...args: unknown[]) => fromTemporaryCredentialsMock(...args),
}));

const mockSTSSend = vi.fn().mockResolvedValue({
  Account: '123456789012',
  Arn: 'arn:aws:iam::123456789012:user/korinfra',
  UserId: 'AIDAIOSFODNN7EXAMPLE',
});

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(function () { return { send: mockSTSSend }; }),
  GetCallerIdentityCommand: vi.fn().mockImplementation(function () { return {}; }),
}));

vi.mock('../../../src/aws/rate-limiter.js', async () => createMockRateLimiter());

import { getCredentials, resolveRegion, testConnection } from '../../../src/aws/credentials.js';
import type { CollectorConfig } from '../../../src/aws/types.js';

function makeConfig(overrides: Partial<CollectorConfig> = {}): CollectorConfig {
  return { regions: ['us-east-1'], ...overrides };
}

// ---------------------------------------------------------------------------
// getCredentials
// ---------------------------------------------------------------------------

describe('getCredentials — profile selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('selects fromIni for explicit profile, env profile, and fromNodeProviderChain when unset', () => {
    getCredentials(makeConfig({ profile: 'prod' }));
    expect(fromIniMock).toHaveBeenCalledWith({ profile: 'prod' });

    vi.clearAllMocks();
    vi.stubEnv('AWS_PROFILE', 'staging');
    getCredentials(makeConfig({ profile: undefined }));
    expect(fromIniMock).toHaveBeenCalledWith({ profile: 'staging' });

    vi.unstubAllEnvs();
    vi.clearAllMocks();
    getCredentials(makeConfig({ profile: undefined }));
    expect(fromNodeProviderChainMock).toHaveBeenCalled();
  });

  it('wraps with fromTemporaryCredentials when roleArn is set, includes ExternalId when provided, omits when absent', () => {
    getCredentials(makeConfig({ profile: 'default', roleArn: 'arn:aws:iam::123456789012:role/korinfraRole' }));
    expect(fromTemporaryCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          RoleArn: 'arn:aws:iam::123456789012:role/korinfraRole',
          RoleSessionName: 'korinfra-session',
        }),
      }),
    );

    vi.clearAllMocks();
    getCredentials(makeConfig({ roleArn: 'arn:aws:iam::123456789012:role/korinfraRole', externalId: 'ext-abc123' }));
    expect(fromTemporaryCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ ExternalId: 'ext-abc123' }) }),
    );

    vi.clearAllMocks();
    getCredentials(makeConfig({ roleArn: 'arn:aws:iam::999999999999:role/CrossAccountRole' }));
    const call = fromTemporaryCredentialsMock.mock.calls[0]![0] as { params: Record<string, unknown> };
    expect(call.params['ExternalId']).toBeUndefined();

    vi.clearAllMocks();
    getCredentials(makeConfig({ profile: 'default' }));
    expect(fromTemporaryCredentialsMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveRegion
// ---------------------------------------------------------------------------

describe('resolveRegion', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves region with correct priority: config > AWS_REGION > AWS_DEFAULT_REGION > default', () => {
    expect(resolveRegion(makeConfig({ regions: ['eu-west-1', 'us-east-1'] }))).toBe('eu-west-1');

    vi.stubEnv('AWS_REGION', 'ap-southeast-1');
    expect(resolveRegion(makeConfig({ regions: [] }))).toBe('ap-southeast-1');
    vi.unstubAllEnvs();

    vi.stubEnv('AWS_DEFAULT_REGION', 'ca-central-1');
    expect(resolveRegion(makeConfig({ regions: [] }))).toBe('ca-central-1');
    vi.unstubAllEnvs();

    expect(resolveRegion(makeConfig({ regions: [] }))).toBe('us-east-1');

    vi.stubEnv('AWS_REGION', 'eu-central-1');
    expect(resolveRegion(makeConfig({ regions: ['us-west-2'] }))).toBe('us-west-2');
  });
});

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('testConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns caller identity from STS and uses resolved region for STS client', async () => {
    const identity = await testConnection(makeConfig({ regions: ['us-east-1'] }));
    expect(identity.account).toBe('123456789012');
    expect(identity.arn).toBe('arn:aws:iam::123456789012:user/korinfra');
    expect(identity.userId).toBe('AIDAIOSFODNN7EXAMPLE');

    const { STSClient } = await import('@aws-sdk/client-sts');
    vi.clearAllMocks();
    await testConnection(makeConfig({ regions: ['eu-west-1'] }));
    expect(STSClient).toHaveBeenCalledWith(expect.objectContaining({ region: 'eu-west-1' }));
  });

  it('handles empty STS response, propagates errors, and respects abort signal', async () => {
    mockSTSSend.mockResolvedValueOnce({ Account: undefined, Arn: undefined, UserId: undefined });
    const identity = await testConnection(makeConfig());
    expect(identity.account).toBe('');
    expect(identity.arn).toBe('');
    expect(identity.userId).toBe('');

    mockSTSSend.mockRejectedValueOnce(new Error('InvalidClientTokenId'));
    await expect(testConnection(makeConfig())).rejects.toThrow('InvalidClientTokenId');

    const controller = new AbortController();
    controller.abort();
    mockSTSSend.mockResolvedValueOnce({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/ci', UserId: 'AIDATEST' });
    const abortedIdentity = await testConnection(makeConfig(), controller.signal);
    expect(abortedIdentity.account).toBe('123456789012');
  });
});
