# CI integration

`korinfra` is designed to run unattended in continuous integration. Every
non-interactive command emits stable JSON via `--json`, exits with a
predictable code, and reads only from local files — no AWS API calls are
required for `security` or `cost-impact`.

This guide shows two common pipelines:

1. **Pre-deployment cost-impact review on every PR** — runs `cost-impact`
   against the `terraform plan` output, posts the summary as a PR comment,
   and fails the build on critical security regressions.
2. **Terraform security scanning on every push** — runs `security` against
   the Terraform directory and fails the build on critical findings.

Both work with GitHub Actions; the principles transfer to other CI systems.

## 1. Pre-deployment cost-impact review

Add the following job to `.github/workflows/cost-impact.yml`:

```yaml
name: Cost impact

on:
  pull_request:
    paths:
      - 'terraform/**'

permissions:
  contents: read
  pull-requests: write   # for PR comments
  id-token: write        # if you use AWS OIDC

jobs:
  cost-impact:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: '1.6.0'

      - name: Terraform plan
        working-directory: terraform
        run: |
          terraform init -input=false -no-color
          terraform plan -out=plan.tfplan -no-color
          terraform show -json plan.tfplan > plan.json

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install korinfra
        run: npm install -g korinfra

      - name: Run cost-impact
        id: impact
        working-directory: terraform
        run: |
          korinfra cost-impact \
            --plan-file plan.json \
            --json \
            --fail-on critical \
            > impact.json
        continue-on-error: true

      - name: Post PR summary
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const impact = JSON.parse(fs.readFileSync('terraform/impact.json', 'utf8'));
            const s = impact.summary;
            const fmt = (n) => (n > 0 ? '+$' : '$') + n.toFixed(2);
            const findings = (impact.findings || [])
              .filter(f => f.severity === 'critical' || f.severity === 'high')
              .slice(0, 5)
              .map(f => `- **[${f.severity.toUpperCase()}]** ${f.ruleId} on \`${f.address}\` — ${f.title}`)
              .join('\n');
            const body = [
              `## 💰 KorInfra cost-impact`,
              ``,
              `**Net delta:** ${fmt(s.netDeltaMonthlyUsd)}/mo (annualized ${fmt(s.netDeltaAnnualUsd)})`,
              ``,
              `${s.counts.create} created · ${s.counts.update} updated · ${s.counts.destroy} destroyed · ${s.counts.replace} replaced`,
              ``,
              findings ? `### Findings that would trigger after apply\n\n${findings}` : '_No critical/high findings._',
            ].join('\n');
            github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body,
            });

      - name: Fail on critical findings
        if: steps.impact.outcome != 'success'
        run: |
          echo "::error::cost-impact reported critical findings — see PR comment for details"
          exit 1
```

Notes:

- `cost-impact` exits `0` on success, `1` when `--fail-on critical` or
  `--fail-on-delta` matches, `2` on user error (missing `--plan-file`, path
  outside cwd, wrong file extension). The `continue-on-error: true` lets
  the workflow post the summary before failing the step.
- The `--plan-file` value is resolved relative to the current directory and
  must stay inside the working directory.
- No AWS credentials are required for `cost-impact` — pricing is computed
  from static tables.

### Dollar-threshold gating (`--fail-on-delta`)

To fail when the plan's net monthly cost delta exceeds a dollar amount:

```yaml
- name: Run cost-impact with dollar gate
  run: |
    korinfra cost-impact \
      --plan-file terraform/plan.json \
      --json \
      --fail-on critical \
      --fail-on-delta ${{ vars.MAX_DELTA_USD }}
```

Both flags compose with **OR** semantics: the step fails when *either* gate
fires. Set `MAX_DELTA_USD` as a repository or environment variable — tighter
thresholds for `production`, looser for `staging`.

The threshold is an **absolute value**: a `+$600/mo` create and a `-$600/mo`
destroy both fire a `--fail-on-delta 500` gate. Use `--fail-on-delta 0` to
fail on any non-zero net delta.

When `--fail-on-delta` is supplied, the JSON `summary` gains two extra fields:

```json
"summary": {
  "netDeltaMonthlyUsd": 612.50,
  "failOnDeltaTriggered": true,
  "failOnDeltaThresholdUsd": 500
}
```

### Populating `filePath` with `--tfdir`

When `--tfdir` is passed alongside `--plan-file`, `cost-impact` parses the
`.tf` files in that directory and annotates each finding with the file where
the resource is defined:

```bash
korinfra cost-impact \
  --plan-file plan.json \
  --tfdir ./terraform \
  --json \
  > impact.json
