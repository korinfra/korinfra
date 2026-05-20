# Changelog

All notable changes to KorInfra are documented here.

## [Unreleased]

### 🔮 New features

- **Terraform plan cost-impact analysis.** Analyze the cost and security impact
  of a Terraform plan before apply via
  `korinfra cost-impact --plan-file <plan.json>`. Reads `terraform show -json`
  output, computes per-change before/after monthly cost deltas, and surfaces
  cost + security rule findings that would trigger against the post-apply
  state. JSON output suitable for CI integration with `--fail-on critical`
  to block PRs that introduce critical security regressions. Also exposed as
  an MCP tool (`analyze_plan`). See [docs/ci-integration.md](docs/ci-integration.md)
  for a GitHub Actions example. (#40)

## [0.1.2] — 2026-05-17

A reliability and hardening release. No breaking changes — safe to upgrade from `0.1.0`:

```bash
npm install -g korinfra@0.1.2
```

> **Note**: version `0.1.1` was skipped. The git tag `v0.1.1` exists but the npm
> publish failed because the `0.1.1` version slot was already consumed on the
> registry (npm refuses re-use). `0.1.2` contains the exact same changes that
> were planned for `0.1.1`.

### 💰 More trustworthy cost data

- **Cost Explorer truncation is now visible.** Large CE queries previously stopped
  at the first page without telling you. Truncation is now surfaced in scan output
  so partial cost data is no longer mistaken for the full picture (#38).
- **No more `NaN` totals from empty AWS values.** Empty-string `Amount` values
  returned by Cost Explorer are now parsed as zero instead of corrupting daily
  spend totals.
- **No more negative or `NaN` savings in recommendations.** Cost rules now clamp
  confidence and currency arithmetic at the rule boundary, so reports stay
  consistent even when underlying metrics are sparse (#37).

### 🔍 Better scan visibility

- **Partial scans no longer hide IAM errors.** When a collector is skipped
  because of a missing AWS permission, the scan summary now tells you exactly
  which one — instead of returning a silently incomplete result (#15).
- **`korinfra doctor` blocks on invalid config.** The `config-valid` check is
  wired into the Enter handler in the TUI and shown in the summary hint, so you
  can't proceed past a broken configuration.
- **Config validation catches contradictions.** Conflicting threshold
  combinations (e.g. mutually exclusive min/max values) are now caught at load
  time with a clear error message instead of producing nonsense scan results.

### 🔌 MCP server (`korinfra mcp`)

If you expose KorInfra to Claude Code, Cursor or another MCP client:

- **Rotate the bearer token without a restart.** Token revocation is now live —
  update the config and the new value takes effect immediately.
- **Multi-client warning.** The server now warns clearly when a second client
  attaches to a transport that only supports one.
- **Configurable HTTP body limit.** The max request body size for the HTTP
  transport is now a config option, not a hardcoded value.
- **Plain warning that HTTP is unencrypted.** A startup log line now makes it
  explicit that the HTTP transport carries no TLS — front it with a reverse
  proxy or use stdio for anything sensitive.

### 🔒 Security & robustness

- **Dropped the `better-sqlite3` native dependency.** Replaced with Node's
  built-in `node:sqlite` — installs are faster, no more compile step, and
  npm supply-chain alerts on the old package are gone.
- **Concurrent runs no longer race on first launch.** SQLite schema migrations
  are serialised across processes, so two `korinfra` invocations starting at
  the same time will not corrupt each other's database (#21).
- **Tighter on-disk permissions.** Sensitive files (sessions, configs) are
  written with stricter permissions and the loader refuses to follow symlinks
  pointing outside the expected directory (#35).
- **20+ static-analysis findings resolved.** TOCTOU races on config/session
  files, prototype-pollution sinks in deep-merge paths — all cleaned up.

### ⚙️ For maintainers

- **Automated release flow.** New maintainer workflow: `workflow_dispatch` →
  version-bump PR → publish on merge, gated by a required reviewer on the
  `release` GitHub environment.
- **CI is ~35–50% lighter.** Caching keyed on Node version + lockfile, Node 24
  matrix dropped, audit job split, third-party actions pinned to commit SHAs.

### 📦 Dependencies

- `@anthropic-ai/claude-agent-sdk` updated
- AWS SDK packages bumped to the `3.1048.x` line (16 packages)
- `ink` 7.0.2 → 7.0.3 and React 19 patch updates
- GitHub Actions: `codeql-action` 4.35.5, `actions/cache` 5.0.5,
  `step-security/harden-runner` 2.19.3
- Dev tooling: TypeScript-eslint, vitest, knip, secretlint, markdownlint

## [0.1.0] — 2026-05-11

### Initial release

**AWS collectors (9 services)**

- EC2: instances, EBS volumes, snapshots, Elastic IPs, NAT Gateways
- RDS: DB instances with connection metrics
- S3: buckets with encryption, versioning, lifecycle, intelligent tiering
- Lambda: functions with invocation metrics
- ECS: clusters and services
- ELB: load balancers with target group health
- ElastiCache: cache clusters
- DynamoDB: tables with capacity metrics
- CloudWatch: CPU, network, connection metrics with batching
- Cost Explorer: daily spend with service/region/tag breakdown

**Cost optimization — 66 rules**

- EC2: idle instances, stopped with attached EBS, previous-gen families, rightsizing, RI coverage gaps, Graviton migration, IMDSv2
- RDS: idle databases, Multi-AZ on non-prod, gp2→gp3 storage, Graviton, public accessibility
- EBS: unattached volumes, gp2→gp3, old snapshots
- S3: incomplete multipart uploads, missing lifecycle rules, intelligent tiering candidates
- Lambda: zero invocations, over-provisioned memory
- ECS: idle services, Fargate vs EC2 cost delta
- ELB: load balancers with no healthy targets
- ElastiCache: undersized or idle clusters
- DynamoDB: on-demand vs provisioned cost comparison
- NAT Gateway: high data transfer costs

**Security scanning — 46 rules (Terraform)**

- IAM: overly permissive policies, missing MFA, public S3 buckets
- Network: unrestricted security group ingress, public RDS, unencrypted EBS/RDS/S3
- Logging: CloudTrail disabled, VPC flow logs missing
- Encryption: KMS key rotation, SSL/TLS enforcement

**Core features**

- 4-pass Terraform matcher: exact ID → ARN → name tag → fuzzy
- Scenario A/B/C classification with confidence scoring
- Z-score anomaly detection with 30-day trend forecasting
- 3-level data redaction (minimal/moderate/strict) before any AI call
- AI agent loop with Claude Haiku 4.5 (configurable)
- MCP server: 20 tools, 3 resources, 3 prompts (stdio + HTTP)
- Report export: JSON, CSV, HTML with inline SVG charts
- GitHub PR auto-creation for Terraform fixes
- SQLite storage with WAL mode and migrations
- Interactive TUI: Ink 6 + React 19, 15 commands, keyboard-driven
- Headless/CI mode: `--json`, `--no-tui`, `CI=true` auto-detected
