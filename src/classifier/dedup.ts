/**
 * Recommendation deduplication — ports Go internal/classifier/dedup.go.
 *
 * Removes duplicate recommendations arising from multiple sources (rules + AI),
 * merging alternatives and keeping the highest-quality record per resource+type.
 */

import type { Recommendation } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractResourceKey(r: Recommendation): string {
  return r.resourceId || `${r.id ?? ''}::${r.type ?? ''}::${r.title}`;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    const arr = m.get(k);
    if (arr) arr.push(item);
    else m.set(k, [item]);
  }
  return m;
}

/**
 * Merges alternatives into the best recommendation by appending their
 * descriptions and promoting the highest confidence/quality score.
 */
function mergeAlternatives(best: Recommendation, alternatives: Recommendation[]): Recommendation {
  if (alternatives.length === 0) return best;

  const altLines = alternatives.map(
    (a) =>
      `Alternative: ${a.title} (savings: $${(a.estimatedSavings ?? 0).toFixed(2)}/mo, confidence: ${Math.round((a.confidence ?? 0) * 100)}%)`,
  );

  let merged = { ...best };
  merged.description = [merged.description, ...altLines].join('\n\n');
  merged.alternatives = [...(merged.alternatives ?? []), ...altLines];

  for (const alt of alternatives) {
    if ((alt.confidence ?? 0) > (merged.confidence ?? 0)) {
      if (alt.confidence !== undefined) merged = { ...merged, confidence: alt.confidence };
    }
    if ((alt.qualityScore ?? 0) > (merged.qualityScore ?? 0)) {
      if (alt.qualityScore !== undefined) merged = { ...merged, qualityScore: alt.qualityScore };
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deduplicates recommendations from multiple sources.
 *
 * Algorithm:
 * 1. Group by resource ID.
 * 2. Within each group, sub-group by recommendation type.
 * 3. Sort by estimated savings desc, then quality score desc.
 * 4. Keep best, merge reasoning from alternatives.
 * 5. Cross-resource dedup to preserve stable ordering.
 */
export function deduplicateRecommendations(recs: Recommendation[]): Recommendation[] {
  if (recs.length <= 1) return recs;

  // Step 1: group by resource ID.
  const byResource = groupBy(recs, extractResourceKey);

  const intermediate: Recommendation[] = [];

  for (const group of byResource.values()) {
    // Step 2: sub-group by type.
    const byType = groupBy(group, (r) => r.type ?? '');

    for (const typeGroup of byType.values()) {
      // Step 3: sort by savings desc, then quality score desc.
      const sorted = [...typeGroup].sort((a, b) => {
        const savingsDiff = (b.estimatedSavings ?? 0) - (a.estimatedSavings ?? 0);
        if (savingsDiff !== 0) return savingsDiff;
        return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
      });

      const [best, ...rest] = sorted;
      if (!best) continue;

      // Step 4: keep best, merge alternatives.
      intermediate.push(mergeAlternatives(best, rest));
    }
  }

  return intermediate;
}
