# Usage

> **New here?** See [Getting Started](getting-started.md) for installation and first-run setup.

## Running modes

korinfra has three ways to run:

1. **Interactive TUI** — run `korinfra` with no arguments to launch the interactive menu, where you can select commands visually
2. **Direct commands** — run `korinfra scan`, `korinfra costs`, etc. to go straight to a specific command
3. **MCP server** — run `korinfra serve` for Claude Code / Cursor integration

```bash
# Interactive mode — pick a command from the menu
korinfra

# Direct mode — run a specific command
korinfra scan
```

> **Headless mode:** korinfra works without a TTY. Pass `--no-tui` or `--json` for plain text or JSON output, or set `CI=true` for automatic headless detection. See [CI/CD](../README.md#cicd) in the main README for details.

---

## Rules-Only Mode (No AI)

korinfra works without an AI provider. When you select "None — rules only" during `korinfra init` (or set `ai.provider: none` in config), the CLI runs all data collection and rules evaluation deterministically:

```bash
# Setup with no AI provider
korinfra init    # select "None" when asked about AI provider

# These commands work fully without AI:
korinfra scan        # collect → 66 cost + 46 security rules → costs → anomalies → save
korinfra costs       # cost charts + anomaly detection
korinfra resources   # resource inventory table
korinfra security    # 46 security rules on Terraform files
korinfra cost-impact # cost + security impact of a terraform plan (see CI integration guide)
korinfra recommend   # browse saved recommendations from DB
korinfra history     # scan history (list/show/diff)
korinfra tags        # tag compliance audit (list mode)
korinfra report      # export to JSON/CSV/HTML from DB

# These commands require AI:
korinfra fix               # needs AI for Terraform patch generation
korinfra recommend --refresh  # needs AI for fresh analysis
korinfra tags suggest      # needs AI for tag suggestions
```

**What you get without AI:**

- Same data collection (same AWS API calls)
- Same 66 cost rules + 46 security rules
- Same cost anomaly detection (z-score algorithm)
- Same quality scoring for recommendations
- Structured output (tables, charts, numbers)
- $0.00 per query (no AI API costs)

**What you miss without AI:**

- Natural language explanations of findings
- Cross-resource correlation and contextual insights
- Follow-up questions after scans
- Free-form AI questions via `/` in the main menu
- Terraform patch generation (`fix` command)

Commands that require AI show a clear "(needs AI)" label in the interactive menu when no AI provider is configured. You can add an AI provider at any time via `korinfra init`.

---

## All commands

### `scan`

Full infrastructure scan — costs, security posture, and optimization findings.

```bash
korinfra scan
korinfra scan --regions us-east-1,eu-west-1   # specific regions only
korinfra scan --profile production             # specific AWS profile
korinfra scan --skip-costs                     # skip Cost Explorer (saves $0.02, no cost data)
korinfra scan --skip-metrics                   # skip CloudWatch metrics (faster, less accurate rules)
```

The AI agent collects live AWS data, evaluates all rules, and produces a prioritized list of findings and recommendations.

---

### `costs`

Cost breakdown by service and region with trend analysis.

```bash
korinfra costs
korinfra costs --days 60          # look back 60 days
korinfra costs --group-by region  # group by region (service|region|account|tag)
korinfra costs --group-by tag     # cost allocation per tag (untagged spend isolated)
```

Uses AWS Cost Explorer (last 30 days by default). Override with `--days N` or `scan.lookback_days` in config.

**GroupBy variants:** All four groupBy options (service, region, account, tag) are pre-fetched in parallel on load. Switching between them is instant — no loading state or additional API calls. Each Cost Explorer call costs $0.01; results are cached for 6 hours to minimize costs across multiple runs.

---

### `resources`

List and filter live AWS resources.

```bash
korinfra resources
korinfra resources --type ec2_instance          # filter by resource type
korinfra resources --filter service=rds         # filter by service name
korinfra resources --max-lines 50               # limit output rows (default 20, max 1000)
korinfra resources --regions us-east-1,eu-west-1
```

---

### `changes`

Audit recent AWS API activity via CloudTrail. View who made which changes and when.

```bash
korinfra changes                              # last 24 hours
korinfra changes --window 7d                  # look back 7 days (24h/48h/7d)
korinfra changes --user alice@company.com     # filter by IAM user/role
korinfra changes --service ec2                # filter by AWS service
korinfra changes --resource-type EC2:Instance # filter by resource type
korinfra changes --filter read-only           # exclude read-only events (default: show all)
```

Keyboard shortcuts in the TUI:

- `j` — cycle time window (24h → 48h → 7d)
- `r` — refresh data from CloudTrail
- `f` — open filter overlay (user, service, resource type)
- `s` — search event summary

---

### `recommend`

Browse saved FinOps recommendations from the last scan.

```bash
korinfra recommend                   # browse saved recommendations
korinfra recommend --refresh         # re-run AI analysis (requires AI provider)
```

---

### `fix`

Apply a specific recommendation. The AI reads your Terraform files, generates a patch, and optionally creates a GitHub PR.

```bash
korinfra fix <rec-id>                             # interactive TUI
korinfra fix <rec-id> --no-tui                    # headless (get rec-id from scan --no-tui)
korinfra fix <rec-id> --dry-run --no-tui          # preview patch without writing files
korinfra fix <rec-id> --pr --no-tui               # apply and open a GitHub PR
korinfra fix <rec-id> --pr --github-owner <org> --github-repo <repo> --no-tui
```

Requires a recommendation ID from a prior `recommend` or `scan` run. If `--github-owner`/`--github-repo` are omitted, korinfra auto-detects from the current git remote.

---

### `report`

Export scan results to a file.

```bash
korinfra report --format json
korinfra report --format csv
korinfra report --format html    # self-contained HTML with inline SVG charts
```

---

### `history`

Browse past scans, view scan detail, or diff two scans.

```bash
korinfra history                        # alias for "history list"
korinfra history list                   # list all saved scans
korinfra history show <scan-id>         # detail for one scan (resources, costs, recs)
korinfra history diff <id1> <id2>       # delta between two scans (resource + cost diff)
```

Scan IDs come from `korinfra scan --no-tui` output or from `history list`.

---

### `security`

Security posture scan using the built-in 46 security rules (Terraform config + live AWS).

```bash
korinfra security
korinfra security --dir ./terraform        # specify Terraform directory
korinfra security --fail-on critical       # exit 1 on critical findings (CI use)
```

Severity levels: CRITICAL, HIGH, MEDIUM, LOW.

---

### `tags`

Audit resource tagging compliance, suggest tags, or apply AI-suggested tags directly to AWS resources.

```bash
korinfra tags list                              # compliance audit (default)
korinfra tags list --required-tags Env,Team     # override required tags for this run
korinfra tags suggest --resource i-0abc123      # AI-suggested tags for one resource
korinfra tags suggest --virtual                 # include inferred/virtual tags
korinfra tags apply --resource i-0abc123        # AI generates tag mutation plan (dry-run mode)
korinfra tags apply --resource i-0abc123 --force  # apply plan without dry-run confirmation
korinfra tags costs                             # cost allocation by tag
korinfra tags suggest -r i-0abc123             # short form for --resource
```

**Direct tag apply from the TUI (`a` key):**
From a suggestion screen, press `a` to apply the AI-suggested tags directly to the resource. A confirmation dialog shows exactly which tags will be added/updated/removed. This uses the Resource Groups Tagging API for bulk writes and is gated behind the confirm dialog.

Required tags are configured in `.korinfra/config.yaml` (used when `--required-tags` is not passed):

```yaml
scan:
  required_tags:
    - Environment
    - Team
    - Project
```

---

### `pricing`

Manage the local AWS Pricing API cache (used to estimate monthly costs offline).

```bash
korinfra pricing                              # interactive: status + browse cached prices
korinfra pricing status --no-tui              # cache stats: entries, expired, regions covered
korinfra pricing download --regions us-east-1,eu-west-1   # pre-warm cache for regions
```

Cache TTL is `scan.pricing_cache_ttl_days` (default 7 days). Stored in `.korinfra/data.db`.

---

### `init`

Interactive configuration wizard. Creates or updates `.korinfra/config.yaml` (and `.korinfra/.env` for API keys).

```bash
korinfra init                                   # interactive wizard (TUI)

# Headless / CI mode:
korinfra init --non-interactive --profile default --ai-provider anthropic --ai-key sk-ant-api...
korinfra init --config ./korinfra-setup.yaml   # load params from a YAML file
```

| Flag | Description |
|------|-------------|
| `--non-interactive` | Skip interactive prompts (required for headless mode) |
| `--config <file>` | Load init params from YAML instead of flags |
| `--profile <name>` | AWS profile name (default: `default`) |
| `--ai-provider <name>` | `anthropic` or `none` |
| `--ai-key <key>` | Anthropic API key (or set `ANTHROPIC_API_KEY` env var) |
| `--github-token <token>` | GitHub PAT for PR creation (or set `GITHUB_TOKEN`) |

---

### `doctor`

Local health checks — verifies AWS credentials, storage path, API connectivity.

```bash
korinfra doctor
```

---

### `config`

View or edit configuration values.

```bash
korinfra config show
korinfra config set output.verbose true
korinfra config set ai.model claude-sonnet-4-6
korinfra config set scan.lookback_days 60
```

---

### `serve`

Start the MCP server for IDE integration (Claude Code, Cursor, etc.).

```bash
# stdio transport (recommended for Claude Code / Cursor)
korinfra serve

# HTTP transport — for additional MCP clients on the SAME machine.
# For remote/team access, place behind a TLS-terminating proxy or an SSH
# tunnel — the transport is plain HTTP (see SECURITY.md).
korinfra serve --http --port 3000
```

See [mcp.md](mcp.md) for full MCP documentation.

---

### `mcp`

Install or uninstall the MCP server into Claude Code or Cursor.

```bash
korinfra mcp install                            # interactive (TUI)
korinfra mcp uninstall

# Headless / CI mode:
korinfra mcp install --non-interactive --ide claude-code,cursor
korinfra mcp install --config ./mcp-setup.yaml
korinfra mcp uninstall --non-interactive --ide cursor
```

| Flag | Description |
|------|-------------|
| `--non-interactive` | Skip interactive prompts |
| `--config <file>` | Load params from YAML |
| `--ide <list>` | Comma-separated IDE targets: `claude-code`, `cursor` |

Writes the appropriate config entries to your IDE's MCP settings:

- Claude Code: `claude_desktop_config.json`
- Cursor: `mcp.json`

---

## Keyboard shortcuts

korinfra is fully keyboard-driven. You don't need a mouse.

### Most important keys

Learn these first — they work everywhere:

| Key | Action |
|-----|--------|
| `q` | Quit korinfra |
| `Esc` or `b` | Go back to previous screen |
| `?` | Show help overlay (all shortcuts for current screen) |
| `:` | Open command palette (jump to any command) |

### Global shortcuts (available on every screen)

| Key | Action |
|-----|--------|
| `q` | Quit |
| `Esc` / `b` | Back to previous screen |
| `?` | Help overlay — shows all shortcuts for current screen |
| `:` | Command palette — jump to command by name (e.g. `:scan`, `:costs`) |
| `Tab` | Switch between tabs (if multiple tabs available) |
| `Shift+Tab` | Switch to previous tab |

### Navigation (lists, tables, results)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll one row |
| `j` / `k` | Scroll one row (vim-style) |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `PgUp` / `PgDn` | Page up / down |
| `f` | Open filter overlay |
| `r` | Refresh / run again |

### Main menu

| Key | Action |
|-----|--------|
| `↑` / `↓` / `j` / `k` | Move selection up/down |
| `Enter` | Run selected command |
| `s` | Search commands (filter by name) |
| `/` | Open AI chat |

### Command-specific actions (action bar)

Each command screen shows domain actions at the bottom. These vary by command but commonly include:

| Key | Action | Used in |
|-----|--------|---------|
| `r` | Run again / refresh | Most commands |
| `p` | Save report to file | scan, costs, security |
| `s` | New scan | Most analysis screens |
| `d` | Diff / doctor / delete | history, recommend, fix |
| `f` | Filter results | Tables |
| `o` | Open / details | Resource lists |

**Tip:** Press `?` on any screen to see the complete help overlay with all available shortcuts for that specific command.

---

## Development mode

Run without a build step using `tsx`:

```bash
npm run dev scan
npm run dev doctor
npm run dev serve
```

---

## Verification

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src/
npm test             # vitest run
npm run build        # tsdown → dist/
npm run check        # typecheck + lint + test (no build)
```

All of the above must pass before any commit. Run `npm run build` separately — `check` does not include it.
