<div align="center">

<img src=".github/banner_korinfra.png" alt="KorInfra" width="800">

### Your AWS bill has waste. KorInfra finds it in minutes

<p>
  9 AWS services · 66 cost rules + 46 security rules · Terraform-aware auto-fixes · AI explanations · zero telemetry
</p>

[![CI](https://github.com/korinfra/korinfra/actions/workflows/ci.yml/badge.svg)](https://github.com/korinfra/korinfra/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/korinfra.svg?color=cb3837)](https://www.npmjs.com/package/korinfra)
[![npm downloads](https://img.shields.io/npm/dm/korinfra.svg)](https://www.npmjs.com/package/korinfra)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

</div>

---

Stopped EC2 instances still billing. Oversized RDS nobody connects to. Lambda functions with zero invocations. EBS volumes attached to nothing.

korinfra scans your live AWS account, runs 112 rules locally in seconds, and tells you exactly what to kill, resize, or fix — with AI-generated explanations and optional Terraform patches.

**No cloud. No dashboard. Your data stays on your machine.**

```bash
npm install -g korinfra
korinfra init    # connect AWS, add AI key (optional), done in 60 seconds
korinfra scan

# or try without installing:
npx korinfra
```

**Requirements:** Node.js ≥ 22 · [AWS credentials configured](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html)

First time? → [Getting started guide](docs/getting-started.md) (5 min walkthrough)

---

## What korinfra does

**Works without AI.** All 66 cost rules and 46 security rules run locally — no API key, no AI calls, $0 cost. Add an AI provider key to unlock natural language explanations and Terraform patch generation.

**Terraform-aware.** 4-pass matcher (ARN → ID → name tag → fuzzy) links every live AWS resource to its `.tf` definition. When a fix is available, korinfra edits the right file and opens a PR — no manual hunting.

**CI/CD ready.** `korinfra scan --json --fail-on critical` exits 1 on critical findings. Pipe it into any pipeline. Zero AI cost in CI.

**Your data stays local.** Everything in a SQLite database. The only data that ever leaves your machine is redacted findings sent to the AI provider you choose. Credentials, ARNs, IPs, and emails are stripped automatically.

**MCP server included.** `korinfra mcp` registers a server in Claude Code or Cursor. Ask your editor "which EC2 instances are idle?" — korinfra runs the analysis and returns results inline.

---

## Commands

Run interactively (`korinfra`) or directly (`korinfra <command>`):

| Command | What it does | Needs AI? |
|---|---|---|
| `scan` | Full cost + security scan | No |
| `costs` | Cost Explorer breakdown. `--days N`, `--group-by service\|region\|account\|tag` | No |
| `resources` | Browse and filter all scanned resources | No |
| `changes` | Audit recent AWS API activity (CloudTrail). Filter by user, resource type, time window (24h/48h/7d) | No |
| `recommend` | Review saved recommendations. `--refresh` re-runs analysis | `--refresh` only |
| `fix` | AI reads your Terraform, generates a patch, opens a GitHub PR | **Yes** |
| `report` | Export to JSON, CSV, or HTML (with inline SVG charts) | No |
| `history` | Browse past scans, diff between them | No |
| `security` | 46 Terraform security rules. `--dir <path>` | No |
| `tags` | Audit required tags. `suggest` mode uses AI. Apply AI-suggested tags directly with confirmation (`a` key) | `suggest/apply` only |
| `pricing` | Inspect or refresh the local AWS pricing cache | No |
| `init` | Setup wizard — AWS profile, AI provider, API key | No |
| `doctor` | Verify credentials, config, storage, and AI provider | No |
| `config` | View or edit config values at runtime | No |
| `mcp` | Install MCP server into Claude Code or Cursor | No |
| `serve` | Start MCP server — `stdio` (default) or `--http --port N` | No |

Press `/` from the main menu to ask your AI assistant anything about your infrastructure.

---

## What it catches

**66 cost rules** across EC2, RDS, EBS, S3, Lambda, ECS, ELB, ElastiCache, DynamoDB, and NAT Gateway — plus **46 security rules** on your Terraform config.

**Idle resource detection** using multi-signal CloudWatch heuristics: CPU + network I/O for EC2, database connections for RDS, attachment status for EBS volumes, and Reserved Instance coverage gaps.

| Rule | Finding | Typical saving |
|---|---|---|
| EC2-001 | Instance with <5% CPU for 7+ days | $50–400/mo |
| EC2-003 | m4/c4/r4 family — faster current-gen is cheaper | $20–200/mo |
| RDS-007 | Multi-AZ on dev/staging (disable and halve the cost) | $100–3000/mo |
| EBS-001 | Unattached volumes still billing | $5–50/mo each |
| EBS-003 | gp2 → gp3 migration (20% cheaper, same performance) | $10–100/mo |
| LAM-001 | Lambda with zero invocations | < $5/mo |
| S3-004 | Bucket without server-side encryption (SSE-S3 is free) | — |
| RDS-005 | Publicly accessible RDS instance | — |

Plus: cost anomaly detection (z-score) and 30-day trend forecasting.

[Full rule list →](docs/rules.md) · [Running costs →](docs/running-costs.md)

---

## Applying fixes

Run `korinfra fix`, select a recommendation, and the AI agent:

1. Reads your Terraform files to locate the resource
2. Generates a minimal, targeted patch
3. Runs `terraform validate` to verify the change
4. Shows exactly what will change before applying
5. Optionally creates a GitHub PR

You stay in control — every change is shown for review. No AWS API calls are made. Rollback is as simple as reverting the file.

> **AI required** — `fix` uses the AI provider you configured in `korinfra init`.

---

## Interactive TUI

korinfra is fully keyboard-driven — built with Ink 7 + React 19, the same stack as Claude Code and Gemini CLI.

- **Navigate** with `↑↓`, drill into any recommendation with `Enter`, go back with `Esc`
- **After a scan** — a follow-up panel stays open so you can ask questions in the same session ("why is this expensive?", "explain the RDS finding")
- **`/` from the main menu** — free-form AI questions about your infrastructure
- **`f` on any recommendation** — jump straight to `fix` and generate a Terraform patch
- **`p`** — export a report without leaving the screen
- Headless when needed: `--json`, `--no-tui`, or `CI=true` auto-detected

---

## MCP Server

korinfra exposes all its capabilities as an [MCP server](https://modelcontextprotocol.io). Add it to your AI editor with one command:

```bash
korinfra mcp       # auto-installs into Claude Code or Cursor
korinfra serve     # start manually (stdio transport)
```

Then ask your editor: *"which EC2 instances have been idle for 2 weeks?"* — korinfra collects live AWS data and returns structured results without switching to the terminal.

**20 tools · 3 resources · 3 prompts.** [Full MCP docs →](docs/mcp.md)

---

## CI/CD

```bash
# Works without a TTY — auto-detected in CI
korinfra scan --json | jq '.summary'
korinfra security --json --dir ./terraform --fail-on critical  # exits 1 on critical
CI=true korinfra scan --json > scan.json
```

All commands support `--json` (machine-readable) and `--no-tui` (plain text). AI streaming works without a TTY. Zero AI cost in headless mode.

[Full reference + GitHub Actions example →](docs/usage.md)

---

## KorInfra vs. alternatives

| | korinfra | AWS Trusted Advisor | Infracost | Checkov |
|---|---|---|---|---|
| AI reasoning (not just rules) | ✓ | — | — | — |
| Cost optimization (live infra) | 66 rules | Limited (free tier) | Pricing only | — |
| Security scanning | 46 rules | ✓ | — | 1000+ rules |
| Cost anomaly detection | ✓ | — | — | — |
| MCP server for AI editors | ✓ | — | — | — |
| Ask anything in natural language | ✓ | — | — | — |
| Data stays local | ✓ | — (AWS console) | Partial | ✓ |
| Generates Terraform fixes + PRs | ✓ | — | — | — |

Checkov catches misconfigs at build time. Trusted Advisor checks running infra. korinfra sits between them: live AWS state, AI-driven analysis, and automated Terraform fix generation in one tool.

---

## AWS Permissions

<details>
<summary><strong>Minimal IAM policy — read-only (click to expand)</strong></summary>

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "korinfraReadOnly",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeVolumes",
        "ec2:DescribeSnapshots",
        "ec2:DescribeAddresses",
        "ec2:DescribeNatGateways",
        "rds:DescribeDBInstances",
        "s3:ListAllMyBuckets",
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetBucketEncryption",
        "s3:GetBucketLifecycleConfiguration",
        "s3:ListBucketIntelligentTieringConfigurations",
        "s3:GetBucketTagging",
        "lambda:ListFunctions",
        "tag:GetResources",
        "ecs:ListClusters",
        "ecs:ListServices",
        "ecs:DescribeServices",
        "ecs:DescribeClusters",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeTargetGroups",
        "elasticloadbalancing:DescribeTargetHealth",
        "elasticloadbalancing:DescribeTags",
        "elasticache:DescribeCacheClusters",
        "elasticache:ListTagsForResource",
        "dynamodb:ListTables",
        "dynamodb:DescribeTable",
        "dynamodb:ListTagsOfResource",
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:GetMetricData",
        "ce:GetCostAndUsage",
        "sts:GetCallerIdentity",
        "pricing:GetProducts"
      ],
      "Resource": "*"
    }
  ]
}
```

korinfra never modifies AWS resources. `fix` edits your local Terraform files only — it does not call AWS APIs to make changes.

</details>

---

## Reference

<details>
<summary><strong>Configuration</strong></summary>

`korinfra init` creates config automatically. To customize:

```yaml
# .korinfra/config.yaml
aws:
  default_profile: production
  default_region: us-east-1

ai:
  provider: claude                       # "none" for rules-only mode (openai not yet supported)
  model: claude-haiku-4-5-20251001       # or claude-sonnet-4-6 for deeper analysis

scan:
  lookback_days: 30
  idle_cpu_threshold: 5                  # % CPU below this = idle
  required_tags: [Environment, Team, Project]

anomaly:
  z_score_threshold: 2.0
  rolling_window_days: 14
```

[Full reference →](docs/configuration.md)

</details>

<details>
<summary><strong>Privacy & redaction</strong></summary>

Before anything is sent to the AI provider, korinfra strips sensitive data automatically:

| Level | What is removed |
|---|---|
| `minimal` | AWS access keys, AI provider API keys, GitHub tokens, JWTs, DSN credentials, PEM private keys |
| **`moderate`** (default) | + ARN account IDs, public IPv4/IPv6, email addresses |
| `strict` | + private IPs, external domain names |

- No telemetry of any kind
- All scan data in a local SQLite database only
- MCP HTTP server binds to localhost only
- API keys stored with `chmod 600`, auto-added to `.gitignore`

</details>

<details>
<summary><strong>Architecture</strong></summary>

Three layers in sequence:

1. **Collect** — AWS SDK v3 pulls live state from 9 services in parallel. CloudWatch adds utilization metrics; Cost Explorer adds spending data. Every API call is rate-limited and logged.
2. **Analyze** — 66 cost + 46 security rules run locally (no AI, no network). 4-pass Terraform matcher compares live resources against `.tf` files. Z-score anomaly detection flags spending spikes.
3. **Output** — Data is redacted, then the AI agent loop produces natural language summaries and generates fixes. Final output goes to the TUI, file export (JSON/CSV/HTML), or an MCP client.

Built with TypeScript 6 · Ink 7 + React 19 · Claude Agent SDK · AWS SDK v3 · better-sqlite3 · Zod 4

[Full architecture →](docs/architecture.md)

</details>

---

## Contributing

Contributions welcome — from fixing a typo to adding a new AWS collector.

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, conventions, good first issues
- [Open an issue](https://github.com/korinfra/korinfra/issues) — bugs, ideas, questions

<details>
<summary><strong>Development setup</strong></summary>

```bash
git clone https://github.com/korinfra/korinfra
cd korinfra && npm install
npm run dev              # interactive menu (no build)
npm run dev -- scan      # run a specific command
npm run check            # typecheck + lint + test (no build)
```

</details>

---

## FAQ

**Do I need an AI provider key?**  
No. All 66 cost rules and 46 security rules run locally — no API key, no AI calls, $0. Add a key to unlock AI-powered analysis, `/` chat, and `fix`.

**Does korinfra modify my AWS resources?**  
Never. korinfra is strictly read-only against AWS. `fix` edits your local Terraform files only.

**Is my data sent to the AI provider?**  
Only redacted findings. Account IDs, ARNs, IPs, and emails are stripped before anything leaves your machine. See [Privacy & redaction](#reference).

**Do I need Terraform?**  
No. Terraform features activate automatically when korinfra finds `.tf` files. Cost rules and security scanning work without Terraform.

**Does it work with multiple AWS accounts?**  
Not yet — v0.1.0 scans one account at a time. Multi-account aggregation is planned; [follow progress on GitHub](https://github.com/korinfra/korinfra/issues).

**What does it cost to run?**  
~$0.02/scan (AWS Cost Explorer) + ~$0.01–0.02 AI with the default Haiku model. Rules-only: $0.00. [Full breakdown →](docs/running-costs.md)

**Does it work on Windows?**  
Yes. Node.js ≥ 22 on Windows, macOS, or Linux.

**Which AI providers are supported?**  
Claude (Anthropic API) in v0.1.0. OpenAI and Amazon Bedrock support is planned; [follow progress on GitHub](https://github.com/korinfra/korinfra/issues).

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
