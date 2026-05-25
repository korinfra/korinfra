import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { safeWriteFile } from '../utils/safe-fs.js';
import { loadConfig, findConfigPath, saveConfig } from '../config/index.js';
import { ConfigSchema } from '../config/types.js';
import { writekorinfraConfig, validateApiKey } from './commands/init-core.js';
import {
  resolveIdeTargets,
  installIntoConfig,
  uninstallFromConfig,
  SUPPORTED_IDE_IDS,
} from './commands/mcp-install-core.js';
import type { InstallResult } from './commands/mcp-install-core.js';
import { runAllChecks } from './commands/doctor-checks.js';
import { defaultStoragePath } from '../config/paths.js';
import { buildScanPipelineSteps, extractRecommendations, extractScanSummary } from './pipelines/scan.js';
import type { CollectError } from '../aws/types.js';
import { buildCostsPipelineSteps, extractAnomalies, extractCostChartData, extractTotalCost } from './pipelines/costs.js';
import { buildResourcesPipelineSteps, extractResourceRows } from './pipelines/resources.js';
import { buildReportPipelineSteps, extractReportResult, type ReportFormat } from './pipelines/report.js';
import { buildHistoryPipelineSteps, extractScanDetail, extractScanDiff, extractScanList, type HistorySubcommand } from './pipelines/history.js';
import { asStr } from '../utils/coerce.js';
import { stripAnsi, SEVERITY_LABELS } from './ui/text.js';
import { buildSecurityPipelineSteps, extractSecurityFindings } from './pipelines/security.js';
import { buildCostImpactPipelineSteps, extractCostImpact } from './pipelines/cost-impact.js';
import { buildTagsPipelineSteps, extractTagCompliance } from './pipelines/tags.js';
import { createFormatter, type ScanReport } from '../output/formatter.js';
import { buildRecommendAnalysisPrompt, buildSecurityAnalysisPrompt } from './pipelines/analysis.js';
import { getAnalysisPrompt, getPrompt } from '../agent/prompts.js';
import { createAgentProvider } from '../agent/index.js';
import { runHeadlessAgent } from './headless-agent.js';
import { getDb } from '../storage/index.js';
import { PricingCache } from '../pricing/index.js';
import { listRules } from '../rules/registry.js';
import type { RuleInfo } from '../rules/types.js';
import { getRecommendationById, listPendingRecommendations, listRecommendations } from '../storage/queries/recommendations.js';
import { buildAgentPrompt, detectGitHubRepo } from './commands/fix-core.js';
import { fixTools } from '../tools/index.js';
import { assertInsideRoot } from '../tools/types.js';
import type { PipelineContext, PipelineStep } from './components/DirectPipeline.js';
import { parseArg, hasFlag } from './utils/parseArgs.js';
import { validateRegions } from './utils/validateRegions.js';

// ─── Headless config-file loader ─────────────────────────────────────────────

// Hard cap on headless --config files. These hold a handful of string keys
// (profile, ai_provider, ide, ...); anything larger is almost certainly an
// attempt to feed us an unrelated file.
const HEADLESS_CONFIG_MAX_BYTES = 64 * 1024;
const HEADLESS_CONFIG_EXTENSIONS = ['.json', '.yaml', '.yml'] as const;

/**
 * Read and parse a user-supplied --config file for headless commands.
 *
 * Sanitizes the path before handing it to fs: rejects null bytes, enforces a
 * known extension, resolves symlinks via realpathSync, and requires a regular
 * file under a size cap. Without these checks the raw CLI argument flows
 * directly into fs.readFileSync (CWE-23).
 */
function loadHeadlessConfigFile(configFile: string): Record<string, string> {
  if (typeof configFile !== 'string' || configFile === '') {
    throw new Error('--config: expected a non-empty file path');
  }
  if (configFile.includes('\0')) {
    throw new Error('--config: path contains a null byte');
  }
  const ext = path.extname(configFile).toLowerCase();
  if (!(HEADLESS_CONFIG_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(
      `--config: unsupported file extension "${ext || '(none)'}". Use one of: ${HEADLESS_CONFIG_EXTENSIONS.join(', ')}`
    );
  }
  const absConfig = path.resolve(process.cwd(), configFile);
  // Dereference symlinks so we read (and stat) the actual target, not a link
  // that could be swapped between checks.
  let realPath: string;
  try {
    realPath = fs.realpathSync(absConfig);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`--config: file does not exist: ${absConfig}`, { cause: err });
    throw new Error(`--config: cannot resolve path: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(realPath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`--config: not a regular file: ${realPath}`);
    }
    if (stat.size > HEADLESS_CONFIG_MAX_BYTES) {
      throw new Error(`--config: file exceeds ${HEADLESS_CONFIG_MAX_BYTES} bytes: ${realPath}`);
    }
    const raw = fs.readFileSync(fd, 'utf8');
    const parsed: unknown = ext === '.json'
      ? JSON.parse(raw)
      : yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, string>;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ─── Headless AI provider factory ────────────────────────────────────────────

async function createHeadlessProvider() {
  try {
    const cfg = await loadConfig();
    if (cfg.ai.provider !== 'claude') return null;
    return createAgentProvider('claude', {
      model: cfg.ai.model,
      apiKeyEnv: cfg.ai.api_key_env,
      extendedThinking: cfg.ai.extended_thinking,
      thinkingBudget: cfg.ai.thinking_budget,
    });
  } catch {
    return null;
  }
}

// ─── Config set helpers ───────────────────────────────────────────────────────

const CONFIG_KNOWN_KEYS: ReadonlySet<string> = new Set([
  'version',
  'aws.default_profile', 'aws.default_region',
  'ai.provider', 'ai.model', 'ai.api_key_env', 'ai.max_recommendations',
  'ai.temperature', 'ai.max_tokens', 'ai.thinking_budget', 'ai.extended_thinking',
  'terraform.default_path', 'terraform.state_file', 'terraform.security_scan',
  'terraform.builtin_rules', 'terraform.cost_estimation',
  'github.token_env', 'github.default_org', 'github.pr_draft', 'github.pr_labels',
  'output.default_format', 'output.color', 'output.verbose', 'output.currency',
  'storage.path', 'storage.retention_days',
  'scan.lookback_days', 'scan.include_idle', 'scan.min_cost_threshold',
  'scan.max_parallel_regions', 'scan.service_timeout_ms', 'scan.collection_timeout_ms',
  'scan.cost_explorer_cache_ttl_hours', 'scan.metric_period', 'scan.idle_cpu_threshold',
  'scan.rightsize_cpu_threshold', 'scan.stopped_instance_days',
  'scan.snapshot_retention_days', 'scan.required_tags', 'scan.pricing_cache_ttl_days',
  'scan.impact_high_threshold', 'scan.impact_medium_threshold',
  'scan.rds_idle_cpu_threshold', 'scan.rds_rightsize_cpu_threshold',
  'scan.cache_memory_threshold', 'scan.lambda_low_invocations',
  'scan.nat_low_traffic_gb', 'scan.nat_endpoint_traffic_gb',
  'scan.ecs_idle_days', 'scan.elb_idle_days', 'scan.region_cost_threshold',
  'scan.scenario_a_cost_risk', 'scan.cpu_high_p95_threshold',
  'scan.memory_low_threshold', 'scan.min_data_points', 'scan.min_period_days',
  'scan.elasticache_idle_cpu_threshold', 'scan.elasticache_idle_memory_threshold',
  'scan.on_demand_running_days', 'scan.snapshot_max_age_days',
  'scan.instance_max_age_days', 'scan.rds_min_cost_for_ri',
  'scan.rds_ri_cpu_threshold', 'scan.rds_min_storage_gb',
  'scan.rds_free_storage_ratio', 'scan.rds_connection_idle_threshold',
  'scan.ecs_min_cpu_threshold', 'scan.ecs_min_desired_count',
  'scan.lambda_min_memory_mb', 'scan.lambda_error_rate_threshold',
  'scan.lb_idle_traffic_mb', 'scan.gp3_iops_baseline', 'scan.fuzzy_match_threshold',
  'anomaly.z_score_threshold', 'anomaly.pct_threshold', 'anomaly.min_cost',
  'anomaly.rolling_window_days', 'anomaly.critical_z_score', 'anomaly.high_z_score',
  'anomaly.medium_z_score', 'anomaly.trend_min_data_points',
  'anomaly.trend_significance_threshold', 'anomaly.forecast_days',
  'mcp.session_cost_limit', 'mcp.max_sessions', 'mcp.http_rate_limit',
  'mcp.session_idle_timeout_ms', 'mcp.max_body_size',
]);

function isKnownConfigKey(dotPath: string): boolean {
  if (CONFIG_KNOWN_KEYS.has(dotPath)) return true;
  return /^aws\.profiles\.[^.]+\.regions$/.test(dotPath);
}

function isArrayConfigKey(dotPath: string): boolean {
  return dotPath === 'github.pr_labels'
    || dotPath === 'scan.required_tags'
    || /^aws\.profiles\.[^.]+\.regions$/.test(dotPath);
}

function setNestedConfigValue(obj: Record<string, unknown>, dotPath: string, raw: string): void {
  const parts = dotPath.split('.');
  // Reject any path segment that could pollute Object.prototype.
  if (parts.some(p => p === '__proto__' || p === 'constructor' || p === 'prototype')) return;
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] ?? '';
    if (typeof cursor[part] !== 'object' || cursor[part] === null) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] ?? '';
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') return;
  const lower = raw.toLowerCase();
  if (lower === 'true') cursor[last] = true;
  else if (lower === 'false') cursor[last] = false;
  else if (!isNaN(Number(raw)) && raw.trim() !== '') cursor[last] = Number(raw);
  else if (isArrayConfigKey(dotPath)) cursor[last] = raw.split(',').map((s) => s.trim()).filter(Boolean);
  else cursor[last] = raw;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function parseRegions(args: string[]): string[] {
  const raw = parseArg(args, '--regions', '-r');
  const regions = raw === null ? [] : raw.split(',').map((r) => r.trim()).filter(Boolean);
  const result = validateRegions(regions);
  if (!result.valid) {
    process.stderr.write(`[korinfra] Invalid AWS region(s): ${result.invalid.join(', ')}\n`);
    process.stderr.write(`[korinfra] Expected format: <lowercase>-<lowercase>-<digit> (e.g. us-east-1)\n`);
    process.exit(2);
  }
  return regions;
}

async function runSteps(
  steps: PipelineStep[],
  onStep?: (key: string) => void,
): Promise<PipelineContext> {
  const context: PipelineContext = { results: new Map() };
  const start = Date.now();
  for (const step of steps) {
    onStep?.(step.key);
    const result = await step.run(context);
    context.results.set(step.key, result);
  }
  context.results.set('__pipelineDurationMs', Date.now() - start);
  return context;
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function writeLines(lines: string[]): void {
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

type Severity = 'low' | 'medium' | 'high';

function isSeverity(value: string): value is Severity {
  return value === 'low' || value === 'medium' || value === 'high';
}

interface RulesFilters {
  text: string | null;
  impact: Severity | null;
  risk: Severity | null;
}

function applyRulesFilter(rules: readonly RuleInfo[], filters: RulesFilters): RuleInfo[] {
  const t = filters.text !== null && filters.text !== '' ? filters.text.toLowerCase() : null;
  return rules.filter((r) => {
    if (t !== null
      && r.category.toLowerCase() !== t
      && !r.id.toLowerCase().startsWith(t)) return false;
    if (filters.impact !== null && r.impact !== filters.impact) return false;
    if (filters.risk !== null && r.risk !== filters.risk) return false;
    return true;
  });
}

/**
 * Returns true when `flag` appears in args without a following value (or with a
 * value that starts with `-`, which `parseArg` already rejects). This lets
 * callers distinguish "flag absent" from "flag present but missing value" —
 * the latter is a usage error rather than a silent no-op for required-value
 * flags like `--filter`, `--impact`, `--risk`.
 */
function isFlagWithoutValue(args: string[], flag: string): boolean {
  const idx = args.findIndex((a) => a === flag);
  if (idx === -1) return false;
  const next = args[idx + 1];
  return next === undefined || next.startsWith('-');
}

function parseRulesFilters(commandArgs: string[]): RulesFilters | { error: string } {
  const REQUIRED_VALUE_EXAMPLES: Record<string, string> = {
    '--filter': '--filter ec2',
    '--impact': '--impact high',
    '--risk': '--risk high',
  };
  for (const flag of ['--filter', '--impact', '--risk']) {
    if (isFlagWithoutValue(commandArgs, flag)) {
      const example = REQUIRED_VALUE_EXAMPLES[flag] ?? '';
      return { error: `${flag} requires a value (e.g. ${example}).` };
    }
  }
  const filterRaw = parseArg(commandArgs, '--filter');
  const text = filterRaw === null ? null : (filterRaw.trim() === '' ? null : filterRaw.trim());
  const impactRaw = parseArg(commandArgs, '--impact');
  const riskRaw = parseArg(commandArgs, '--risk');
  if (impactRaw !== null && !isSeverity(impactRaw.toLowerCase())) {
    return { error: `Invalid --impact "${impactRaw}". Use low, medium, or high.` };
  }
  if (riskRaw !== null && !isSeverity(riskRaw.toLowerCase())) {
    return { error: `Invalid --risk "${riskRaw}". Use low, medium, or high.` };
  }
  return {
    text,
    impact: impactRaw === null ? null : impactRaw.toLowerCase() as Severity,
    risk: riskRaw === null ? null : riskRaw.toLowerCase() as Severity,
  };
}

function describeActiveFilters(filters: RulesFilters): string[] {
  const parts: string[] = [];
  if (filters.text !== null) parts.push(`filter=${filters.text}`);
  if (filters.impact !== null) parts.push(`impact=${filters.impact}`);
  if (filters.risk !== null) parts.push(`risk=${filters.risk}`);
  return parts;
}

// ─── Format resolution helper ─────────────────────────────────────────────────

/**
 * Resolves the effective output format for a headless command.
 *
 * Rules:
 *  - If `rawFormat` is explicitly provided AND is not 'json' → use it.
 *  - If `rawFormat` is 'json' → return null (falls through to native output).
 *  - If `rawFormat` is null → check `output.default_format` in config; use it
 *    only if it is 'csv' or 'html' (json default has no effect on headless paths).
 *  - Config errors other than ENOENT are surfaced as a stderr warning.
 */
async function resolveEffectiveFormat(rawFormat: string | null): Promise<string | null> {
  if (rawFormat !== null) {
    return rawFormat === 'json' ? null : rawFormat;
  }
  try {
    const cfg = await loadConfig();
    const cfgFmt = cfg.output.default_format;
    if (cfgFmt === 'csv' || cfgFmt === 'html') return cfgFmt;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[korinfra] Warning: could not read config: ${String(err)}\n`);
    }
  }
  return null;
}

// ─── Output helpers ──────────────────────────────────────────────────────────

function resolveOutputArg(commandArgs: string[]): string | null {
  const arg = parseArg(commandArgs, '--output', '-o');
  return arg !== null ? path.resolve(process.cwd(), arg) : null;
}

function isWithinCwd(abs: string): boolean {
  const cwd = process.cwd();
  return abs === cwd || abs.startsWith(cwd + path.sep);
}

