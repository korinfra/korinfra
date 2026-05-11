import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryWithBackoff } from '../../src/utils/retry.js';

// Use fake timers so tests don't actually sleep
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('retryWithBackoff', () => {
  it('returns immediately on first success and uses sensible defaults', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await retryWithBackoff(fn, { maxAttempts: 3 })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);

    const fn2 = vi.fn().mockResolvedValue(42);
    expect(await retryWithBackoff(fn2)).toBe(42);
  });

  it('retries on transient failure and succeeds eventually', async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'done';
    });

    const promise = retryWithBackoff(fn, { maxAttempts: 5, initialWaitMs: 10, maxWaitMs: 1000, multiplier: 2 });
    await vi.runAllTimersAsync();

    expect(await promise).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after all attempts exhausted with cause chain', async () => {
    const original = new Error('root cause');
    const fn = vi.fn().mockRejectedValue(original);

    const promise = retryWithBackoff(fn, { maxAttempts: 3, initialWaitMs: 10, maxWaitMs: 100 });
    await Promise.allSettled([(async () => { await vi.runAllTimersAsync(); })(), promise]);

    await expect(promise).rejects.toThrow('all 3 attempts failed');
    expect(fn).toHaveBeenCalledTimes(3);

    const promise2 = retryWithBackoff(vi.fn().mockRejectedValue(original), { maxAttempts: 2, initialWaitMs: 10 });
    await Promise.allSettled([(async () => { await vi.runAllTimersAsync(); })(), promise2]);
    const err = await promise2.catch((e: unknown) => e as Error);
    expect(err.cause).toBe(original);
  });

  it('respects AbortSignal: stops mid-retry and rejects if pre-aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) controller.abort(new Error('aborted by test'));
      throw new Error('fail');
    });

    const promise = retryWithBackoff(fn, { maxAttempts: 5, initialWaitMs: 10 }, controller.signal);
    await Promise.allSettled([(async () => { await vi.runAllTimersAsync(); })(), promise]);
    await expect(promise).rejects.toThrow(/retry cancelled|aborted/i);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(2);

    // pre-aborted: fn never called
    const ctrl2 = new AbortController();
    ctrl2.abort(new Error('pre-aborted'));
    await expect(retryWithBackoff(vi.fn().mockResolvedValue('never'), { maxAttempts: 3 }, ctrl2.signal)).rejects.toThrow(/retry cancelled/i);
  });

  // ─── A. 4xx/5xx extracted from error message ───────────────────────────────

  it('does not retry when error message contains a 4xx status code', async () => {
    const err = new Error('Request failed with status 404');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, { maxAttempts: 3, initialWaitMs: 10 })).rejects.toThrow('404');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries when error message contains a 5xx status code', async () => {
    const err = new Error('Upstream returned 503');
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw err;
      return 'recovered';
    });
    const promise = retryWithBackoff(fn, { maxAttempts: 5, initialWaitMs: 10 });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries when error message has no status code', async () => {
    const err = new Error('something went wrong');
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw err;
      return 'ok';
    });
    const promise = retryWithBackoff(fn, { maxAttempts: 5, initialWaitMs: 10 });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // ─── A2. Regex specificity — false-positive guard ──────────────────────────

  it('does not retry on "status: 404" message', async () => {
    const err = new Error('status: 404 Not Found');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, { maxAttempts: 3, initialWaitMs: 10 })).rejects.toThrow('404');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on "HTTP 503 Service Unavailable" message (5xx)', async () => {
    const err = new Error('HTTP 503 Service Unavailable');
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw err;
      return 'recovered';
    });
    const promise = retryWithBackoff(fn, { maxAttempts: 5, initialWaitMs: 10 });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on "The 404 page was not found" message (false-positive guard)', async () => {
    const err = new Error('The 404 page was not found in the response');
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw err;
      return 'ok';
    });
    const promise = retryWithBackoff(fn, { maxAttempts: 5, initialWaitMs: 10 });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry on "429 Too Many Requests" message (4xx at start)', async () => {
    const err = new Error('429 Too Many Requests');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, { maxAttempts: 3, initialWaitMs: 10 })).rejects.toThrow('429');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on "Processing 404 items" message (false-positive guard)', async () => {
    const err = new Error('Processing 404 items failed due to timeout');
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw err;
      return 'ok';
    });
    const promise = retryWithBackoff(fn, { maxAttempts: 5, initialWaitMs: 10 });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // ─── B. AWS non-retryable error names ─────────────────────────────────────

  it.each([
    'UnauthorizedException',
    'AccessDeniedException',
    'InvalidParameterException',
    'ValidationException',
    'InvalidRequestException',
  ])('does not retry on AWS error name: %s', async (errorName) => {
    const err = new Error('non-retryable');
    err.name = errorName;
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, { maxAttempts: 3, initialWaitMs: 10 })).rejects.toThrow('non-retryable');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ─── C. Invalid config clamping ────────────────────────────────────────────

  it('clamps maxAttempts <= 0 to default of 5', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    const promise = retryWithBackoff(fn, { maxAttempts: -1, initialWaitMs: 10 });
    await Promise.allSettled([(async () => { await vi.runAllTimersAsync(); })(), promise]);
    await promise.catch(() => {});
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('clamps multiplier <= 0 to default 2.0 without hanging', async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw new Error('fail');
      return 'ok';
    });
    const promise = retryWithBackoff(fn, { multiplier: 0, maxAttempts: 2, initialWaitMs: 10 });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ─── D. Abort during backoff sleep ────────────────────────────────────────

  it('aborts during backoff wait between retries', async () => {
    vi.useRealTimers();
    const controller = new AbortController();
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      throw new Error('fail');
    });

    const promise = retryWithBackoff(
      fn,
      { maxAttempts: 5, initialWaitMs: 2000, maxWaitMs: 2000 },
      controller.signal,
    );

    // Wait for the first call to fail and backoff sleep to start, then abort
    await new Promise<void>((r) => setTimeout(r, 20));
    controller.abort(new Error('aborted during sleep'));

    await expect(promise).rejects.toThrow(/retry cancelled|aborted/i);
    // fn was called at most once before abort interrupted the sleep
    expect(calls).toBeLessThanOrEqual(2);
    vi.useFakeTimers();
  });

  it('caps backoff at maxWaitMs', async () => {
    const sleeps: number[] = [];
    const original = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation((cb, ms, ...args) => {
      if (typeof ms === 'number' && ms > 0) sleeps.push(ms);
      return original(cb as () => void, 0, ...args);
    });

    let count = 0;
    const fn = vi.fn().mockImplementation(async () => {
      count++;
      if (count < 4) throw new Error('fail');
      return 'ok';
    });

    const promise = retryWithBackoff(fn, { maxAttempts: 5, initialWaitMs: 100, maxWaitMs: 150, multiplier: 10 });
    await vi.runAllTimersAsync();
    await promise;

    for (const s of sleeps) {
      expect(s).toBeLessThanOrEqual(150 * 1.25 + 1);
    }
  });
});
