# Running Costs

This guide explains what it costs to run korinfra on your AWS account and with your chosen AI provider.

---

## TL;DR

**Typical monthly cost for a small/medium team:**

| Team Size | AWS API | AI (default model) | Total/month |
|-----------|---------|------------------|------------|
| **Small** (1 dev, 1 scan/week) | ~$0.08 | $0.04–0.10 | **~$0.20** |
| **Medium** (5 devs, 2 scans/week) | ~$0.32 | $0.20–0.50 | **~$1.00** |
| **Large** (20+ devs, daily scans + fixes) | ~$2.00 | $2.00–5.00 | **~$7.00** |

**Rules-only mode (no AI provider):** $0.00 cost. You lose AI-powered analysis and fix generation, but cost + security rules still work.

---

## AWS API Costs

Most AWS API calls that korinfra makes are **free**. Only **Cost Explorer** charges:

### Free API calls (per scan)

- **EC2:** `DescribeInstances`, `DescribeVolumes`, `DescribeAddresses`, `DescribeSnapshots` — free
- **RDS:** `DescribeDBInstances` — free
- **S3:** `ListBuckets` + per-bucket calls (`GetBucketLocation`, `GetBucketVersioning`, `GetBucketEncryption`, `GetBucketLifecycleConfiguration`, `GetBucketTagging`, `ListBucketIntelligentTieringConfigurations`) — all free
- **Lambda:** `ListFunctions`, `GetResources` — free
- **ECS:** `ListClusters`, `ListServices`, `DescribeServices`, `DescribeClusters` — free
- **ELB:** `DescribeLoadBalancers`, `DescribeTargetGroups`, `DescribeTargetHealth`, `DescribeTags` — free
- **ElastiCache:** `DescribeCacheClusters`, `ListTagsForResource` — free
- **DynamoDB:** `ListTables`, `DescribeTable`, `ListTagsOfResource` — free
- **NAT Gateway:** `DescribeNatGateways` — free
- **CloudWatch:** `GetMetricData`, `GetMetricStatistics` — free (1,000,000 free API requests/month; $0.01 per 1,000 requests above that)
- **Pricing API:** `GetProducts` — free
- **STS:** `GetCallerIdentity` — free
- **AWS Resource Groups Tagging API:** `GetResources`, `ListTagsForResource` — free

### Paid API calls

**Cost Explorer:** 2 × `GetCostAndUsage` per scan

- **Cost:** $0.01 per request → **$0.02 per scan** (when cache miss)
- **Cache TTL:** 6 hours (stored in `~/.korinfra/ce_cache.json`)
- **Repeat scans within 6h:** $0.00 (cache hit)

**Example:** Running 2 scans per week with staggered timing (cache hits on 1 of 2):

- Week 1: Scan 1 ($0.02) + Scan 2 cache hit ($0.00) = $0.02
- Week 2: Scan 1 cache hit ($0.00) + Scan 2 ($0.02) = $0.02
- **Monthly cost:** ~$0.08 (2 cache misses per month)

Large teams running many scans will get more cache hits:

- 10 scans/week, varied times: ~$0.08/month (Cost Explorer)
- Continuous CI/CD (hourly): First scan/hour hits cache, repeats free → ~$0.24/month

---

## AI Provider Costs

korinfra supports multiple AI providers. The default is **Claude Haiku** — fast and cheap. The model is configurable.

### Default model: Claude Haiku

**Model:** `claude-haiku-4-5-20251001` (fast, cheap)  
**Pricing:** ~$0.80/MTok input, ~$4.00/MTok output  
**Budget cap:** $0.50 per command (configurable via `ai.max_budget_usd` in your config file)

**Typical costs per command:**

| Command | Input tokens | Output tokens | Cost |
|---------|--------------|---------------|------|
| `scan` (8 resources) | 8K–12K | 2K–4K | $0.01–0.015 |
| `scan` (100+ resources) | 15K–20K | 4K–6K | $0.020–0.030 |
| `costs` (with analysis) | 6K–10K | 2K–3K | $0.008–0.012 |
| `recommend --refresh` | 5K–8K | 3K–5K | $0.010–0.018 |
| `fix` (Terraform patch) | 10K–18K | 2K–8K | $0.015–0.040 |
| `tags suggest` | 8K–12K | 3K–6K | $0.013–0.025 |
| `/` custom prompt | 6K–15K | 3K–8K | $0.012–0.040 |

**Monthly cost example (medium team, 2 scans + 1 fix per week):**

- 8 scans/month × $0.015 = $0.12
- 4 fixes/month × $0.025 = $0.10
- 4 tag suggestions/month × $0.018 = $0.07
- **Total: ~$0.29/month**

**Budget cap note:** The TUI agent caps at $0.50 per command by default (`ai.max_budget_usd`). If token usage exceeds that limit, the Agent SDK stops generating and returns partial results. This is a safety mechanism.

### Optional: Claude Sonnet (deeper analysis)

If you want more sophisticated reasoning for complex infrastructure:

**Model:** `claude-sonnet-4-6`  
**Pricing:** ~$3.00/MTok input, ~$15.00/MTok output (3–4× more expensive than Haiku)  
**Best for:** Complex cross-service optimizations, custom prompts

**Typical cost per scan:** $0.10–0.15 (vs. Haiku's $0.015)

Set in config:

```yaml
ai:
  model: claude-sonnet-4-6
```

### Other providers

Only Claude models are supported in v0.1.0. To disable AI entirely, set `provider: none` — all rules still run at $0.00 cost. [Follow progress on GitHub →](https://github.com/korinfra/korinfra/issues)

---

## Cost Control Levers

### 1. Use Rules-Only Mode (Zero AI Cost)

Set `provider: none` in your config:

```yaml
ai:
  provider: none
```

**What you get:** All 66 cost rules + 46 security rules, Terraform-aware matching, cost anomaly detection — all working without AI.

**What you lose:** AI-powered recommendations, natural language summaries, `fix` command, custom prompts.

**Savings:** 100% of AI costs → $0.00/month.

### 2. Narrow Scope (Fewer Resources)

Large accounts with 1000+ resources cost more to analyze (more input tokens).

Options:

```bash
korinfra scan --regions us-east-1,eu-west-1          # Scan only specific regions
korinfra scan --profile production                    # Scan only one AWS profile
korinfra resources --service ec2                      # Analyze only one service
```

**Impact:** Fewer resources → fewer input tokens → lower AI cost.

### 3. Use CloudWatch Cache (Faster Cost Explorer)

korinfra caches Cost Explorer data for 6 hours. Batching scans within that window avoids repeated $0.02 calls:

```bash
korinfra scan      # First scan: $0.02 CE cost
korinfra scan      # Within 6 hours: $0.00 CE cost
# Wait 6 hours
korinfra scan      # Next cycle: $0.02 CE cost
```

**Impact on CI/CD:** Run all korinfra commands within a 6-hour batch, not hourly. Daily scans + on-demand fixes minimize CE repeats.

### 4. Switch to Haiku (Already Default)

If you're using Sonnet, switching to Haiku saves 75% on AI costs:

```yaml
ai:
  model: claude-haiku-4-5-20251001  # ~$0.015 per scan
```

### 5. Set a Budget Cap

Set `ai.max_budget_usd` in your config to control per-command AI spend. The default is $0.50. Commands well within this limit (typical Haiku scan: $0.015) are unaffected. Raise it for complex accounts or Sonnet:

```yaml
ai:
  max_budget_usd: 2.00  # allow up to $2 per command
```

---

## Rules-Only Mode (Detailed)

korinfra works **completely without AI**. All deterministic analysis runs locally:

| Feature | Rules-Only | With AI |
|---------|-----------|---------|
| Resource collection | ✓ | ✓ |
| 66 cost rules | ✓ | ✓ |
| 46 security rules | ✓ | ✓ |
| Terraform-aware matching | ✓ | ✓ |
| Cost anomaly detection (z-score) | ✓ | ✓ |
| Cost trend forecasting | ✓ | ✓ |
| Natural language summaries | ✗ | ✓ |
| AI ranking of findings | ✗ | ✓ |
| `fix` (Terraform patch generation) | ✗ | ✓ |
| Custom prompts (`/` command) | ✗ | ✓ |
| `recommend --refresh` | ✗ | ✓ |
| `tags suggest` | ✗ | ✓ |

**Cost:** $0.00 (AWS free tier only)

**Output:** Tables, JSON export, CSV export, HTML reports — all work the same.

**Headless mode:** Perfect for CI/CD pipelines that only need structured data:

```bash
korinfra scan --json --no-tui
korinfra recommend --json
korinfra security --json --dir ./terraform
```

---

## Disclaimer

Costs vary based on:

- **Account size:** Large accounts with 1000+ resources cost more to analyze (more input tokens).
- **Service mix:** Scanning 9 services vs. 1 service.
- **Scan frequency:** More scans = more AI costs (but Cost Explorer cache helps).
- **Regional scope:** Scanning all regions vs. a few.
- **Model choice:** Sonnet is 3–4× more expensive than Haiku.
- **Current pricing:** This guide reflects pricing current as of April 2026. Check your AI provider's pricing page and [AWS Cost Explorer pricing](https://aws.amazon.com/aws-cost-management/pricing/) for the latest rates.

All figures in this guide are **estimates** based on typical infrastructure. Your actual costs may vary.

---

## Questions?

- **How do I check my current AI spending?** Check your AI provider's usage dashboard (e.g., Anthropic console → "Usage") for recent charge history.
- **Can I set spending alerts?** Set `ai.max_budget_usd` in your config file (default: $0.50). The agent stops generating when that limit is reached per command.
- **Does headless mode cost less?** No — headless (`--json`) and TUI cost the same. The difference is only in output format, not in API calls.
- **Can I turn off Cost Explorer calls?** Not directly, but you can use the 6-hour cache by batching scans. Running one scan per day will hit the cache most of the time.