/** Write formatted content to file (text path). Returns true if an error occurred. */
function writeFormattedText(content: string, format: ReportFormat, absPath: string): boolean {
  try {
    safeWriteFile(absPath, content, { mode: 0o600, dirMode: 0o700 });
    process.stderr.write(`[korinfra] ${format.toUpperCase()} report written to ${absPath}\n`);
    return false;
  } catch (err: unknown) {
    process.stderr.write(`[korinfra] Failed to write output: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return true;
  }
}

/** Write formatted content to file (JSON path). Returns exit code on error, null on success. */
function writeFormattedJson(content: string, format: ReportFormat, absPath: string, command: string): number | null {
  try {
    safeWriteFile(absPath, content, { mode: 0o600, dirMode: 0o700 });
    process.stderr.write(`[korinfra] ${format.toUpperCase()} report written to ${absPath}\n`);
    return null;
  } catch (err: unknown) {
    process.stdout.write(JSON.stringify({ command, status: 'error', error: `Failed to write output: ${err instanceof Error ? err.message : String(err)}` }) + '\n');
    return 1;
  }
}

// ─── Headless: text output ────────────────────────────────────────────────────

export async function runHeadlessTextCommand(command: string, commandArgs: string[]): Promise<boolean> {
  if (command === 'scan') {
    const rawFormat = parseArg(commandArgs, '--format', '-f')?.toLowerCase() ?? null;
    if (rawFormat !== null && !['json', 'csv', 'html'].includes(rawFormat)) {
      process.stderr.write(`korinfra scan: Unknown format "${rawFormat}"\n\nUse --format json|csv|html\n`);
      process.exitCode = 2;
      return true;
    }

    const context = await runSteps(buildScanPipelineSteps({
      regions: parseRegions(commandArgs),
      profile: parseArg(commandArgs, '--profile', '-p'),
      skipCosts: hasFlag(commandArgs, '--skip-costs'),
      skipMetrics: hasFlag(commandArgs, '--skip-metrics'),
    }));
    const summary = extractScanSummary(context);

    const effectiveFormat = await resolveEffectiveFormat(rawFormat);

    const recs = extractRecommendations(context);
    const collectResult = context.results.get('collect') as {
      errors?: CollectError[];
    } | undefined;
    const collectErrors = collectResult?.errors ?? [];

    if (effectiveFormat !== null) {
      const failOn = parseArg(commandArgs, '--fail-on');
      const criticalCount = recs.filter((r) => r.impact === 'critical').length;
      if (failOn === 'critical' && criticalCount > 0) process.exitCode = 1;
      if (failOn === 'partial' && collectErrors.length > 0) process.exitCode = 1;

      const format = effectiveFormat as ReportFormat;
      const outputArg = parseArg(commandArgs, '--output', '-o');
      const resolvedOutput = outputArg !== null ? path.resolve(process.cwd(), outputArg) : undefined;
      if (resolvedOutput !== undefined) {
        const cwd = process.cwd();
        if (!resolvedOutput.startsWith(cwd + path.sep) && resolvedOutput !== cwd) {
          process.stderr.write(`korinfra scan: --output path must stay within the current directory\n`);
          process.exitCode = 2;
          return true;
        }
      }
      try {
        const reportContext = await runSteps(buildReportPipelineSteps({
          format,
          outputPath: resolvedOutput,
          scanId: summary.scanId,
        }));
        const result = extractReportResult(reportContext);
        if (result.written && result.outputPath) {
          process.stderr.write(`[korinfra] ${format.toUpperCase()} report written to ${result.outputPath}\n`);
        } else if (result.content !== undefined) {
          process.stdout.write(result.content);
        } else {
          process.stderr.write('[korinfra] Warning: formatter produced no output\n');
        }
      } catch (err: unknown) {
        process.stderr.write(`[korinfra] Report generation failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
      return true;
    }

    const scanId = summary.scanId ?? '';
    const warningLines: string[] = collectErrors.length > 0
      ? [
        `Warnings: ${collectErrors.length} collection error${collectErrors.length !== 1 ? 's' : ''} — partial results`,
        ...collectErrors.map((e) => `  - [${e.code ?? 'ERROR'}] ${e.collector}${e.region ? `@${e.region}` : ''}: ${e.message}`),
      ]
      : [];
    // Surface resources whose monthly_cost could not be determined. Cost-saving
    // rules skip them with a warning; security-only rules still emit (savings 0).
    const unknownCostLines = summary.unknownCostCount > 0
      ? [`[korinfra] ${summary.unknownCostCount} resource${summary.unknownCostCount !== 1 ? 's' : ''} had unknown monthly_cost — cost-saving rules skipped them`]
      : [];
    const warningLine = summary.warnings.length > 0
      ? [`[korinfra] ${summary.warnings.length} rule warning${summary.warnings.length !== 1 ? 's' : ''} (resources skipped) — run with --json to inspect`]
      : [];
    writeLines([
      'korinfra scan',
      'Status: completed',
      ...warningLines,
      ...unknownCostLines,
      ...warningLine,
      `Resources: ${summary.resourceCount}`,
      `Cost: ${formatMoney(summary.totalMonthlyCostUsd)}/mo`,
      `Recommendations: ${summary.recommendationCount}`,
      `Anomalies: ${summary.anomalyCount}`,
      recs.length > 0 ? `Top recommendation: ${recs[0]?.title ?? ''}` : 'Top recommendation: none',
      '',
      'Next:',
      ...(scanId ? [`- korinfra report --scan ${scanId} --format html --output reports/scan-${scanId.slice(0, 8)}.html`] : ['- korinfra report --format html --output reports/latest.html']),
      '- korinfra recommend --no-tui',
      '- korinfra fix',
    ]);
    return true;
  }

  if (command === 'costs') {
    const rawDays = Number(parseArg(commandArgs, '--days') ?? '30');
    const days = Number.isInteger(rawDays) && rawDays > 0 ? Math.min(rawDays, 397) : 30;
    const rawGroup = parseArg(commandArgs, '--group-by') ?? 'service';
    const groupBy = (['service', 'region', 'account', 'tag'].includes(rawGroup) ? rawGroup : 'service') as 'service' | 'region' | 'account' | 'tag';
    const context = await runSteps(buildCostsPipelineSteps({ days, groupBy }));
    const total = extractTotalCost(context);
    const chart = extractCostChartData(context);
    const { anomalyCount } = extractAnomalies(context);
    writeLines([
      'korinfra costs',
      `Period: last ${days} days`,
      `Group by: ${groupBy}`,
      `Total: ${formatMoney(total)}`,
      `Anomalies: ${anomalyCount}`,
      ...chart.slice(0, 10).map((row) => `- ${row.label}: ${formatMoney(row.value)}`),
      '',
      'Next:',
      '- korinfra report --format html --output reports/costs.html',
      '- korinfra scan',
    ]);
    return true;
  }

  if (command === 'resources') {
    const context = await runSteps(buildResourcesPipelineSteps({
      regions: parseRegions(commandArgs),
      typeFilter: parseArg(commandArgs, '--type'),
    }));
    const rows = extractResourceRows(context);
    const maxLines = Math.max(1, Math.min(1000, Number(parseArg(commandArgs, '--max-lines') ?? '20')));
    const filterRaw = parseArg(commandArgs, '--filter');
    const serviceFilter = filterRaw?.startsWith('service=') ? filterRaw.slice(8).toLowerCase() : null;
    const filtered = serviceFilter ? rows.filter((r) => (r.type ?? '').toLowerCase().includes(serviceFilter)) : rows;
    writeLines([
      'korinfra resources',
      `Resources: ${filtered.length}`,
      ...filtered.slice(0, maxLines).map((row) => `- ${stripAnsi(row.name)} (${stripAnsi(row.type)}, ${stripAnsi(row.region)}) ${row.monthlyCostUsd !== undefined ? formatMoney(row.monthlyCostUsd) : ''}`.trim()),
      ...(filtered.length > maxLines ? [`... ${filtered.length - maxLines} more`] : []),
      '',
      'Next:',
      '- korinfra report --format html --output reports/resources.html',
      '- korinfra scan',
    ]);
    return true;
  }

  if (command === 'report') {
    const rawFormat = parseArg(commandArgs, '--format', '-f') ?? 'json';
    if (!['json', 'csv', 'html'].includes(rawFormat)) {
      writeLines([
        `korinfra report: Unknown format "${rawFormat}"`,
        '',
        'Use --format json|csv|html',
      ]);
      process.exitCode = 2;
      return true;
    }
    const format = rawFormat as ReportFormat;
    const output = parseArg(commandArgs, '--output', '-o');
    const resolvedOutput = output !== null ? path.resolve(process.cwd(), output) : undefined;
    if (resolvedOutput !== undefined) {
      const cwd = process.cwd();
      if (!resolvedOutput.startsWith(cwd + path.sep) && resolvedOutput !== cwd) {
        process.stderr.write(`korinfra report: --output path must stay within the current directory\n`);
        process.exitCode = 2;
        return true;
      }
    }
    const context = await runSteps(buildReportPipelineSteps({
      format,
      outputPath: resolvedOutput,
      scanId: parseArg(commandArgs, '--scan') ?? undefined,
    }));
    const result = extractReportResult(context);
    writeLines([
      'korinfra report',
      `Status: generated`,
      `Format: ${result.format.toUpperCase()}`,
      `Resources: ${result.resourceCount}`,
      `Cost: ${formatMoney(result.totalCost)}`,
      `Recommendations: ${result.recommendationCount}`,
      result.written && result.outputPath ? `Saved: ${result.outputPath}` : `Size: ${result.size} bytes`,
      ...(!result.written && result.content !== undefined ? ['', result.content] : []),
      '',
      'Next:',
      '- korinfra recommend --no-tui',
      '- korinfra scan',
    ]);
    return true;
  }

  if (command === 'history') {
    const subcommand = (commandArgs[0] ?? 'list') as HistorySubcommand;
    if (!['list', 'show', 'diff'].includes(subcommand)) return false;
    const context = await runSteps(buildHistoryPipelineSteps({
      subcommand,
      id1: commandArgs[1] ?? null,
      id2: commandArgs[2] ?? null,
    }));
    if (subcommand === 'list') {
      const scans = extractScanList(context);
      writeLines([
        'korinfra history',
        `Scans: ${scans.length}`,
        ...scans.map((scan) => `- ${scan.id} ${scan.date} resources=${scan.resourceCount} cost=${formatMoney(scan.totalCost)} recs=${scan.recommendationCount}`),
        '',
        'Next:',
        ...(scans.length > 0 ? [`- korinfra history show ${scans[0]?.id ?? ''}`] : []),
        '- korinfra report --format html --output reports/latest.html',
      ]);
      return true;
    }
    if (subcommand === 'show') {
      const detail = extractScanDetail(context);
      const id = String((detail.scan['id'] as string | number | null | undefined) ?? '');
      writeLines([
        'korinfra history show',
        `Scan: ${id}`,
        `Resources: ${detail.resources.length}`,
        `Cost entries: ${detail.costs.length}`,
        `Recommendations: ${detail.recommendations.length}`,
        '',
        'Next:',
        ...(id ? [`- korinfra report --scan ${id} --format html --output reports/scan-${id.slice(0, 8)}.html`] : []),
        '- korinfra history list',
      ]);
      return true;
    }
    const diff = extractScanDiff(context);
    writeLines([
      'korinfra history diff',
      `From: ${String((diff.scanA['id'] as string | number | null | undefined) ?? '')}`,
      `To: ${String((diff.scanB['id'] as string | number | null | undefined) ?? '')}`,
      `Resource delta: ${diff.resourceCountDelta >= 0 ? '+' : ''}${diff.resourceCountDelta}`,
      `Cost delta: ${diff.costDelta >= 0 ? '+' : '-'}${formatMoney(Math.abs(diff.costDelta))}`,
      '',
      'Next:',
      '- korinfra report --format html --output reports/diff.html',
    ]);
    return true;
  }

  if (command === 'pricing') {
    const subcommand = commandArgs[0] ?? 'status';
    if (subcommand !== 'status') return false;
    const db = getDb();
    const cache = new PricingCache(db);
    const stats = cache.getCacheStats();
    const expiredCount = cache.getExpiredCount();
    writeLines([
      'korinfra pricing status',
      `Cached entries: ${stats.count}`,
      `Cache size: ${(stats.total_size_bytes / 1024).toFixed(1)} KB`,
      `Oldest entry: ${stats.oldest_entry ?? 'N/A'}`,
      `Newest entry: ${stats.newest_entry ?? 'N/A'}`,
      `Expired entries: ${expiredCount}`,
      '',
      'Next:',
      ...(expiredCount > 0 || stats.count === 0 ? ['- korinfra pricing download'] : []),
      '- korinfra scan',
    ]);
    return true;
  }

  if (command === 'security') {
    const rawFormat = parseArg(commandArgs, '--format', '-f')?.toLowerCase() ?? null;
    if (rawFormat !== null && !['json', 'csv', 'html'].includes(rawFormat)) {
      process.stderr.write(`korinfra security: Unknown format "${rawFormat}"\n\nUse --format json|csv|html\n`);
      process.exitCode = 2;
      return true;
    }
    const terraformDir = parseArg(commandArgs, '--dir', '-d');
    const severity = parseArg(commandArgs, '--severity');
    let context;
    try {
      context = await runSteps(buildSecurityPipelineSteps({
        terraformDir: terraformDir ?? undefined,
        severity: severity ?? undefined,
      }));
    } catch (e) {
      process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.stderr.write(`Hint: use --dir <path> to specify a directory containing .tf files.\n`);
      process.exit(1);
    }
    const securityResult = extractSecurityFindings(context, severity ?? undefined);
    const { findings, totalCount, bySeverity } = securityResult;
    const criticalCount = bySeverity['critical'] ?? 0;
    const highCount = bySeverity['high'] ?? 0;
    const mediumCount = bySeverity['medium'] ?? 0;
    const severityOrder = ['critical', 'high', 'medium', 'low'] as const;

    const effectiveSecFmt = await resolveEffectiveFormat(rawFormat);
    if (effectiveSecFmt !== null) {
      const failOn = parseArg(commandArgs, '--fail-on');
      if (failOn === 'critical' && criticalCount > 0) process.exitCode = 1;
      if (failOn === 'partial') {
        process.stderr.write('[korinfra] Warning: --fail-on partial is not applicable to security\n');
      }
      const format = effectiveSecFmt as ReportFormat;
      const secScanId = (context?.results.get('save_security') as { scan_id?: string } | undefined)?.scan_id ?? '';
      const scanReport: ScanReport = {
        scanId: secScanId,
        timestamp: new Date().toISOString(),
        resources: [],
        recommendations: findings.map((f) => ({
          id: f.id,
          resourceId: f.resource,
          type: f.id,
          title: f.title,
          description: f.description,
          estimatedSavings: 0,
          confidence: 1.0,
          impact: f.severity,
          risk: f.severity,
          status: 'open',
          implementationSteps: f.remediation ? [f.remediation] : null,
        })),
        costs: [],
        summary: {
          totalResources: 0,
          totalMonthlyCost: 0,
          potentialSavings: 0,
          recommendationCount: findings.length,
        },
      };
      const resolvedSecOutput = resolveOutputArg(commandArgs);
      if (resolvedSecOutput !== null && !isWithinCwd(resolvedSecOutput)) {
        process.stderr.write(`korinfra security: --output path must stay within the current directory\n`);
        process.exitCode = 2;
        return true;
      }
      const secFormatted = createFormatter(format).format(scanReport);
      if (resolvedSecOutput !== null) {
        if (writeFormattedText(secFormatted, format, resolvedSecOutput)) return true;
      } else {
        process.stdout.write(secFormatted);
      }
      return true;
    }

    const summaryParts: string[] = [];
    if (criticalCount > 0) summaryParts.push(`${criticalCount} critical`);
    if (highCount > 0) summaryParts.push(`${highCount} high`);
    if (mediumCount > 0) summaryParts.push(`${mediumCount} medium`);
    const lowCount = bySeverity['low'] ?? 0;
    if (lowCount > 0) summaryParts.push(`${lowCount} low`);

    const lines: string[] = [
      `Security scan: ${terraformDir ?? '.'}`,
      totalCount > 0
        ? `Findings: ${totalCount}${summaryParts.length > 0 ? ` (${summaryParts.join(', ')})` : ''}`
        : 'Findings: 0',
      '',
    ];

    if (totalCount === 0) {
      lines.push('(no findings)');
    } else {
      for (const sev of severityOrder) {
        const group = findings.filter((f) => f.severity === sev);
        if (group.length === 0) continue;
        lines.push(sev.toUpperCase());
        for (const f of group) {
          lines.push(`  \u2717 ${stripAnsi(f.id)} \u2014 ${stripAnsi(f.resource)}`);
          if (f.remediation) lines.push(`    Fix: ${stripAnsi(f.remediation)}`);
        }
        lines.push('');
      }
    }

    lines.push('Next:');
    // Look up the first rec UUID from DB so the hint works with `korinfra fix`
    const saveResult = context.results.get('save_security') as { scan_id?: string } | undefined;
    if (saveResult?.scan_id) {
      const db = getDb();
      const recs = listRecommendations(db, saveResult.scan_id, { status: 'draft' });
      if (recs.length > 0) {
        lines.push(`- korinfra fix ${recs[0]?.id ?? ''} --pr --no-tui`);
      }
    } else if (findings.length > 0) {
      lines.push(`- korinfra fix <rec-id> --pr --no-tui   (run with --no-tui to get rec IDs)`);
    }
    lines.push('- korinfra security --analyze   (AI analysis)');
    writeLines(lines);

    // --analyze: stream AI analysis after printing deterministic findings
    if (hasFlag(commandArgs, '--analyze')) {
      const provider = await createHeadlessProvider();
      if (provider === null) {
        process.stderr.write('[korinfra] AI provider not configured — skipping analysis. Run `korinfra init` to configure.\n');
      } else {
        process.stderr.write('[korinfra] running AI analysis…\n');
        const analysisPrompt = buildSecurityAnalysisPrompt(context);
        await runHeadlessAgent(
          analysisPrompt,
          provider,
          { systemPrompt: getAnalysisPrompt('security') },
          'text',
        );
      }
    }

    return true;
  }

  if (command === 'cost-impact') {
    const rawCiFormat = parseArg(commandArgs, '--format')?.toLowerCase() ?? null;
    if (rawCiFormat !== null && !['json', 'csv', 'html'].includes(rawCiFormat)) {
      process.stderr.write(`korinfra cost-impact: Unknown format "${rawCiFormat}"\n\nUse --format json|csv|html\n`);
      process.exitCode = 2;
      return true;
    }
    const planFile = parseArg(commandArgs, '--plan-file', '-f');
    if (planFile === null) {
      process.stderr.write('Error: --plan-file <path> is required.\n');
      process.stderr.write('Hint: terraform show -json plan.tfplan > plan.json\n');
      process.exit(2);
    }
    // `--tfdir` is accepted for forward-compat with the documented invocation
    // in issue #40, but the cross-reference to .tf source files is not yet
    // wired up. Warn so users know the flag is currently a no-op.
    if (parseArg(commandArgs, '--tfdir') !== null) {
      process.stderr.write('[korinfra] note: --tfdir is accepted but not yet used; plan parsing reads only --plan-file.\n');
    }
    const absPlan = path.resolve(process.cwd(), planFile);
    if (!absPlan.toLowerCase().endsWith('.json')) {
      process.stderr.write(`Error: --plan-file must be a .json file (terraform show -json output): ${absPlan}\n`);
      process.exit(2);
    }
    let realPlan: string;
    try {
      realPlan = fs.realpathSync(absPlan);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      process.stderr.write(code === 'ENOENT'
        ? `Error: plan file not found: ${absPlan}\n`
        : `Error: cannot resolve --plan-file path: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
    try { assertInsideRoot(realPlan, '--plan-file'); }
    catch (e) { process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); }
    let currency = 'USD';
    try {
      const cfg = await loadConfig();
      currency = cfg.output.currency;
    } catch {
      // No config — fall back to USD.
    }
    let context;
    try {
      context = await runSteps(buildCostImpactPipelineSteps({ planFile: realPlan, currency }));
    } catch (e) {
      process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
    const impact = extractCostImpact(context);
    const failOn = parseArg(commandArgs, '--fail-on');
    const criticalCount = impact.findings.filter((f) => f.severity === 'critical').length;
    const shouldFailOnCritical = failOn === 'critical' && criticalCount > 0;

    const effectiveCiFmt = await resolveEffectiveFormat(rawCiFormat);
    if (effectiveCiFmt !== null) {
      if (shouldFailOnCritical) process.exitCode = 1;
      if (failOn === 'partial') {
        process.stderr.write('[korinfra] Warning: --fail-on partial is not applicable to cost-impact\n');
      }
      const format = effectiveCiFmt as ReportFormat;
      const scanReport: ScanReport = {
        scanId: '',
        timestamp: new Date().toISOString(),
        resources: impact.changes.map((c) => ({
          id: c.address,
          type: c.resourceType,
          name: c.address,
          region: '',
          state: c.action,
          monthlyCost: Math.abs(c.deltaUsd),
          monthlyCostSource: null,
        })),
        recommendations: impact.findings.map((f) => ({
          id: f.ruleId,
          resourceId: f.address,
          type: f.ruleId,
          title: f.title,
          description: f.description,
          estimatedSavings: 0,
          confidence: 1.0,
          impact: f.severity,
          risk: f.severity,
          status: 'open',
        })),
        costs: [],
        summary: {
          totalResources: impact.changes.length,
          totalMonthlyCost: impact.summary.netDeltaMonthlyUsd,
          potentialSavings: 0,
          recommendationCount: impact.findings.length,
        },
      };
      const resolvedCiOutput = resolveOutputArg(commandArgs);
      if (resolvedCiOutput !== null && !isWithinCwd(resolvedCiOutput)) {
        process.stderr.write(`korinfra cost-impact: --output path must stay within the current directory\n`);
        process.exitCode = 2;
        return true;
      }
      const ciFormatted = createFormatter(format).format(scanReport);
      if (resolvedCiOutput !== null) {
        if (writeFormattedText(ciFormatted, format, resolvedCiOutput)) return true;
      } else {
        process.stdout.write(ciFormatted);
      }
      return true;
    }

    const netLabel = impact.summary.netDeltaMonthlyUsd >= 0
      ? `+${formatMoney(impact.summary.netDeltaMonthlyUsd)}/mo`
      : `-${formatMoney(Math.abs(impact.summary.netDeltaMonthlyUsd))}/mo`;
    const annualLabel = impact.summary.netDeltaAnnualUsd >= 0
      ? `+${formatMoney(impact.summary.netDeltaAnnualUsd)}/yr`
      : `-${formatMoney(Math.abs(impact.summary.netDeltaAnnualUsd))}/yr`;

    const lines: string[] = [
      `korinfra cost-impact`,
      `Plan: ${realPlan}`,
      `Net delta: ${netLabel}  (annualized ${annualLabel})`,
      `Changes: ${impact.summary.counts.create} created, ${impact.summary.counts.update} updated, ${impact.summary.counts.destroy} destroyed, ${impact.summary.counts.replace} replaced`,
    ];
    if (
      impact.summary.unknownCount > 0 ||
      impact.summary.unpricedCount > 0 ||
      impact.summary.variableCount > 0
    ) {
      lines.push(
        `Caveats: ${impact.summary.unknownCount} unknown, ${impact.summary.unpricedCount} unpriced, ${impact.summary.variableCount} variable`,
      );
    }
    lines.push('');
    if (impact.changes.length === 0) {
      lines.push('No cost-impacting changes.');
    } else {
      for (const row of impact.changes.slice(0, 50)) {
        const sign = row.deltaUsd > 0 ? '+' : row.deltaUsd < 0 ? '-' : ' ';
        const deltaStr = row.costStatus === 'unknown' || row.costStatus === 'unpriced' || row.costStatus === 'partial-unknown'
          ? '—'
          : `${sign}${formatMoney(Math.abs(row.deltaUsd))}`;
        lines.push(`  ${row.action.padEnd(8)} ${stripAnsi(row.address).padEnd(40)} ${deltaStr.padStart(10)} (${row.costStatus})`);
      }
      if (impact.changes.length > 50) {
        lines.push(`  ... ${impact.changes.length - 50} more (run with --json for the full list)`);
      }
    }
    if (impact.findings.length > 0) {
      lines.push('');
      lines.push(`Findings (${impact.findings.length} would trigger after apply):`);
      const severityOrder = ['critical', 'high', 'medium', 'low'] as const;
      const sortedFindings = [...impact.findings].sort(
        (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity),
      );
      for (const f of sortedFindings.slice(0, 10)) {
        lines.push(`  [${SEVERITY_LABELS[f.severity] ?? f.severity.toUpperCase()}] ${f.ruleId} @ ${stripAnsi(f.address)} — ${stripAnsi(f.title)}`);
      }
      if (sortedFindings.length > 10) {
        lines.push(`  ... ${sortedFindings.length - 10} more (run with --json for the full list)`);
      }
    }
    lines.push('');
    lines.push('Next:');
    lines.push('- korinfra cost-impact --plan-file plan.json --json     (machine-readable)');
    lines.push('- korinfra security --dir ./terraform                   (post-apply security review)');
    writeLines(lines);

    if (shouldFailOnCritical) process.exit(1);
    return true;
  }

  if (command === 'config') {
    const subcommand = commandArgs[0] ?? 'show';
    if (subcommand === 'show') {
      const configPath = await findConfigPath();
      const cfg = await loadConfig(configPath ?? undefined);
      const lines: string[] = [
        `Config: ${configPath ?? '(none)'}`,
        '',
      ];
      // Render top-level sections as key: value pairs (one level deep)
      const cfgObj = cfg as Record<string, unknown>;
      for (const [section, value] of Object.entries(cfgObj)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          lines.push(`${section}:`);
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (v !== null && v !== undefined && v !== '' && !(typeof v === 'object')) {
              lines.push(`  ${k}: ${asStr(v)}`);
            }
          }
        }
      }
      writeLines(lines);
      return true;
    }
    if (subcommand === 'set') {
      const key = commandArgs[1];
      const value = commandArgs[2];
      if (!key || value === undefined) {
        writeLines(['Usage: korinfra config set <key> <value>']);
        process.exitCode = 2;
        return true;
      }
      if (!isKnownConfigKey(key)) {
        writeLines([`Unknown config key: "${key}". Run korinfra config show to see valid keys.`]);
        process.exitCode = 2;
        return true;
      }
      if (value === '') {
        writeLines(['Value cannot be empty.']);
        process.exitCode = 2;
        return true;
      }
      try {
        const configPath = await findConfigPath();
        const cfg = await loadConfig(configPath ?? undefined);
        const mutable = structuredClone(cfg) as Record<string, unknown>;
        setNestedConfigValue(mutable, key, value);
        const parsed = ConfigSchema.safeParse(mutable);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
          writeLines([`Config validation failed:\n${issues}`]);
          process.exitCode = 2;
          return true;
        }
        await saveConfig(parsed.data, configPath ?? undefined);
        writeLines([`Set ${key} = ${value}`]);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
      return true;
    }
    return false;
  }

  if (command === 'recommend') {
    const rawRecFormat = parseArg(commandArgs, '--format', '-f')?.toLowerCase() ?? null;
    if (rawRecFormat !== null && !['json', 'csv', 'html'].includes(rawRecFormat)) {
      process.stderr.write(`korinfra recommend: Unknown format "${rawRecFormat}"\n\nUse --format json|csv|html\n`);
      process.exitCode = 2;
      return true;
    }
    const source = parseArg(commandArgs, '--source');
    if (source !== null && source !== 'compute-optimizer') {
      writeLines([
        `korinfra recommend: unknown --source value '${source}'. Valid: 'compute-optimizer'.`,
      ]);
      process.exitCode = 1;
      return true;
    }
    if (source === 'compute-optimizer') {
      if (hasFlag(commandArgs, '--refresh')) {
        process.stderr.write('[korinfra] note: --refresh is ignored when --source is set\n');
      }
      const { getComputeOptimizerRecommendationsTool } = await import('../tools/get-compute-optimizer-recommendations.js');
      const handlerArgs: Record<string, unknown> = {};
      try {
        const cfg = await loadConfig();
        if (cfg.aws.default_profile) handlerArgs['profile'] = cfg.aws.default_profile;
        if (cfg.aws.default_region) handlerArgs['regions'] = [cfg.aws.default_region];
      } catch {
        // No config file; rely on AWS_* env vars and the SDK default provider chain.
      }
      const handlerResult = await getComputeOptimizerRecommendationsTool.handler(handlerArgs);
      // The tool returns errorResult(err) (plain-text body) for unhandled
      // failures like credential resolution. Surface those before JSON.parse
      // so the CLI never throws SyntaxError on an error body.
      if (handlerResult.isError) {
        writeLines([
          '[Source: AWS Compute Optimizer]',
          `Error: ${handlerResult.content[0]?.text ?? 'unknown error'}`,
        ]);
        process.exitCode = 1;
        return true;
      }
      let parsed: {
        status?: string;
        message?: string;
        summary?: { total?: number; estimatedMonthlySavingsUsd?: number; byType?: Record<string, number> };
        recommendations?: Array<{ resourceType?: string; resourceArn?: string; finding?: string; estimatedMonthlySavingsUsd?: number; performanceRisk?: string }>;
        warnings?: string[];
        next?: Array<{ label?: string; command?: string; url?: string }>;
      };
      try {
        parsed = JSON.parse(handlerResult.content[0]?.text ?? '{}') as typeof parsed;
      } catch {
        writeLines([
          '[Source: AWS Compute Optimizer]',
          `Error: tool returned unparseable output: ${handlerResult.content[0]?.text ?? '(empty)'}`,
        ]);
        process.exitCode = 1;
        return true;
      }
      if (parsed.status === 'not_enabled' || parsed.status === 'access_denied' || parsed.status === 'partial_failure') {
        writeLines([
          '[Source: AWS Compute Optimizer]',
          parsed.message ?? `Compute Optimizer call failed (${parsed.status}).`,
          ...(parsed.warnings && parsed.warnings.length > 0
            ? ['', 'Warnings:', ...parsed.warnings.map((w) => `- ${w}`)]
            : []),
          ...(parsed.next && parsed.next.length > 0
            ? ['', 'Next:', ...parsed.next.map((n) => {
                const detail = (n as { command?: string; url?: string; permissions?: string[] });
                if (detail.command) return `- ${n.label ?? ''}: ${detail.command}`;
                if (detail.url) return `- ${n.label ?? ''}: ${detail.url}`;
                if (Array.isArray(detail.permissions)) return `- ${n.label ?? ''}: ${detail.permissions.join(', ')}`;
                return `- ${n.label ?? ''}`;
              })]
            : []),
        ]);
        if (parsed.status === 'partial_failure') process.exitCode = 1;
        return true;
      }
      // Recommendations are pre-sorted descending by savings inside the tool.
      const recs = parsed.recommendations ?? [];
      const total = parsed.summary?.total ?? recs.length;
      const totalSavings = parsed.summary?.estimatedMonthlySavingsUsd ?? 0;

      const effectiveCoFmt = await resolveEffectiveFormat(rawRecFormat);
      if (effectiveCoFmt !== null) {
        const coTextFailOn = parseArg(commandArgs, '--fail-on');
        if (coTextFailOn === 'partial') {
          process.stderr.write('[korinfra] Warning: --fail-on partial is not applicable to recommend\n');
        }
        const format = effectiveCoFmt as ReportFormat;
        const scanReport: ScanReport = {
          scanId: '',
          timestamp: new Date().toISOString(),
          resources: [],
          recommendations: recs.slice(0, 50).map((r, i) => ({
            id: String(i),
            resourceId: r.resourceArn ?? '',
            type: r.resourceType ?? '',
            title: r.finding ?? 'Optimization recommendation',
            estimatedSavings: r.estimatedMonthlySavingsUsd ?? 0,
            confidence: 1.0,
            impact: (r.estimatedMonthlySavingsUsd ?? 0) >= 100 ? 'critical'
              : (r.estimatedMonthlySavingsUsd ?? 0) >= 50 ? 'high'
              : (r.estimatedMonthlySavingsUsd ?? 0) >= 10 ? 'medium' : 'low',
            risk: 'low',
            status: 'open',
          })),
          costs: [],
          summary: {
            totalResources: 0,
            totalMonthlyCost: 0,
            potentialSavings: totalSavings,
            recommendationCount: recs.slice(0, 50).length,
          },
        };
        const resolvedCoOutput = resolveOutputArg(commandArgs);
        if (resolvedCoOutput !== null && !isWithinCwd(resolvedCoOutput)) {
          process.stderr.write(`korinfra recommend: --output path must stay within the current directory\n`);
          process.exitCode = 2;
          return true;
        }
        const coFormatted = createFormatter(format).format(scanReport);
        if (resolvedCoOutput !== null) {
          if (writeFormattedText(coFormatted, format, resolvedCoOutput)) return true;
        } else {
          process.stdout.write(coFormatted);
        }
        return true;
      }

      writeLines([
        '[Source: AWS Compute Optimizer]',
        ...(parsed.status === 'partial'
          ? ['Warning: partial results (some calls failed). Output may underreport savings.']
          : []),
        `Recommendations: ${total}`,
        totalSavings > 0 ? `Estimated savings: ${formatMoney(totalSavings)}/mo` : 'Estimated savings: none',
        '',
        ...recs.slice(0, 20).map((r) =>
          `- [${stripAnsi(r.finding ?? 'Unknown')}] ${r.resourceType ?? '?'} ${stripAnsi(r.resourceArn ?? '')} — ${formatMoney(r.estimatedMonthlySavingsUsd ?? 0)}/mo`,
        ),
        ...(recs.length > 20 ? [`... ${recs.length - 20} more`] : []),
        ...(parsed.warnings && parsed.warnings.length > 0
          ? ['', 'Warnings:', ...parsed.warnings.map((w) => `- ${w}`)]
          : []),
      ]);
      return true;
    }
    const isRefresh = hasFlag(commandArgs, '--refresh');
    if (isRefresh && rawRecFormat !== null) {
      process.stderr.write('[korinfra] Warning: --format is not supported with --refresh; use without --refresh to format cached recommendations\n');
    }
    if (isRefresh) {
      const provider = await createHeadlessProvider();
      if (provider === null) {
        writeLines([
          'korinfra recommend --refresh: AI provider not configured.',
          '',
          'Next:',
          '- korinfra init   (configure AI)',
          '- korinfra recommend --no-tui   (cached recommendations, no AI)',
        ]);
        process.exitCode = 1;
        return true;
      }
      process.stderr.write('[korinfra] refreshing recommendations via AI…\n');
      let context;
      try {
        context = await runSteps(buildScanPipelineSteps({}));
      } catch (e) {
        process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(1);
      }
      const prompt = buildRecommendAnalysisPrompt(context);
      const agentResult = await runHeadlessAgent(
        prompt,
        provider,
        { systemPrompt: getAnalysisPrompt('recommend') },
        'text',
      );
      if (!agentResult.aborted && agentResult.result.length === 0) {
        process.stdout.write('\n');
      }
      return true;
    }
    // No --refresh: read from DB and format as text
    const db = getDb();
    const recs = listPendingRecommendations(db, 50);
    const totalSavings = recs.reduce((s, r) => s + (r.estimated_savings ?? 0), 0);

    const effectiveRecFmt = await resolveEffectiveFormat(rawRecFormat);
    if (effectiveRecFmt !== null) {
      const recDbFailOn = parseArg(commandArgs, '--fail-on');
      if (recDbFailOn === 'partial') {
        process.stderr.write('[korinfra] Warning: --fail-on partial is not applicable to recommend\n');
      }
      const format = effectiveRecFmt as ReportFormat;
      const scanReport: ScanReport = {
        scanId: '',
        timestamp: new Date().toISOString(),
        resources: [],
        recommendations: recs.slice(0, 50).map((r) => ({
          id: r.id,
          resourceId: r.resource_id ?? '',
          type: r.type ?? '',
          title: r.title,
          ...(r.description !== null && r.description !== undefined ? { description: r.description } : {}),
          estimatedSavings: r.estimated_savings ?? 0,
          confidence: r.confidence ?? 0,
          impact: r.impact ?? 'medium',
          risk: r.risk ?? 'low',
          status: r.status ?? 'open',
        })),
        costs: [],
        summary: {
          totalResources: 0,
          totalMonthlyCost: 0,
          potentialSavings: totalSavings,
          recommendationCount: recs.length,
        },
      };
      const resolvedRecOutput = resolveOutputArg(commandArgs);
      if (resolvedRecOutput !== null && !isWithinCwd(resolvedRecOutput)) {
        process.stderr.write(`korinfra recommend: --output path must stay within the current directory\n`);
        process.exitCode = 2;
        return true;
      }
      const recFormatted = createFormatter(format).format(scanReport);
      if (resolvedRecOutput !== null) {
        if (writeFormattedText(recFormatted, format, resolvedRecOutput)) return true;
      } else {
        process.stdout.write(recFormatted);
      }
      return true;
    }

    writeLines([
      'korinfra recommend',
      `Recommendations: ${recs.length}`,
      totalSavings > 0 ? `Estimated savings: ${formatMoney(totalSavings)}/mo` : 'Estimated savings: none',
      '',
      ...recs.slice(0, 20).map((r) => `- [${r.impact ?? 'medium'}] ${stripAnsi(r.title)}`),
      ...(recs.length > 20 ? [`... ${recs.length - 20} more`] : []),
      '',
      'Next:',
      '- korinfra recommend --refresh --no-tui   (AI-powered refresh)',
      '- korinfra fix',
    ]);
    return true;
  }

  if (command === 'tags') {
    const subcommand = commandArgs[0] ?? 'list';
    if (subcommand === 'suggest') {
      const provider = await createHeadlessProvider();
      if (provider === null) {
        writeLines([
          'korinfra tags suggest: AI provider not configured.',
          '',
          'Next:',
          '- korinfra init   (configure AI)',
          '- korinfra tags list --no-tui   (compliance audit, no AI)',
        ]);
        process.exitCode = 1;
        return true;
      }
      const resourceIdx = commandArgs.findIndex((a) => a === '--resource' || a === '-r');
      const resource = (resourceIdx !== -1 && commandArgs[resourceIdx + 1] && !(commandArgs[resourceIdx + 1] ?? '').startsWith('-'))
        ? commandArgs[resourceIdx + 1]
        : undefined;
      const virtual = hasFlag(commandArgs, '--virtual');
      const resourceFilter = resource ? ` for resource: ${resource}` : '';
      const virtualNote = virtual ? ' Include virtual/inferred tags.' : '';
      const prompt = `Suggest tags for untagged resources${resourceFilter}.${virtualNote}

Steps: collect_aws_resources → infer tags from names, types, context

Output: table per resource type: resource | suggested Environment | Team | Project | confidence`;
      process.stderr.write('[korinfra] generating tag suggestions via AI…\n');
      await runHeadlessAgent(
        prompt,
        provider,
        { systemPrompt: getAnalysisPrompt('tags') },
        'text',
      );
      return true;
    }
    if (subcommand === 'costs') {
      const provider = await createHeadlessProvider();
      if (provider === null) {
        writeLines([
          'korinfra tags costs: AI provider not configured.',
          '',
          'Next:',
          '- korinfra init   (configure AI)',
          '- korinfra costs --no-tui   (raw cost totals, no tag allocation)',
        ]);
        process.exitCode = 1;
        return true;
      }
      const resourceIdx = commandArgs.findIndex((a) => a === '--resource' || a === '-r');
      const resource = (resourceIdx !== -1 && commandArgs[resourceIdx + 1] && !(commandArgs[resourceIdx + 1] ?? '').startsWith('-'))
        ? commandArgs[resourceIdx + 1]
        : undefined;
      const resourceFilter = resource ? ` for resource: ${resource}` : '';
      const prompt = `Cost allocation by tag${resourceFilter}.

Steps: get_costs with tag dimensions

Output:
## Cost by Environment (table: env | cost | % of total)
## Cost by CostCenter (table)
## Untagged Spend (total and % of all spend)`;
      process.stderr.write('[korinfra] running tag cost allocation via AI…\n');
      await runHeadlessAgent(
        prompt,
        provider,
        { systemPrompt: getAnalysisPrompt('tags') },
        'text',
      );
      return true;
    }

    if (subcommand === 'apply') {
      const provider = await createHeadlessProvider();
      if (provider === null) {
        writeLines([
          'korinfra tags apply: AI provider not configured.',
          '',
          'Next:',
          '- korinfra init   (configure AI)',
          '- korinfra tags list --no-tui   (compliance audit, no AI)',
        ]);
        process.exitCode = 1;
        return true;
      }
      const resourceIdx = commandArgs.findIndex((a) => a === '--resource' || a === '-r');
      const resource = (resourceIdx !== -1 && commandArgs[resourceIdx + 1] && !(commandArgs[resourceIdx + 1] ?? '').startsWith('-'))
        ? commandArgs[resourceIdx + 1]
        : undefined;
      const virtual = hasFlag(commandArgs, '--virtual');
      const force = hasFlag(commandArgs, '--force');

      const resourceFilter = resource ? ` for resource: ${resource}` : '';
      const virtualNote = virtual ? ' Include virtual/inferred tags.' : '';
      const prompt = `Plan tag changes${resourceFilter}. This command prepares an action plan only; it does not write tags itself.${virtualNote}

Steps: collect_aws_resources → generate AWS CLI and Terraform edits

Output: for each change: resource | tag | value | AWS CLI command | Terraform edit`;

      if (!force) {
        process.stderr.write('[korinfra] running tag plan (dry run)…\n');
        await runHeadlessAgent(
          prompt,
          provider,
          { systemPrompt: getAnalysisPrompt('tags') },
          'text',
        );
        process.stdout.write('\nReview changes above. Re-run with --force to apply.\n');
        return true;
      }

      process.stderr.write('[korinfra] running tag apply…\n');
      await runHeadlessAgent(
        prompt,
        provider,
        { systemPrompt: getAnalysisPrompt('tags') },
        'text',
      );
      return true;
    }

    if (subcommand !== 'list') {
      writeLines([
        `korinfra tags ${subcommand}: this subcommand requires the interactive TUI (AI agent streaming).`,
        '',
        'Next:',
        '- korinfra tags list --no-tui   (compliance audit)',
        '- korinfra tags suggest --no-tui   (AI tag suggestions)',
        '- korinfra (interactive TUI for apply/costs)',
      ]);
      process.exitCode = 1;
      return true;
    }
    const rawTags = parseArg(commandArgs, '--required-tags');
    const requiredTags = rawTags ? rawTags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    let context;
    try {
      context = await runSteps(buildTagsPipelineSteps({ requiredTags }));
    } catch (e) {
      process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
    const { resources, totalCount, compliantCount, compliancePercent, missingTagCounts } =
      extractTagCompliance(context, { requiredTags });
    const untagged = resources.filter((r) => !r.isCompliant);

    const lines: string[] = [
      `Tag compliance: ${compliancePercent}% (${compliantCount}/${totalCount} resources tagged)`,
      '',
    ];

    if (untagged.length === 0) {
      lines.push('All resources are compliant.');
    } else {
      lines.push('Untagged resources:');
      for (const r of untagged) {
        lines.push(`  - ${stripAnsi(r.name)} (${stripAnsi(r.type)}, ${stripAnsi(r.region)})`);
      }
    }

    lines.push('');
    const effectiveTags = requiredTags ?? ['Environment', 'Team', 'Project'];
    lines.push(`Required tags: ${effectiveTags.join(', ')}`);

    const topMissing = Object.entries(missingTagCounts)
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);
    if (topMissing.length > 0) {
      lines.push('');
      lines.push('Most missing:');
      for (const [tag, count] of topMissing) {
        lines.push(`  - ${tag}: ${count} resource${count !== 1 ? 's' : ''}`);
      }
    }

    lines.push('');
    lines.push('Next:');
    lines.push('- korinfra scan');
    writeLines(lines);
    return true;
  }

  if (command === 'doctor') {
    const storagePath = defaultStoragePath();
    const results = await runAllChecks(storagePath);
    const lines: string[] = ['Doctor'];
    for (const [, result] of results) {
      const icon = result.status === 'pass' ? '✓' : result.status === 'warn' ? '!' : '✗';
      lines.push(`  ${icon} ${result.label}: ${result.detail ?? ''}`);
    }
    const failed = [...results.values()].filter((r) => r.status === 'fail').length;
    lines.push('');
    lines.push(failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`);
    writeLines(lines);
    return true;
  }

  if (command === 'init') {
    const nonInteractive = hasFlag(commandArgs, '--non-interactive');
    const configFile = parseArg(commandArgs, '--config');

    if (!nonInteractive && !configFile) {
      process.stderr.write('korinfra init: use --non-interactive with flags or --config <file> for headless mode.\n');
      process.stderr.write('Examples:\n');
      process.stderr.write('  korinfra init --non-interactive --profile default --ai-provider anthropic --ai-key sk-ant-api...\n');
      process.stderr.write('  korinfra init --config ./korinfra-setup.yaml\n');
      process.exit(2);
    }

    // Load config file params (YAML or JSON)
    let fileParams: Record<string, string> = {};
    if (configFile) {
      try {
        fileParams = loadHeadlessConfigFile(configFile);
      } catch (err) {
        process.stderr.write(`korinfra init: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(2);
      }
    }

    // Priority: flag > config file > env > existing config > default
    const profile = (parseArg(commandArgs, '--profile') ?? String(fileParams['profile'] ?? '')) || (process.env['AWS_PROFILE'] ?? 'default');
    const aiProviderFlag = parseArg(commandArgs, '--ai-provider') ?? String(fileParams['ai_provider'] ?? '');
    let existingAiProvider: string | undefined;
    if (!aiProviderFlag) {
      try { existingAiProvider = (await loadConfig()).ai.provider; } catch { /* no existing config */ }
    }
    const aiProvider = (aiProviderFlag || (existingAiProvider === 'claude' ? 'anthropic' : '') || 'none') as 'anthropic' | 'none';
    const aiKey = (parseArg(commandArgs, '--ai-key') ?? String(fileParams['ai_key'] ?? '')) || (process.env['ANTHROPIC_API_KEY'] ?? '');
    const githubToken = parseArg(commandArgs, '--github-token') ?? process.env['GITHUB_TOKEN'] ?? '';

    if (!['anthropic', 'none'].includes(aiProvider)) {
      process.stderr.write(`korinfra init: unknown --ai-provider "${aiProvider}". Use "anthropic" or "none".\n`);
      process.exit(2);
    }

    if (aiProvider === 'anthropic' && !aiKey) {
      process.stderr.write('korinfra init: --ai-provider anthropic requires --ai-key or ANTHROPIC_API_KEY env var.\n');
      process.exit(2);
    }

    if (aiKey && !validateApiKey('anthropic', aiKey)) {
      process.stderr.write('korinfra init: invalid API key format. Must start with sk-ant-api.\n');
      process.exit(2);
    }

    const result = await writekorinfraConfig({ profile, aiProvider, aiKey, ...(githubToken ? { githubToken } : {}) });
    writeLines([
      'korinfra init',
      `Status: ${result.configExisted ? 'updated' : 'created'}`,
      `Config: ${result.configPath}`,
      result.envSaved ? 'API key: saved to .korinfra/.env' : 'AI provider: none (rules-only mode)',
      'Note: AWS connection was not verified in headless mode. Run `korinfra doctor` to check.',
      '',
      'Next:',
      '- korinfra scan',
      '- korinfra doctor',
    ]);
    return true;
  }

  if (command === 'mcp') {
    const rawSubcommand = commandArgs[0];

    if (rawSubcommand === 'token') {
      // Text-only path. `--json` is stripped by src/index.ts before routing here
      // and JSON output is handled by runJsonCommand instead.
      const action = commandArgs[1];

      if (action === 'status') {
        const { readPersistedTokenData, getTokenFilePath, getTokenFileMtimeMs } = await import('../mcp/token.js');
        const filePath = getTokenFilePath();
        const envOverride = Boolean(process.env['MCP_AUTH_TOKEN']);
        const data = envOverride ? null : readPersistedTokenData();
        const mtimeMs = envOverride ? 0 : getTokenFileMtimeMs();
        if (envOverride) {
          writeLines([`Source: MCP_AUTH_TOKEN env`, `Path:   ${filePath} (not used)`]);
        } else if (data) {
          writeLines([
            `Path:    ${filePath}`,
            `Version: ${data.version}`,
            mtimeMs ? `Mtime:   ${new Date(mtimeMs).toISOString()}` : '',
          ].filter(Boolean));
        } else {
          writeLines([`Path:    ${filePath}`, 'Status:  no token yet']);
        }
        return true;
      }

      if (action !== 'revoke' && action !== 'rotate') {
        process.stderr.write('korinfra mcp token: usage: korinfra mcp token <revoke|rotate|status> [--json]\n');
        process.exit(2);
      }
      if (process.env['MCP_AUTH_TOKEN']) {
        process.stderr.write('korinfra mcp token: MCP_AUTH_TOKEN is set; unset it to rotate the persisted file.\n');
        process.exit(2);
      }
      const { revokeToken, getTokenFilePath } = await import('../mcp/token.js');
      try {
        const result = revokeToken();
        writeLines([
          `Token:   ${result.token}`,
          `Version: ${result.version}`,
          `Path:    ${getTokenFilePath()}`,
          '',
          'The running MCP HTTP server picks this up on the next request.',
        ]);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`korinfra mcp token ${action}: failed: ${msg}\n`);
        process.exit(1);
      }
    }

    const subcommand = rawSubcommand === 'uninstall' ? 'uninstall' : rawSubcommand === 'status' ? 'status' : 'install';
    const nonInteractive = hasFlag(commandArgs, '--non-interactive');
    const configFile = parseArg(commandArgs, '--config');
    const jsonOutput = hasFlag(commandArgs, '--json');

    // Status subcommand doesn't require --non-interactive or --config
    if (subcommand !== 'status' && !nonInteractive && !configFile) {
      process.stderr.write('korinfra mcp: use --non-interactive with flags or --config <file> for headless mode.\n');
      process.stderr.write('Examples:\n');
      process.stderr.write('  korinfra mcp install --non-interactive --ide claude-code,cursor\n');
      process.stderr.write('  korinfra mcp install --config ./mcp-setup.yaml\n');
      process.stderr.write('  korinfra mcp status\n');
      process.exit(2);
    }

    // Load config file params
    let fileParams: Record<string, string> = {};
    if (configFile) {
      try {
        fileParams = loadHeadlessConfigFile(configFile);
      } catch (err) {
        process.stderr.write(`korinfra mcp: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(2);
      }
    }

    const rawIde = parseArg(commandArgs, '--ide') ?? String(fileParams['ide'] ?? '');
    const ideFilter: string[] | undefined = rawIde
      ? rawIde.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    if (ideFilter !== undefined) {
      const invalid = ideFilter.filter((id) => !(SUPPORTED_IDE_IDS as readonly string[]).includes(id));
      if (invalid.length > 0) {
        process.stderr.write(`korinfra mcp: unknown IDE(s): ${invalid.join(', ')}. Supported: ${SUPPORTED_IDE_IDS.join(', ')}.\n`);
        process.exit(2);
      }
    }

    const rawScope = parseArg(commandArgs, '--scope') ?? String(fileParams['scope'] ?? 'user');
    const scope = (rawScope === 'project' ? 'project' : 'user');

    const targets = resolveIdeTargets(ideFilter, scope);
    if (targets.length === 0) {
      process.stderr.write('korinfra mcp: no matching IDE targets found.\n');
      process.exit(2);
    }

    if (subcommand === 'status') {
      // Status: print install state per IDE without modifying anything
      const statusLines: string[] = ['korinfra mcp status'];
      const statusJson: Array<{ id: string; label: string; configPath: string; installState: string; exists: boolean }> = [];
      for (const target of targets) {
        const state = target.installState;
        statusLines.push(`  ${target.label}: ${state} (${target.configPath})`);
        statusJson.push({
          id: target.id,
          label: target.label,
          configPath: target.configPath,
          installState: state,
          exists: target.exists,
        });
      }
      if (jsonOutput) {
        process.stdout.write(JSON.stringify(statusJson, null, 2) + '\n');
      } else {
        writeLines(statusLines);
      }
      return true;
    }

    const results: InstallResult[] = subcommand === 'uninstall'
      ? targets.map((t) => uninstallFromConfig(t))
      : targets.map((t) => installIntoConfig(t));

    const errorCount = results.filter((r) => r.action === 'error').length;
    const lines: string[] = [
      `korinfra mcp ${subcommand}`,
      `IDEs processed: ${results.length}`,
      ...results.map((r) => `  ${r.action === 'error' ? '✗' : '✓'} ${r.label} (${r.configPath}) — ${r.action}${r.detail ? ': ' + r.detail : ''}`),
      '',
      'Next:',
      subcommand === 'install' ? '- Restart your IDE to activate the MCP server' : '- Run install again to re-add: korinfra mcp install --non-interactive',
    ];
    writeLines(lines);
    if (errorCount > 0) process.exitCode = 1;
    return true;
  }

  if (command === 'fix') {
    const rawTarget = commandArgs.filter(a => !a.startsWith('--')).join(' ').trim();
    const recId = rawTarget && /^[\w-]+$/.test(rawTarget) ? rawTarget : '';
    const isDryRun = hasFlag(commandArgs, '--dry-run');
    const isPR = hasFlag(commandArgs, '--pr');

    if (!recId) {
      writeLines([
        'korinfra fix: missing recommendation ID.',
        '',
        'Usage: korinfra fix <rec-id> --no-tui',
        '       korinfra fix <rec-id> --dry-run --no-tui',
        '       korinfra fix <rec-id> --json',
      ]);
      process.exitCode = 2;
      return true;
    }

    const db = getDb();
    const rec = getRecommendationById(db, recId);
    if (!rec) {
      writeLines([`korinfra fix: recommendation "${recId}" not found. Run korinfra scan first.`]);
      process.exitCode = 1;
      return true;
    }
    if (rec.status === 'applied') {
      const appliedDate = rec.applied_at ? ` on ${rec.applied_at.slice(0, 10)}` : '';
      writeLines([`korinfra fix: recommendation was already applied${appliedDate}. Run korinfra scan to find new optimizations.`]);
      process.exitCode = 1;
      return true;
    }
    if (rec.status === 'dismissed') {
      writeLines([`korinfra fix: recommendation "${recId}" was dismissed.`]);
      process.exitCode = 1;
      return true;
    }

    const provider = await createHeadlessProvider();
    if (provider === null) {
      writeLines([
        'korinfra fix: AI provider required for fix workflow.',
        '',
        'Next:',
        '- korinfra init   (configure AI)',
      ]);
      process.exitCode = 1;
      return true;
    }

    const prOwner = parseArg(commandArgs, '--github-owner');
    const prRepo = parseArg(commandArgs, '--github-repo');
    const prContext = isPR
      ? (prOwner && prRepo ? { owner: prOwner, repo: prRepo } : detectGitHubRepo())
      : null;

    if (isPR && !prContext) {
      writeLines([
        'korinfra fix: could not detect GitHub owner/repo from git remote.',
        '',
        'Pass them explicitly:',
        '  korinfra fix ' + recId + ' --pr --github-owner <owner> --github-repo <repo> --no-tui',
      ]);
      process.exitCode = 1;
      return true;
    }

    const prompt = buildAgentPrompt(rec, { isDryRun, isPR, prContext });
    process.stderr.write(`[korinfra] running fix for rec ${recId}…\n`);
    const fixCfg = await loadConfig().catch(() => null);
    await runHeadlessAgent(prompt, provider, {
      builtinTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
      settingSources: ['project'],
      systemPrompt: getPrompt('fix'),
      timeoutMs: (fixCfg?.ai.timeout_ms ?? 300_000) * 3,
      maxBudgetUsd: fixCfg?.ai.max_budget_usd ?? 0.50,
      tools: fixTools,
    }, 'text');
    if (isDryRun) {
      process.stdout.write('\n(dry run — no changes applied)\n');
    }
    return true;
  }

  if (command === 'rules') {
    const firstArg = commandArgs[0];
    const subcommand = firstArg === undefined || firstArg.startsWith('-') ? 'list' : firstArg;
    if (subcommand !== 'list') {
      writeLines([
        `korinfra rules ${subcommand}: unknown subcommand.`,
        '',
        'Usage:',
        '  korinfra rules list',
        '  korinfra rules list --json',
        '  korinfra rules list --filter <category-or-id-prefix>',
        '  korinfra rules list --impact high   (also: low, medium)',
        '  korinfra rules list --risk high     (also: low, medium)',
      ]);
      process.exitCode = 2;
      return true;
    }

    const filtersResult = parseRulesFilters(commandArgs);
    if ('error' in filtersResult) {
      writeLines([`korinfra rules list: ${filtersResult.error}`]);
      process.exitCode = 2;
      return true;
    }
    const filters = filtersResult;
    const allRules = listRules();
    const filtered = applyRulesFilter(allRules, filters);
    const activeFilters = describeActiveFilters(filters);

    const lines: string[] = ['korinfra rules'];
    if (activeFilters.length > 0) lines.push(`Filters: ${activeFilters.join(', ')}`);
    lines.push(`Rules: ${filtered.length}${activeFilters.length > 0 ? ` of ${allRules.length}` : ''}`);
    lines.push('');

    if (filtered.length === 0) {
      lines.push(`(no rules match ${activeFilters.length > 0 ? activeFilters.join(', ') : 'the active filters'})`);
      lines.push('');
    } else {
      const byCategory = new Map<string, RuleInfo[]>();
      for (const rule of filtered) {
        const arr = byCategory.get(rule.category) ?? [];
        arr.push(rule);
        byCategory.set(rule.category, arr);
      }
      for (const [category, rules] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${category.toUpperCase()} (${rules.length})`);
        for (const rule of rules) {
          lines.push(`  ${rule.id}  [impact=${rule.impact} risk=${rule.risk}]  ${rule.title}`);
        }
        lines.push('');
      }
    }

    lines.push('Next:');
    lines.push('- korinfra rules list --json   (machine-readable output)');
    lines.push('- korinfra scan                (run all rules against AWS)');
    writeLines(lines);
    return true;
  }

  return false;
}

