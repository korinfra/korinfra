# Getting Started

A 5-minute walkthrough: install korinfra, connect your AWS account, run your first scan.

---

## 1. Install

**Requirements:**

- **Node.js** >= 22.0.0 (check with `node --version`)
- **AWS credentials** configured (`~/.aws/credentials`, env vars, or IAM role)
- **AI provider** (optional) — Anthropic API key for AI features; all rules work without it

Install globally:

```bash
npm install -g korinfra
korinfra --version
```

Or run without installing:

```bash
npx korinfra scan
```

---

## 2. Initialize Configuration

Run the interactive setup wizard:

```bash
korinfra init
```

The wizard will guide you through:

1. **AWS Profile** — select which AWS profile to use (auto-detects from `~/.aws/credentials`)
2. **AWS Connection Test** — verifies credentials work, shows your account ID
3. **AI Provider** — choose Claude or None (rules-only mode with $0 cost)
4. **API Key** — if you chose an AI provider, paste your API key (safely stored, input is masked)

Configuration is saved to:

- `.korinfra/config.yaml` — AWS profile, regions, AI settings
- `.korinfra/.env` — API key (0600 permissions, auto-added to `.gitignore`)

All setup is automatic — no manual YAML editing needed.

**No AWS credentials or API key yet?** See [Troubleshooting](#troubleshooting) below.

---

## 3. Run Your First Scan

```bash
korinfra scan
```

**What happens step by step:**

1. Collects live resources from 9 AWS services: EC2, RDS, S3, Lambda, ECS, ELB, ElastiCache, DynamoDB, NAT Gateway
2. Fetches CloudWatch metrics (CPU, memory, connections, invocations) for the past 14 days
3. Queries AWS Cost Explorer for 30 days of spending history
4. Evaluates 66 cost optimization rules locally (no AI needed, same results every time)
5. If AI provider is configured: the AI agent analyzes findings, groups related issues, estimates savings
6. Saves all results to local SQLite database for history and future reference

**You'll see recommendations like:**

```
Terminate idle RDS instance "staging-analytics"

db.r5.xlarge cluster with 0 connections for 14 days.
This staging database was likely forgotten after the analytics
migration.

resource: arn:aws:rds:us-east-1:[account]...

impact: high | risk: medium | saves: $380/month
```

**Time to first results:** 30–90 seconds depending on your AWS account size and network speed.

A well-optimized account may show zero recommendations — that's actually a good result.

> **How data flows:** `scan` is the only command that calls AWS live. Everything else — `resources`, `costs`, `tags`, `history`, `recommend`, `security`, `report` — reads from the local SQLite database populated by the last scan. Run `scan` first; subsequent commands are instant. If you run them before any scan, korinfra shows an empty state with a "Run a scan first" prompt.

---

## 4. Ask a Question (AI Mode Only)

If you configured an AI provider, press `/` from the main menu to open chat mode:

```
Ask anything about your AWS infrastructure:

❯ which EC2 instances have been idle for more than a week?
```

The AI agent can:

- Analyze your specific infrastructure patterns
- Answer cross-resource questions ("which services drive the most cost?")
- Suggest optimizations based on your configuration
- Run any of the 15 built-in tools automatically

**Examples:**

- "Show me Lambda functions with zero invocations in the past month"
- "What's our highest-cost region and why?"
- "Which RDS instances are candidate for read replicas?"

Without an AI provider (rules-only mode), you can still browse all data and recommendations through the interactive menu.

---

## 5. Apply a Fix (AI Mode Only)

Apply a specific recommendation with the `fix` command:

```bash
korinfra fix
```

You'll see a list of saved recommendations. Select one, and the AI agent will:

1. Verify the resource still exists and is in the same state
2. Find the Terraform file(s) managing it
3. Generate a minimal Terraform change
4. Show the change for review before applying
5. Optionally create a GitHub PR (add `--pr` flag)

**Requires:** AI provider configured + read access to Terraform files.

---

## 6. Export a Report

Export all findings to a portable format:

```bash
korinfra report --format html
korinfra report --format json
korinfra report --format csv
```

Reports are self-contained (HTML includes inline SVG charts, no external dependencies) and print-friendly.

---

## Troubleshooting

Run `korinfra doctor` for a quick diagnostic of all components (credentials, config, storage, AI key).

### Missing AWS credentials

**Error:** `No AWS credentials found`

**Fix:**

- Ensure `~/.aws/credentials` exists, OR
- Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables, OR
- Use an IAM role if running on EC2 / ECS / Lambda

Run `korinfra doctor` to verify.

### No AI provider API key

**Error:** `AI features disabled` or `provider: none`

**Fix:**

- **Claude:** Get an API key from [console.anthropic.com](https://console.anthropic.com/) and set `ANTHROPIC_API_KEY=sk-ant-...`
- Or run `korinfra init` again and paste the key when prompted

### Slow scans / throttling errors

**Cause:** AWS API rate limits or large account (1000+ resources)

**Fix:**

- Reduce `scan.lookback_days` in `.korinfra/config.yaml` (default 30)
- Filter specific regions: `aws.default_region: us-east-1`
- Run at off-peak times
- Retry — exponential backoff is automatic

### Debug mode — diagnosing slow or hung scans

Set `KORINFRA_DEBUG=1` to enable real-time per-service tracing:

```bash
# macOS / Linux
KORINFRA_DEBUG=1 korinfra scan

# Windows (PowerShell)
$env:KORINFRA_DEBUG="1"; korinfra scan
```

**What it produces** (both files land in `~/.korinfra/debug/`):

| File | Contents |
|------|----------|
| `~/.korinfra/debug/korinfra-debug.log` | Timestamped trace — every AWS API call with ms + resource count |
| `~/.korinfra/debug/korinfra-timing.json` | Per-service summary sorted slowest-first, written after scan completes |

**Tail the log live while the scan runs:**

```bash
# macOS / Linux
tail -f ~/.korinfra/debug/korinfra-debug.log

# Windows (PowerShell)
Get-Content ~/.korinfra/debug/korinfra-debug.log -Wait -Tail 40
```

**Sample output:**

```
[10:23:01.123] collectAll start — regions: us-east-1 skipCosts:false
[10:23:01.890] STS GetCallerIdentity done — 767ms account:123456789012
[10:23:01.891] region:us-east-1 — launching all service tasks
[10:23:01.892]   START ec2 region:us-east-1
[10:23:01.893]   START s3 (global) region:us-east-1
[10:23:02.456]   DONE  lambda region:us-east-1 575ms count:12
[10:23:02.614]   DONE  ec2 region:us-east-1 722ms count:0
[10:23:03.218]   DONE  s3 region:us-east-1 1327ms count:3
[10:23:03.219] CE start (cached parallel)
[10:23:03.220] CE done — 1ms costs:151 resourceCosts:0  ← cache hit
```

A `1ms` CE entry means the result was served from `~/.korinfra/ce_cache.json` (6h TTL).

**View the timing summary:**

```bash
cat ~/.korinfra/debug/korinfra-timing.json
```

### Storage path permission errors

**Error:** `Failed to access .korinfra/data.db`

**Fix:**

- Set explicit storage path in config:

  ```yaml
  storage:
    path: /tmp/korinfra.db
  ```

- Or set env var: `KORINFRA_STORAGE_PATH=/custom/path/data.db`

---

## CI / Headless Mode

korinfra works without a TTY. Three ways to use it in CI/CD pipelines:

```bash
# Plain text output (no TUI)
korinfra scan --no-tui

# JSON output for scripting
korinfra scan --json

# Auto-detect CI environment (GitHub Actions, CircleCI, etc.)
CI=true korinfra scan
```

**Non-interactive init** (for provisioning or Docker builds):

```bash
korinfra init --non-interactive \
  --profile default \
  --ai-provider anthropic \
  --ai-key "$ANTHROPIC_API_KEY"
```

**Security gate in CI:**

```bash
korinfra security --fail-on critical --no-tui
# exits 1 if critical findings found
```

---

## Next Steps

| Task | Command | Notes |
|------|---------|-------|
| Cost trends | `korinfra costs` | Spending by service + anomaly detection |
| Security audit | `korinfra security` | 46 Terraform security checks |
| Tag compliance | `korinfra tags` | Audit required tags |
| View recommendations | `korinfra recommend` | Browse all saved recommendations |
| Export report | `korinfra report --format html` | Self-contained HTML + charts |
| History | `korinfra history` | View past scans and costs |
| IDE integration | `korinfra mcp` | Use in Claude Code or Cursor |

**Full reference:** See [Usage](usage.md) for all 15 commands, [Configuration](configuration.md) for YAML schema, and [Architecture](architecture.md) for how korinfra works.
