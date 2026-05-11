import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  logApiCall,
  flushApiCallLog,
  getApiCallLog,
  getRateLimiter,
  throttledCall,
} from '../../../src/aws/rate-limiter.js';
import type { ApiCallRecord } from '../../../src/aws/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<ApiCallRecord> = {}): ApiCallRecord {
  return {
    service: 'ec2',
    operation: 'DescribeInstances',
    region: 'us-east-1',
    timestamp: new Date().toISOString(),
    durationMs: 45,
    estimatedCost: 0,
    ...overrides,
  };
}

// ── logApiCall / getApiCallLog / flushApiCallLog ──────────────────────────────

describe('API call log', () => {
  beforeEach(() => {
    flushApiCallLog();
  });

  it('logs records and retrieves them with correct fields', () => {
    const rec = makeRecord({ service: 'rds', operation: 'DescribeDBInstances', region: 'us-west-2' });
    logApiCall(rec);
    const log = getApiCallLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ service: 'rds', operation: 'DescribeDBInstances', region: 'us-west-2' });

    // Verify all required fields are present
    logApiCall(makeRecord());
    const entry = getApiCallLog()[1]!;
    expect(entry.service).toBe('ec2');
    expect(entry.operation).toBe('DescribeInstances');
    expect(entry.region).toBe('us-east-1');
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof entry.estimatedCost).toBe('number');
  });

  it('accumulates multiple records, logs optional error, flushes cleanly', () => {
    logApiCall(makeRecord({ service: 'ec2' }));
    logApiCall(makeRecord({ service: 'rds', error: 'ThrottlingException: Rate exceeded' }));
    logApiCall(makeRecord({ service: 's3' }));
    expect(getApiCallLog()).toHaveLength(3);
    expect(getApiCallLog()[1]!.error).toBe('ThrottlingException: Rate exceeded');

    const flushed = flushApiCallLog();
    expect(flushed).toHaveLength(3);
    expect(getApiCallLog()).toHaveLength(0);
    expect(flushApiCallLog()).toEqual([]);
  });

  it('does not exceed MAX_LOG_SIZE and removes oldest entries on truncation', () => {
    for (let i = 0; i < 10_001; i++) {
      logApiCall(makeRecord({ operation: `Op${i}` }));
    }
    const log = getApiCallLog();
    expect(log.length).toBeLessThanOrEqual(10_000);
    expect(log[log.length - 1]!.operation).toBe('Op10000');
    expect(log.find(r => r.operation === 'Op0')).toBeUndefined();
  });
});

// ── getRateLimiter ────────────────────────────────────────────────────────────

describe('getRateLimiter', () => {
  it('returns a function that executes calls, propagates errors, and handles all service/region combos', async () => {
    const limiter = getRateLimiter('ec2', 'us-east-1');
    expect(typeof limiter).toBe('function');

    expect(await limiter(() => Promise.resolve('hello'))).toBe('hello');

    await expect(
      getRateLimiter('rds', 'eu-west-1')(() => Promise.reject(new Error('AWS error'))),
    ).rejects.toThrow('AWS error');

    // Different services and regions each get their own callable limiter
    const [r1, r2] = await Promise.all([
      getRateLimiter('cloudwatch', 'us-east-1')(() => Promise.resolve('us')),
      getRateLimiter('cloudwatch', 'eu-west-1')(() => Promise.resolve('eu')),
    ]);
    expect(r1).toBe('us');
    expect(r2).toBe('eu');

    // Case-insensitive
    const [lo, up] = await Promise.all([
      getRateLimiter('ec2', 'us-east-1')(() => Promise.resolve('lower')),
      getRateLimiter('EC2', 'us-east-1')(() => Promise.resolve('upper')),
    ]);
    expect(lo).toBe('lower');
    expect(up).toBe('upper');

    // Unknown service uses default rate limit
    expect(await getRateLimiter('unknown-service-xyz', 'us-east-1')(() => Promise.resolve(42))).toBe(42);
  });
});

// ── throttledCall ─────────────────────────────────────────────────────────────

