import { describe, it, expect } from 'vitest';
import { extractNextToken, buildCmdOptions } from '../../../src/aws/utils.js';

// ─── extractNextToken ─────────────────────────────────────────────────────────

describe('extractNextToken', () => {
  it('returns undefined when token is undefined', () => {
    expect(extractNextToken(undefined)).toBeUndefined();
  });

  it('returns undefined when token is an empty string', () => {
    expect(extractNextToken('')).toBeUndefined();
  });

  it('returns undefined when token is whitespace-only', () => {
    expect(extractNextToken('   ')).toBeUndefined();
    expect(extractNextToken('\t')).toBeUndefined();
    expect(extractNextToken('\n')).toBeUndefined();
  });

  it('returns the token unchanged when it is a non-empty string', () => {
    expect(extractNextToken('abc')).toBe('abc');
    expect(extractNextToken('token123')).toBe('token123');
  });

  it('preserves surrounding whitespace (does not trim the returned value)', () => {
    // The function checks if trimmed is empty, but returns the original
    expect(extractNextToken('  abc  ')).toBe('  abc  ');
    expect(extractNextToken('\ttoken\t')).toBe('\ttoken\t');
  });

  it('returns non-empty strings with internal whitespace', () => {
    expect(extractNextToken('token with spaces')).toBe('token with spaces');
    expect(extractNextToken('next:123')).toBe('next:123');
  });
});

// ─── buildCmdOptions ──────────────────────────────────────────────────────────

describe('buildCmdOptions', () => {
  it('returns empty object when called with no arguments', () => {
    expect(buildCmdOptions()).toEqual({});
  });

  it('returns empty object when passed undefined', () => {
    expect(buildCmdOptions(undefined)).toEqual({});
  });

  it('returns object with abortSignal property when passed an AbortSignal', () => {
    const controller = new AbortController();
    const result = buildCmdOptions(controller.signal);

    expect(result).toEqual({ abortSignal: controller.signal });
    expect(result['abortSignal']).toBe(controller.signal);
  });

  it('includes abortSignal even when signal is aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const result = buildCmdOptions(controller.signal);

    expect(result).toEqual({ abortSignal: controller.signal });
    expect(result['abortSignal']?.aborted).toBe(true);
  });
});
