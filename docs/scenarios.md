# Resource Scenarios: A, B, C

korinfra classifies resources into three scenarios based on whether they exist in Terraform code, AWS, or both. Understanding scenarios helps you decide which resources to fix and how.

## Overview

| Scenario | Location | Characteristics | Auto-fix | PR Support |
|----------|----------|-----------------|----------|-----------|
| **A** | `.tf` code only | Not yet deployed | ✓ Edit .tf | ✓ Yes |
| **B** | `.tf` code + AWS | Deployed & managed | ✓ Edit .tf | ✓ Yes |
| **C** | AWS only | Unmanaged (manual creation) | ✗ Manual steps | ✗ No |

---

## Scenario A: Not Deployed

**Resources defined in Terraform code but not found in AWS.**

### What this means

The resource exists in your `.tf` files but has never been deployed to AWS. This could be:

- A new resource not yet applied
- A resource in a module that hasn't been instantiated
- A resource commented out or conditionally disabled
- A resource in your local repo but not yet pushed to production

### When korinfra flags it

korinfra detects Scenario A resources by scanning your `.tf` files and looking for resources without matching AWS entities. It estimates the monthly cost based on the Terraform configuration.

### Example: EC2 instance not yet deployed

```hcl
# modules/app/main.tf
resource "aws_instance" "web_server" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.medium"  # Estimated: $30/mo
  
  tags = {
    Name = "web-server-prod"
  }
}
```

korinfra report:

```
Resource aws_instance.web_server — projected $30 USD/mo if applied
(SCENARIO A: Not deployed)

This resource is defined in Terraform but not found in AWS.
If applied, it will cost approximately $30.00 USD/mo.

Actions:
• Run `terraform plan` to check if this resource needs to be created
• Run `terraform apply` to deploy
• Or remove the resource block from your .tf files if no longer needed
```

### Cost estimates in Scenario A

Cost is **estimated** by `CostEngine.estimateMonthlyCost()` (`src/pricing/engine.ts`) using Terraform configuration values (`instance_type`, `allocated_storage`, `volume_size`, etc.) against the cached AWS Pricing API. The estimate:

- Uses AWS list pricing (not discounted rates, RIs, or Savings Plans)
- Assumes 730 hours/month (24/7 operation)
- Returns `0` when required attributes are missing or the resource type is not supported by the engine
- May not account for all cost drivers (data transfer, request volume, snapshot storage)

**Confidence is dynamic** — computed by `attributeConfidence()` (`src/classifier/scenarios.ts`) based on how many pricing-relevant attributes the Terraform block declares:

```
confidence = min(base + step × attributeCount, max)
```

Defaults (configurable in `.korinfra/config.yaml` under `scan.scenario_confidence_*`):

| Config key | Default | Meaning |
|---|---|---|
| `scenario_confidence_base` | `0.50` | Baseline when zero meaningful attributes are defined |
| `scenario_confidence_step` | `0.075` | Confidence increment per attribute |
| `scenario_confidence_max` | `0.95` | Upper bound regardless of attribute count |
| `scenario_confidence_state_base` | `0.80` | Higher baseline for state-only resources (state file is authoritative) |

Resulting confidence by attribute count (defaults):

| Attributes | TF-only confidence | State-only confidence |
|---|---|---|
| 0 | 0.50 | 0.80 |
| 1 | 0.575 | 0.875 |
| 2 | 0.65 | 0.95 (capped) |
| 3 | 0.725 | 0.95 |
| 4 | 0.80 | 0.95 |
| 6+ | 0.95 (capped) | 0.95 |

**What counts as a "meaningful attribute":** any non-empty top-level key in the Terraform `configuration` block, excluding bookkeeping fields (`tags`, `tags_all`, `depends_on`, `lifecycle`, `provider`, `count`, `for_each`, `provisioner`, `connection`, `timeouts`).

**Why state-only uses a higher base:** when a resource exists in `.tfstate`, the state file is authoritative — Terraform records every attribute it knows about. Detection of the AWS-side deletion is highly reliable regardless of attribute count.

The confidence reflects detection certainty + config completeness, not pricing accuracy. Use cost estimates for planning, not exact billing predictions.

### Using `korinfra fix` with Scenario A

```bash
korinfra fix  # select the resource
```

1. korinfra reads your Terraform files
2. Generates a patch that edits or removes the resource
3. Runs `terraform validate` to check syntax and schema
4. Optionally creates a GitHub PR with your changes

**You still run `terraform apply` manually** — korinfra only edits the code and can open a PR.

