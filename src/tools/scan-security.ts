/**
 * MCP tool: scan_security
 * Parses a Terraform directory and runs all built-in security rules against it.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import { parseTerraformDir, filterAWSResources } from '../terraform/parser.js';
import { evaluateSecurityRules } from '../rules/security/index.js';
import type { SecurityFinding } from '../rules/security/index.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';
import { redactObject } from '../redaction/index.js';

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

type EnrichedFinding = SecurityFinding & {
  filePath: string | null;
  resource_type: string | null;
};

function groupBySeverity(
  findings: EnrichedFinding[],
): Record<string, EnrichedFinding[]> {
  const groups: Record<string, EnrichedFinding[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  };
  for (const f of findings) {
    (groups[f.severity] ??= []).push(f);
  }
  return groups;
}

export const scanSecurityTool: ToolDefinition = {
  name: 'scan_security',
  description:
    'Scan a Terraform directory for security misconfigurations using built-in rules. ' +
    'Returns findings grouped by severity (critical → low). ' +
    'Analyzes Terraform configuration files for security misconfigurations.',
  inputSchema: {
    type: 'object',
    properties: {
      dir: {
        type: 'string',
        description:
          'Absolute or relative path to the Terraform directory containing .tf files.',
      },
    },
    required: ['dir'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    try {
      const dir = args['dir'];
      if (typeof dir !== 'string' || !dir) {
        return errorResult('dir must be a non-empty string path');
      }

      // Validate dir: must exist and contain at least one .tf file
      const resolvedDir = resolve(dir);
      if (resolvedDir === '/' || /^[A-Z]:\\?$/i.test(resolvedDir) || /^\\\\./.test(resolvedDir)) {
        return errorResult(`dir must not be a filesystem root: ${resolvedDir}`);
      }
      if (!existsSync(resolvedDir)) {
        return errorResult(`dir does not exist: ${resolvedDir}`);
      }
      const dirEntries = await readdir(resolvedDir);
      if (!dirEntries.some((e) => e.endsWith('.tf') || e.endsWith('.tf.json'))) {
        return errorResult(`dir contains no .tf files: ${resolvedDir}`);
      }

      const allResources = await parseTerraformDir(resolvedDir);
      const resources = filterAWSResources(allResources);
      const findings = evaluateSecurityRules(resources);

      const resourceByAddress = new Map(resources.map(r => [r.address, r]));

      // Sort by severity then by rule id for deterministic output.
      findings.sort((a, b) => {
        const sd = (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
        if (sd !== 0) return sd;
        return a.ruleId.localeCompare(b.ruleId);
      });

      const enrichedFindings: EnrichedFinding[] = findings.map(f => ({
        ...f,
        filePath: resourceByAddress.get(f.resource)?.filePath ?? null,
        resource_type: resourceByAddress.get(f.resource)?.type ?? null,
      }));

      const bySeverity = groupBySeverity(enrichedFindings);

      return jsonResult(redactObject({
        dir: resolvedDir,
        resources_scanned: resources.length,
        total_findings: findings.length,
        summary: {
          critical: bySeverity['critical']?.length ?? 0,
          high: bySeverity['high']?.length ?? 0,
          medium: bySeverity['medium']?.length ?? 0,
          low: bySeverity['low']?.length ?? 0,
        },
        findings: bySeverity,
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