describe('throttledCall', () => {
  beforeEach(() => {
    flushApiCallLog();
  });

  it('calls fn, returns result, and logs the API call on success', async () => {
    const result = await throttledCall('ec2', 'DescribeInstances', 'us-east-1', () =>
      Promise.resolve({ instances: ['i-001'] }),
    );
    expect(result).toEqual({ instances: ['i-001'] });

    await throttledCall('s3', 'ListBuckets', 'us-east-1', () => Promise.resolve([]));
    const rec = getApiCallLog().find(r => r.service === 's3' && r.operation === 'ListBuckets');
    expect(rec).toBeDefined();
    expect(rec!.region).toBe('us-east-1');
    expect(rec!.error).toBeUndefined();
  });

  it('logs correct fields including estimatedCost and durationMs', async () => {
    await throttledCall('rds', 'DescribeDBInstances', 'eu-central-1', () =>
      Promise.resolve('ok'), 0.001,
    );
    const rec = getApiCallLog().find(r => r.operation === 'DescribeDBInstances')!;
    expect(rec.service).toBe('rds');
    expect(rec.region).toBe('eu-central-1');
    expect(rec.estimatedCost).toBe(0.001);
    expect(rec.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rec.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not retry 4xx non-throttle errors, $metadata errors, or $retryable:false errors', async () => {
    let count1 = 0;
    await expect(throttledCall('iam', 'GetRole', 'us-east-1', () => {
      count1++;
      return Promise.reject(Object.assign(new Error('AccessDeniedException'), { name: 'AccessDeniedException' }));
    })).rejects.toThrow('AccessDeniedException');
    expect(count1).toBe(1);

    let count2 = 0;
    await expect(throttledCall('ec2', 'DescribeInstances', 'us-east-1', () => {
      count2++;
      return Promise.reject(Object.assign(new Error('ThrottlingException'), {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 429 },
      }));
    })).rejects.toThrow();
    expect(count2).toBe(1);

    let count3 = 0;
    await expect(throttledCall('ec2', 'RunInstances', 'us-east-1', () => {
      count3++;
      return Promise.reject(Object.assign(new Error('InvalidParameterValue'), {
        name: 'InvalidParameterValue',
        $retryable: false,
      }));
    })).rejects.toThrow();
    expect(count3).toBe(1);
  });

  it('retries throttle errors up to MAX_ATTEMPTS (3) and succeeds on retry', async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      // Attach .catch before running timers to avoid unhandled rejection warning
      const exhaustedAssertion = expect(
        throttledCall('ec2', 'DescribeInstances', 'us-east-1', () => {
          callCount++;
          return Promise.reject(Object.assign(new Error('ThrottlingException'), { name: 'ThrottlingException' }));
        }),
      ).rejects.toThrow('ThrottlingException');
      await vi.runAllTimersAsync();
      await exhaustedAssertion;
      expect(callCount).toBe(3);

      let retryCount = 0;
      const retryPromise = throttledCall('ec2', 'DescribeInstances', 'us-east-1', () => {
        retryCount++;
        if (retryCount < 2) {
          return Promise.reject(Object.assign(new Error('ThrottlingException'), { name: 'ThrottlingException' }));
        }
        return Promise.resolve('success');
      });
      await vi.runAllTimersAsync();
      const result = await retryPromise;
      expect(result).toBe('success');
      expect(retryCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('all known throttle error names trigger retry', async () => {
    vi.useFakeTimers();
    const throttleNames = [
      'ThrottlingException',
      'RequestLimitExceeded',
      'TooManyRequestsException',
      'Throttling',
      'RequestThrottled',
    ];

    try {
      for (const name of throttleNames) {
        let callCount = 0;
        // Start call before running timers so the promise is created first
        let resolveResult!: (v: string) => void;
        const resultCapture = new Promise<string>((res) => { resolveResult = res; });
        throttledCall('ec2', 'DescribeInstances', 'us-east-1', () => {
          callCount++;
          if (callCount < 2) {
            return Promise.reject(Object.assign(new Error(name), { name }));
          }
          resolveResult('ok');
          return Promise.resolve('ok');
        }).then(resolveResult, () => {/* handled */});
        await vi.runAllTimersAsync();
        const result = await resultCapture;
        expect(result, `should retry for ${name}`).toBe('ok');
        expect(callCount, `callCount for ${name}`).toBe(2);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs error when a non-throttle error is thrown', async () => {
    await expect(throttledCall('ec2', 'DescribeVpcs', 'ap-southeast-1', () =>
      Promise.reject(Object.assign(new Error('NetworkError'), { name: 'NetworkError' })),
    )).rejects.toThrow();
    const rec = getApiCallLog().find(r => r.operation === 'DescribeVpcs');
    expect(rec).toBeDefined();
    expect(rec!.error).toBeTruthy();
  });
});