If the resource is a security issue (e.g., public S3 bucket in code), korinfra may:

- Restrict IAM policy to private-access-only
- Enable encryption
- Add missing tags

---

## Scenario B: Deployed

**Resources that exist in both Terraform and AWS (matched by ARN, ID, name tag, or fuzzy match).**

### What this means

The resource is managed by Terraform and is currently deployed in AWS. korinfra detected it by matching your `.tf` files against live AWS resources using a 4-pass algorithm:

1. **ARN match** — most reliable
2. **Resource ID** (e.g., instance ID, DB identifier)
3. **Name tag** — if it matches the Terraform resource name
4. **Fuzzy match** — handles renamed or partially-matching resources

### When korinfra flags it

Scenario B resources are flagged when:

- They're consuming unnecessary costs (e.g., idle, oversized, previous-gen)
- They have **config mismatch** — Terraform says one thing, AWS has another
- They're missing required tags or security controls
- They can be optimized for cost or performance

### Example: Oversized RDS instance

```hcl
# terraform/main.tf
resource "aws_db_instance" "staging" {
  allocated_storage    = 500
  instance_class       = "db.r5.2xlarge"  # $3,088/mo
  multi_az             = true             # doubles cost
  engine               = "postgres"
}
```

AWS reality:

```
Instance: db-staging
Allocated storage: 500 GB
Instance class: db.r5.2xlarge
Multi-AZ: enabled
Actual CPU usage (last 30 days): 2%
Actual memory usage: <5%
Monthly cost: $6,176 (including Multi-AZ)
```

korinfra report:

```
HIGH: Staging RDS is oversized and Multi-AZ for a low-utilization database
Estimated savings: $4,118/mo (switch to db.r5.large + disable Multi-AZ)

Current config:
  instance_class = "db.r5.2xlarge"
  multi_az = true
  allocated_storage = 500

Recommended config:
  instance_class = "db.r5.large"
  multi_az = false
  allocated_storage = 250

Actions:
1. Press 'd' to see the full diff
2. Press Enter to apply + create a GitHub PR
```

### Config mismatch in Scenario B

A config mismatch occurs when the Terraform configuration no longer matches the actual AWS resource. Example:

```
Resource: aws_security_group.app
Terraform expects:
  ingress {
    from_port = 443
    to_port = 443
    protocol = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }

AWS has:
  ingress {
    from_port = 443
    to_port = 443
    protocol = "tcp"
    cidr_blocks = ["0.0.0.0/0"]  # PUBLIC! someone edited in console
  }
```

korinfra flags this as a **HIGH-SEVERITY config mismatch** because the rule violation (public HTTPS) is live in production.

### Using `korinfra fix` with Scenario B

```bash
korinfra fix  # select the resource
```

1. korinfra reads your Terraform file and live AWS configuration
2. Detects the difference
3. Generates a Terraform patch to align them
4. Runs `terraform validate` to verify the patch
5. Optionally creates a GitHub PR

You can choose to:

- **Apply + PR** — fix the code, commit, and open a PR for review
- **Dry-run** (`d`) — see what would change without committing

---

## Scenario C: Unmanaged

**Resources that exist in AWS but have no Terraform code.**

### What this means

The resource was created manually via the AWS Console, AWS CLI, or another IaC tool (CloudFormation, etc.). It's not tracked by Terraform and cannot be auto-fixed with Terraform patches.

Common causes:

- Developer created a test instance directly in the console
- Legacy resource predates your Terraform adoption
- Resource created by a CI/CD pipeline that doesn't use Terraform
- Accidental resource creation outside of code

### When korinfra flags it

Scenario C is flagged when the resource:

- Is costing money (and could be deleted)
- Is missing required tags
- Has insecure configuration (public access, no encryption)
- Represents manual overhead that should be in Terraform

### Example: Unmanaged EC2 instance

```
Instance: i-0abc123def456789
Name: staging-test-vm
Type: t3.xlarge
State: running
Monthly cost: $143
Created: 2024-10-15 (unknown by Terraform)
```

korinfra report:

```
MEDIUM: EC2 instance created outside Terraform (unmanaged)
Monthly cost: $143/mo

This resource exists in your AWS account but is not managed by Terraform.
It may have been created manually via the console or CLI.

Actions:
Manual fix required — no .tf file to edit.

Option 1: Import to Terraform
  terraform import aws_instance.staging_test i-0abc123def456789
  (then add the resource block to your .tf files)

Option 2: Delete if no longer needed
  aws ec2 terminate-instances --instance-ids i-0abc123def456789

Option 3: Leave as-is (manual resource, monitor in Cost Explorer)
```

