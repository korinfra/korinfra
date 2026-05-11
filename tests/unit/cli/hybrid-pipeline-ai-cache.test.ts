/**
 * Tests for the exported `deriveAiStatus` pure function from HybridPipeline.
 * Covers every branch: running, off, no-fingerprint, cache hit, view-drift stale,
 * done-no-cache, fallback, and error fall-through.
 */

import { deriveAiStatus } from '../../../src/cli/components/HybridPipeline.js';
import type { AiStatus } from '../../../src/cli/components/HybridPipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCache(
  entries: Array<[string, { fingerprint: string }]> = [],
): Map<string, { fingerprint: string }> {
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Branch: status is 'analyzing' → ai-running
// ---------------------------------------------------------------------------

describe('deriveAiStatus — ai-running', () => {
  it('returns ai-running when status is analyzing', () => {
    const result: AiStatus = deriveAiStatus({
      status: 'analyzing',
      datasetFingerprint: 'fp-1',
      viewFingerprint: 'fp-1',
      aiInsightCache: makeCache(),
    });
    expect(result).toBe('ai-running');
  });
});

// ---------------------------------------------------------------------------
// Branch: status is 'awaiting-activation' or 'confirming' → ai-off
// ---------------------------------------------------------------------------

describe('deriveAiStatus — ai-off (deferred / confirming)', () => {
  it('returns ai-off when status is awaiting-activation', () => {
    expect(
      deriveAiStatus({
        status: 'awaiting-activation',
        datasetFingerprint: 'fp-1',
        viewFingerprint: 'fp-1',
        aiInsightCache: makeCache(),
      }),
    ).toBe('ai-off');
  });

  it('returns ai-off when status is confirming', () => {
    expect(
      deriveAiStatus({
        status: 'confirming',
        datasetFingerprint: 'fp-1',
        viewFingerprint: 'fp-1',
        aiInsightCache: makeCache(),
      }),
    ).toBe('ai-off');
  });

  it('returns ai-off when no fingerprint is provided (collecting)', () => {
    expect(
      deriveAiStatus({
        status: 'collecting',
        datasetFingerprint: undefined,
        viewFingerprint: undefined,
        aiInsightCache: makeCache(),
      }),
    ).toBe('ai-off');
  });
});

// ---------------------------------------------------------------------------
// Branch: cache hit, view matches → ai-cached
// ---------------------------------------------------------------------------

describe('deriveAiStatus — ai-cached (cache hit)', () => {
  it('returns ai-cached when datasetFingerprint is in cache and view fingerprint matches', () => {
    const cache = makeCache([['ds-1', { fingerprint: 'view-1' }]]);
    expect(
      deriveAiStatus({
        status: 'done',
        datasetFingerprint: 'ds-1',
        viewFingerprint: 'view-1',
        aiInsightCache: cache,
      }),
    ).toBe('ai-cached');
  });

  it('returns ai-cached when only viewFingerprint is given and it is cached', () => {
    const cache = makeCache([['view-only', { fingerprint: 'view-only' }]]);
    expect(
      deriveAiStatus({
        status: 'collecting',
        datasetFingerprint: undefined,
        viewFingerprint: 'view-only',
        aiInsightCache: cache,
      }),
    ).toBe('ai-cached');
  });

  it('returns ai-cached when status is done with fingerprint but no cache entry (done short-circuits)', () => {
    expect(
      deriveAiStatus({
        status: 'done',
        datasetFingerprint: 'ds-2',
        viewFingerprint: undefined,
        aiInsightCache: makeCache(),
      }),
    ).toBe('ai-cached');
  });
});

// ---------------------------------------------------------------------------
// Branch: cache hit but view drifted → ai-stale
// ---------------------------------------------------------------------------

describe('deriveAiStatus — ai-stale (view drift)', () => {
  it('returns ai-stale when view fingerprint changed but dataset fingerprint is cached', () => {
    // The cache entry has the old view fingerprint
    const cache = makeCache([['ds-3', { fingerprint: 'old-view' }]]);
    expect(
      deriveAiStatus({
        status: 'collecting',
        datasetFingerprint: 'ds-3',
        viewFingerprint: 'new-view',   // different from cached.fingerprint
        aiInsightCache: cache,
      }),
    ).toBe('ai-stale');
  });

  it('returns ai-stale when status is error with fingerprint and no cache entry (fall-through)', () => {
    expect(
      deriveAiStatus({
        status: 'error',
        datasetFingerprint: 'ds-4',
        viewFingerprint: undefined,
        aiInsightCache: makeCache(),
      }),
    ).toBe('ai-stale');
  });

  it('returns ai-stale when status is collecting with fingerprint and no cache entry', () => {
    expect(
      deriveAiStatus({
        status: 'collecting',
        datasetFingerprint: 'ds-5',
        viewFingerprint: undefined,
        aiInsightCache: makeCache(),
      }),
    ).toBe('ai-stale');
  });
});

// ---------------------------------------------------------------------------
// Branch: fallback → ai-unavailable
// ---------------------------------------------------------------------------

describe('deriveAiStatus — ai-unavailable', () => {
  it('returns ai-unavailable when status is fallback and fingerprint has no cache entry', () => {
    expect(
      deriveAiStatus({
        status: 'fallback',
        datasetFingerprint: 'ds-6',
        viewFingerprint: undefined,
        aiInsightCache: makeCache(),
      }),
    ).toBe('ai-unavailable');
  });
});
