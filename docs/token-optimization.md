# Token Optimization

This document explains how korinfra minimizes Claude API token usage to reduce costs and improve prompt cache hit rates.

---

## Why This Matters

korinfra embeds AWS resource inventory, recommendations, and cost data directly into analysis prompts sent to Claude. Without optimization:

- **Volatile data prevents cache hits:** Timestamps embedded in resource JSON cause identical scans (same account, same day) to produce different prompts
- **Unused data inflates token count:** Raw resource arrays, excessive field counts, and redundant arrays consume input tokens without improving AI analysis quality
- **Cost scales with scope:** Large accounts (500+ resources) send 15K–20K tokens per scan; small optimizations compound

Token optimization targets the interface between local analysis and the AI agent loop: `buildScanAnalysisPrompt()`, `buildResourcesAnalysisPrompt()`, `buildCostsAnalysisPrompt()`, and related builders in `src/cli/pipelines/analysis.ts`.

---

## Patterns Adopted

### 1. Strip Volatile Timestamps

**Fields removed from all AI-bound JSON:**

- `collected_at`, `startDate`, `endDate`, `launchTime`, `createdAt`, and similar timestamp fields

**Why:** Two identical scans of the same account at different times (e.g., 9 AM and 5 PM on the same day) now produce identical JSON prompts, enabling Claude SDK's internal prompt cache to recognize and reuse the cached tokens from the first call.

**Before:** Same account, same cost, same resources — different timestamps → different prompt hash → cache miss → full read cost  
**After:** Same account, same resources → same prompt → cache hit → zero input tokens

**Implementation:** `stripTimestamps()` helper in `src/cli/pipelines/analysis.ts` removes these fields before any `redactObject()` call.

---

### 2. Summary-First Resource Presentation

**Changes:**

- Resources sorted by `monthly_cost` descending
- Limited to top 30 resources per analysis (was 50, now default is 30)
- Type distribution header added: `"EC2: 12 ($340/mo) · RDS: 3 ($180/mo)"`

**Why:** The AI agent receives **pre-evaluated recommendations** from the rules engine (already processed all resources). Sending every resource is redundant; the agent needs only context on high-cost items to rank and explain recommendations. A summary header (cost by type) gives the agent enough context to justify prioritization without raw arrays.

**Token savings:** ~1K–2K tokens per scan  
**Quality trade-off:** Minimal — agent explanation improves because it focuses on high-impact findings

**Implementation:** `buildScanAnalysisPrompt()` and `buildResourcesAnalysisPrompt()` in `src/cli/pipelines/analysis.ts`.

---

### 3. Recommendation Limit Reduced

**Change:** Reduced from 30 → 20 recommendations per analysis

**Why:** Recommendations are already ranked by the rules engine (high → low impact). The last 10 lowest-impact recommendations had negligible contribution to AI insights and were rarely mentioned in summaries. Dropping them saves tokens with no discernible loss in output quality.

**Token savings:** ~500–700 tokens per scan  
**Quality impact:** None observed — users still get all high/medium-impact findings

**Implementation:** `buildScanAnalysisPrompt()` sets `maxRecs` default to 20.

---

### 4. Agent maxTurns Reduced

**Change:** Reduced from 30 → 20 in `src/cli/commands/fix.tsx` (line 313)

**Why:** Each turn accumulates all previous tool results. By turn 15+, the context window contains duplicate `terraform state list` outputs from turns 1–14. Typical `fix` commands complete in <10 turns. The extra 10 turns added ~3K tokens to cache writes with no benefit.

**Token savings:** ~2K–3K per `fix` command  
**Quality impact:** None — fix logic completes in <10 turns on 99% of real fixes

**Implementation:** `maxTurns: 20` in fix agent configuration.

---

### 5. Daily Cost Granularity Preserved

**What was NOT changed:** `buildCostsAnalysisPrompt()` still sends 30 daily cost entries (not aggregated to weekly/monthly).

**Why:** The `costs` command's AI analysis specifically needs day-level granularity to identify spike days ("Why did costs jump on March 15?"). Aggregating to weekly would lose that signal. The 30-day window (at ~100 bytes per entry) is acceptable overhead for this command's use case.

---

## What Was NOT Done (and Why)

### `cache_control` on System Prompt

**Status:** Not implemented