### Why Scenario C cannot be auto-fixed

Scenario C resources have no Terraform code, so:

- ✗ No `.tf` file to edit
- ✗ No PR can be created (requires code change)
- ✗ `korinfra fix` provides AWS CLI commands only, not automation

You must manually:

1. Import the resource into Terraform (`terraform import ...`)
2. Delete the resource from AWS (`aws ...` CLI)
3. Or keep it unmanaged and accept manual cost tracking

### Cost estimates in Scenario C

Cost is **actual or list-price estimated** from AWS. If available:

- Uses Cost Explorer for real billing data (past 30 days)
- Falls back to AWS list pricing if not in billing history

Scenario C resources may not appear in your billing immediately if they're brand new. Check AWS Cost Explorer to confirm.

---

## When to Use Each Scenario

### Scenario A: Prevention

Use Scenario A findings to catch issues **before deployment**:

- Review new Terraform for cost surprises
- Catch security misconfigurations in code
- Validate configuration before apply
- Plan infrastructure changes with accurate cost estimates

**GitHub PR workflow:**

```
Code review → terraform plan preview → GitHub PR → Approval → terraform apply
```

### Scenario B: Optimization

Use Scenario B findings to **improve production resources**:

- Resize oversized instances
- Fix config mismatch
- Optimize reserved instance usage
- Apply security hardening to live resources
- Update tags for compliance

**GitHub PR workflow:**

```
terraform plan → PR with estimated savings → Review → terraform apply
```

### Scenario C: Compliance

Use Scenario C findings to **adopt unmanaged resources** into Terraform:

- Import legacy resources
- Establish single source of truth
- Enable standardized code reviews
- Reduce manual overhead

**Workflow:**

```
terraform import ... → Add code → PR for review → terraform apply
```

Or delete if the resource is no longer needed:

```
AWS CLI delete → Remove from Cost Explorer alerts
```

---

## Matching Algorithm (Scenario B)

When you run `korinfra scan` with a Terraform directory, korinfra matches your `.tf` files against live AWS resources using a 4-pass algorithm:

### Pass 1: ARN Match (highest confidence)

If a Terraform resource has an `arn` attribute or the ARN can be constructed from known IDs, it's compared directly against AWS ARNs.

**Example:** EBS volume with explicit ARN in state → direct match → confidence 0.95+

### Pass 2: Resource ID Match

If Terraform has the exact resource ID (instance ID, DB identifier, etc.), it's matched against AWS resources by ID.

**Example:** `aws_instance` with ID `i-0123456789abcdef0` → exact ID match → confidence 0.90+

### Pass 3: Name Tag Match

If the Terraform resource name matches the AWS `Name` tag, they're considered a match.

**Example:** `resource "aws_instance" "app_server"` with `Name` tag `app_server` → name tag match → confidence 0.60

### Pass 4: Fuzzy Match

If none of the above match, korinfra applies fuzzy heuristics:

- Matching by partial name, owner tag, or other identifying attributes
- May have lower confidence (0.6–0.7)

**Example:** `web_server` in code vs. `web-server-prod` in AWS → fuzzy match → confidence 0.65

### Low-Confidence Matches

Matches with confidence < 0.7 are flagged for manual review. korinfra will show both the Terraform and AWS configurations so you can confirm they're the same resource.

---

## Configuration

Auto-detection of Terraform directory:

```bash
# If you have .tf files in the current directory:
korinfra scan                  # Auto-detects Terraform, runs classification

# Or specify a Terraform directory:
korinfra scan --dir ./terraform
```

Or configure it in your `.korinfra/config.yaml`:

```yaml
terraform:
  default_path: ./terraform    # Relative to working directory or absolute
```

When no Terraform directory is found or configured, korinfra still runs the 66 cost rules and 46 security rules — just without Scenario A/B/C classification.

---

## Summary

| Scenario | Action | Tool | Outcome |
|----------|--------|------|---------|
| A: Not deployed | Review code, optimize, test | `korinfra fix` → edit .tf → PR | Prevent costs before deployment |
| B: Deployed | Optimize live, sync config | `korinfra fix` → edit .tf → PR | Reduce costs, maintain consistency |
| C: Unmanaged | Import or delete | Manual `terraform import` / `aws cli` | Establish IaC governance |

For detailed rule reference, see [docs/rules.md](rules.md). For fixing workflow, see [docs/usage.md](usage.md).
