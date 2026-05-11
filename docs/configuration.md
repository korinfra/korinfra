# Configuration

> **Quick setup:** Run `korinfra init` for an interactive wizard that creates the config file automatically — no manual editing needed.

korinfra uses [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) for config file discovery and [Zod](https://zod.dev) for validation.

## Config file location

korinfra searches for config in this order (first match wins):

1. `KORINFRA_*` environment variables (highest priority) — use double underscore as dot separator: `KORINFRA_AI__MODEL=claude-sonnet-4-6`
2. `.korinfra/config.yaml` or `.korinfra/config.yml`
3. `.korinfra/config.json`
4. Built-in defaults (lowest priority)

All korinfra project state lives in `.korinfra/` (created by `korinfra init`): config, SQLite DB, `.env` with API keys, pricing cache. Nothing is read from project root or parent directories.

**Search scope:** Configuration files are searched only in the current working directory — the search does not traverse parent directories or the user's home directory. See [Security: Configuration File Security](../SECURITY.md#configuration-file-security) for details on why JS/TS config files are not supported.

## Minimal config

The smallest config that works (AI + single AWS profile):

```yaml
aws:
  default_profile: default

ai:
  provider: claude
  # API key is read from ANTHROPIC_API_KEY env var
  # or stored by `korinfra init` in .korinfra/.env
```

For rules-only mode (no AI API key needed):

```yaml
ai:
  provider: none
```

## AWS Permissions

korinfra requires **read-only access** to scan your AWS account. See the [IAM policy](../README.md#aws-permissions) in the main README for the minimal permission set.

The `fix` command edits Terraform files locally — it does **not** call AWS APIs to make changes.

---

## Full config reference

```yaml
# AWS Configuration
aws:
  default_profile: default          # Which AWS profile to use (from ~/.aws/credentials)
  default_region: us-east-1         # Default region if not specified
  profiles: {}                      # Multi-account support (advanced)

# AI Provider Configuration
ai:
  provider: claude                  # AI provider: claude | none (openai not yet supported)
  model: claude-haiku-4-5-20251001  # Model ID (default is fine for cost)
  api_key_env: ANTHROPIC_API_KEY    # Env var name (default: ANTHROPIC_API_KEY)
  max_tokens: 16384                 # Max output tokens per query
  max_recommendations: 20           # Max recommendations per scan result
  temperature: 0.3                  # Sampling temperature (0.0-1.0)
  extended_thinking: false          # Enable Claude extended thinking (beta feature)
  thinking_budget: 0                # Token budget for extended thinking (if enabled)
  confirm_threshold_usd: 0.01       # Show confirmation before AI calls estimated above this USD cost
  confirm_threshold_sec: 10         # Show confirmation before AI calls estimated above this duration (seconds)
  max_budget_usd: 0.50              # Per-command AI spend cap in USD; agent stops when limit reached
  timeout_ms: 300000                # Agent timeout in milliseconds (fix command uses 3× this value)
  redaction_level: moderate         # Redact AWS data before sending to AI: minimal | moderate | strict
  prompt_max_resources: 30          # Max resources sent to AI per analysis (increase for large environments)
  prompt_max_recommendations: 20    # Max recommendations included in AI prompts
  # When provider is "none": all rules work the same, output is tables only, no fix/chat

# Terraform Configuration
terraform:
  default_path: .                   # Path to Terraform directory (default: cwd; override to e.g. ./terraform)
  state_file: ''                    # Path to .tfstate file (optional, for Terraform matching)
  security_scan: true               # Run security rules on Terraform files
  builtin_rules: true               # Use built-in cost/security rules
  cost_estimation: true             # Estimate costs from Terraform config

# GitHub Configuration
github:
  token_env: GITHUB_TOKEN           # Env var containing GitHub PAT
  default_org: ''                   # Default organization for PR creation
  pr_draft: true                    # Create PRs as drafts (safer for first run)
  pr_labels: [korinfra, cost-optimization]  # Labels for auto-created PRs

# Output Configuration
output:
  default_format: json              # Default export format: json | csv | html
  color: true                       # Colored terminal output
  verbose: false                    # Verbose logging (debug mode)
  currency: USD                     # Currency for cost display

# Storage Configuration
storage:
  path: .korinfra/data.db          # SQLite database path (relative to cwd, auto-created)
  retention_days: 365               # How long to keep scan history

# Scan Configuration
scan:
  lookback_days: 30                 # Cost Explorer lookback (days)
  metric_period: 14d                # CloudWatch metric window
  include_idle: true                # Include idle resources in analysis
  min_cost_threshold: 0.01           # Ignore resources below this monthly cost
  max_parallel_regions: 4           # Max AWS regions scanned in parallel (increase for many-region accounts)
  service_timeout_ms: 30000         # Per-service collector timeout in ms (increase for slow/large environments)
  collection_timeout_ms: 60000      # Hard stop for total collection in ms (partial results returned on timeout)
  cost_explorer_cache_ttl_hours: 6  # How long to cache Cost Explorer results (each CE call costs $0.01)

  # Core thresholds — most commonly tuned
  idle_cpu_threshold: 5.0           # % CPU usage — below = idle
  rightsize_cpu_threshold: 30.0     # % CPU usage — below = oversized
  required_tags: [Environment, Team, Project]  # Required resource tags

  # Advanced thresholds (optional, uncomment to customize)
  # stopped_instance_days: 7           # Days stopped before EC2 flagged
  # snapshot_retention_days: 90        # Days before snapshot flagged as old
  # snapshot_max_age_days: 365         # Hard max age for snapshots
  # instance_max_age_days: 365         # Max age for on-demand instances
  # on_demand_running_days: 30         # Days on-demand before RI recommended
  # pricing_cache_ttl_days: 7          # Pricing API cache TTL
  # impact_high_threshold: 100.0       # Monthly savings above this = HIGH impact
  # impact_medium_threshold: 25.0      # Monthly savings above this = MEDIUM impact

  # RDS thresholds
  # rds_idle_cpu_threshold: 1.0
  # rds_rightsize_cpu_threshold: 15.0
  # rds_min_cost_for_ri: 20.0          # Min monthly cost to suggest RDS RI
  # rds_ri_cpu_threshold: 15.0         # CPU% threshold for RDS RI suggestion
  # rds_min_storage_gb: 100.0          # Min storage to flag for gp2→gp3
  # rds_free_storage_ratio: 0.7        # Free/total storage ratio threshold
  # rds_connection_idle_threshold: 1.0 # Avg connections below = idle RDS

  # Lambda thresholds
  # lambda_low_invocations: 100        # Invocations/month below = idle
  # lambda_min_memory_mb: 512          # Min memory to consider rightsizing
  # lambda_error_rate_threshold: 10.0  # Error rate % above = flag

  # NAT Gateway thresholds
  # nat_low_traffic_gb: 1.0
  # nat_endpoint_traffic_gb: 5.0

  # ECS thresholds
  # ecs_idle_days: 3                   # Days with 0 tasks = idle ECS service
  # ecs_min_cpu_threshold: 20.0        # CPU% threshold for ECS rightsizing
  # ecs_min_desired_count: 3           # Min desired count for rightsizing suggestion

  # ElastiCache thresholds
  # cache_memory_threshold: 10.0       # Memory utilization % below = idle
  # elasticache_idle_cpu_threshold: 2.0
  # elasticache_idle_memory_threshold: 5.0

  # Load balancer thresholds
  # elb_idle_days: 7                   # Days with no traffic = idle LB
  # lb_idle_traffic_mb: 0.1            # Traffic MB/day below = idle LB

  # EBS thresholds
  # gp3_iops_baseline: 3000            # IOPS baseline for gp2→gp3 analysis

  # Classifier
  # fuzzy_match_threshold: 0.7         # Terraform↔AWS name fuzzy match (0.0–1.0)

  # Scenario A confidence — dynamic formula: base + step × attributeCount, capped at max
  # scenario_confidence_base: 0.50         # Baseline (zero meaningful attributes)
  # scenario_confidence_step: 0.075        # Confidence increment per defined attribute
  # scenario_confidence_max: 0.95          # Upper bound regardless of attribute count
  # scenario_confidence_state_base: 0.80   # Higher baseline for state-only (state is authoritative)

  # Savings multipliers (fraction of monthly cost saved per recommendation type)
  # savings_multipliers:
  #   ec2_idle_stop: 0.80
  #   ec2_stopped_ebs: 0.10
  #   ec2_previous_gen: 0.15
  #   ec2_rightsize: 0.60
  #   ec2_ri_discount: 0.40
  #   ec2_graviton: 0.20
  #   rds_idle: 0.90
  #   rds_rightsize: 0.40
  #   rds_multi_az: 0.50
  #   rds_gp2_gp3: 0.20
  #   rds_graviton: 0.15

# Anomaly Detection Configuration
anomaly:
  z_score_threshold: 2.0            # Minimum z-score for cost anomalies (= low severity)
  pct_threshold: 20                 # Minimum % deviation to flag
  rolling_window_days: 14           # Window for z-score calculation
  medium_z_score: 2.5               # Z-score threshold for medium severity
  high_z_score: 3.0                 # Z-score threshold for high severity
  critical_z_score: 4.0             # Z-score threshold for critical severity
  forecast_days: 30                 # How far to forecast cost trends

# Quality Scoring Configuration
# Controls how recommendations are scored (0-100) and ranked. Higher score = better rec.
# Final score is clamped to [0, 100]; component sums theoretically reach 110 before clamp.
quality:
  # Label thresholds (used by qualityLabel())
  excellent_threshold: 85           # Score >= this = "excellent"
  good_threshold: 70                # Score >= this = "good"
  fair_threshold: 50                # Score >= this = "fair" (below = "poor")

  # Absolute savings tiers (USD/month) → impact points 15/12/8/4
  savings_tier_high: 500
  savings_tier_medium: 100
  savings_tier_low: 20

  # Relative impact — savings as fraction of resource's currentCost.
  # Lifts recommendations from small AWS accounts where absolute USD looks tiny
  # but represents a large % of spend. Final impact = max(absolute, relative).
  savings_pct_high: 0.20            # ≥20% of currentCost = relative tier 15
  savings_pct_medium: 0.05          # ≥5% = relative tier 10

  # Clarity scoring
  title_min_length: 10              # Minimum title length for full clarity points
  title_max_length: 80              # Maximum (titles longer than this lose points)
  description_full_length: 80       # Description ≥ this = +10 clarity
  description_partial_length: 30    # Description ≥ this but < full = +6

  # Evidence scoring
  reasoning_full_length: 50         # Reasoning text ≥ this = +10 evidence

  # Actionability bonus — smooth ramp instead of binary cliff
  actionability_confidence_threshold: 0.9   # Confidence at which bonus starts
  actionability_max_bonus: 5                # Max bonus at confidence = 1.0 (linear ramp)

  # Confidence floor — recs below this are dropped as not actionable
  min_confidence_threshold: 0.40

# MCP Server Configuration (HTTP transport only)
mcp:
  session_cost_limit: 1000          # Max cumulative AI cost per session (cents)
  max_sessions: 100                 # Max concurrent HTTP sessions
  http_rate_limit: 300              # Max requests per minute per IP
  session_idle_timeout_ms: 1800000  # Idle session cleanup timeout (default 30 min)
```

**Note:** All values are optional — korinfra uses sensible defaults if you omit them. The `scan.savings_multipliers` block and per-service thresholds are commented out above; uncomment only the ones you need to tune.

**Reserved fields (accepted but not yet applied):**

| Field | Status |
|-------|--------|
| `ai.temperature` | Claude Agent SDK does not expose temperature as a query parameter — reserved for future SDK support |
| `ai.max_tokens` | Same SDK constraint as `temperature` — reserved for future support |

To discover all available config fields with their defaults, run:

```bash
korinfra config show
```

---

## AI Provider Setup

### Claude (default provider)

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/)
2. Either:
   - Run `korinfra init` and paste the key (stored in `.korinfra/.env` with 0600 permissions)
   - Or set the environment variable: `export ANTHROPIC_API_KEY=sk-ant-...`

### Rules-Only Mode (No AI)

Set `provider: none` during `korinfra init` to use korinfra without an AI provider. All data collection, rules, and anomaly detection work the same — you just get structured output (tables) instead of natural language explanations.

```yaml
ai:
  provider: none
```

Commands like `fix`, `recommend --refresh`, and custom prompts require an AI provider. They'll show a "(needs AI)" label in the interactive menu when no provider is configured.

---

## Environment variables

All config values can be overridden with `KORINFRA_` prefixed env vars. Use **double underscore** (`__`) as the dot separator for nested keys:

```bash
KORINFRA_AI__MODEL=claude-sonnet-4-6
KORINFRA_AI__MAX_BUDGET_USD=2.00
KORINFRA_SCAN__LOOKBACK_DAYS=60
KORINFRA_OUTPUT__VERBOSE=true
```

Special env vars (single underscore, handled directly — not through the config prefix system):

```bash
KORINFRA_STORAGE_PATH=/custom/path/data.db   # override SQLite DB path
KORINFRA_NO_MOUSE=1                           # disable mouse reporting in TUI
```

Other recognized env vars (not prefixed):

```bash
ANTHROPIC_API_KEY=sk-ant-...
AWS_PROFILE=default
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
GITHUB_TOKEN=ghp_...
MCP_AUTH_TOKEN=...             # Fixed Bearer token for HTTP MCP transport
```

---

## `config` command

View and edit config values from the CLI without editing the file directly:

```bash
korinfra config show
korinfra config set ai.model claude-haiku-4-5-20251001
korinfra config set scan.lookback_days 60
korinfra config set output.verbose true
```