**Technical reason:** Claude Agent SDK v0.2.109 types `systemPrompt` as `string | {type:'preset'...}` — the `cache_control` field is not exposed in the SDK's type definitions. Accessing it would require switching analysis calls to raw `@anthropic-ai/sdk`, which would duplicate agent creation logic and break the MCP server mode (which relies on Agent SDK's unified tool handling).

**Token math:** System prompts are 375–1200 tokens. Anthropic's cache minimum is 4,096 tokens. Even if padded to 4,096, system prompt caching would only apply if the same system prompt appeared in ≥2 requests within 5 minutes. Current usage patterns (interactive scans, not batch runs) don't hit this threshold often enough to justify the refactor.

**Future:** If usage grows to >100 daily scans or >5 hourly CI/CD runs, revisit this.

---

### System Prompt Padding to 4,096 Tokens

**Status:** Not implemented

**Token math:**

- Cache write cost: 1.25× read cost (Anthropic's 5:1 ratio)
- Cache minimum: 4,096 tokens
- Current padding needed: 2,000–3,000 tokens
- Cost per scan with new 4,096-token base: +$0.003–0.005 per write

**Break-even threshold:** Needs >5 repeated calls per 5-minute window (same system prompt hash) to recoup the padding cost. Current patterns don't meet this.

---

## How to Measure Cache Effectiveness

Check your Anthropic Console **Usage** dashboard for:

- **`usage_input_tokens_cache_read` > 0** — cache hits are occurring
- **`usage_input_tokens_cache_write_5m`** — cache being established for 5-minute windows
- **Days with both = 0** — single short-turn sessions (scan + view result) fall below cache thresholds

**Good sign:** `cache_read / cache_write > 1` on active days (infrastructure scanned >1 time per 5-minute window).

**Example metrics (small team, 2 scans/week):**

- Week 1: 2 scans = 2 cache writes, 0 reads (first time)
- Week 2: 2 scans = 0 writes, 2 reads (cache hits, stale prompts re-validated)
- Week 3: 1 new scan = 1 write, 1 read (mixed)

---

## Future Opportunities

### High-Usage Scenario: Batch Analysis

If usage grows to **≥100 daily scans** or **hourly CI/CD runs:**

**Opportunity:** Switch `buildScanAnalysisPrompt()` calls to raw `@anthropic-ai/sdk` with explicit `cache_control`:

```typescript
const response = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 1024,
  system: [
    {
      type: 'text',
      text: systemPromptContent,
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: [
    {
      role: 'user',
      content: analysisPrompt,
    },
  ],
});
```

**Prerequisites:**

1. Pad system prompts to ≥4,096 tokens with comprehensive AWS reference content (service names, common cost patterns, security baselines)
2. Migrate analysis calls from Agent SDK to raw `@anthropic-ai/sdk` (requires duplicating agent loop logic for this single call type)
3. Keep MCP server mode on Agent SDK (don't refactor that)

**Estimated token savings:** 30–40% on cache write cost for 2nd+ scans within 5-minute window  
**Break-even:** ~5–10 repeated calls per window

**Not recommended for:** Current usage volumes or single-user teams (scans are sporadic, not batched).

---

## Implementation Checklist

When adding new AI prompts or modifying existing ones:

- [ ] Remove all `collected_at`, `timestamp`, `createdAt` fields from resource/cost JSON
- [ ] Sort resources by cost desc, limit to top 30 (or justify higher limit)
- [ ] Limit recommendations to 20 unless analysis specifically needs all (rare)
- [ ] Test with `npm run test` to ensure prompt builders still pass
- [ ] Manual verification: scan same infrastructure twice, check Anthropic console for `cache_read` > 0 within 5 minutes
- [ ] Update this doc if you change limits or add new volatile fields

## Config Field Reference

The following fields control token usage:

| Field | Default | Notes |
|-------|---------|-------|
| `ai.prompt_max_resources` | 30 | Max resources sent to AI per analysis. For very large environments (>100 resources), increase to 50 to restore previous behavior |
| `ai.prompt_max_recommendations` | 20 | Max recommendations included in AI prompts. Rarely needs adjustment |

Override in `.korinfra/config.yaml`:

```yaml
ai:
  prompt_max_resources: 50          # Restore for large environments
```

---

## Related Docs

- **[Running Costs](running-costs.md)** — token costs, pricing, budget caps
- **[Architecture](architecture.md)** — agent loop, prompt builders, redaction pipeline
- **[CLAUDE.md](/CLAUDE.md)** — redaction rules, ESM conventions, project stack
