# GitHub Configuration

This directory contains all GitHub-specific configuration for the korinfra repository.

## Files Overview

### Workflows (`.github/workflows/`)

| File | Purpose | Trigger |
|------|---------|---------|
| **ci.yml** | Full test suite: typecheck, lint, test, build | Push to main/master + PR |
| **release.yml** | Auto-publish to npm + create GitHub Release | Git tag `v*.*.*` |
| **triage.yml** | Auto-manage stale issues | Issue/PR opened or reopened |

### Issue Templates (`.github/ISSUE_TEMPLATE/`)

| File | Purpose |
|------|---------|
| **1-bug.yml** | Bug reports — includes environment, reproduction steps, security reminder |
| **2-feature.yml** | Feature requests — problem statement, proposed solution, impact |
| **3-documentation.yml** | Doc improvements — specific page/section, what's wrong, suggested fix |
| **config.yml** | Issue template configuration — disables blank issues, links to docs/discussions |

### Templates

| File | Purpose |
|------|---------|
| **PULL_REQUEST_TEMPLATE.md** | PR template with checklists for code, TUI, security, and docs |

### Configuration

| File | Purpose |
|------|---------|
| **CODEOWNERS** | Automatic PR reviewer assignment |
| **dependabot.yml** | Automated dependency updates (npm + GitHub Actions) |
| **FUNDING.yml** | Sponsorship links (GitHub Sponsors, Polar) |

## Workflow Details

### CI Workflow

Runs on:

- Push to `main` or `master` (with path filters)
- Pull requests to `main` or `master` (with path filters)

Matrix: Node.js 20 and 22 (from `package.json` `engines.node`)

Steps:

1. Security hardening (StepSecurity harden-runner)
2. Checkout code
3. Setup Node.js + npm cache
4. Install dependencies (`npm ci`)
5. Audit npm signatures
6. Audit dependencies for high-severity issues
7. Verify lockfile integrity
8. Type checking (`npm run typecheck`)
9. Linting (`npm run lint`)
10. Secret scanning (`npm run lint:secrets`)
11. Tests (`npm test`)
12. Build (`npm run build`)
13. Upload artifacts (Node.js 20 only, 7-day retention)

**Concurrency:** Cancels previous CI runs for the same ref (prevents queue-up).

### Release Workflow

Runs on: Git tags matching `v*.*.*` or `v*.*.*-*` (semver format)

Steps:

1. Validate tag format (must be valid semver)
2. Checkout code
3. Setup Node.js 22 + npm registry auth
4. Install dependencies
5. Run full checks (`npm run check`)
6. Build distribution
7. Publish to npm with public access
8. Create GitHub Release with auto-generated release notes
9. Upload build artifacts to release

**Permissions:**

- `contents: write` — create GitHub releases
- `id-token: write` — npm provenance (future-proof)

### Triage Workflow

Automatically labels issues as `stale` after 30 days of inactivity.

- Closes issues after 44 days of inactivity
- Issues labeled `bug` or `blocked` are exempt from auto-close
- Removes `stale` label when activity resumes

## Issue Templates

### Bug Report (`1-bug.yml`)

**Required fields:**

- Bug description
- Steps to reproduce
- Expected vs actual behavior
- korinfra version
- Operating System

**Optional fields:**

- Error output / stack trace
- `korinfra doctor` output
- AWS region

**Security reminder:** Fields prominently request redaction of AWS account IDs, ARNs, API keys, etc.

### Feature Request (`2-feature.yml`)

**Required fields:**

- Problem this solves
- Proposed solution

**Optional fields:**

- Alternatives considered
- Use case / impact
- Willing to contribute checkbox

### Documentation (`3-documentation.yml`)

**Required fields:**

- Page or section
- What's wrong or missing

**Optional fields:**

- Suggested fix / content
- Impact level dropdown (Critical/High/Medium/Low)

### AI Provider Request (`4-ai-provider.yml`)

**Required fields:**

- Provider name
- Why this provider

**Optional fields:**

- SDK/API documentation link
- Provider capabilities (streaming, function calling, etc.)
- Willing to implement checkbox

## Pull Request Template

Guides contributors through:

- Concise summary (1-3 sentences)
- Type of change (bug fix, feature, refactor, docs, CI)
- Verification checklist (typecheck, lint, test, build)
- TUI changes checklist (spacing, severity labels, navigation keys)
- Security checklist (if applicable)
- Documentation updates
- Related issues

## Code Owners

Auto-assigns `@vladimirmocanu` as reviewer for:

- All code changes (fallback)
- AWS integration (`src/aws/`, `src/pricing/`)
- CLI & TUI (`src/cli/`, `src/utils/`)
- Agent system (`src/agent/`, `src/classifier/`)
- Storage (`src/storage/`)
- Security (`src/rules/`, `src/redaction/`)
- IaC (`src/terraform/`)
- Configuration & MCP (`src/config/`, `src/mcp/`)
- Build config (`tsconfig.json`, `eslint.config.js`, etc.)
- Documentation and workflows

## Dependabot Configuration

### npm Dependencies

- **Schedule:** Weekly (Mondays at 08:00 UTC)
- **Grouping:**
  - `aws-sdk` — all AWS SDK packages
  - `anthropic-providers` — Anthropic SDK
  - `openai-providers` — OpenAI SDK
  - `ink-react` — Ink + React dependencies
  - `development` — all dev dependencies
- **Open PR limit:** 10
- **Commit prefix:** `chore(deps)`

### GitHub Actions

- **Schedule:** Weekly (Mondays at 08:30 UTC)
- **Open PR limit:** 5
- **Commit prefix:** `ci(actions)`

## Funding

korinfra accepts sponsorships through:

- [GitHub Sponsors](https://github.com/sponsors/vladimirmocanu)
- [Polar.sh](https://polar.sh/vladimirmocanu)

## Security

For security vulnerabilities:

1. **Do NOT open a public GitHub issue**
2. Report via [GitHub Security Advisories](https://github.com/korinfra/korinfra/security/advisories/new)
3. Response time: 48 hours acknowledgment, 90-day fix target

See [SECURITY.md](../SECURITY.md) for the full security policy.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines on:

- Code conventions
- Adding cost/security rules
- Adding AWS collectors
- Testing requirements
- PR checklist
- Good first issues

---

**Last updated:** 2026-04-15
