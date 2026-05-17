/**
 * Handler-level tests for src/tools/ — mocks all external dependencies
 * so handlers can be exercised without live AWS / SQLite / GitHub calls.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('node:fs');
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(() => Promise.resolve(['main.tf'])),
  realpath: vi.fn((p: string) => Promise.resolve(p)),
}));

vi.mock('node:path', async () => {
  const actual = await vi.importActual('node:path');
  return { ...actual, resolve: (p: string) => p };
});

vi.mock('../../../src/aws/collector.js', () => ({
  collectAll: vi.fn(),
}));

vi.mock('../../../src/aws/cost-explorer.js', () => ({
  getCosts: vi.fn(),
  getCostsCached: vi.fn(),
}));

vi.mock('../../../src/redaction/index.js', () => ({
  redactObject: vi.fn((obj: unknown) => obj),
}));

vi.mock('../../../src/storage/db.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../../src/storage/queries/scans.js', () => ({
  insertScan: vi.fn(),
  getScan: vi.fn(),
  listScans: vi.fn(),
}));

vi.mock('../../../src/storage/queries/resources.js', () => ({
  insertResources: vi.fn(),
  listResources: vi.fn(),
}));

vi.mock('../../../src/storage/queries/costs.js', () => ({
  insertCosts: vi.fn(),
  aggregateCostsByService: vi.fn(),
}));

vi.mock('../../../src/storage/queries/recommendations.js', () => ({
  insertRecommendations: vi.fn(),
  upsertRecommendations: vi.fn(),
  listRecommendations: vi.fn(),
}));

vi.mock('../../../src/terraform/parser.js', () => ({
  parseTerraformDir: vi.fn(),
  filterAWSResources: vi.fn(),
}));

vi.mock('../../../src/terraform/state.js', () => ({
  parseStateFile: vi.fn(),
  findStateFile: vi.fn(),
}));

vi.mock('../../../src/rules/security/index.js', () => ({
  evaluateSecurityRules: vi.fn(),
}));

vi.mock('../../../src/github/client.js', () => ({
  GitHubClient: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock('../../../src/github/pr.js', () => ({
  createPR: vi.fn(),
  buildPRBody: vi.fn(),
}));

vi.mock('../../../src/classifier/index.js', () => ({
  classifyResources: vi.fn(),
  deduplicateRecommendations: vi.fn(),
  detectConfigDiffs: vi.fn(),
  generateConfigDiffRecommendations: vi.fn(),
  generateScenarioRecommendations: vi.fn(),
  generateTfSecurityRecommendations: vi.fn(),
  summarize: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/tools/types.js', async () => {
  const actual = await vi.importActual('../../../src/tools/types.js');
  return {
    ...actual,
    assertInsideRoot: vi.fn(), // bypass path check in unit tests
  };
});

// ─── Lazy imports (after mocks) ───────────────────────────────────────────────

import { collectAwsTool } from '../../../src/tools/collect-aws.js';
import { getCostsTool } from '../../../src/tools/get-costs.js';
import { getHistoryTool } from '../../../src/tools/get-history.js';
import { saveScanTool } from '../../../src/tools/save-scan.js';
import { compareScansTool } from '../../../src/tools/compare-scans.js';
import { scanTerraformTool } from '../../../src/tools/scan-terraform.js';
import { scanSecurityTool } from '../../../src/tools/scan-security.js';
import { createPRTool } from '../../../src/tools/create-pr.js';
import { classifyResourcesTool } from '../../../src/tools/classify-resources.js';

import { collectAll } from '../../../src/aws/collector.js';
import { getCostsCached } from '../../../src/aws/cost-explorer.js';
import { getDb } from '../../../src/storage/db.js';
import {
  insertScan,
  getScan,
  listScans,
} from '../../../src/storage/queries/scans.js';
import { insertResources, listResources } from '../../../src/storage/queries/resources.js';
import { insertCosts, aggregateCostsByService } from '../../../src/storage/queries/costs.js';
import {
  upsertRecommendations,
  listRecommendations,
} from '../../../src/storage/queries/recommendations.js';
import { parseTerraformDir, filterAWSResources } from '../../../src/terraform/parser.js';
import { parseStateFile, findStateFile } from '../../../src/terraform/state.js';
import { evaluateSecurityRules } from '../../../src/rules/security/index.js';
import { createPR, buildPRBody } from '../../../src/github/pr.js';
import { GitHubClient } from '../../../src/github/client.js';
import {
  classifyResources,
  deduplicateRecommendations,
  generateConfigDiffRecommendations,
  generateScenarioRecommendations,
  generateTfSecurityRecommendations,
  summarize,
} from '../../../src/classifier/index.js';

// ─── Typed mock helpers ───────────────────────────────────────────────────────

const mockCollectAll = vi.mocked(collectAll);
const mockGetCostsCached = vi.mocked(getCostsCached);
const mockGetDb = vi.mocked(getDb);
const mockInsertScan = vi.mocked(insertScan);
const mockInsertResources = vi.mocked(insertResources);
const mockInsertCosts = vi.mocked(insertCosts);
const mockUpsertRecommendations = vi.mocked(upsertRecommendations);
const mockGetScan = vi.mocked(getScan);
const mockListScans = vi.mocked(listScans);
const mockListResources = vi.mocked(listResources);
const mockAggCosts = vi.mocked(aggregateCostsByService);
const mockListRecs = vi.mocked(listRecommendations);
const mockParseTerraformDir = vi.mocked(parseTerraformDir);
const mockFilterAWSResources = vi.mocked(filterAWSResources);
const mockParseStateFile = vi.mocked(parseStateFile);
const mockFindStateFile = vi.mocked(findStateFile);
const mockEvalSecurityRules = vi.mocked(evaluateSecurityRules);
const mockCreatePR = vi.mocked(createPR);
const mockBuildPRBody = vi.mocked(buildPRBody);
const mockClassifyResources = vi.mocked(classifyResources);
const mockDeduplicateRecs = vi.mocked(deduplicateRecommendations);
const mockGenConfigDiffRecs = vi.mocked(generateConfigDiffRecommendations);
const mockGenScenarioRecs = vi.mocked(generateScenarioRecommendations);
const mockGenTfSecurityRecs = vi.mocked(generateTfSecurityRecommendations);
const mockSummarize = vi.mocked(summarize);

// ─── Fake DB with transaction support ────────────────────────────────────────

function makeFakeDb() {
  return {
    transaction: (fn: () => void) => {
      fn();
    },
  } as ReturnType<typeof getDb>;
}

// ─── collect-aws ─────────────────────────────────────────────────────────────

describe('collectAwsTool — handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns resource list, forwards options, filters by typeFilter, and handles errors', async () => {
    // success + default options
    mockCollectAll.mockResolvedValue({
      resources: [{ id: 'i-0a1b2c3d4e5f67890', arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0a1b2c3d4e5f67890', type: 'ec2_instance', name: 'web-server-1', region: 'us-east-1', state: 'running', instance_type: 'm5.large', tags: { Environment: 'production' } }],
      costs: [], errors: [], durationMs: 1234,
    });
    const r1 = await collectAwsTool.handler({});
    expect(r1.isError).toBeUndefined();
    const d1 = JSON.parse(r1.content[0]!.text) as Record<string, unknown>;
    expect(d1['resourceCount']).toBe(1);
    expect(d1['durationMs']).toBe(1234);

    // forwards profile and regions
    mockCollectAll.mockResolvedValue({ resources: [], costs: [], errors: [], durationMs: 50 });
    await collectAwsTool.handler({ profile: 'prod-account', regions: ['us-east-1', 'eu-west-1'] });
    expect(mockCollectAll).toHaveBeenCalledWith(expect.objectContaining({ profile: 'prod-account', regions: ['us-east-1', 'eu-west-1'] }));

    // typeFilter filtering
    mockCollectAll.mockResolvedValue({
      resources: [
        { id: 'i-111', type: 'ec2_instance', arn: '', name: '', region: 'us-east-1', state: 'running', tags: {} },
        { id: 'db-222', type: 'rds_instance', arn: '', name: '', region: 'us-east-1', state: 'available', tags: {} },
      ],
      costs: [], errors: [], durationMs: 100,
    });
    const r3 = await collectAwsTool.handler({ typeFilter: ['ec2_instance'] });
    expect(JSON.parse(r3.content[0]!.text)['resourceCount']).toBe(1);

    // skipMetrics/skipCosts forwarded
    mockCollectAll.mockResolvedValue({ resources: [], costs: [], errors: [], durationMs: 10 });
    await collectAwsTool.handler({ skipMetrics: true, skipCosts: true });
    expect(mockCollectAll).toHaveBeenCalledWith(expect.objectContaining({ skipMetrics: true, skipCosts: true }));

    // error path
    mockCollectAll.mockRejectedValue(new Error('AWS credentials not configured'));
    const rErr = await collectAwsTool.handler({});
    expect(rErr.isError).toBe(true);
    expect(rErr.content[0]!.text).toContain('AWS credentials not configured');
  });
});

// ─── get-costs ────────────────────────────────────────────────────────────────

describe('getCostsTool — handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns cost entries, forwards options, and handles errors', async () => {
    mockGetCostsCached.mockResolvedValue({
      costs: [{ service: 'Amazon EC2', amount: 4523.76, unit: 'USD', startDate: '2024-01-01', endDate: '2024-01-31', granularity: 'MONTHLY' }],
      resourceCosts: new Map(),
      partial: false,
    });
    const r1 = await getCostsTool.handler({ startDate: '2024-01-01', endDate: '2024-01-31' });
    expect(r1.isError).toBeUndefined();
    const d1 = JSON.parse(r1.content[0]!.text) as Record<string, unknown>;
    expect(d1['count']).toBe(1);

    // forwards profile
    mockGetCostsCached.mockResolvedValue({
      costs: [],
      resourceCosts: new Map(),
      partial: false,
    });
    await getCostsTool.handler({ profile: 'staging' });
    expect(mockGetCostsCached).toHaveBeenCalledWith(expect.objectContaining({ profile: 'staging' }), expect.any(Object));

    // no profile key when not supplied (exactOptionalPropertyTypes: omit undefined keys)
    await getCostsTool.handler({});
    expect(mockGetCostsCached).toHaveBeenCalledWith({}, expect.any(Object));

    // empty result
    const rEmpty = await getCostsTool.handler({});
    const dEmpty = JSON.parse(rEmpty.content[0]!.text) as Record<string, unknown>;
    expect(dEmpty['count']).toBe(0);
    expect(dEmpty['costs']).toEqual([]);

    // error
    mockGetCostsCached.mockRejectedValue(new Error('AccessDeniedException'));
    const rErr = await getCostsTool.handler({});
    expect(rErr.isError).toBe(true);
    expect(rErr.content[0]!.text).toContain('AccessDeniedException');
  });
});

// ─── get-history ─────────────────────────────────────────────────────────────

describe('getHistoryTool — handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns scan list with defaults, clamps limit, passes offset, handles NaN, and errors', async () => {
    const fakeDb = makeFakeDb();
    mockGetDb.mockReturnValue(fakeDb);
    mockListScans.mockReturnValue([{
      id: 'scan-abc-001', started_at: '2024-01-15T10:00:00Z', completed_at: '2024-01-15T10:05:00Z',
      status: 'completed', aws_profile: 'default', aws_region: 'us-east-1', terraform_path: '/infra/terraform',
      total_resources: 42, total_cost: 9876.54, total_recommendations: 7, total_savings: 1234.56,
      scenario_a_count: 5, scenario_b_count: 30, scenario_c_count: 7,
    }]);

    const r1 = await getHistoryTool.handler({});
    expect(r1.isError).toBeUndefined();
    const d1 = JSON.parse(r1.content[0]!.text) as Record<string, unknown>;
    expect(d1['count']).toBe(1);
    expect(d1['limit']).toBe(20);
    expect(d1['offset']).toBe(0);
    expect((d1['scans'] as Array<Record<string, unknown>>)[0]!['id']).toBe('scan-abc-001');

    // clamps limit to 100
    mockListScans.mockReturnValue([]);
    const r2 = await getHistoryTool.handler({ limit: 500 });
    expect(JSON.parse(r2.content[0]!.text)['limit']).toBe(100);
    expect(mockListScans).toHaveBeenCalledWith(fakeDb, 100, 0);

    // passes offset
    await getHistoryTool.handler({ limit: 10, offset: 20 });
    expect(mockListScans).toHaveBeenCalledWith(fakeDb, 10, 20);

    // NaN limit → default 20
    const rNaN = await getHistoryTool.handler({ limit: NaN });
    expect(JSON.parse(rNaN.content[0]!.text)['limit']).toBe(20);

    // empty scans
    const rEmpty = await getHistoryTool.handler({});
    const dEmpty = JSON.parse(rEmpty.content[0]!.text) as Record<string, unknown>;
    expect(dEmpty['scans']).toEqual([]);

    // error path
    mockGetDb.mockImplementation(() => { throw new Error('database locked'); });
    const rErr = await getHistoryTool.handler({});
    expect(rErr.isError).toBe(true);
    expect(rErr.content[0]!.text).toContain('database locked');
  });
});

// ─── save-scan ────────────────────────────────────────────────────────────────

describe('saveScanTool — handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves a full scan, empty scan, skips inserts when empty, counts scenarios, and handles errors', async () => {
    const fakeDb = makeFakeDb();
    mockGetDb.mockReturnValue(fakeDb);

    // full scan
    const r1 = await saveScanTool.handler({
      aws_profile: 'prod', aws_region: 'us-east-1', terraform_path: '/infra/terraform',
      resources: [{ resource_id: 'i-0a1b2c3d4e5f67890', scan_id: '', type: 'ec2_instance', region: 'us-east-1', name: 'web-server', state: 'running', instance_type: 'm5.large', monthly_cost: 69.12, scenario: 'B' }],
      costs: [{ service: 'Amazon EC2', startDate: '2024-01-01', endDate: '2024-01-31', amount: 4523.76, unit: 'USD', granularity: 'MONTHLY' }],
      recommendations: [{ scan_id: '', resource_id: 'i-0a1b2c3d4e5f67890', type: 'rightsize', title: 'Downsize to m5.small', description: 'CPU util < 5%', estimated_savings: 34.56, impact: 'high', confidence: 0.9 }],
    });
    expect(r1.isError).toBeUndefined();
    const d1 = JSON.parse(r1.content[0]!.text) as Record<string, unknown>;
    expect(typeof d1['scan_id']).toBe('string');
    expect(d1['resources']).toBe(1);
    expect(d1['costs']).toBe(1);
    expect(d1['recommendations']).toBe(1);
    expect(d1['total_cost']).toBeCloseTo(4523.76);
    expect(d1['total_savings']).toBeCloseTo(34.56);

    // empty scan
    const rEmpty = await saveScanTool.handler({});
    const dEmpty = JSON.parse(rEmpty.content[0]!.text) as Record<string, unknown>;
    expect(dEmpty['resources']).toBe(0);
    expect(dEmpty['total_cost']).toBe(0);

    // no inserts called when empty
    vi.clearAllMocks();
    mockGetDb.mockReturnValue(fakeDb);
    await saveScanTool.handler({});
    expect(mockInsertResources).not.toHaveBeenCalled();
    expect(mockInsertCosts).not.toHaveBeenCalled();
    expect(mockUpsertRecommendations).not.toHaveBeenCalled();

    // scenario A/B/C counting
    await saveScanTool.handler({
      resources: [
        { resource_id: 'r1', scan_id: '', type: 'ec2_instance', region: 'us-east-1', name: 'r1', state: 'running', monthly_cost: 10, scenario: 'A' },
        { resource_id: 'r2', scan_id: '', type: 'ec2_instance', region: 'us-east-1', name: 'r2', state: 'running', monthly_cost: 20, scenario: 'B' },
        { resource_id: 'r3', scan_id: '', type: 'ec2_instance', region: 'us-east-1', name: 'r3', state: 'running', monthly_cost: 30, scenario: 'C' },
        { resource_id: 'r4', scan_id: '', type: 'ec2_instance', region: 'us-east-1', name: 'r4', state: 'running', monthly_cost: 40, scenario: 'B' },
      ],
    });
    expect(mockInsertScan).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ scenario_a_count: 1, scenario_b_count: 2, scenario_c_count: 1 }));

    // db error
    mockGetDb.mockReturnValue({ transaction: () => { throw new Error('SQLITE_BUSY: database is locked'); } } as unknown as ReturnType<typeof getDb>);
    const rErr = await saveScanTool.handler({});
    expect(rErr.isError).toBe(true);
    expect(rErr.content[0]!.text).toContain('SQLITE_BUSY');
  });
});

// ─── compare-scans ────────────────────────────────────────────────────────────

describe('compareScansTool — handler with mocked DB', () => {
  beforeEach(() => vi.clearAllMocks());

  const baseScan = {
    id: 'scan-001', started_at: '2024-01-01T00:00:00Z', completed_at: null, status: 'completed',
    aws_profile: null, aws_region: null, terraform_path: null,
    total_resources: 10, total_cost: 5000, total_savings: 200, total_recommendations: 3,
    scenario_a_count: 0, scenario_b_count: 10, scenario_c_count: 0,
  };

  it('returns diff when both scans exist with cost delta and resource diff', async () => {
    const fakeDb = makeFakeDb();
    mockGetDb.mockReturnValue(fakeDb);
    mockGetScan.mockImplementation((_db, id) => {
      const scans: Record<string, ReturnType<typeof getScan>> = {
        'scan-001': { ...baseScan },
        'scan-002': { ...baseScan, id: 'scan-002', started_at: '2024-02-01T00:00:00Z', total_resources: 11, total_cost: 5500, scenario_a_count: 1 },
      };
      return id ? scans[id] ?? null : null;
    });
    mockListResources.mockReturnValueOnce([{ resource_id: 'i-0aaa', scan_id: 'scan-001', type: 'ec2_instance', region: 'us-east-1', name: 'old-server', state: 'running', monthly_cost: 69, instance_type: 'm5.large' }])
      .mockReturnValueOnce([{ resource_id: 'i-0bbb', scan_id: 'scan-002', type: 'ec2_instance', region: 'us-east-1', name: 'new-server', state: 'running', monthly_cost: 35, instance_type: 'm5.small' }]);
    mockAggCosts.mockReturnValue([{ service_name: 'Amazon EC2', total_monthly_cost: 4000 }]);
    mockListRecs.mockReturnValue([]);

    const result = await compareScansTool.handler({ scan_id_1: 'scan-001', scan_id_2: 'scan-002' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect((data['scan_1'] as Record<string, unknown>)['id']).toBe('scan-001');
    const summary = data['summary'] as Record<string, unknown>;
    expect(summary['cost_delta']).toBe(500);
    const resources = data['resources'] as Record<string, unknown[]>;
    expect(resources['added'].length).toBe(1);
    expect(resources['removed'].length).toBe(1);
  });

  it('returns error when scan not found or getDb throws', async () => {
    const fakeDb = makeFakeDb();
    mockGetDb.mockReturnValue(fakeDb);

    // scan_id_1 not found
    mockGetScan.mockReturnValue(null);
    const r1 = await compareScansTool.handler({ scan_id_1: 'missing-scan', scan_id_2: 'scan-002' });
    expect(r1.isError).toBe(true);
    expect(r1.content[0]!.text).toContain('missing-scan');

    // scan_id_2 not found
    mockGetScan.mockReturnValueOnce({ ...baseScan }).mockReturnValueOnce(null);
    const r2 = await compareScansTool.handler({ scan_id_1: 'scan-001', scan_id_2: 'missing' });
    expect(r2.isError).toBe(true);
    expect(r2.content[0]!.text).toContain('missing');

    // getDb throws
    mockGetDb.mockImplementation(() => { throw new Error('db init failure'); });
    const r3 = await compareScansTool.handler({ scan_id_1: 'scan-001', scan_id_2: 'scan-002' });
    expect(r3.isError).toBe(true);
    expect(r3.content[0]!.text).toContain('db init failure');
  });
});

// ─── scan-terraform ───────────────────────────────────────────────────────────

describe('scanTerraformTool — handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses HCL, includes state when found, uses explicit stateFile, handles warnings and errors', async () => {
    // basic parse
    mockParseTerraformDir.mockResolvedValue([{
      address: 'aws_instance.web', type: 'aws_instance', name: 'web', provider: 'aws', module: '',
      filePath: 'main.tf', lineNumber: 10, configuration: { instance_type: 'c5.2xlarge' }, estimatedCost: 280.32, dependencies: [],
    }]);
    mockFindStateFile.mockResolvedValue(null);
    const r1 = await scanTerraformTool.handler({ dir: '/workspace/infra' });
    expect(r1.isError).toBeUndefined();
    const d1 = JSON.parse(r1.content[0]!.text) as Record<string, unknown>;
    expect((d1['resources'] as Array<Record<string, unknown>>)[0]!['address']).toBe('aws_instance.web');
    expect(d1['stateResources']).toBeUndefined();

    // includes stateResources when found
    mockParseTerraformDir.mockResolvedValue([]);
    mockFindStateFile.mockResolvedValue('/workspace/infra/terraform.tfstate');
    mockParseStateFile.mockResolvedValue([{ type: 'aws_instance', name: 'web', provider: 'aws', id: 'i-0a1b2c3d4e5f67890', arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0a1b2c3d4e5f67890', attributes: {} }]);
    const r2 = await scanTerraformTool.handler({ dir: '/workspace/infra' });
    expect((JSON.parse(r2.content[0]!.text) as Record<string, unknown[]>)['stateResources'].length).toBe(1);

    // explicit stateFile bypasses findStateFile
    vi.clearAllMocks();
    mockParseTerraformDir.mockResolvedValue([]);
    mockParseStateFile.mockResolvedValue([]);
    await scanTerraformTool.handler({ dir: '/workspace/infra', stateFile: '/custom/path/terraform.tfstate' });
    expect(mockParseStateFile).toHaveBeenCalledWith('/custom/path/terraform.tfstate');
    expect(mockFindStateFile).not.toHaveBeenCalled();

    // warning when state parse fails
    mockParseTerraformDir.mockResolvedValue([]);
    mockFindStateFile.mockResolvedValue('/infra/terraform.tfstate');
    mockParseStateFile.mockRejectedValue(new Error('invalid JSON in state file'));
    const r4 = await scanTerraformTool.handler({ dir: '/infra' });
    const d4 = JSON.parse(r4.content[0]!.text) as Record<string, unknown>;
    expect(typeof d4['warning']).toBe('string');

    // error when parseTerraformDir throws
    mockParseTerraformDir.mockRejectedValue(new Error('ENOENT: no such file or directory'));
    const rErr = await scanTerraformTool.handler({ dir: '/nonexistent' });
    expect(rErr.isError).toBe(true);
    expect(rErr.content[0]!.text).toContain('ENOENT');
  });
});

// ─── scan-security ────────────────────────────────────────────────────────────

describe('scanSecurityTool — handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns findings grouped by severity, handles clean config, missing dir, and errors', async () => {
    const s3Resource = { address: 'aws_s3_bucket.public', type: 'aws_s3_bucket', name: 'public', provider: 'aws', module: '', filePath: 'storage.tf', lineNumber: 1, configuration: { acl: 'public-read' }, estimatedCost: 0, dependencies: [] };
    mockParseTerraformDir.mockResolvedValue([s3Resource]);
    mockFilterAWSResources.mockReturnValue([s3Resource]);
    mockEvalSecurityRules.mockReturnValue([
      { ruleId: 'S3-001', severity: 'critical', message: 'public-read ACL', resource: 'aws_s3_bucket.public', filePath: 'storage.tf', lineNumber: 1 },
      { ruleId: 'S3-002', severity: 'high', message: 'logging not enabled', resource: 'aws_s3_bucket.public', filePath: 'storage.tf', lineNumber: 1 },
    ]);
    const r1 = await scanSecurityTool.handler({ dir: '/infra' });
    expect(r1.isError).toBeUndefined();
    const d1 = JSON.parse(r1.content[0]!.text) as Record<string, unknown>;
    expect(d1['total_findings']).toBe(2);
    const summary = d1['summary'] as Record<string, number>;
    expect(summary['critical']).toBe(1);
    expect(summary['high']).toBe(1);
    expect(summary['medium']).toBe(0);

    // clean config → zero findings
    mockParseTerraformDir.mockResolvedValue([]);
    mockFilterAWSResources.mockReturnValue([]);
    mockEvalSecurityRules.mockReturnValue([]);
    const rClean = await scanSecurityTool.handler({ dir: '/clean-infra' });
    const dClean = JSON.parse(rClean.content[0]!.text) as Record<string, unknown>;
    expect(dClean['total_findings']).toBe(0);

    // missing dir
    expect((await scanSecurityTool.handler({})).isError).toBe(true);
    expect((await scanSecurityTool.handler({ dir: '' })).isError).toBe(true);

    // error when parse throws
    mockParseTerraformDir.mockRejectedValue(new Error('parse error'));
    const rErr = await scanSecurityTool.handler({ dir: '/bad' });
    expect(rErr.isError).toBe(true);
    expect(rErr.content[0]!.text).toContain('parse error');
  });
});

// ─── create-pr ────────────────────────────────────────────────────────────────

describe('createPRTool — handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(GitHubClient).mockImplementation(function () {
      return {} as InstanceType<typeof GitHubClient>;
    });
  });

  it('creates PR, auto-generates body from recs, uses explicit body, passes draft flag, and handles errors', async () => {
    mockCreatePR.mockResolvedValue({ number: 42, html_url: 'https://github.com/acme/infra/pull/42', title: 'korinfra: Rightsize EC2 fleet', state: 'open', draft: false, created_at: '2024-01-15T12:00:00Z' });
    const r1 = await createPRTool.handler({ owner: 'acme', repo: 'infra', title: 'korinfra: Rightsize EC2 fleet', head: 'infra/rightsize-ec2', base: 'main' });
    expect(r1.isError).toBeUndefined();
    const d1 = JSON.parse(r1.content[0]!.text) as Record<string, unknown>;
    expect(d1['number']).toBe(42);
    expect(d1['url']).toBe('https://github.com/acme/infra/pull/42');

    // auto-generates body from recommendations
    mockBuildPRBody.mockReturnValue('## korinfra Cost Optimization\n...');
    mockCreatePR.mockResolvedValue({ number: 7, html_url: 'https://github.com/acme/infra/pull/7', title: 'Cost optimizations', state: 'open', draft: false, created_at: '2024-01-20T08:00:00Z' });
    const recs = [{ resource_id: 'i-0a1b2c3d4e5f67890', title: 'Rightsize', description: 'CPU < 5%', current_config: 'm5.large', recommended_config: 'm5.small', estimated_savings: 34.56, confidence: 0.92, risk: 'low' }];
    await createPRTool.handler({ owner: 'acme', repo: 'infra', title: 'Cost optimizations', head: 'infra/cost-opts', recommendations: recs });
    expect(mockBuildPRBody).toHaveBeenCalledWith(recs, 34.56);

    // explicit body skips buildPRBody
    vi.clearAllMocks();
    vi.mocked(GitHubClient).mockImplementation(function () { return {} as InstanceType<typeof GitHubClient>; });
    mockCreatePR.mockResolvedValue({ number: 3, html_url: 'https://github.com/acme/infra/pull/3', title: 'Manual', state: 'open', draft: true, created_at: '2024-01-22T09:00:00Z' });
    await createPRTool.handler({ owner: 'acme', repo: 'infra', title: 'Manual', head: 'fix/manual', body: 'Explicit PR body', recommendations: [{ resource_id: 'i-0aaa', title: 'u', description: 'u', current_config: 'm5.large', recommended_config: 'm5.small', estimated_savings: 100, confidence: 0.8 }] });
    expect(mockBuildPRBody).not.toHaveBeenCalled();
    expect(mockCreatePR).toHaveBeenCalledWith(expect.anything(), 'acme', 'infra', expect.objectContaining({ body: 'Explicit PR body' }));

    // draft flag forwarded
    mockCreatePR.mockResolvedValue({ number: 99, html_url: 'https://github.com/acme/infra/pull/99', title: 'Draft', state: 'open', draft: true, created_at: '2024-02-01T00:00:00Z' });
    await createPRTool.handler({ owner: 'acme', repo: 'infra', title: 'Draft', head: 'wip', draft: true });
    expect(mockCreatePR).toHaveBeenCalledWith(expect.anything(), 'acme', 'infra', expect.objectContaining({ draft: true }));

    // error path
    mockCreatePR.mockRejectedValue(new Error('401 Bad credentials'));
    const rErr = await createPRTool.handler({ owner: 'acme', repo: 'infra', title: 'Fail', head: 'bad' });
    expect(rErr.isError).toBe(true);
    expect(rErr.content[0]!.text).toContain('401 Bad credentials');
  });
});

// ─── classify-resources ───────────────────────────────────────────────────────

describe('classifyResourcesTool — handler', () => {
  beforeEach(() => vi.clearAllMocks());

  function setupClassifier(overrides: Partial<{
    matchedPairs: ReturnType<typeof classifyResources>['matched'];
    terraformOnly: ReturnType<typeof classifyResources>['terraformOnly'];
    awsOnly: ReturnType<typeof classifyResources>['awsOnly'];
  }> = {}) {
    const classification = {
      matched: overrides.matchedPairs ?? [],
      terraformOnly: overrides.terraformOnly ?? [],
      awsOnly: overrides.awsOnly ?? [],
    };
    mockClassifyResources.mockReturnValue(classification);
    mockGenScenarioRecs.mockReturnValue([]);
    mockGenTfSecurityRecs.mockReturnValue([]);
    mockGenConfigDiffRecs.mockReturnValue([]);
    mockDeduplicateRecs.mockReturnValue([]);
    mockSummarize.mockReturnValue({ totalResources: 0, scenarioACount: 0, scenarioBCount: 0, scenarioCCount: 0, configDiffCount: 0, highConfidence: 0, lowConfidence: 0 });
  }

  it('runs full pipeline, uses default/custom fuzzyMatchThreshold, handles stateResources and errors', async () => {
    // full classification
    setupClassifier({
      matchedPairs: [{
        terraform: { address: 'aws_instance.web', type: 'aws_instance', name: 'web', provider: 'aws', module: '', filePath: 'main.tf', lineNumber: 10, configuration: { instance_type: 'm5.large' }, estimatedCost: 69.12, dependencies: [] },
        aws: { id: 'i-0a1b2c3d4e5f67890', arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0a1b2c3d4e5f67890', type: 'aws_instance', name: 'web', region: 'us-east-1', state: 'running', tags: {} },
        confidence: 0.95, matchType: 'arn', drift: [],
      }],
    });
    const r1 = await classifyResourcesTool.handler({
      awsResources: [{ id: 'i-0a1b2c3d4e5f67890', arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0a1b2c3d4e5f67890', type: 'aws_instance', name: 'web', region: 'us-east-1', state: 'running', tags: {} }],
      terraformResources: [{ address: 'aws_instance.web', type: 'aws_instance', name: 'web', filePath: 'main.tf' }],
    });
    expect(r1.isError).toBeUndefined();
    const d1 = JSON.parse(r1.content[0]!.text) as Record<string, unknown>;
    expect((d1['classification'] as Record<string, unknown[]>)['matched'].length).toBe(1);
    expect(d1['recommendations']).toEqual([]);

    // default fuzzyMatchThreshold = 0.7
    setupClassifier();
    await classifyResourcesTool.handler({ awsResources: [], terraformResources: [] });
    expect(mockClassifyResources).toHaveBeenCalledWith([], [], [], expect.objectContaining({ fuzzyMatchThreshold: 0.7 }));

    // custom threshold
    await classifyResourcesTool.handler({ awsResources: [], terraformResources: [], fuzzyMatchThreshold: 0.9 });
    expect(mockClassifyResources).toHaveBeenCalledWith([], [], [], expect.objectContaining({ fuzzyMatchThreshold: 0.9 }));

    // stateResources forwarded
    await classifyResourcesTool.handler({
      awsResources: [], terraformResources: [],
      stateResources: [{ type: 'aws_instance', name: 'web', provider: 'aws', id: 'i-0a1b2c3d4e5f67890', arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0a1b2c3d4e5f67890', attributes: {} }],
    });
    expect(mockClassifyResources).toHaveBeenCalledWith([], [], expect.arrayContaining([expect.objectContaining({ id: 'i-0a1b2c3d4e5f67890' })]), expect.any(Object));

    // error path
    mockClassifyResources.mockImplementation(() => { throw new Error('classifier internal error'); });
    const rErr = await classifyResourcesTool.handler({ awsResources: [], terraformResources: [] });
    expect(rErr.isError).toBe(true);
    expect(rErr.content[0]!.text).toContain('classifier internal error');
  });

  it('populates terraformOnly and awsOnly in output', async () => {
    setupClassifier({
      terraformOnly: [{ address: 'aws_rds_instance.primary', type: 'aws_db_instance', name: 'primary', provider: 'aws', module: '', filePath: 'rds.tf', lineNumber: 5, configuration: { instance_class: 'db.r6g.xlarge' }, estimatedCost: 450.00, dependencies: [] }],
      awsOnly: [{ id: 'nat-0a1b2c3d4e5f67890', arn: 'arn:aws:ec2:us-east-1:123456789012:natgateway/nat-0a1b2c3d4e5f67890', type: 'natgateway', name: 'main-nat', region: 'us-east-1', state: 'available', tags: { Name: 'main-nat' } }],
    });
    const result = await classifyResourcesTool.handler({ awsResources: [], terraformResources: [] });
    const data = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    const classification = data['classification'] as Record<string, unknown[]>;
    expect(classification['terraformOnly'].length).toBe(1);
    expect(classification['awsOnly'].length).toBe(1);
    expect((classification['terraformOnly'][0] as Record<string, unknown>)['address']).toBe('aws_rds_instance.primary');
  });
});