// ─── Headless: JSON output (CLI-1) ────────────────────────────────────────────

export async function runJsonCommand(command: string, commandArgs: string[]): Promise<number | false> {
  if (command === 'scan') {
    const rawFormat = parseArg(commandArgs, '--format', '-f')?.toLowerCase() ?? null;
    if (rawFormat !== null && !['json', 'csv', 'html'].includes(rawFormat)) {
      process.stdout.write(JSON.stringify({
        command: 'scan',
        status: 'error',
        error: `Unknown format "${rawFormat}"`,
        hint: 'Use --format json|csv|html',
      }) + '\n');
      return 2;
    }

    const context = await runSteps(buildScanPipelineSteps({
      regions: parseRegions(commandArgs),
      profile: parseArg(commandArgs, '--profile', '-p'),
      skipCosts: hasFlag(commandArgs, '--skip-costs'),
      skipMetrics: hasFlag(commandArgs, '--skip-metrics'),
    }));
    const summary = extractScanSummary(context);
    const recs = extractRecommendations(context);
    const collectResult = context.results.get('collect') as {
      errors?: CollectError[];
    } | undefined;
    const collectErrors = collectResult?.errors ?? [];
    const scanId = summary.scanId ?? '';
    const criticalCount = recs.filter((r) => r.impact === 'critical').length;
    const failOn = parseArg(commandArgs, '--fail-on');
    const shouldFailOnCritical = failOn === 'critical' && criticalCount > 0;
    const shouldFailOnPartial = failOn === 'partial' && collectErrors.length > 0;
    const failExitCode = (shouldFailOnCritical || shouldFailOnPartial) ? 1 : 0;

    const effectiveFormat = await resolveEffectiveFormat(rawFormat);

    if (effectiveFormat !== null) {
      const format = effectiveFormat as ReportFormat;
      const outputArg = parseArg(commandArgs, '--output', '-o');
      const resolvedOutput = outputArg !== null ? path.resolve(process.cwd(), outputArg) : undefined;
      if (resolvedOutput !== undefined) {
        const cwd = process.cwd();
        if (!resolvedOutput.startsWith(cwd + path.sep) && resolvedOutput !== cwd) {
          process.stdout.write(JSON.stringify({ command: 'scan', status: 'error', error: '--output path must stay within the current directory' }) + '\n');
          return 2;
        }
      }
      try {
        const reportContext = await runSteps(buildReportPipelineSteps({
          format,
          outputPath: resolvedOutput,
          scanId: summary.scanId,
        }));
        const result = extractReportResult(reportContext);
        if (result.written && result.outputPath) {
          process.stderr.write(`[korinfra] ${format.toUpperCase()} report written to ${result.outputPath}\n`);
        } else if (result.content !== undefined) {
          process.stdout.write(result.content);
        } else {
          process.stderr.write('[korinfra] Warning: formatter produced no output\n');
        }
      } catch (err: unknown) {
        process.stderr.write(`[korinfra] Report generation failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      return failExitCode;
    }

    const out = {
      command: 'scan',
      status: 'completed',
      ...(collectErrors.length > 0 ? {
        partial: true,
        errors: collectErrors,
      } : {}),
      summary: {
        resources: summary.resourceCount,
        monthlyCostUsd: summary.totalMonthlyCostUsd,
        recommendations: summary.recommendationCount,
        anomalies: summary.anomalyCount,
        ...(summary.unknownCostCount > 0 ? { unknownCostCount: summary.unknownCostCount } : {}),
        ...(summary.warnings.length > 0 ? { warningCount: summary.warnings.length } : {}),
      },
      ...(summary.warnings.length > 0 ? { warnings: summary.warnings } : {}),
      recommendations: recs.slice(0, 50).map((r) => ({
        id: r.id ?? '',
        ruleId: r.type ?? '',
        resourceId: r.resourceId,
        resourceType: r.type,
        title: r.title,
        impact: r.impact,
        risk: r.risk,
        estimatedSavingsUsd: r.estimatedSavingsUsd ?? 0,
        confidence: r.confidence,
      })),
      next: [
        ...(scanId ? [{ label: 'generate report', command: `korinfra report --scan ${scanId} --format html --output reports/scan-${scanId.slice(0, 8)}.html` }] : [{ label: 'generate report', command: 'korinfra report --format html --output reports/latest.html' }]),
        { label: 'review recommendations', command: 'korinfra recommend --no-tui' },
        { label: 'apply a fix', command: 'korinfra fix' },
      ],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return failExitCode;
  }

  if (command === 'costs') {
    const rawDays = Number(parseArg(commandArgs, '--days') ?? '30');
    const days = Number.isInteger(rawDays) && rawDays > 0 ? Math.min(rawDays, 397) : 30;
    const rawGroup = parseArg(commandArgs, '--group-by') ?? 'service';
    const groupBy = (['service', 'region', 'account', 'tag'].includes(rawGroup) ? rawGroup : 'service') as 'service' | 'region' | 'account' | 'tag';
    const context = await runSteps(buildCostsPipelineSteps({ days, groupBy }));
    const total = extractTotalCost(context);
    const chart = extractCostChartData(context);
    const { anomalyCount } = extractAnomalies(context);
    const out = {
      command: 'costs',
      status: 'completed',
      summary: {
        periodDays: days,
        groupBy,
        totalUsd: total,
        anomalies: anomalyCount,
        topServices: chart.slice(0, 10).map((row) => ({ label: row.label, usd: row.value })),
      },
      next: [
        { label: 'generate report', command: 'korinfra report --format html --output reports/costs.html' },
        { label: 'scan now', command: 'korinfra scan' },
      ],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  if (command === 'resources') {
    const context = await runSteps(buildResourcesPipelineSteps({
      regions: parseRegions(commandArgs),
      typeFilter: parseArg(commandArgs, '--type'),
    }));
    const rows = extractResourceRows(context);
    const out = {
      command: 'resources',
      status: 'completed',
      summary: {
        total: rows.length,
        resources: rows.slice(0, 50).map((row) => ({
          name: row.name,
          type: row.type,
          region: row.region,
          monthlyCostUsd: row.monthlyCostUsd ?? 0,
        })),
      },
      next: [
        { label: 'generate report', command: 'korinfra report --format html --output reports/resources.html' },
        { label: 'scan now', command: 'korinfra scan' },
      ],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  if (command === 'report') {
    const rawFormat = parseArg(commandArgs, '--format', '-f') ?? 'json';
    if (!['json', 'csv', 'html'].includes(rawFormat)) {
      process.stdout.write(JSON.stringify({
        command: 'report',
        status: 'error',
        error: `Unknown format "${rawFormat}"`,
        hint: 'Use --format json|csv|html',
      }) + '\n');
      return 2;
    }
    const format = rawFormat as ReportFormat;
    const output = parseArg(commandArgs, '--output', '-o');
    const resolvedOutput = output !== null ? path.resolve(process.cwd(), output) : undefined;
    if (resolvedOutput !== undefined) {
      const cwd = process.cwd();
      if (!resolvedOutput.startsWith(cwd + path.sep) && resolvedOutput !== cwd) {
        process.stdout.write(JSON.stringify({ command: 'report', status: 'error', error: '--output path must stay within the current directory' }) + '\n');
        return 2;
      }
    }
    const context = await runSteps(buildReportPipelineSteps({
      format,
      outputPath: resolvedOutput,
      scanId: parseArg(commandArgs, '--scan') ?? undefined,
    }));
    const result = extractReportResult(context);
    const out = {
      command: 'report',
      status: 'completed',
      summary: {
        format: result.format,
        resources: result.resourceCount,
        monthlyCostUsd: result.totalCost,
        recommendations: result.recommendationCount,
        written: result.written,
        outputPath: result.outputPath ?? null,
        sizeBytes: result.size,
      },
      next: [
        { label: 'review recommendations', command: 'korinfra recommend --no-tui' },
        { label: 'scan now', command: 'korinfra scan' },
      ],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  if (command === 'history') {
    const subcommand = (commandArgs[0] ?? 'list') as HistorySubcommand;
    if (!['list', 'show', 'diff'].includes(subcommand)) return false;
    const context = await runSteps(buildHistoryPipelineSteps({
      subcommand,
      id1: commandArgs[1] ?? null,
      id2: commandArgs[2] ?? null,
    }));
    if (subcommand === 'list') {
      const scans = extractScanList(context);
      const out = {
        command: 'history',
        status: 'completed',
        summary: {
          total: scans.length,
          scans: scans.map((scan) => ({
            id: scan.id,
            date: scan.date,
            resources: scan.resourceCount,
            monthlyCostUsd: scan.totalCost,
            recommendations: scan.recommendationCount,
          })),
        },
        next: scans.length > 0
          ? [{ label: 'show latest scan', command: `korinfra history show ${scans[0]?.id ?? ''}` }]
          : [{ label: 'scan now', command: 'korinfra scan' }],
      };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return 0;
    }
    if (subcommand === 'show') {
      const detail = extractScanDetail(context);
      const id = String((detail.scan['id'] as string | number | null | undefined) ?? '');
      const out = {
        command: 'history show',
        status: 'completed',
        summary: {
          scanId: id,
          resources: detail.resources.length,
          costEntries: detail.costs.length,
          recommendations: detail.recommendations.length,
        },
        next: [
          ...(id ? [{ label: 'generate report', command: `korinfra report --scan ${id} --format html --output reports/scan-${id.slice(0, 8)}.html` }] : []),
          { label: 'history list', command: 'korinfra history list' },
        ],
      };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return 0;
    }
    const diff = extractScanDiff(context);
    const out = {
      command: 'history diff',
      status: 'completed',
      summary: {
        from: asStr(diff.scanA['id']),
        to: asStr(diff.scanB['id']),
        resourceCountDelta: diff.resourceCountDelta,
        costDeltaUsd: diff.costDelta,
      },
      next: [
        { label: 'generate diff report', command: 'korinfra report --format html --output reports/diff.html' },
      ],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  if (command === 'pricing') {
    const subcommand = commandArgs[0] ?? 'status';
    if (subcommand !== 'status') return false;
    const db = getDb();
    const cache = new PricingCache(db);
    const stats = cache.getCacheStats();
    const expiredCount = cache.getExpiredCount();
    const out = {
      command: 'pricing status',
      status: 'completed',
      summary: {
        cachedEntries: stats.count,
        cacheSizeBytes: stats.total_size_bytes,
        oldestEntry: stats.oldest_entry ?? null,
        newestEntry: stats.newest_entry ?? null,
        expiredEntries: expiredCount,
      },
      next: [
        ...(expiredCount > 0 || stats.count === 0
          ? [{ label: 'download prices', command: 'korinfra pricing download' }]
          : []),
        { label: 'scan now', command: 'korinfra scan' },
      ],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  if (command === 'recommend') {
    const rawJsonRecFmt = parseArg(commandArgs, '--format', '-f')?.toLowerCase() ?? null;
    if (rawJsonRecFmt !== null && !['json', 'csv', 'html'].includes(rawJsonRecFmt)) {
      process.stdout.write(JSON.stringify({ command: 'recommend', status: 'error', error: `Unknown format "${rawJsonRecFmt}"`, hint: 'Use --format json|csv|html' }) + '\n');
      return 2;
    }
    const source = parseArg(commandArgs, '--source');
    if (source !== null && source !== 'compute-optimizer') {
      process.stdout.write(JSON.stringify({
        command: 'recommend',
        status: 'error',
        error: `unknown --source value '${source}'. Valid: 'compute-optimizer'.`,
      }, null, 2) + '\n');
      return 1;
    }
    if (source === 'compute-optimizer') {
      if (hasFlag(commandArgs, '--refresh')) {
        process.stderr.write('[korinfra] note: --refresh is ignored when --source is set\n');
      }
      const { getComputeOptimizerRecommendationsTool } = await import('../tools/get-compute-optimizer-recommendations.js');
      const handlerArgs: Record<string, unknown> = {};
      // loadConfig throws if no .korinfra/config.yaml — treat as "use env defaults"
      try {
        const cfg = await loadConfig();
        if (cfg.aws.default_profile) handlerArgs['profile'] = cfg.aws.default_profile;
        if (cfg.aws.default_region) handlerArgs['regions'] = [cfg.aws.default_region];
      } catch {
        // No config file; rely on AWS_* env vars and the SDK default provider chain.
      }
      const handlerResult = await getComputeOptimizerRecommendationsTool.handler(handlerArgs);
      // The tool returns errorResult(err) (plain-text body) for unhandled
      // failures like credential resolution. Surface those before JSON.parse
      // so the CLI never throws SyntaxError on an error body.
      if (handlerResult.isError) {
        process.stdout.write(JSON.stringify({
          command: 'recommend',
          source: 'compute-optimizer',
          status: 'error',
          error: handlerResult.content[0]?.text ?? 'unknown error',
        }, null, 2) + '\n');
        return 1;
      }
      let parsed: {
        status?: string;
        message?: string;
        summary?: { total?: number; estimatedMonthlySavingsUsd?: number; byType?: Record<string, number> };
        recommendations?: Array<{ estimatedMonthlySavingsUsd?: number; performanceRisk?: string }>;
        warnings?: string[];
        next?: unknown[];
      };
      try {
        parsed = JSON.parse(handlerResult.content[0]?.text ?? '{}') as typeof parsed;
      } catch {
        process.stdout.write(JSON.stringify({
          command: 'recommend',
          source: 'compute-optimizer',
          status: 'error',
          error: `tool returned unparseable output: ${handlerResult.content[0]?.text ?? '(empty)'}`,
        }, null, 2) + '\n');
        return 1;
      }
      // Map CO recommendations to severity buckets by estimated savings.
      // performanceRisk is the risk of a recommendation being wrong (application risk),
      // not the severity of the wastage — so savings amount is the correct signal for --fail-on.
      const recs = parsed.recommendations ?? [];
      const totalCoSavings = parsed.summary?.estimatedMonthlySavingsUsd ?? 0;
      const totalCoCount = parsed.summary?.total ?? recs.length;
      const critical = recs.filter((r) => (r.estimatedMonthlySavingsUsd ?? 0) >= 100).length;
      const high = recs.filter((r) => { const s = r.estimatedMonthlySavingsUsd ?? 0; return s >= 50 && s < 100; }).length;
      const medium = recs.filter((r) => { const s = r.estimatedMonthlySavingsUsd ?? 0; return s >= 10 && s < 50; }).length;
      const low = recs.filter((r) => (r.estimatedMonthlySavingsUsd ?? 0) < 10).length;
      const coFailOn = parseArg(commandArgs, '--fail-on');
      const coFailExitCode = coFailOn === 'critical' && critical > 0 ? 1 : 0;

      const effectiveJsonCoFmt = await resolveEffectiveFormat(rawJsonRecFmt);
      if (effectiveJsonCoFmt !== null) {
        if (coFailOn === 'partial') {
          process.stderr.write('[korinfra] Warning: --fail-on partial is not applicable to recommend\n');
        }
        const format = effectiveJsonCoFmt as ReportFormat;
        const scanReport: ScanReport = {
          scanId: '',
          timestamp: new Date().toISOString(),
          resources: [],
          recommendations: recs.slice(0, 50).map((r, i) => ({
            id: String(i),
            resourceId: (r as { resourceArn?: string }).resourceArn ?? '',
            type: (r as { resourceType?: string }).resourceType ?? '',
            title: (r as { finding?: string }).finding ?? 'Optimization recommendation',
            estimatedSavings: r.estimatedMonthlySavingsUsd ?? 0,
            confidence: 1.0,
            impact: (r.estimatedMonthlySavingsUsd ?? 0) >= 100 ? 'critical'
              : (r.estimatedMonthlySavingsUsd ?? 0) >= 50 ? 'high'
              : (r.estimatedMonthlySavingsUsd ?? 0) >= 10 ? 'medium' : 'low',
            risk: 'low',
            status: 'open',
          })),
          costs: [],
          summary: {
            totalResources: 0,
            totalMonthlyCost: 0,
            potentialSavings: totalCoSavings,
            recommendationCount: recs.slice(0, 50).length,
          },
        };
        const resolvedJsonCoOutput = resolveOutputArg(commandArgs);
        if (resolvedJsonCoOutput !== null && !isWithinCwd(resolvedJsonCoOutput)) {
          process.stdout.write(JSON.stringify({ command: 'recommend', status: 'error', error: '--output path must stay within the current directory' }) + '\n');
          return 2;
        }
        const jsonCoFormatted = createFormatter(format).format(scanReport);
        if (resolvedJsonCoOutput !== null) {
          const writeErr = writeFormattedJson(jsonCoFormatted, format, resolvedJsonCoOutput, 'recommend');
          if (writeErr !== null) return writeErr;
        } else {
          process.stdout.write(jsonCoFormatted);
        }
        // partial_failure → exit 1 even for formatted output (no data arrived)
        if (parsed.status === 'partial_failure') return 1;
        return coFailExitCode;
      }

      const out = {
        command: 'recommend',
        source: 'compute-optimizer',
        status: parsed.status ?? 'completed',
        summary: {
          total: totalCoCount,
          critical,
          high,
          medium,
          low,
          estimatedMonthlySavingsUsd: totalCoSavings,
          byType: parsed.summary?.byType ?? {},
        },
        recommendations: recs,
        ...(parsed.warnings && parsed.warnings.length > 0 ? { warnings: parsed.warnings } : {}),
        next: parsed.next ?? [],
      };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      // partial_failure → exit 1 (nothing came back). partial → exit 0 (some data
      // arrived; consumer can branch on the status field).
      if (parsed.status === 'partial_failure') return 1;
      return coFailExitCode;
    }
    const isRefresh = hasFlag(commandArgs, '--refresh');
    if (isRefresh) {
      const provider = await createHeadlessProvider();
      if (provider === null) {
        process.stdout.write(JSON.stringify({
          command: 'recommend',
          status: 'error',
          error: 'AI provider not configured. Run `korinfra init` to configure.',
        }, null, 2) + '\n');
        return 1;
      }
      let context;
      try {
        context = await runSteps(buildScanPipelineSteps({}));
      } catch (e) {
        process.stdout.write(JSON.stringify({ command: 'recommend', status: 'error', error: e instanceof Error ? e.message : String(e) }) + '\n');
        return 1;
      }
      const prompt = buildRecommendAnalysisPrompt(context);
      const agentResult = await runHeadlessAgent(
        prompt,
        provider,
        { systemPrompt: getAnalysisPrompt('recommend') },
        'json',
      );
      process.stdout.write(JSON.stringify({
        command: 'recommend',
        status: agentResult.aborted ? 'aborted' : 'ok',
        result: agentResult.result,
        costUsd: agentResult.costUsd,
        turns: agentResult.turns,
        durationMs: agentResult.durationMs,
      }, null, 2) + '\n');
      return agentResult.aborted ? 1 : 0;
    }
    const db = getDb();
    const recs = listPendingRecommendations(db, 50);
    const failOn = parseArg(commandArgs, '--fail-on');
    const criticalCount = recs.filter(r => r.impact === 'critical').length;
    const shouldFailOnCritical = failOn === 'critical' && criticalCount > 0;
    const recFailExitCode = shouldFailOnCritical ? 1 : 0;
    const totalDbSavings = recs.reduce((sum, r) => sum + (r.estimated_savings ?? 0), 0);

    const effectiveJsonRecFmt = await resolveEffectiveFormat(rawJsonRecFmt);
    if (effectiveJsonRecFmt !== null) {
      if (failOn === 'partial') {
        process.stderr.write('[korinfra] Warning: --fail-on partial is not applicable to recommend\n');
      }
      const format = effectiveJsonRecFmt as ReportFormat;
      const scanReport: ScanReport = {
        scanId: '',
        timestamp: new Date().toISOString(),
        resources: [],
        recommendations: recs.slice(0, 50).map((r) => ({
          id: r.id,
          resourceId: r.resource_id ?? '',
          type: r.type ?? '',
          title: r.title,
          ...(r.description !== null && r.description !== undefined ? { description: r.description } : {}),
          estimatedSavings: r.estimated_savings ?? 0,
          confidence: r.confidence ?? 0,
          impact: r.impact ?? 'medium',
          risk: r.risk ?? 'low',
          status: r.status ?? 'open',
        })),
        costs: [],
        summary: {
          totalResources: 0,
          totalMonthlyCost: 0,
          potentialSavings: totalDbSavings,
          recommendationCount: recs.length,
        },
      };
      const resolvedJsonRecOutput = resolveOutputArg(commandArgs);
      if (resolvedJsonRecOutput !== null && !isWithinCwd(resolvedJsonRecOutput)) {
        process.stdout.write(JSON.stringify({ command: 'recommend', status: 'error', error: '--output path must stay within the current directory' }) + '\n');
        return 2;
      }
      const jsonRecFormatted = createFormatter(format).format(scanReport);
      if (resolvedJsonRecOutput !== null) {
        const writeErr = writeFormattedJson(jsonRecFormatted, format, resolvedJsonRecOutput, 'recommend');
        if (writeErr !== null) return writeErr;
      } else {
        process.stdout.write(jsonRecFormatted);
      }
      return recFailExitCode;
    }

    const out = {
      command: 'recommend',
      status: 'completed',
      summary: {
        total: recs.length,
        critical: recs.filter(r => r.impact === 'critical').length,
        high: recs.filter(r => r.impact === 'high').length,
        medium: recs.filter(r => r.impact === 'medium').length,
        low: recs.filter(r => r.impact === 'low').length,
        estimatedMonthlySavingsUsd: totalDbSavings,
      },
      recommendations: recs.slice(0, 50).map((r) => ({
        id: r.id,
        scanId: r.scan_id,
        resourceId: r.resource_id,
        resourceType: r.resource_type,
        type: r.type,
        title: r.title,
        description: r.description,
        impact: r.impact ?? 'medium',
        risk: r.risk ?? 'low',
        estimatedSavingsUsd: r.estimated_savings ?? 0,
        status: r.status ?? 'draft',
        confidence: r.confidence ?? 0,
      })),
      next: [
        { label: 'scan now', command: 'korinfra scan' },
        { label: 'apply a fix', command: 'korinfra fix' },
      ],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return recFailExitCode;
  }

  if (command === 'tags') {
    const subcommand = commandArgs[0] ?? 'list';

    if (subcommand === 'costs') {
      const provider = await createHeadlessProvider();
      if (provider === null) {
        process.stdout.write(JSON.stringify({
          command: 'tags costs',
          status: 'error',
          error: 'AI provider not configured. Run `korinfra init` to configure.',
        }, null, 2) + '\n');
        return 1;
      }
      const resourceIdx = commandArgs.findIndex((a) => a === '--resource' || a === '-r');
      const resource = (resourceIdx !== -1 && commandArgs[resourceIdx + 1] && !(commandArgs[resourceIdx + 1] ?? '').startsWith('-'))
        ? commandArgs[resourceIdx + 1]
        : undefined;
      const resourceFilter = resource ? ` for resource: ${resource}` : '';
      const prompt = `Cost allocation by tag${resourceFilter}.

Steps: get_costs with tag dimensions

Output:
## Cost by Environment (table: env | cost | % of total)
## Cost by CostCenter (table)
## Untagged Spend (total and % of all spend)`;
      const agentResult = await runHeadlessAgent(
        prompt,
        provider,
        { systemPrompt: getAnalysisPrompt('tags') },
        'json',
      );
      process.stdout.write(JSON.stringify({
        command: 'tags costs',
        status: agentResult.aborted ? 'aborted' : 'ok',
        result: agentResult.result,
        costUsd: agentResult.costUsd,
        turns: agentResult.turns,
        durationMs: agentResult.durationMs,
      }, null, 2) + '\n');
      return agentResult.aborted ? 1 : 0;
    }

    if (subcommand === 'apply') {
      const provider = await createHeadlessProvider();
      if (provider === null) {
        process.stdout.write(JSON.stringify({
          command: 'tags apply',
          status: 'error',
          error: 'AI provider not configured. Run `korinfra init` to configure.',
        }, null, 2) + '\n');
        return 1;
      }
      const resourceIdx = commandArgs.findIndex((a) => a === '--resource' || a === '-r');
      const resource = (resourceIdx !== -1 && commandArgs[resourceIdx + 1] && !(commandArgs[resourceIdx + 1] ?? '').startsWith('-'))
        ? commandArgs[resourceIdx + 1]
        : undefined;
      const virtual = hasFlag(commandArgs, '--virtual');
      const force = hasFlag(commandArgs, '--force');

      const resourceFilter = resource ? ` for resource: ${resource}` : '';
      const virtualNote = virtual ? ' Include virtual/inferred tags.' : '';
      const prompt = `Plan tag changes${resourceFilter}. This command prepares an action plan only; it does not write tags itself.${virtualNote}

Steps: collect_aws_resources → generate AWS CLI and Terraform edits

Output: for each change: resource | tag | value | AWS CLI command | Terraform edit`;

      if (!force) {
        const agentResult = await runHeadlessAgent(
          prompt,
          provider,
          { systemPrompt: getAnalysisPrompt('tags') },
          'json',
        );
        process.stdout.write(JSON.stringify({
          command: 'tags apply',
          status: 'dry-run',
          force: false,
          hint: 'Review changes above. Re-run with --force to apply.',
          result: agentResult.result,
          costUsd: agentResult.costUsd,
          turns: agentResult.turns,
          durationMs: agentResult.durationMs,
        }, null, 2) + '\n');
        return 0;
      }

      const agentResult = await runHeadlessAgent(
        prompt,
        provider,
        { systemPrompt: getAnalysisPrompt('tags') },
        'json',
      );
      process.stdout.write(JSON.stringify({
        command: 'tags apply',
        status: agentResult.aborted ? 'aborted' : 'ok',
        force: true,
        result: agentResult.result,
        costUsd: agentResult.costUsd,
        turns: agentResult.turns,
        durationMs: agentResult.durationMs,
      }, null, 2) + '\n');
      return agentResult.aborted ? 1 : 0;
    }

    return false;
  }

  if (command === 'config') {
    const subcommand = commandArgs[0] ?? 'show';
    if (subcommand === 'show') {
      const configPath = await findConfigPath();
      const cfg = await loadConfig(configPath ?? undefined);
      const out = {
        command: 'config show',
        status: 'completed',
        configPath: configPath ?? null,
        config: cfg,
      };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return 0;
    }
    if (subcommand === 'set') {
      const key = commandArgs[1];
      const value = commandArgs[2];
      if (!key || value === undefined) {
        process.stdout.write(JSON.stringify({ command: 'config set', status: 'error', error: 'Usage: korinfra config set <key> <value>' }) + '\n');
        return 2;
      }
      if (!isKnownConfigKey(key)) {
        process.stdout.write(JSON.stringify({ command: 'config set', status: 'error', error: `Unknown config key: "${key}"` }) + '\n');
        return 2;
      }
      if (value === '') {
        process.stdout.write(JSON.stringify({ command: 'config set', status: 'error', error: 'Value cannot be empty.' }) + '\n');
        return 2;
      }
      try {
        const configPath = await findConfigPath();
        const cfg = await loadConfig(configPath ?? undefined);
        const mutable = structuredClone(cfg) as Record<string, unknown>;
        setNestedConfigValue(mutable, key, value);
        const parsed = ConfigSchema.safeParse(mutable);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
          process.stdout.write(JSON.stringify({ command: 'config set', status: 'error', error: 'Validation failed', issues }) + '\n');
          return 2;
        }
        await saveConfig(parsed.data, configPath ?? undefined);
        process.stdout.write(JSON.stringify({ command: 'config set', status: 'completed', key, value }) + '\n');
        return 0;
      } catch (err) {
        process.stdout.write(JSON.stringify({ command: 'config set', status: 'error', error: err instanceof Error ? err.message : String(err) }) + '\n');
        return 1;
      }
    }
    return false;
  }

  if (command === 'security') {
    const rawJsonSecFmt = parseArg(commandArgs, '--format', '-f')?.toLowerCase() ?? null;
    if (rawJsonSecFmt !== null && !['json', 'csv', 'html'].includes(rawJsonSecFmt)) {
      process.stdout.write(JSON.stringify({ command: 'security', status: 'error', error: `Unknown format "${rawJsonSecFmt}"`, hint: 'Use --format json|csv|html' }) + '\n');
      return 2;
    }
    const terraformDir = parseArg(commandArgs, '--dir', '-d');
    const severity = parseArg(commandArgs, '--severity');
    let context;
    try {
      context = await runSteps(buildSecurityPipelineSteps({
        terraformDir: terraformDir ?? undefined,
        severity: severity ?? undefined,
      }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ command: 'security', status: 'error', error: e instanceof Error ? e.message : String(e) }) + '\n');
      process.exit(1);
    }
    const securityResult = extractSecurityFindings(context, severity ?? undefined);
    const failOn = parseArg(commandArgs, '--fail-on');
    const criticalCount = securityResult.bySeverity['critical'] ?? 0;
    const shouldFailOnCritical = failOn === 'critical' && criticalCount > 0;
    const failExitCode = shouldFailOnCritical ? 1 : 0;

    const effectiveJsonSecFmt = await resolveEffectiveFormat(rawJsonSecFmt);
    if (effectiveJsonSecFmt !== null) {
      if (failOn === 'partial') {
        process.stderr.write('[korinfra] Warning: --fail-on partial is not applicable to security\n');
      }
      const format = effectiveJsonSecFmt as ReportFormat;
      const jsonSecScanId = (context?.results.get('save_security') as { scan_id?: string } | undefined)?.scan_id ?? '';
      const scanReport: ScanReport = {
        scanId: jsonSecScanId,
        timestamp: new Date().toISOString(),
        resources: [],
        recommendations: securityResult.findings.map((f) => ({
          id: f.id,
          resourceId: f.resource,
          type: f.id,
          title: f.title,
          description: f.description,
          estimatedSavings: 0,
          confidence: 1.0,
          impact: f.severity,
          risk: f.severity,
          status: 'open',
          implementationSteps: f.remediation ? [f.remediation] : null,
        })),
        costs: [],
        summary: {
          totalResources: 0,
          totalMonthlyCost: 0,
          potentialSavings: 0,
          recommendationCount: securityResult.findings.length,
        },
      };
      const resolvedJsonSecOutput = resolveOutputArg(commandArgs);
      if (resolvedJsonSecOutput !== null && !isWithinCwd(resolvedJsonSecOutput)) {
        process.stdout.write(JSON.stringify({ command: 'security', status: 'error', error: '--output path must stay within the current directory' }) + '\n');
        return 2;
      }
      const jsonSecFormatted = createFormatter(format).format(scanReport);
      if (resolvedJsonSecOutput !== null) {
        const writeErr = writeFormattedJson(jsonSecFormatted, format, resolvedJsonSecOutput, 'security');
        if (writeErr !== null) return writeErr;
      } else {
        process.stdout.write(jsonSecFormatted);
      }
      return failExitCode;
    }

    const out = {
      command: 'security',
      status: 'completed',
      summary: {
        total: securityResult.totalCount,
        critical: securityResult.bySeverity['critical'] ?? 0,
        high: securityResult.bySeverity['high'] ?? 0,
        medium: securityResult.bySeverity['medium'] ?? 0,
        low: securityResult.bySeverity['low'] ?? 0,
      },
      findings: securityResult.findings.slice(0, 50).map((f) => ({
        id: f.id,
        ruleId: f.id,
        resourceId: f.resource,
        title: f.title,
        severity: f.severity,
        description: f.description,
        remediation: f.remediation,
      })),
      next: [
        { label: 'scan now', command: 'korinfra scan' },
      ],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return failExitCode;
  }

  if (command === 'cost-impact') {
    const rawJsonCiFmt = parseArg(commandArgs, '--format')?.toLowerCase() ?? null;
    if (rawJsonCiFmt !== null && !['json', 'csv', 'html'].includes(rawJsonCiFmt)) {
      process.stdout.write(JSON.stringify({ command: 'cost-impact', status: 'error', error: `Unknown format "${rawJsonCiFmt}"`, hint: 'Use --format json|csv|html' }) + '\n');
      return 2;
    }
    const planFile = parseArg(commandArgs, '--plan-file', '-f');
    if (planFile === null) {
      process.stdout.write(JSON.stringify({
        command: 'cost-impact',
        status: 'error',
        error: '--plan-file <path> is required',
        hint: 'terraform show -json plan.tfplan > plan.json',
      }, null, 2) + '\n');
      return 2;
    }
    const absPlan = path.resolve(process.cwd(), planFile);
    if (!absPlan.toLowerCase().endsWith('.json')) {
      process.stdout.write(JSON.stringify({
        command: 'cost-impact',
        status: 'error',
        error: `--plan-file must be a .json file (terraform show -json output): ${absPlan}`,
      }, null, 2) + '\n');
      return 2;
    }
    let realPlan: string;
    try {
      realPlan = fs.realpathSync(absPlan);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      process.stdout.write(JSON.stringify({
        command: 'cost-impact',
        status: 'error',
        error: code === 'ENOENT'
          ? `plan file not found: ${absPlan}`
          : `cannot resolve --plan-file path: ${err instanceof Error ? err.message : String(err)}`,
      }, null, 2) + '\n');
      return 2;
    }
    try { assertInsideRoot(realPlan, '--plan-file'); }
    catch (e) {
      process.stdout.write(JSON.stringify({
        command: 'cost-impact',
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      }, null, 2) + '\n');
      return 2;
    }
    // `--tfdir` is accepted for forward-compat with the documented invocation
    // in issue #40, but the cross-reference to .tf source files is not yet
    // wired up. The flag is parsed and ignored.
    const tfdirIgnored = parseArg(commandArgs, '--tfdir') !== null;
    let currency = 'USD';
    try {
      const cfg = await loadConfig();
      currency = cfg.output.currency;
    } catch {
      // No config — fall back to USD.
    }
    let context;
    try {
      context = await runSteps(buildCostImpactPipelineSteps({ planFile: realPlan, currency }));
    } catch (e) {
      process.stdout.write(JSON.stringify({
        command: 'cost-impact',
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      }, null, 2) + '\n');
      return 1;
    }
    const impact = extractCostImpact(context);
    const failOn = parseArg(commandArgs, '--fail-on');
    const criticalCount = impact.findings.filter((f) => f.severity === 'critical').length;
    const shouldFailOnCritical = failOn === 'critical' && criticalCount > 0;
    const failExitCodeCi = shouldFailOnCritical ? 1 : 0;

    const effectiveJsonCiFmt = await resolveEffectiveFormat(rawJsonCiFmt);
    if (effectiveJsonCiFmt !== null) {
      if (failOn === 'partial') {
        process.stderr.write('[korinfra] Warning: --fail-on partial is not applicable to cost-impact\n');
      }
      const format = effectiveJsonCiFmt as ReportFormat;
      const scanReport: ScanReport = {
        scanId: '',
        timestamp: new Date().toISOString(),
        resources: impact.changes.map((c) => ({
          id: c.address,
          type: c.resourceType,
          name: c.address,
          region: '',
          state: c.action,
          monthlyCost: Math.abs(c.deltaUsd),
          monthlyCostSource: null,
        })),
        recommendations: impact.findings.map((f) => ({
          id: f.ruleId,
          resourceId: f.address,
          type: f.ruleId,
          title: f.title,
          description: f.description,
          estimatedSavings: 0,
          confidence: 1.0,
          impact: f.severity,
          risk: f.severity,
          status: 'open',
        })),
        costs: [],
        summary: {
          totalResources: impact.changes.length,
          totalMonthlyCost: impact.summary.netDeltaMonthlyUsd,
          potentialSavings: 0,
          recommendationCount: impact.findings.length,
        },
      };
      const resolvedJsonCiOutput = resolveOutputArg(commandArgs);
      if (resolvedJsonCiOutput !== null && !isWithinCwd(resolvedJsonCiOutput)) {
        process.stdout.write(JSON.stringify({ command: 'cost-impact', status: 'error', error: '--output path must stay within the current directory' }) + '\n');
        return 2;
      }
      const jsonCiFormatted = createFormatter(format).format(scanReport);
      if (resolvedJsonCiOutput !== null) {
        const writeErr = writeFormattedJson(jsonCiFormatted, format, resolvedJsonCiOutput, 'cost-impact');
        if (writeErr !== null) return writeErr;
      } else {
        process.stdout.write(jsonCiFormatted);
      }
      return failExitCodeCi;
    }

    const out = {
      command: 'cost-impact',
      status: 'completed',
      summary: impact.summary,
      changes: impact.changes,
      findings: impact.findings,
      warnings: tfdirIgnored
        ? [...impact.warnings, '--tfdir is accepted but not yet used; cross-referencing to .tf source files is planned for a future release']
        : impact.warnings,
      next: [
        { label: 'generate report', command: 'korinfra report --format html --output reports/cost-impact.html' },
        { label: 'review post-apply security rules', command: 'korinfra security --dir ./terraform' },
      ],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return failExitCodeCi;
  }

  if (command === 'doctor') {
    const storagePath = defaultStoragePath();
    const results = await runAllChecks(storagePath);
    const values = [...results.values()];
    const passed = values.filter((r) => r.status === 'pass').length;
    const warned = values.filter((r) => r.status === 'warn').length;
    const failed = values.filter((r) => r.status === 'fail').length;
    const hasNonOptionalFailure = values.some((r) => r.status === 'fail' && !r.optional);
    const out = {
      command: 'doctor',
      status: hasNonOptionalFailure ? 'error' : 'ok',
      summary: { passed, warned, failed },
      items: values.map((r) => ({
        id: r.id,
        label: r.label,
        status: r.status,
        detail: r.detail ?? '',
        optional: r.optional,
      })),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return hasNonOptionalFailure ? 1 : 0;
  }

  if (command === 'init') {
    const nonInteractive = hasFlag(commandArgs, '--non-interactive');
    const configFile = parseArg(commandArgs, '--config');

    if (!nonInteractive && !configFile) {
      process.stdout.write(JSON.stringify({
        command: 'init',
        status: 'error',
        error: 'Headless init requires --non-interactive with flags or --config <file>.',
        hint: 'korinfra init --non-interactive --profile default --ai-provider anthropic --ai-key sk-ant-api...',
      }) + '\n');
      return 2;
    }

    let fileParams: Record<string, string> = {};
    if (configFile) {
      try {
        fileParams = loadHeadlessConfigFile(configFile);
      } catch (err) {
        process.stdout.write(JSON.stringify({
          command: 'init',
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }) + '\n');
        return 2;
      }
    }

    const profile = (parseArg(commandArgs, '--profile') ?? String(fileParams['profile'] ?? '')) || (process.env['AWS_PROFILE'] ?? 'default');
    const aiProvider = ((parseArg(commandArgs, '--ai-provider') ?? String(fileParams['ai_provider'] ?? '')) || 'none') as 'anthropic' | 'none';
    const aiKey = (parseArg(commandArgs, '--ai-key') ?? String(fileParams['ai_key'] ?? '')) || (process.env['ANTHROPIC_API_KEY'] ?? '');

    if (!['anthropic', 'none'].includes(aiProvider)) {
      process.stdout.write(JSON.stringify({ command: 'init', status: 'error', error: `Unknown --ai-provider "${aiProvider}". Use "anthropic" or "none".` }) + '\n');
      return 2;
    }
    if (aiProvider === 'anthropic' && !aiKey) {
      process.stdout.write(JSON.stringify({ command: 'init', status: 'error', error: '--ai-provider anthropic requires --ai-key or ANTHROPIC_API_KEY env var.' }) + '\n');
      return 2;
    }
    if (aiKey && !validateApiKey('anthropic', aiKey)) {
      process.stdout.write(JSON.stringify({ command: 'init', status: 'error', error: 'Invalid API key format. Must start with sk-ant-api.' }) + '\n');
      return 2;
    }

    const result = await writekorinfraConfig({ profile, aiProvider, aiKey });
    const out = {
      command: 'init',
      status: result.configExisted ? 'updated' : 'created',
      configPath: result.configPath,
      envSaved: result.envSaved,
      aiProvider,
      note: 'AWS connection was not verified in headless mode. Run `korinfra doctor` to check.',
      next: [
        { label: 'scan now', command: 'korinfra scan' },
        { label: 'verify environment', command: 'korinfra doctor' },
      ],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  if (command === 'mcp') {
    if (commandArgs[0] === 'token') {
      const action = commandArgs[1];

      if (action === 'status') {
        const { readPersistedTokenData, getTokenFilePath, getTokenFileMtimeMs } = await import('../mcp/token.js');
        const filePath = getTokenFilePath();
        const envOverride = Boolean(process.env['MCP_AUTH_TOKEN']);
        const data = envOverride ? null : readPersistedTokenData();
        const mtimeMs = envOverride ? 0 : getTokenFileMtimeMs();
        process.stdout.write(JSON.stringify({
          command: 'mcp token status',
          status: 'ok',
          path: filePath,
          version: data?.version ?? null,
          file_exists: data !== null,
          mtime_ms: mtimeMs || null,
          managed_by_env: envOverride,
        }) + '\n');
        return 0;
      }

      if (action !== 'revoke' && action !== 'rotate') {
        process.stdout.write(JSON.stringify({
          command: 'mcp token',
          status: 'error',
          error: 'usage: korinfra mcp token <revoke|rotate|status> [--json]',
        }) + '\n');
        return 2;
      }
      if (process.env['MCP_AUTH_TOKEN']) {
        process.stdout.write(JSON.stringify({
          command: `mcp token ${action}`,
          status: 'error',
          error: 'MCP_AUTH_TOKEN env var is set — token is managed externally. Unset it to rotate the persisted file.',
        }) + '\n');
        return 2;
      }
      const { revokeToken, getTokenFilePath } = await import('../mcp/token.js');
      try {
        const result = revokeToken();
        process.stdout.write(JSON.stringify({
          command: `mcp token ${action}`,
          status: 'ok',
          token: result.token,
          version: result.version,
          path: getTokenFilePath(),
        }) + '\n');
        return 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(JSON.stringify({
          command: `mcp token ${action}`,
          status: 'error',
          error: msg,
        }) + '\n');
        return 1;
      }
    }

    const subcommand = commandArgs[0] === 'uninstall' ? 'uninstall' : 'install';
    const nonInteractive = hasFlag(commandArgs, '--non-interactive');
    const configFile = parseArg(commandArgs, '--config');

    if (!nonInteractive && !configFile) {
      process.stdout.write(JSON.stringify({
        command: `mcp ${subcommand}`,
        status: 'error',
        error: 'Headless mcp requires --non-interactive with flags or --config <file>.',
        hint: 'korinfra mcp install --non-interactive --ide claude-code,cursor',
      }) + '\n');
      return 2;
    }

    let fileParams: Record<string, string> = {};
    if (configFile) {
      try {
        fileParams = loadHeadlessConfigFile(configFile);
      } catch (err) {
        process.stdout.write(JSON.stringify({
          command: `mcp ${subcommand}`,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }) + '\n');
        return 2;
      }
    }

    const rawIde = parseArg(commandArgs, '--ide') ?? String(fileParams['ide'] ?? '');
    const ideFilter: string[] | undefined = rawIde
      ? rawIde.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    if (ideFilter !== undefined) {
      const invalid = ideFilter.filter((id) => !(SUPPORTED_IDE_IDS as readonly string[]).includes(id));
      if (invalid.length > 0) {
        process.stdout.write(JSON.stringify({
          command: `mcp ${subcommand}`,
          status: 'error',
          error: `Unknown IDE(s): ${invalid.join(', ')}. Supported: ${SUPPORTED_IDE_IDS.join(', ')}.`,
        }) + '\n');
        return 2;
      }
    }

    const targets = resolveIdeTargets(ideFilter);
    if (targets.length === 0) {
      process.stdout.write(JSON.stringify({ command: `mcp ${subcommand}`, status: 'error', error: 'No matching IDE targets found.' }) + '\n');
      return 2;
    }

    const results: InstallResult[] = subcommand === 'uninstall'
      ? targets.map((t) => uninstallFromConfig(t))
      : targets.map((t) => installIntoConfig(t));

    const errorCount = results.filter((r) => r.action === 'error').length;
    const out = {
      command: `mcp ${subcommand}`,
      status: errorCount === 0 ? 'completed' : errorCount === results.length ? 'error' : 'partial',
      results: results.map((r) => ({
        id: r.id,
        label: r.label,
        configPath: r.configPath,
        action: r.action,
        detail: r.detail ?? null,
        backupPath: r.backupPath ?? null,
      })),
      next: subcommand === 'install'
        ? [{ label: 'restart IDE to activate MCP server', command: '(manual)' }]
        : [{ label: 'install again', command: 'korinfra mcp install --non-interactive' }],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return errorCount > 0 ? (errorCount === results.length ? 1 : 1) : 0;
  }

  if (command === 'fix') {
    const rawTarget = commandArgs.filter(a => !a.startsWith('--')).join(' ').trim();
    const recId = rawTarget && /^[\w-]+$/.test(rawTarget) ? rawTarget : '';
    const isDryRun = hasFlag(commandArgs, '--dry-run');
    const isPR = hasFlag(commandArgs, '--pr');

    if (!recId) {
      process.stdout.write(JSON.stringify({
        command: 'fix',
        status: 'error',
        error: 'Missing recommendation ID.',
        hint: 'korinfra fix <rec-id> --json',
      }, null, 2) + '\n');
      return 2;
    }

    const db = getDb();
    const rec = getRecommendationById(db, recId);
    if (!rec) {
      process.stdout.write(JSON.stringify({
        command: 'fix',
        status: 'error',
        recId,
        error: `Recommendation "${recId}" not found. Run korinfra scan first.`,
      }, null, 2) + '\n');
      return 1;
    }
    if (rec.status === 'applied') {
      const appliedDate = rec.applied_at ? ` on ${rec.applied_at.slice(0, 10)}` : '';
      process.stdout.write(JSON.stringify({
        command: 'fix',
        status: 'error',
        recId,
        error: `Recommendation was already applied${appliedDate}.`,
      }, null, 2) + '\n');
      return 1;
    }
    if (rec.status === 'dismissed') {
      process.stdout.write(JSON.stringify({
        command: 'fix',
        status: 'error',
        recId,
        error: `Recommendation "${recId}" was dismissed.`,
      }, null, 2) + '\n');
      return 1;
    }

    const provider = await createHeadlessProvider();
    if (provider === null) {
      process.stdout.write(JSON.stringify({
        command: 'fix',
        status: 'error',
        recId,
        error: 'AI provider required for fix workflow. Run `korinfra init` to configure.',
      }, null, 2) + '\n');
      return 1;
    }

    const startMs = Date.now();
    const prOwner2 = parseArg(commandArgs, '--github-owner');
    const prRepo2 = parseArg(commandArgs, '--github-repo');
    const prContext2 = isPR
      ? (prOwner2 && prRepo2 ? { owner: prOwner2, repo: prRepo2 } : detectGitHubRepo())
      : null;

    if (isPR && !prContext2) {
      process.stdout.write(JSON.stringify({
        command: 'fix',
        status: 'error',
        recId,
        error: 'Could not detect GitHub owner/repo from git remote. Pass --github-owner and --github-repo.',
      }, null, 2) + '\n');
      return 1;
    }

    const prompt = buildAgentPrompt(rec, { isDryRun, isPR, prContext: prContext2 });
    const fixCfg2 = await loadConfig().catch(() => null);
    const agentResult = await runHeadlessAgent(prompt, provider, {
      builtinTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
      settingSources: ['project'],
      systemPrompt: getPrompt('fix'),
      timeoutMs: (fixCfg2?.ai.timeout_ms ?? 300_000) * 3,
      maxBudgetUsd: fixCfg2?.ai.max_budget_usd ?? 0.50,
      tools: fixTools,
    }, 'json');

    process.stdout.write(JSON.stringify({
      command: 'fix',
      status: agentResult.aborted ? 'error' : 'ok',
      recId,
      dryRun: isDryRun,
      result: agentResult.result,
      costUsd: agentResult.costUsd,
      turns: agentResult.turns,
      durationMs: Date.now() - startMs,
    }, null, 2) + '\n');
    return agentResult.aborted ? 1 : 0;
  }

  if (command === 'rules') {
    const firstArg = commandArgs[0];
    const subcommand = firstArg === undefined || firstArg.startsWith('-') ? 'list' : firstArg;
    if (subcommand !== 'list') {
      process.stdout.write(JSON.stringify({
        command: `rules ${subcommand}`,
        status: 'error',
        error: `Unknown subcommand "${subcommand}". Supported: list`,
      }, null, 2) + '\n');
      return 2;
    }

    const filtersResult = parseRulesFilters(commandArgs);
    if ('error' in filtersResult) {
      process.stdout.write(JSON.stringify({
        command: 'rules list',
        status: 'error',
        error: filtersResult.error,
      }, null, 2) + '\n');
      return 2;
    }
    const filters = filtersResult;
    const allRules = listRules();
    const filtered = applyRulesFilter(allRules, filters);

    const out = {
      command: 'rules list',
      status: 'completed',
      ...(filters.text !== null ? { filter: filters.text } : {}),
      ...(filters.impact !== null ? { impact: filters.impact } : {}),
      ...(filters.risk !== null ? { risk: filters.risk } : {}),
      summary: {
        total: filtered.length,
        totalAllRules: allRules.length,
      },
      // `total` at top-level mirrors the shape proposed in issue #25, while
      // `summary.total` keeps consistency with other commands' JSON envelopes.
      total: filtered.length,
      rules: filtered.map(({ id, category, title, description, impact, risk }) => ({ id, category, title, description, impact, risk })),
      next: [
        { label: 'run rules against AWS', command: 'korinfra scan' },
      ],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  return false;
}
