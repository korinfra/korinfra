import { describe, it, expect } from 'vitest';
import { extractNextToken, buildCmdOptions, tagsToMap, tagsToMapLower } from '../../../src/aws/utils.js';

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

// ─── tagsToMap / tagsToMapLower ───────────────────────────────────────────────

describe('tagsToMap', () => {
  it('returns empty object for undefined input', () => {
    expect(tagsToMap(undefined)).toEqual({});
  });

  it('returns empty object for empty array', () => {
    expect(tagsToMap([])).toEqual({});
  });

  it('converts well-formed tags to a plain key-value map', () => {
    expect(tagsToMap([
      { Key: 'Env', Value: 'prod' },
      { Key: 'Team', Value: 'platform' },
    ])).toEqual({ Env: 'prod', Team: 'platform' });
  });

  it('skips tags with undefined Key', () => {
    const result = tagsToMap([
      { Key: undefined, Value: 'orphan' },
      { Key: 'Name', Value: 'api' },
    ]);
    expect(result).toEqual({ Name: 'api' });
    expect(Object.keys(result)).toHaveLength(1);
  });

  // ─── Null / undefined Value regression ─────────────────────────────────────
  // AWS tags with a null or undefined Value must be OMITTED from the result map.
  // Old code stored '' via `?? ''`, making `'Key' in tags` return true for
  // tags that should be absent — hiding compliance violations.

  it('omits tags with undefined Value (compliance fix)', () => {
    const result = tagsToMap([{ Key: 'Environment', Value: undefined }]);
    expect(result).toEqual({});
    expect('Environment' in result).toBe(false);
  });

  it('omits tags with null Value (compliance fix)', () => {
    // AWS can return null for tags on some resource types
    const result = tagsToMap([{ Key: 'Environment', Value: null as unknown as undefined }]);
    expect(result).toEqual({});
    expect('Environment' in result).toBe(false);
  });

  it('omits undefined-Value tags but keeps tags with a real value', () => {
    const result = tagsToMap([
      { Key: 'MissingTag', Value: undefined },
      { Key: 'PresentTag', Value: 'yes' },
    ]);
    expect(result).toEqual({ PresentTag: 'yes' });
    expect('MissingTag' in result).toBe(false);
  });

  it('keeps tags whose Value is the empty string (explicitly set to "")', () => {
    const result = tagsToMap([{ Key: 'AllowedEmpty', Value: '' }]);
    expect(result).toEqual({ AllowedEmpty: '' });
  });
});

describe('tagsToMapLower', () => {
  it('converts lowercase-keyed tag objects', () => {
    expect(tagsToMapLower([
      { key: 'env', value: 'staging' },
      { key: 'app', value: 'backend' },
    ])).toEqual({ env: 'staging', app: 'backend' });
  });

  it('omits entries with undefined value (same rule as tagsToMap)', () => {
    const result = tagsToMapLower([
      { key: 'missing', value: undefined },
      { key: 'present', value: 'ok' },
    ]);
    expect(result).toEqual({ present: 'ok' });
    expect('missing' in result).toBe(false);
  });
});
