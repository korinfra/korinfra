import { vi } from 'vitest';

export function createMockRateLimiter() {
  return {
    throttledCall: vi.fn().mockImplementation(
      async (_service: string, _operation: string, _region: string, fn: () => Promise<unknown>) => fn(),
    ),
    logApiCall: vi.fn(),
    flushApiCallLog: vi.fn().mockReturnValue([]),
    getApiCallLog: vi.fn().mockReturnValue([]),
    getRateLimiter: vi.fn().mockReturnValue((fn: () => Promise<unknown>) => fn()),
  };
}
