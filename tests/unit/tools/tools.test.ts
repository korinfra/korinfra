import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/tools/types.js', async () => {
  const actual = await vi.importActual('../../../src/tools/types.js');
  return { ...actual, assertInsideRoot: vi.fn() };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return { ...actual, readdir: vi.fn(() => Promise.resolve(['main.tf'])) };
});
import { jsonResult, errorResult, textResult, normalizeTerraformResource } from '../../../src/tools/types.js';
import { saveScanTool } from '../../../src/tools/save-scan.js';
import { compareScansTool } from '../../../src/tools/compare-scans.js';
import { scanTerraformTool } from '../../../src/tools/scan-terraform.js';
import { terraformValidateTool } from '../../../src/tools/terraform-validate.js';
import { getHistoryTool } from '../../../src/tools/get-history.js';
import { getCostsTool } from '../../../src/tools/get-costs.js';
import { allTools, getTool } from '../../../src/tools/index.js';
import type { ToolDefinition } from '../../../src/tools/types.js';

// ─── result helpers ───────────────────────────────────────────────────────────

describe('tools/types — result helpers', () => {
  it('jsonResult wraps data as pretty-printed text content', () => {
    const r = jsonResult({ foo: 'bar', count: 42 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.type).toBe('text');
    expect(r.content[0]!.text).toContain('\n'); // pretty-printed
    const parsed = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    expect(parsed['foo']).toBe('bar');
    expect(parsed['count']).toBe(42);
    expect(JSON.parse(jsonResult([1, 2, 3]).content[0]!.text)).toEqual([1, 2, 3]);
    expect(jsonResult(null).content[0]!.text).toBe('null');
  });

  it('errorResult wraps Error, string, and unknown types', () => {
    const r1 = errorResult(new Error('something went wrong'));
    expect(r1.isError).toBe(true);
    expect(r1.content[0]!.text).toBe('something went wrong');

    const r2 = errorResult('scan not found');
    expect(r2.isError).toBe(true);
    expect(r2.content[0]!.text).toBe('scan not found');

    expect(errorResult(404).content[0]!.text).toBe('404');
  });

  it('textResult wraps plain text', () => {
    const r = textResult('hello world');
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.type).toBe('text');
    expect(r.content[0]!.text).toBe('hello world');
  });
});

// ─── normalizeTerraformResource ───────────────────────────────────────────────

describe('tools/types — normalizeTerraformResource', () => {
  it('normalizes a well-formed resource and falls back for missing fields', () => {
    const raw = {
      address: 'aws_instance.web', type: 'aws_instance', name: 'web', provider: 'aws', module: '',
      filePath: 'modules/compute/main.tf', lineNumber: 12,
      configuration: { instance_type: 'm5.xlarge' }, estimatedCost: 2345.67,
      dependencies: ['aws_security_group.web'],
    };
    const r = normalizeTerraformResource(raw);
    expect(r['address']).toBe('aws_instance.web');
    expect(r['filePath']).toBe('modules/compute/main.tf');
    expect(r['estimatedCost']).toBe(2345.67);
    expect(r['dependencies']).toEqual(['aws_security_group.web']);

    // filename fallback
    expect(normalizeTerraformResource({ filename: 'main.tf' })['filePath']).toBe('main.tf');

    // config field fallback
    expect(normalizeTerraformResource({ config: { instance_type: 'db.r6g.large' } })['configuration']).toEqual({ instance_type: 'db.r6g.large' });

    // defaults for empty input
    const defaults = normalizeTerraformResource({});
    expect(defaults['address']).toBe('');
    expect(defaults['lineNumber']).toBe(0);
    expect(defaults['estimatedCost']).toBe(0);
    expect(defaults['dependencies']).toEqual([]);
    expect(defaults['configuration']).toEqual({});

    // non-array dependencies → empty
    expect(normalizeTerraformResource({ dependencies: 'not-an-array' })['dependencies']).toEqual([]);
  });
});

// ─── ToolDefinition shapes ────────────────────────────────────────────────────

