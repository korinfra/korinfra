import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

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
import { buildSecurityPipelineSteps, extractSecurityFindings } from './pipelines/security.js';
import { buildTagsPipelineSteps, extractTagCompliance } from './pipelines/tags.js';
import { buildRecommendAnalysisPrompt, buildSecurityAnalysisPrompt } from './pipelines/analysis.js';
import { getAnalysisPrompt, getPrompt } from '../agent/prompts.js';
import { createAgentProvider } from '../agent/index.js';
import { runHeadlessAgent } from './headless-agent.js';
import { getDb } from '../storage/index.js';
import { PricingCache } from '../pricing/index.js';
import { getRecommendationById, listPendingRecommendations, listRecommendations } from '../storage/queries/recommendations.js';
import { buildAgentPrompt, detectGitHubRepo } from './commands/fix-core.js';
import { fixTools } from '../tools/index.js';
import type { PipelineContext, PipelineStep } from './components/DirectPipeline.js';
import { parseArg, hasFlag } from './utils/parseArgs.js';
import { validateRegions } from './utils/validateRegions.js';

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

// ─── Headless: text output ────────────────────────────────────────────────────

export async function runHeadlessTextCommand(command: string, commandArgs: string[]): Promise<boolean> {
  if (command === 'scan') {
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
    const warningLines: string[] = collectErrors.length > 0
      ? [
        `Warnings: ${collectErrors.length} collection error${collectErrors.length !== 1 ? 's' : ''} — partial results`,
        ...collectErrors.map((e) => `  - [${e.code ?? 'ERROR'}] ${e.collector}${e.region ? `@${e.region}` : ''}: ${e.message}`),
      ]
      : [];
    writeLines([
      'korinfra scan',
      'Status: completed',
      ...warningLines,
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
      ...filtered.slice(0, maxLines).map((row) => `- ${row.name} (${row.type}, ${row.region}) ${row.monthlyCostUsd !== undefined ? formatMoney(row.monthlyCostUsd) : ''}`.trim()),
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
        throw new Error(`Output path must stay within ${cwd}`);
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
          lines.push(`  \u2717 ${f.id} \u2014 ${f.resource}`);
          if (f.remediation) lines.push(`    Fix: ${f.remediation}`);
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
    const isRefresh = hasFlag(commandArgs, '--refresh');
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
    writeLines([
      'korinfra recommend',
      `Recommendations: ${recs.length}`,
      totalSavings > 0 ? `Estimated savings: ${formatMoney(totalSavings)}/mo` : 'Estimated savings: none',
      '',
      ...recs.slice(0, 20).map((r) => `- [${r.impact ?? 'medium'}] ${r.title}`),
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
        lines.push(`  - ${r.name} (${r.type}, ${r.region})`);
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
      const absConfig = path.resolve(process.cwd(), configFile);
      const raw = fs.readFileSync(absConfig, 'utf8');
      const parsed: unknown = absConfig.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw, { schema: yaml.JSON_SCHEMA });
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fileParams = parsed as Record<string, string>;
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
      const absConfig = path.resolve(process.cwd(), configFile);
      const raw = fs.readFileSync(absConfig, 'utf8');
      const parsed: unknown = absConfig.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw, { schema: yaml.JSON_SCHEMA });
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fileParams = parsed as Record<string, string>;
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

  return false;
}

// ─── Headless: JSON output (CLI-1) ────────────────────────────────────────────

export async function runJsonCommand(command: string, commandArgs: string[]): Promise<number | false> {
  if (command === 'scan') {
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
    const criticalCount = recs.filter(r => r.impact === 'critical').length;
    const failOn = parseArg(commandArgs, '--fail-on');
    const shouldFailOnCritical = failOn === 'critical' && criticalCount > 0;
    const shouldFailOnPartial = failOn === 'partial' && collectErrors.length > 0;
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
      },
      recommendations: recs.slice(0, 50).map((r) => ({
        id: r.id ?? '',
        ruleId: r.type ?? '',
        resourceId: r.resourceId,
        resourceType: r.type,
        title: r.title,
        impact: r.impact,
        risk: r.risk,
        estimatedSavingsUsd: r.estimatedSavingsUsd ?? 0,
        confidence: 1,
      })),
      next: [
        ...(scanId ? [{ label: 'generate report', command: `korinfra report --scan ${scanId} --format html --output reports/scan-${scanId.slice(0, 8)}.html` }] : [{ label: 'generate report', command: 'korinfra report --format html --output reports/latest.html' }]),
        { label: 'review recommendations', command: 'korinfra recommend --no-tui' },
        { label: 'apply a fix', command: 'korinfra fix' },
      ],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return (shouldFailOnCritical || shouldFailOnPartial) ? 1 : 0;
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
        throw new Error(`Output path must stay within ${cwd}`);
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
    const out = {
      command: 'recommend',
      status: 'completed',
      summary: {
        total: recs.length,
        critical: recs.filter(r => r.impact === 'critical').length,
        high: recs.filter(r => r.impact === 'high').length,
        medium: recs.filter(r => r.impact === 'medium').length,
        low: recs.filter(r => r.impact === 'low').length,
        estimatedMonthlySavingsUsd: recs.reduce((sum, r) => sum + (r.estimated_savings ?? 0), 0),
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
    return shouldFailOnCritical ? 1 : 0;
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
    return shouldFailOnCritical ? 1 : 0;
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
      const absConfig = path.resolve(process.cwd(), configFile);
      const raw = fs.readFileSync(absConfig, 'utf8');
      const parsed: unknown = absConfig.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw, { schema: yaml.JSON_SCHEMA });
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fileParams = parsed as Record<string, string>;
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
      const absConfig = path.resolve(process.cwd(), configFile);
      const raw = fs.readFileSync(absConfig, 'utf8');
      const parsed: unknown = absConfig.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw, { schema: yaml.JSON_SCHEMA });
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fileParams = parsed as Record<string, string>;
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

  return false;
}
