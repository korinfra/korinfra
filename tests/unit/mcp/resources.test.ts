/**
 * Tests for src/mcp/resources.ts — registerResources handler logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../../src/config/index.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    aws: { default_region: 'us-east-1' },
    ai: { provider: 'claude' },
    github: { token: 'ghp_secret_value' },
  }),
}));

vi.mock('../../../src/storage/index.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

const mockScan = {
  id: 'scan-abc123',
  started_at: '2026-03-01T10:00:00.000Z',
  completed_at: '2026-03-01T10:05:00.000Z',
  status: 'completed',
  total_resources: 142,
  total_cost: 4820.50,
  total_recommendations: 17,
  total_savings: 980.00,
  scenario_a_count: 3,
  scenario_b_count: 12,
  scenario_c_count: 2,
  aws_profile: 'prod',
  aws_region: 'us-east-1',
};

const mockListScans = vi.fn().mockReturnValue([mockScan]);
vi.mock('../../../src/storage/queries/scans.js', () => ({
  listScans: (...args: unknown[]) => mockListScans(...args),
}));

vi.mock('../../../src/redaction/redactor.js', () => ({
  redactObject: vi.fn().mockImplementation((obj: unknown) => obj),
  redact: vi.fn().mockImplementation((s: unknown) => String(s)),
}));

import { registerResources } from '../../../src/mcp/resources.js';

type Handler = (request: { params: Record<string, unknown> }) => Promise<unknown>;

function buildServer() {
  const handlerMap = new Map<object, Handler>();
  const server = {
    setRequestHandler(schema: object, handler: Handler) {
      handlerMap.set(schema, handler);
    },
    async list() {
      const handler = handlerMap.get(ListResourcesRequestSchema)!;
      return handler({ params: {} }) as Promise<{
        resources: Array<{ uri: string; name: string; description: string; mimeType: string }>;
      }>;
    },
    async read(uri: string) {
      const handler = handlerMap.get(ReadResourceRequestSchema)!;
      return handler({ params: { uri } }) as Promise<{
        contents: Array<{ uri: string; mimeType: string; text: string }>;
      }>;
    },
  };
  registerResources(server as never);
  return server;
}

describe('registerResources — list', () => {
  beforeEach(() => { vi.clearAllMocks(); mockListScans.mockReturnValue([mockScan]); });

  it('registers exactly 3 resources with application/json mimeType and non-empty names/descriptions', async () => {
    const server = buildServer();
    const result = await server.list();
    expect(result.resources).toHaveLength(3);
    expect(result.resources.some(r => r.uri === 'iw://config')).toBe(true);
    expect(result.resources.some(r => r.uri === 'iw://last-scan')).toBe(true);
    expect(result.resources.some(r => r.uri === 'iw://cost-summary')).toBe(true);
    for (const r of result.resources) {
      expect(r.mimeType).toBe('application/json');
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
    }
  });
});

describe('registerResources — read resources', () => {
  beforeEach(() => { vi.clearAllMocks(); mockListScans.mockReturnValue([mockScan]); });

  it('reads iw://config with valid JSON containing aws key', async () => {
    const server = buildServer();
    const result = await server.read('iw://config');
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]!.uri).toBe('iw://config');
    expect(result.contents[0]!.mimeType).toBe('application/json');
    expect(() => JSON.parse(result.contents[0]!.text)).not.toThrow();
    const parsed = JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
    expect(parsed).toHaveProperty('aws');
  });

  it('reads iw://last-scan and returns scan data or "No scans found"', async () => {
    const server = buildServer();
    const result = await server.read('iw://last-scan');
    const parsed = JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
    expect(parsed['id']).toBe('scan-abc123');
    expect(mockListScans).toHaveBeenCalledWith(expect.anything(), 1, 0);

    mockListScans.mockReturnValueOnce([]);
    const emptyResult = await server.read('iw://last-scan');
    const emptyParsed = JSON.parse(emptyResult.contents[0]!.text) as { message: string };
    expect(emptyParsed.message).toMatch(/No scans found/);
  });

  it('reads iw://cost-summary with correct fields and scenario breakdown', async () => {
    const server = buildServer();
    const result = await server.read('iw://cost-summary');
    const parsed = JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
    expect(parsed['scanId']).toBe('scan-abc123');
    expect(parsed['totalCostUsd']).toBe(4820.50);
    expect(parsed['estimatedSavingsUsd']).toBe(980.00);
    expect(parsed['totalResources']).toBe(142);
    const breakdown = parsed['scenarioBreakdown'] as Record<string, number>;
    expect(breakdown['scenarioA']).toBe(3);
    expect(breakdown['scenarioB']).toBe(12);
    expect(breakdown['scenarioC']).toBe(2);

    mockListScans.mockReturnValueOnce([]);
    const emptyResult = await server.read('iw://cost-summary');
    expect((JSON.parse(emptyResult.contents[0]!.text) as { message: string }).message).toMatch(/No scans found/);
  });

  it('returns error for unknown URI and propagates thrown errors', async () => {
    const server = buildServer();
    const unknownResult = await server.read('iw://does-not-exist');
    const parsed = JSON.parse(unknownResult.contents[0]!.text) as { error: string };
    expect(parsed.error).toContain('Unknown resource');
    expect(parsed.error).toContain('iw://does-not-exist');
    expect(unknownResult.contents[0]!.uri).toBe('iw://does-not-exist');

    const { loadConfig } = await import('../../../src/config/index.js');
    vi.mocked(loadConfig).mockRejectedValueOnce(new Error('config file missing'));
    const errResult = await server.read('iw://config');
    expect((JSON.parse(errResult.contents[0]!.text) as { error: string }).error).toContain('config file missing');

    const { getDb } = await import('../../../src/storage/index.js');
    vi.mocked(getDb).mockImplementationOnce(() => { throw new Error('db not initialised'); });
    const dbErrResult = await server.read('iw://last-scan');
    expect((JSON.parse(dbErrResult.contents[0]!.text) as { error: string }).error).toContain('db not initialised');
  });
});
