# Security Policy

## Supported Versions

Only the latest release (`latest` on npm) receives security fixes. We do not backport fixes to older versions.

| Version | Supported |
|---------|-----------|
| latest (npm) | ✅ |
| older versions | ❌ |

Upgrade to the latest version before reporting a vulnerability — it may already be fixed.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue.** Vulnerabilities disclosed publicly before a fix is ready put all users at risk.

**Preferred channel:** [GitHub Security Advisories](https://github.com/korinfra/korinfra/security/advisories/new) — reports are private, you get a CVE assigned automatically once fixed.

**Alternative:** Email **<vladimirmocanu14@gmail.com>** with `[SECURITY]` in the subject line if you cannot use GitHub.

Include in your report:

- Description of the vulnerability
- Steps to reproduce (minimal reproduction is most helpful)
- Potential impact (what data or system could be affected)
- Suggested fix (optional, but appreciated)

### Disclosure Timeline

| Time | What happens |
|------|-------------|
| T+0 | You submit the report |
| T+2d | Acknowledgment — we confirm receipt and begin triage |
| T+7d | Severity assessment and fix ETA communicated back to you |
| T+90d | Fix shipped (or coordinated extension if complexity requires). Critical severity (RCE, credential leak) — target 14 days. |
| T+30d post-fix | Public disclosure — CVE published via GitHub Advisory, release notes updated |

We follow coordinated disclosure. If 90 days passes without a fix, you may disclose publicly — we will not contest it.

---

## Sensitive Environment Variables

The following environment variables contain credentials and must never be logged, committed, or exposed to untrusted processes:

### Required for Core Features

- **ANTHROPIC_API_KEY** — Claude API key for AI reasoning. Required for all agent commands (`scan`, `recommend`, etc.). Never log this value.
  
- **AWS_ACCESS_KEY_ID** — AWS IAM access key. Required if not using AWS profiles or instance metadata. Combined with `AWS_SECRET_ACCESS_KEY` for AWS API authentication.

- **AWS_SECRET_ACCESS_KEY** — AWS IAM secret key. Must be paired with `AWS_ACCESS_KEY_ID`. Never log or transmit this value.

- **AWS_SESSION_TOKEN** — Optional session token from AWS STS. Required only when using temporary credentials (e.g., from `sts:AssumeRole`). Can be empty if using long-lived credentials.

### Optional for Features

- **GITHUB_TOKEN** — GitHub personal access token. Required only to enable the PR creation feature (`korinfra fix --pr`). Not needed for local scanning. Use fine-grained tokens with minimal permissions for safety.

- **MCP_AUTH_TOKEN** — MCP HTTP server authentication token. Auto-generated at startup if not provided. Set this in production to a stable 32+ character value to avoid regeneration on each restart. Only used when running `korinfra serve --http`.

---

## MCP Transport Trust Model

korinfra supports two MCP server transports for IDE integration and API access:

### Stdio Transport (Default for IDE Integration)

- **Transport** — JSON-RPC over stdin/stdout (used by VS Code, JetBrains IDEs, Cursor, etc.)
- **Authentication** — None required
- **Trust boundary** — The OS process boundary (parent process)
- **Why no auth?** Stdio inherently runs within a single operating system process. An attacker with enough privilege to capture or manipulate stdin/stdout to korinfra already has full system access. Additional token validation adds no security.
- **Use case** — Local IDE integration, where the IDE process and korinfra run on the same machine under the same user.

### HTTP Transport (For Remote/API Access)

- **Transport** — HTTP on a configurable port (default 3000, bound to `127.0.0.1` only)
- **Authentication** — Bearer token in `Authorization: Bearer <token>` header
- **Token generation** — korinfra generates a random 32-byte (256-bit) hex token at startup if `MCP_AUTH_TOKEN` is not set. The token fingerprint (SHA256 prefix) is logged to stderr for verification.
- **Token storage** — Set `MCP_AUTH_TOKEN` environment variable in production to a fixed value (min 32 characters) to avoid regeneration on restart.
- **Token validation** — Uses constant-time comparison (`timingSafeEqual`) to prevent timing side-channel attacks.
- **Use case** — Remote tool access from external processes, CI/CD pipelines, or programmatic clients.
- **Encryption** — None. Plain HTTP. Bearer tokens and response payloads (resource IDs, cost figures, configuration details) travel unencrypted over the underlying connection. The `127.0.0.1` bind prevents direct LAN / internet access by default; for encrypted remote access add an SSH tunnel (`ssh -L 3000:localhost:3000 user@host` — SSH wraps the wire) or a TLS-terminating reverse proxy in front (nginx / Caddy on the same host). Do **not** bind to `0.0.0.0` or `docker run -p 0.0.0.0:3000:3000` without a TLS proxy. See `docs/mcp.md` for setup.

**Important:** The HTTP server binds to `127.0.0.1` only. It does not listen on `0.0.0.0` and cannot be accessed from other machines without explicit port forwarding or proxy configuration.

---

## Proxy and Man-in-the-Middle (MITM) Protection

Proxy configuration (via `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` environment variables) is intentionally **blocked** at the OS/shell level. korinfra does not load proxy settings from `.env` files.

### Why?

A malicious or misconfigured proxy could redirect all AWS API calls through an attacker-controlled endpoint, exfiltrating:

- AWS credentials
- API responses containing account information
- Cost and resource data

### What to Do

If you need to route traffic through a corporate proxy:

1. Configure the proxy at the **OS or shell level** before launching korinfra:
   - **macOS/Linux** — `export HTTP_PROXY=http://proxy.corp.com:8080`
   - **Windows** — Set via System Properties > Environment Variables
2. The proxy is now visible to all child processes launched from that shell, including korinfra.
3. Do NOT commit proxy settings to `.env` or `.korinfra/config.yaml`.

### Verification

korinfra logs a warning if it detects proxy environment variables set at the OS level. This is informational only and does not prevent operation.

---

## Threat Model

### What korinfra protects against

- **Credentials reaching the LLM** — AWS access keys, ARNs with account IDs, public IPs, email addresses are stripped by `src/redaction/` before any Claude API call. This is enforced at multiple boundaries: tool outputs, MCP resources, streamed assistant text, and final result payloads.
- **Arbitrary code execution via config files** — JavaScript/TypeScript config loaders are disabled. Only `.yaml`, `.yml`, and `.json` formats are accepted. YAML is parsed with the restrictive `JSON_SCHEMA` preset (no custom tags, no `!!python/object`-style execution).
- **Path traversal via config discovery** — korinfra uses cosmiconfig with upward traversal disabled. Config search is limited to the current working directory only — it cannot read config files in `~/` or parent directories.
- **Sensitive data in debug logs** — debug output (when `KORINFRA_DEBUG=1`) records only service names, regions, durations, and resource counts. No ARNs, no credentials, no IPs are logged.
- **MCP server abuse** — the HTTP server binds to `localhost` only, uses a bearer token for authentication, and enforces rate limiting per IP. **Note:** the HTTP transport itself is unencrypted; protection against on-the-wire eavesdropping is the deployer's responsibility (SSH tunnel or TLS-terminating proxy).

### What korinfra does NOT protect against

- **Compromised AWS account** — korinfra is a read-only analysis tool. If your AWS credentials are already compromised, korinfra cannot detect or prevent abuse at the AWS level.
- **Malicious local user** — if an attacker has shell access to the machine running korinfra, they can read the SQLite database and config files directly. korinfra is a single-user local tool; it has no multi-tenant isolation.
- **npm supply chain attacks** — korinfra uses ~100 npm dependencies. A compromised transitive dependency is out of scope here; report it to the dependency maintainer. We run `npm audit` and dependabot weekly to reduce exposure.
- **Prompt injection via AWS resource data** — resource names, tags, and descriptions from AWS are sent (redacted) to Claude. A malicious actor who can write arbitrary resource names in your AWS account could theoretically craft prompt injection payloads. The redaction layer strips credentials and IPs but does not sanitize free-form text.
- **Physical access to the machine.**

---

## Architecture Notes

### Credentials & Data Handling

- **AWS credentials never stored** — korinfra uses your local [AWS credential chain](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html) in order: environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`), AWS profiles from `~/.aws/credentials` or `~/.aws/config`, and IAM instance roles. Credentials are never logged, cached, or transmitted by korinfra.
- **AI provider keys stored securely** — API keys saved by `korinfra init` are stored with file permissions `0o600` (owner read-only) and auto-added to `.gitignore`. They are loaded at runtime only.
- **Data is redacted before AI** — all AWS resource data passes through `src/redaction/` at `moderate` level (default) before any Claude API call:

  | Level | What is stripped |
  |-------|-----------------|
  | `minimal` | AWS access keys, Anthropic/OpenAI API keys, GitHub tokens, JWTs, Bearer tokens, DSN credentials, PEM private key blocks, `secret key=value` patterns |
  | **`moderate`** (default) | + ARN account IDs, owner/principal/account IDs, public IPv4/IPv6, email addresses |
  | `strict` | + private IPv4 addresses, external domain names (AWS-internal hostnames like `.amazonaws.com` are preserved) |

- **Redaction is applied at multiple boundaries** — tool outputs, MCP resources, streamed assistant text, and final assistant result payloads are sanitized before surfacing in CLI/MCP responses. A finding that bypasses tool-output redaction still gets sanitized before display.

### What Redaction Cannot Catch

Redaction is pattern-based. It reliably strips structured secrets (API keys, ARNs, IP addresses). It cannot protect against:

- **Free-form text fields** — EC2 instance `Name` tags, RDS cluster identifiers, S3 bucket names, Lambda function names, and resource `Description` fields are sent as-is. If your naming convention embeds account IDs, usernames, or internal domain names (e.g., `user-john.doe-prod-db`), those will reach the AI provider.
- **Custom tag values** — Any tag value on any resource is sent verbatim. Avoid tagging resources with credentials, personal data, or internal-only identifiers.
- **S3 object keys and bucket policies** — korinfra does not read S3 object contents or full bucket policies; only metadata (versioning, encryption, public-access-block) is collected. But if a bucket's `Name` contains sensitive information, it is not stripped.

The redaction level defaults to `moderate` and is configurable via `ai.redaction_level` in your config file. To apply `strict` redaction (also strips private IPs and external domain names), set `ai.redaction_level: strict`.

### Local Storage

- **SQLite database stored locally** — all scan results, recommendations, cost history are stored in `.korinfra/data.db` in your project directory. No data syncs to any external service.
- **Database permissions** — set to `0o600` on Unix systems (owner read-write only). Windows uses the user profile directory with standard ACLs.
- **Automatic retention purge** — records older than 365 days are automatically deleted from the database on each startup.
- **Forensic trail** — every AWS API call is logged to the `api_call_log` table (capped at 10,000 entries). If korinfra ever behaves unexpectedly or you suspect credential misuse, inspect this table: it contains the service name, operation, region, timestamp, and response status — no credential values.
- **No telemetry** — the cost display in the TUI shows your own Claude API usage cost; this data is not sent to korinfra or any third party. korinfra has no analytics, no crash reporting, no ping-home mechanism.

### Network & MCP Server

- **MCP HTTP server binds to `localhost` only** — the HTTP transport (`korinfra serve --http`) is never exposed on external network interfaces.
- **HTTP transport is unencrypted** — plain HTTP, no TLS. Auth tokens and resource payloads travel in plaintext over the underlying connection. The `localhost` bind prevents direct LAN access; for encrypted remote access, terminate TLS in a reverse proxy (nginx, Caddy) or wrap the wire in an SSH tunnel. See `docs/mcp.md` Security model for details.
- **Bearer token authentication** — a random auth token is auto-generated at startup. Set `MCP_AUTH_TOKEN` env var to a fixed value (min 32 chars) to reuse it across restarts. Rotate by clearing the env var and restarting.
- **Per-session state** — each MCP session is isolated. Session state is not shared between clients or persisted after disconnect.
- **Rate limiting** — 300 requests/minute per IP on the HTTP transport (configurable in `config.mcp.http_rate_limit`). Additional rate limiting by weighted tool cost prevents expensive operations from exhausting session budgets.
- **stdio transport** (used by Claude Code, Cursor) communicates exclusively through stdin/stdout — no network port is opened.

### Configuration File Security

#### Search Boundary & Path Traversal Prevention

korinfra uses [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) with an explicit **project-only boundary**:

- Configuration search is **limited to `process.cwd()` only** — upward traversal is disabled
- Does **not** traverse parent directories or `~` (home directory)
- Prevents configuration inheritance from parent projects or system-wide files
- If no config is found, korinfra fails with `ENOENT` and prompts `korinfra init`

Recognized config locations (in search order):

1. `.korinfra/config.yaml` or `.korinfra/config.yml`
2. `.korinfra/config.json`

All project state (config, DB, `.env`, cache) is contained in the `.korinfra/` directory created by `korinfra init`.

#### Disabled Code Execution in Config Files

JavaScript and TypeScript config loaders are **explicitly disabled**. Only `.yaml`, `.yml`, and `.json` formats are accepted:

- `.js`, `.mjs`, `.cjs`, `.ts` configs are rejected with a clear error
- YAML is loaded with the `JSON_SCHEMA` preset (no custom YAML tags, no code execution)
- JSON uses the native Node.js parser

**Why:** Config files may be touched by build tools, CI systems, or version control hooks. Accepting JS/TS creates an injection surface — a compromised file in the repo could execute arbitrary code on every korinfra run.

---

## Supply Chain Security

- **npm provenance** — releases published via GitHub Actions with `id-token: write` permission. Provenance is attestable via `npm audit signatures`.
- **Lockfile integrity** — CI verifies `package-lock.json` integrity on every run (`npm run lint:lockfile`).
- **Secret scanning** — `secretlint` runs on every CI build to prevent accidental credential commits (`npm run lint:secrets`).
- **Dependabot** — dependency updates run weekly (Mondays). AWS SDK, Anthropic SDK, and Ink/React packages are updated as grouped batches.
- **Security audit** — `npm audit --audit-level=high` runs in CI. High-severity advisories block the build.
- **Minimal permissions** — GitHub Actions workflows use explicit, minimal permissions per job. No `write-all` grants.

---

## Scope

**In scope:**

- Credential leaks (AWS keys, API keys reaching logs, AI provider, or network)
- Remote code execution
- Data exposure (scan results, recommendations, cost data leaving the local machine)
- Authentication bypass (MCP bearer token bypass)
- Arbitrary code execution via config file or input handling
- Path traversal in config discovery or file operations

**Out of scope:**

- Vulnerabilities in upstream npm dependencies — report to the dependency maintainer; we will update versions
- Issues requiring physical access to the machine
- Denial of service via local resource exhaustion
- Social engineering of maintainers
- Bugs that only affect development builds or unreleased code