```

Findings in `impact.json` will include `"filePath": "terraform/rds.tf"` for
every resource address that matches a parsed `.tf` file. Resources defined
outside the scanned directory (remote modules, or resources in sub-modules
not under `--tfdir`) will be listed in `warnings[]` as unmatched.

Once you have a `impact.json` with `filePath` populated, the
`korinfra fix --from` flow can apply suggested patches directly:

```bash
# CI step: generate findings
terraform plan -out=plan.tfplan
terraform show -json plan.tfplan > plan.json
korinfra cost-impact --plan-file plan.json --tfdir ./terraform --json > impact.json

# Developer step: apply patches locally
korinfra fix --from impact.json
```

This is the same pipeline as `korinfra security → korinfra fix`.

## 2. Terraform security scanning

```yaml
name: Terraform security

on:
  push:
    paths:
      - 'terraform/**'

jobs:
  security:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm install -g korinfra
      - name: Run security scan
        run: |
          korinfra security \
            --dir terraform \
            --json \
            --fail-on critical \
            > security.json
```

The `security` command works against the raw `.tf` files — no `terraform
plan` step required.

## JSON output schema

`cost-impact --json` emits:

```json
{
  "command": "cost-impact",
  "status": "completed",
  "summary": {
    "netDeltaMonthlyUsd": 515.00,
    "netDeltaAnnualUsd": 6180.00,
    "counts": { "create": 3, "update": 1, "destroy": 2, "replace": 0 },
    "unpricedCount": 0,
    "unknownCount": 0,
    "variableCount": 1,
    "skippedCount": 2
  },
  "changes": [
    {
      "action": "create",
      "address": "aws_db_instance.api",
      "tfType": "aws_db_instance",
      "resourceType": "rds_instance",
      "beforeUsd": 0,
      "afterUsd": 487.00,
      "deltaUsd": 487.00,
      "costStatus": "known",
      "triggeredRuleIds": ["RDS-002"],
      "filePath": "terraform/rds.tf"
    }
  ],
  "findings": [
    {
      "ruleId": "RDS-002",
      "address": "aws_db_instance.api",
      "severity": "high",
      "title": "Production RDS without Multi-AZ",
      "description": "Single-AZ RDS has no automatic failover on hardware failure",
      "filePath": "terraform/rds.tf"
    }
  ],
  "warnings": [],
  "next": [
    { "label": "generate report", "command": "korinfra report --format html --output reports/cost-impact.html" },
    { "label": "review post-apply security rules", "command": "korinfra security --dir ./terraform" }
  ]
}
```

`costStatus` values:

| Value | Meaning |
|---|---|
| `known` | All pricing fields known; `deltaUsd` is the real monthly impact. For ECS Fargate services, this requires the companion `aws_ecs_task_definition` to be present in the same plan. |
| `partial-unknown` | Some pricing fields cannot be resolved from the plan. For ECS services, this means the task definition's CPU/memory are unavailable (e.g. the task def is already deployed and not part of this plan). Cost is estimated using engine defaults (0.25 vCPU / 0.5 GB); row is excluded from net total. |
| `unknown` | A pricing-critical field (e.g. `instance_type`) is computed at apply time. `deltaUsd` is `0` and the row is excluded from net total. |
| `variable` | Usage-dependent resource (Lambda, S3 storage, DynamoDB on-demand). Fixed-cost floor is included in net total. |
| `unpriced` | Resource type not in the pricing engine. Row is shown for review but excluded from net total. |

The `filePath` field is populated on both `findings[]` and `changes[]` entries when `--tfdir` is supplied and the resource address matches a parsed `.tf` file. Resources defined in external modules (not under `--tfdir`) appear in `warnings[]` as unmatched.

### Region defaulting

When the plan has no explicit AWS provider region, `cost-impact` defaults to `us-east-1` and adds a warning:

```
No AWS region found in plan provider config — defaulting to us-east-1.
Set a provider region block to avoid mispriced resources in non-US regions.
```

To suppress this, ensure your Terraform provider block includes a `region` argument (or use a variable bound at plan time).

## OpenTofu

`terraform show -json` and the OpenTofu equivalent (`tofu show -json`) emit
the same schema; `cost-impact` works with both without changes.