function validateToolShape(tool: ToolDefinition) {
  expect(typeof tool.name).toBe('string');
  expect(tool.name.length).toBeGreaterThan(0);
  expect(typeof tool.description).toBe('string');
  expect(tool.description.length).toBeGreaterThan(0);
  expect(typeof tool.inputSchema).toBe('object');
  expect(tool.inputSchema).not.toBeNull();
  expect(typeof tool.handler).toBe('function');
}

describe('tools — ToolDefinition shapes and allTools registry', () => {
  it('each named tool has correct shape and required fields', () => {
    validateToolShape(saveScanTool);
    expect(saveScanTool.name).toBe('save_scan');
    expect(saveScanTool.inputSchema['required']).toBeUndefined(); // all optional

    validateToolShape(compareScansTool);
    expect(compareScansTool.name).toBe('compare_scans');
    expect((compareScansTool.inputSchema['required'] as string[])).toContain('scan_id_1');
    expect(compareScansTool.annotations?.readOnlyHint).toBe(true);

    validateToolShape(scanTerraformTool);
    expect(scanTerraformTool.name).toBe('scan_terraform');
    expect((scanTerraformTool.inputSchema['required'] as string[])).toContain('dir');
    expect(scanTerraformTool.annotations?.readOnlyHint).toBe(true);

    validateToolShape(terraformValidateTool);
    expect(terraformValidateTool.name).toBe('terraform_validate');
    expect(terraformValidateTool.annotations?.readOnlyHint).toBe(true);

    validateToolShape(getHistoryTool);
    expect(getHistoryTool.name).toBe('get_history');
    expect(getHistoryTool.annotations?.readOnlyHint).toBe(true);

    validateToolShape(getCostsTool);
    expect(getCostsTool.name).toBe('get_costs');
    expect(getCostsTool.annotations?.readOnlyHint).toBe(true);
  });

  it('allTools registry contains all expected tools with no duplicates', () => {
    const names = allTools.map((t) => t.name);
    for (const expected of ['save_scan', 'compare_scans', 'get_history', 'get_costs', 'scan_terraform', 'terraform_validate', 'collect_aws_resources', 'list_rules']) {
      expect(names).toContain(expected);
    }
    expect(new Set(names).size).toBe(names.length);
    for (const tool of allTools) validateToolShape(tool);
    const tool = getTool('save_scan');
    expect(tool?.name).toBe('save_scan');
    expect(getTool('nonexistent_tool')).toBeUndefined();
  });

  it('getHistoryTool and saveScanTool input schema shapes', () => {
    const histProps = getHistoryTool.inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(histProps['limit']!['default']).toBe(20);
    expect(histProps['limit']!['type']).toBe('number');
    expect(histProps['offset']!['default']).toBe(0);

    const saveProps = saveScanTool.inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(saveProps['resources']!['type']).toBe('array');
    expect(saveProps['costs']!['type']).toBe('array');
    expect(saveProps['recommendations']!['type']).toBe('array');
    expect(saveProps['metadata']!['type']).toBe('object');
  });
});

// ─── compareScansTool — handler validation ────────────────────────────────────

describe('compareScansTool — handler validation', () => {
  it('returns error when scan IDs are missing', async () => {
    const r1 = await compareScansTool.handler({ scan_id_2: 'scan-b' });
    expect(r1.isError).toBe(true);
    expect(r1.content[0]!.text).toContain('scan_id_1');

    const r2 = await compareScansTool.handler({ scan_id_1: 'scan-a' });
    expect(r2.isError).toBe(true);
    expect(r2.content[0]!.text).toContain('scan_id_2');

    expect((await compareScansTool.handler({})).isError).toBe(true);
  });
});

// ─── terraformValidateTool — error path ──────────────────────────────────────────

describe('terraformValidateTool — handler error path', () => {
  it('returns error result when terraform is not installed', async () => {
    const result = await terraformValidateTool.handler({ dir: '/tmp/nonexistent-terraform-dir' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.length).toBeGreaterThan(0);
  });
});
