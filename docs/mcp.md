# MCP Server

korinfra implements the [Model Context Protocol](https://modelcontextprotocol.io) — it can act as an MCP server that exposes all its tools, resources, and prompts to any MCP-compatible AI client (Claude Code, Cursor, Continue, etc.).

**Why use MCP mode?** Instead of switching to the terminal, you can ask your AI coding assistant natural language questions about your AWS infrastructure directly from your editor: "which EC2 instances are idle?", "are my RDS instances encrypted?", "show me cost anomalies this month". korinfra runs the analysis and returns structured results — no context switching needed.

---

## Transports

### stdio (recommended for IDE integrations)

```bash
korinfra serve
```

The process communicates over stdin/stdout. This is the standard transport for IDE plugins.

### HTTP (Streamable HTTP)

```bash
korinfra serve --http --port 3000
```

- Per-session stateful connections
- Localhost-only bind
- Bearer token authentication (auto-generated and persisted on first start)
- 300 requests/minute rate limiting per IP (default, configurable via `mcp.http_rate_limit`)
- Sessions idle for 30 minutes are cleaned up automatically (configurable via `mcp.session_idle_timeout_ms`)

**Token rotation:**

```bash
korinfra serve --http --port 3000 --rotate-token
```

Deletes the persisted token and generates a new one. Use this if the token is compromised or when starting fresh in a new environment.

---

## Auto-install (`korinfra mcp install`)

The fastest way to register korinfra as an MCP server. Runs the interactive wizard or a headless one-shot — both edit the IDE's config file in place, with an automatic `.bak` backup before any write.

### Interactive wizard

```bash
korinfra mcp
```

Renders a TUI that detects which of the four supported IDEs are installed, shows current state per IDE (`not-installed` / `installed` / `differs`), and lets you toggle each. Restart the IDE afterward to load the server.

### Headless (CI / scripts / non-TTY)

```bash
# Install into one or more IDEs
korinfra mcp install --non-interactive --ide claude-code,cursor,vscode,jetbrains

# Single IDE
korinfra mcp install --non-interactive --ide claude-code

# Remove
korinfra mcp uninstall --non-interactive

# JSON output (for scripting)
korinfra mcp install --non-interactive --ide claude-code --json

# From a config file
korinfra mcp install --config ./mcp-setup.yaml
```

Config file shape (YAML or JSON):

```yaml
ide: claude-code,cursor
```

### Supported IDEs and config paths

| IDE | Config path | Shape |
|---|---|---|
| `claude-code` | `~/.claude.json` | `mcpServers.korinfra` (flat) |
| `cursor` | `~/.cursor/mcp.json` | `mcpServers.korinfra` (flat) |
| `vscode` | `%APPDATA%/Code/User/settings.json` (Windows) · `~/Library/Application Support/Code/User/settings.json` (macOS) · `~/.config/Code/User/settings.json` (Linux) | `mcp.servers.korinfra` (nested) |
| `jetbrains` | `~/.config/JetBrains/mcp.json` | `mcpServers.korinfra` (flat) |

VS Code also supports project-local install at `<cwd>/.vscode/mcp.json` (set scope via the wizard).

### What gets written

```json
{
  "mcpServers": {
    "korinfra": {
      "type": "stdio",
      "command": "korinfra",
      "args": ["serve"]
    }
  }
}
```

The `command` defaults to `korinfra` (resolved on `PATH`). Override with `KORINFRA_BIN=/abs/path/to/korinfra` if the binary is not on `PATH`.

After install, **restart the IDE** to pick up the new server. korinfra tools then appear in the IDE's MCP tool list.

---

## Manual install

If `korinfra mcp install` does not cover your client, add the entry yourself:

```json
{
  "mcpServers": {
    "korinfra": {
      "command": "npx",
      "args": ["korinfra", "serve"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "AWS_PROFILE": "default"
      }
    }
  }
}
```

> Set `ANTHROPIC_API_KEY` for Claude. Optional if you use rules-only mode (`ai.provider: none`).

Or if you have korinfra installed globally:

```json
{
  "mcpServers": {
    "korinfra": {
      "command": "korinfra",
      "args": ["serve"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "AWS_PROFILE": "default"
      }
    }
  }
}
```

---

## Tools (20)

19 tools are shared between agent mode (in-process) and MCP server mode (external clients). Two additional tools are restricted: `git_commit_push` (exclusively for `fix` command agent, not exposed via MCP) and `apply_tags_real` (only callable via TUI confirmation gate, not exposed via MCP).

| Tool | Description |
|---|---|
| `collect_aws_resources` | Collect live AWS inventory with utilization metrics. Data is redacted at `moderate` level before being returned. |
| `get_costs` | Cost breakdown (daily/monthly, by service/region) from Cost Explorer. |
| `list_rules` | List all 66 cost rules + 46 security rules with metadata. |
| `evaluate_rules` | Run deterministic rules against collected resource data. Returns findings with estimated monthly savings. |
| `save_scan` | Persist scan results (resources, costs, findings, recommendations) to SQLite. |
| `get_history` | Retrieve past scans from the local DB. |
| `compare_scans` | Diff two scans — new findings, resolved findings, cost delta. |
| `scan_terraform` | Parse Terraform HCL files or directories. Returns structured resource definitions. |
| `terraform_validate` | Run `terraform validate -json` and return parsed results. Does not require AWS credentials or backend access. |
| `scan_security` | Evaluate security rules against Terraform resources. |
| `classify_resources` | Classify AWS and Terraform resources into scenarios A/B/C, generate recommendations, and deduplicate findings. |
| `detect_cost_anomalies` | Z-score anomaly detection on Cost Explorer time-series data. |
| `create_github_pr` | Create a GitHub PR with fix details and savings estimate. Requires `GITHUB_TOKEN`. |
| `get_recommendations` | Load saved recommendations from the DB. |
| `apply_recommendation` | Mark a recommendation as applied or dismissed. |
| `get_changes` | Query CloudTrail for recent AWS API activity. Filter by user, resource type, or service within a configurable time window (24h/48h/7d). |
| `find_idle_ec2` | Multi-signal idle EC2 detection: CPU < threshold AND egress < 1 GB/month AND age > N days. |
| `find_orphan_ebs` | Detect unattached EBS volumes still billing. Returns volumes with age and associated costs. |
| `find_idle_rds` | Detect zero-connection RDS instances: DatabaseConnections ≈ 0 for > 7 days AND CPU < 10%. |
| `get_ri_coverage` | Reserved Instance utilization analysis: compare RI commitments vs. on-demand spend by service. |

---

## Resources (3, read-only)

Resources are read-only snapshots exposed to AI clients. All data is redacted at `moderate` level.

| URI | Description |
|---|---|
| `iw://config` | Current korinfra configuration (sanitized — no API keys). |
| `iw://last-scan` | Most recent scan results summary. |
| `iw://cost-summary` | Cost summary with total savings identified, anomaly counts, and scenario counts. |

---

## Prompts (3)

Workflow guidance prompts for AI assistants.

| Name | Description |
|---|---|
| `analyze-costs` | Guides step-by-step cost breakdown analysis for a given AWS account or service. |
| `find-waste` | Guides waste detection across EC2, RDS, S3, Lambda, ECS. |
| `check-scenarios` | Compares Terraform state against live AWS resources and classifies discrepancies into Scenario A/B/C. |

---

## Security model

> See also: [SECURITY.md](../SECURITY.md) for the formal trust model, threat model, and credential handling notes.

### Transport security

- **stdio** has no network exposure — communication happens entirely over the stdin/stdout pipe of the parent process. This is the recommended default for IDE integrations.
- **HTTP** is plain HTTP, **not HTTPS**. The Bearer auth token and all resource payloads (resource IDs, cost figures, configuration details) travel unencrypted over the underlying connection.
- The server binds to `127.0.0.1` only, which prevents direct LAN / internet access by default. Remote access must intentionally add an encryption layer:
  - **SSH tunnel** — recommended for ad-hoc remote access. SSH wraps the entire wire between your client and the remote host in its own encryption, so the plain-HTTP traffic only ever appears on the two `127.0.0.1` segments at each endpoint (no wire involved).
  - **TLS-terminating reverse proxy** (nginx, Caddy) on the same host as the MCP server, fronting `127.0.0.1:3000` — recommended for production remote access. The proxy speaks HTTPS to the world and plain HTTP over loopback to korinfra. Whichever proxy you use, it must be configured to strip `X-Forwarded-For` before forwarding (see snippets below) — the MCP server rejects requests carrying that header.
  - **Avoid** binding the server to `0.0.0.0` or using `docker run -p 0.0.0.0:3000:3000` without a TLS proxy in front — both expose plain HTTP directly to the network with no encryption.

> **Multi-user caveat:** once a reverse proxy fronts the server, every client appears to come from the proxy's local address. Per-IP rate limiting (`mcp.http_rate_limit`, default 300 req/min) becomes a single bucket shared by all users, and there is only one bearer token for the whole server. For true multi-tenant access with per-user quotas, terminate authentication at the proxy and shape per-client traffic there.

**SSH tunnel (ad-hoc remote access):**

```bash
# From your laptop, forward local port 3000 to the MCP server on the remote.
# SSH encrypts the wire; the HTTP traffic only exists in plaintext on each
# machine's loopback interface, never on the network in between.
ssh -L 3000:localhost:3000 user@remote-host
```

**TLS-terminating reverse proxy (production / multi-user):**

```nginx
# nginx terminates TLS for mcp.example.com and forwards to korinfra on
# 127.0.0.1:3000.
server {
    listen 443 ssl;
    server_name mcp.example.com;
    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        # Do NOT forward X-Forwarded-For — the MCP server rejects requests
        # carrying that header (it has no trusted meaning for a localhost bind).
        proxy_set_header X-Forwarded-For "";
    }
}
```

```caddy
# Caddyfile equivalent (automatic Let's Encrypt certificates).
# Caddy's reverse_proxy adds X-Forwarded-For by default — strip it
# explicitly, otherwise the MCP server returns 400.
mcp.example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up -X-Forwarded-For
    }
}
```

### Authentication

- Bearer token is auto-generated and persisted to `~/.korinfra/mcp-token` on first start, then reused on restarts
- Set `MCP_AUTH_TOKEN` env var to override with a fixed 32+ char value
- Use `korinfra serve --http --rotate-token` to delete the persisted token and generate a new one
- Token file is created with mode `0o600` (readable/writable by owner only) on POSIX systems

### Data redaction

- All MCP resource data is redacted at `moderate` level before transmission. Redaction limits what the client sees, not what an on-the-wire eavesdropper sees — it is not a substitute for transport encryption.

### Tool restrictions

- The MCP server never has access to `Bash` or `WebFetch` — these are always denied

---

## Troubleshooting

### Server not appearing in IDE after install

**Symptom:** After running `korinfra mcp install`, the korinfra server doesn't appear in the IDE's MCP tool list.

**Causes & fixes:**

- **IDE not restarted.** Close and reopen the IDE completely (not just the editor window).
- **`korinfra` not on PATH.** If using the default `korinfra` command (not `KORINFRA_BIN`), ensure the binary is in your `$PATH`. Check with `which korinfra` (Unix) or `where korinfra` (Windows). If not found, set `KORINFRA_BIN=/abs/path/to/korinfra` before running `korinfra mcp install`.
- **Config file syntax error.** Check the IDE's config file (paths above) for invalid JSON. A `.bak` backup was created before the last install — you can restore it and retry.
- **VS Code project scope.** If installing to a specific project, use `korinfra mcp install --non-interactive --ide vscode --scope project` (writes to `.vscode/mcp.json` in the current directory).

### Token mismatch on HTTP transport

**Symptom:** Requests to `http://localhost:3000` fail with 401 Unauthorized.

**Causes & fixes:**

- **Token moved or deleted.** The persisted token is stored at `~/.korinfra/mcp-token`. If you've moved your home directory or deleted this file, the server will generate a new token. Read it from stderr or from `~/.korinfra/mcp-token` and update your IDE config.
- **Different token after restart.** If the persisted file is missing or corrupted, the server generates a new one. Use `korinfra serve --http --rotate-token` intentionally, or restore the backed-up `~/.korinfra/mcp-token` file.
- **Authorization header missing.** Ensure the `Authorization: Bearer <token>` header is sent. The token is printed to stderr when the MCP server starts and also stored at `~/.korinfra/mcp-token`.
- **Using MCP_AUTH_TOKEN override.** If you set the `MCP_AUTH_TOKEN` env var, the persisted file is ignored. Ensure the token value is consistent across restarts.

### `` command not found `` after install

**Symptom:** IDE fails to start the MCP server with "korinfra: command not found".

**Cause & fix:** The `korinfra` binary is not on `PATH`. Set `KORINFRA_BIN=/abs/path/to/korinfra` in your shell or IDE environment before restarting the IDE.

### Config file invalid JSON

**Symptom:** Install fails with "contains invalid JSON".

**Cause & fix:** The IDE's config file (or `.vscode/mcp.json`) is malformed. Check for missing commas, trailing commas, or unclosed braces. A `.bak` backup was created — restore it, fix the JSON, and retry.

### Check install status

```bash
korinfra mcp status
```

Prints the current install state per IDE without modifying anything. Use `--json` for scripting.

---

## Resources — redaction details

All resources expose data at `moderate` redaction level. The following fields are stripped or redacted:

| Resource | Redacted fields |
|---|---|
| `iw://config` | `ai.api_key_env` (env var name exposed, actual key not returned), `aws.profile` (aws CLI profile name), `storage.path` (full filesystem path to DB) |
| `iw://last-scan` | No additional redaction beyond moderate level (IPs, email, ARNs redacted by default) |
| `iw://cost-summary` | No additional redaction |

To see exactly what fields are redacted, run:

```bash
korinfra serve --http &
curl -X GET http://localhost:3000/resources/iw://config \
  -H "Authorization: Bearer <token>"
```

(Use the token printed to stderr when the server starts.)
