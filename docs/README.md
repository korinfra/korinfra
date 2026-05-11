# KorInfra Documentation

| Page | What you'll find |
|---|---|
| **[Getting Started](getting-started.md)** | Install korinfra, run `init` wizard, first scan in 5 minutes — includes troubleshooting |
| **[Usage Reference](usage.md)** | All 15 commands with examples, flags, and complete keyboard shortcut reference |
| **[Configuration](configuration.md)** | Complete YAML config schema, environment variables, thresholds, AI provider setup |
| **[Architecture](architecture.md)** | How korinfra works — data flow, rules engine, Terraform resource matching, redaction, AI agent loop, module map |
| **[Scenarios](scenarios.md)** | Scenario A/B/C classification, 4-pass Terraform↔AWS matcher, resource matching, confidence levels |
| **[Workflow & Modes](workflow.md)** | Three execution modes, AI mode vs rules-only mode, step-by-step scan process, tool inventory |
| **[Rules Reference](rules.md)** | All 66 cost optimization rules + 46 security rules (descriptions, severity, savings estimates) |
| **[Running Costs](running-costs.md)** | AWS API costs, AI provider pricing, cost control strategies, rules-only mode cost breakdown |
| **[Token Optimization](token-optimization.md)** | How korinfra minimizes Claude API token usage — volatile data removal, prompt caching, break-even analysis |
| **[MCP Server](mcp.md)** | Use korinfra inside Claude Code, Cursor, or any MCP-compatible IDE/tool |
| **[CI/CD](../README.md#cicd)** | CI/CD integration — headless mode, `--json`, `--fail-on`, exit codes |

## Quick reference

**Install & run:**

```bash
npm install -g korinfra
korinfra init              # first-time setup wizard
korinfra scan              # full infrastructure scan
korinfra costs             # cost breakdown
korinfra report --format html  # export report
```

**Interactive mode:**

```bash
korinfra                   # menu-driven UI
```

**Rules-only (no AI):**
During `korinfra init`, select "None" for AI provider to use korinfra free with no API costs.

**Learn more:**

- Need help? Press `?` on any screen for command-specific shortcuts
- Want to customize? See [Configuration](configuration.md) for all settings
- How it works? Read [Architecture](architecture.md) for the technical deep dive
