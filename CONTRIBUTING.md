# Contributing

All contributions are welcome — from fixing a typo to adding new AWS collectors. New to open source? Check [Good First Issues](#good-first-issues) below.

## Fork → Commit → PR

```bash
# 1. Fork repo on GitHub
# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/korinfra
cd korinfra
npm install

# 3. Create a feature or fix branch
git checkout -b fix/issue-description       # or feat/ or docs/
npm run dev -- doctor                       # test a command without building

# 4. Make your changes, verify they work
npm run typecheck && npm run lint && npm run test && npm run build

# 5. Commit with conventional message
git commit -m "fix(tui): correct label in costs screen"

# 6. Push and open PR against main
git push origin fix/issue-description
```

## Branch Naming

- `fix/description` — bug fixes
- `feat/description` — new features
- `docs/description` — documentation only
- `chore/description` — dependencies, build scripts

## Commit Format

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
fix(scan): add --regions flag for region filtering
docs: update README with new examples
feat(terraform): support Terraform 1.8+ backend configs
```

Scope is optional but helps reviewers. Common scopes: `scan`, `costs`, `tui`, `terraform`, `aws`, `mcp`, `rules`, `agent`, `storage`.

## Verification Checklist

Before opening a PR, **all four must pass**:

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint src/
npm run test             # vitest run
npm run build            # tsdown → dist/
```

Shortcut: `npm run check` runs typecheck + lint + test (does not include build — run that separately).

## Code Style

### TypeScript & ESM

- Pure ESM only — `"type": "module"`, all imports use `.js` extensions (even for `.ts` source files)
- `import type` for type-only imports — enforced by ESLint `consistent-type-imports`
- Zod 4 for all runtime validation: config, API payloads, tool schemas
- Strict TypeScript — no `any`, all types explicit
- No unnecessary abstractions — if something is used once, inline it

### AWS & Security

- Rate limit all AWS API calls via `src/aws/rate-limiter.ts` — never call AWS SDK directly
- Redact before AI — call `redactObject()` from `src/redaction/` at `moderate` level minimum before any AI call. This is non-negotiable: raw ARNs, IPs, and account IDs must not reach the LLM.
- Log every AWS API call to the `api_call_log` table (via the rate limiter — it logs automatically)
- Never prompt for credentials in code — credential handling belongs in `korinfra init`

### TUI Changes (if modifying `src/cli/`)

- Use constants from `src/cli/ui/spacing.ts` — no inline `marginTop`/`marginBottom` values
- Use `DOT_SEP` from `src/cli/ui/text.ts` — no inline `' · '` strings
- Use `SEVERITY_LABELS` from `src/cli/ui/text.ts` — no hardcoded `'CRITICAL'`, `'HIGH'`, etc.
- All command screens must be wrapped in `ScreenShell` — never replicate the header manually
- `ActionBar` is for domain actions only (e.g., `r refresh`, `f filter`); `NavHints` is for navigation only (e.g., `↑↓ navigate`, `Enter select`)
- Test at terminal widths: 56, 72, and 80+ columns

## Debug Mode

Set `KORINFRA_DEBUG=1` to trace every AWS API call in real time — useful when adding a new collector or investigating a slow scan:

```bash
KORINFRA_DEBUG=1 npm run dev -- scan
```

Two files are written to `~/.korinfra/debug/`:

- **`korinfra-debug.log`** — live trace. Run `tail -f ~/.korinfra/debug/korinfra-debug.log` in a separate terminal while the scan runs.
- **`korinfra-timing.json`** — per-service timing sorted slowest-first, written after the scan completes.

Both files are `.gitignore`d and contain no credentials — only service names, regions, durations, and resource counts.

## Adding a Cost or Security Rule

1. Look at an existing rule in `src/rules/cost/` or `src/rules/security/` to understand the shape
2. Create a new file following the same pattern (each rule is a single exported function)
3. Register it in `src/rules/registry.ts` — add to the correct array
4. Write a test in `tests/unit/rules.test.ts` — cover the positive case (rule fires) and negative case (rule doesn't fire)
5. Run `npm test` to confirm the test passes

Rules are deterministic — they run locally without AI and must not make AWS API calls. All resource data they need is passed in as arguments.

## Adding an AWS Collector

1. Create `src/aws/collectors/<service>.ts`
2. Use `getRateLimiter('<service>')` for every AWS SDK call — never call the SDK directly
3. Return data in the shape defined by `src/aws/types.ts`
4. Register the collector in `src/aws/collect.ts`
5. Add an integration test in `tests/integration/`
6. Test locally: `npm run dev -- scan` and verify the new service appears in the output

Every AWS API call is automatically logged to the `api_call_log` SQLite table via the rate limiter — no extra work needed.

## Tests

Tests live in `tests/` mirroring `src/`:

- `tests/unit/` — pure logic, no external dependencies (no AWS, no DB, no network calls)
- `tests/integration/` — SQLite and MCP server (use real SQLite, not mocks — mocks have caused prod/test divergence before)

Vitest globals are enabled — no need to import `describe`, `it`, or `expect`. Per-test timeout: 30s.

## PR Guidelines

- One logical change per PR — easier to review, easier to revert if something breaks
- Include tests for new functionality (unit or integration depending on what you're adding)
- Update docs if changing user-facing behavior (`README.md`, `docs/`)
- PR title: imperative mood, under 70 chars — e.g., `fix: correct savings label in costs screen`
- PR body: describe what, why, and how you tested it
- The `.github/PULL_REQUEST_TEMPLATE.md` auto-populates the PR form — fill in every section

## Getting Help & Good First Issues

New contributor? Check GitHub issues tagged [`good first issue`](https://github.com/korinfra/korinfra/labels/good%20first%20issue):

- **Add a cost or security rule** — copy an existing rule, register it, add a test (~30 min)
- **Improve a doc page** — fix unclear sections, add examples (~30 min)
- **Add a test for an untested rule** — find a rule without a test and write one (~1 hour)
- **Fix a typo or error message** (~15 min)

**Non-code contributions:**

- File accurate bug reports with reproduction steps
- Request features — describe the AWS service or workflow you need
- Answer questions in [GitHub Discussions](https://github.com/korinfra/korinfra/discussions)

## Issue Labels

| Label | Meaning |
|-------|---------|
| `bug` | Something isn't working |
| `enhancement` | New feature or improvement |
| `documentation` | Docs changes only |
| `good first issue` | Suitable for new contributors |
| `needs-triage` | Not yet reviewed by a maintainer |
| `area:ai` | Related to AI providers or agent loop |
| `area:aws` | Related to AWS collectors or SDK |
| `area:terraform` | Related to Terraform parsing or resource matching |
| `area:mcp` | Related to MCP server mode |

## Release Process

> Maintainer only.

1. Ensure `npm run check` passes and `npm run build` succeeds
2. Bump version: `npm version patch|minor|major` (updates `package.json` and creates a git tag)
3. Push: `git push && git push --tags`
4. GitHub Actions `release.yml` picks up the new tag, publishes to npm, and creates a GitHub Release automatically

**Required repo secret:** `NPM_TOKEN` — generate at npmjs.com → Access Tokens → Automation token.
