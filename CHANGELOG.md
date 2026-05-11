# Changelog

All notable changes to KorInfra are documented here.

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
