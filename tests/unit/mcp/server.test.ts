/**
 * Tests for src/mcp/server.ts — buildServer factory, registration, and transport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn().mockImplementation(function () {
    return { close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation(function () {
    return { close: vi.fn().mockResolvedValue(undefined), handleRequest: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  const mockServer = {
    connect: vi.fn().mockResolvedValue(undefined),
    setRequestHandler: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { Server: vi.fn().mockImplementation(function () { return mockServer; }) };
});

vi.mock('../../../src/mcp/tools.js', () => ({ registerTools: vi.fn() }));
vi.mock('../../../src/mcp/resources.js', () => ({ registerResources: vi.fn() }));
vi.mock('../../../src/mcp/prompts.js', () => ({ registerPrompts: vi.fn() }));
vi.mock('../../../src/utils/version.js', () => ({
  getVersionInfo: vi.fn().mockReturnValue({ name: 'korinfra', version: '0.1.0', description: 'AWS FinOps agent' }),
}));

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from '../../../src/mcp/tools.js';
import { registerResources } from '../../../src/mcp/resources.js';
import { registerPrompts } from '../../../src/mcp/prompts.js';

describe('buildServer — registration and transport', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates Server with correct name/version/capabilities, registers all handlers, and uses StdioTransport', async () => {
    const { startMcpServer } = await import('../../../src/mcp/server.js');
    await startMcpServer({ transport: 'stdio' });

    expect(Server).toHaveBeenCalledWith(
      { name: 'korinfra', version: '0.1.0' },
      expect.objectContaining({
        capabilities: expect.objectContaining({ tools: {}, resources: {}, prompts: {} }),
        instructions: 'AWS FinOps agent',
      }),
    );

    expect(registerTools).toHaveBeenCalled();
    expect(registerResources).toHaveBeenCalled();
    expect(registerPrompts).toHaveBeenCalled();

    const serverInstance = vi.mocked(Server).mock.results[0]?.value;
    expect(registerTools).toHaveBeenCalledWith(serverInstance);
    expect(registerResources).toHaveBeenCalledWith(serverInstance);
    expect(registerPrompts).toHaveBeenCalledWith(serverInstance);

    expect(StdioServerTransport).toHaveBeenCalled();
    const transportInstance = vi.mocked(StdioServerTransport).mock.results[0]?.value;
    expect(serverInstance.connect).toHaveBeenCalledWith(transportInstance);
  });
});

describe('getMaxBodySize — KORINFRA_MCP_MAX_BODY_SIZE env var', () => {
  const DEFAULT = 10 * 1024 * 1024;
  const originalEnv = process.env['KORINFRA_MCP_MAX_BODY_SIZE'];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['KORINFRA_MCP_MAX_BODY_SIZE'];
    } else {
      process.env['KORINFRA_MCP_MAX_BODY_SIZE'] = originalEnv;
    }
    stderrSpy.mockRestore();
  });

  it('returns default + source=default when env unset and no config given', async () => {
    delete process.env['KORINFRA_MCP_MAX_BODY_SIZE'];
    const { getMaxBodySize } = await import('../../../src/mcp/server.js');
    expect(getMaxBodySize()).toEqual({ value: DEFAULT, source: 'default' });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('returns config value + source=config when env unset', async () => {
    delete process.env['KORINFRA_MCP_MAX_BODY_SIZE'];
    const { getMaxBodySize } = await import('../../../src/mcp/server.js');
    expect(getMaxBodySize(5_000_000)).toEqual({ value: 5_000_000, source: 'config' });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('env var overrides config (source=env)', async () => {
    process.env['KORINFRA_MCP_MAX_BODY_SIZE'] = '2048';
    const { getMaxBodySize } = await import('../../../src/mcp/server.js');
    expect(getMaxBodySize(5_000_000)).toEqual({ value: 2048, source: 'env' });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('invalid env reports source=config when config given (not env)', async () => {
    process.env['KORINFRA_MCP_MAX_BODY_SIZE'] = 'garbage';
    const { getMaxBodySize } = await import('../../../src/mcp/server.js');
    expect(getMaxBodySize(5_000_000)).toEqual({ value: 5_000_000, source: 'config' });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('WARNING'));
  });

  it('invalid env without config reports source=default', async () => {
    process.env['KORINFRA_MCP_MAX_BODY_SIZE'] = 'garbage';
    const { getMaxBodySize } = await import('../../../src/mcp/server.js');
    expect(getMaxBodySize()).toEqual({ value: DEFAULT, source: 'default' });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('WARNING'));
  });

  it('returns default when env is empty string', async () => {
    process.env['KORINFRA_MCP_MAX_BODY_SIZE'] = '';
    const { getMaxBodySize } = await import('../../../src/mcp/server.js');
    expect(getMaxBodySize()).toEqual({ value: DEFAULT, source: 'default' });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('parses a valid positive integer', async () => {
    process.env['KORINFRA_MCP_MAX_BODY_SIZE'] = '5242880';
    const { getMaxBodySize } = await import('../../../src/mcp/server.js');
    expect(getMaxBodySize()).toEqual({ value: 5_242_880, source: 'env' });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['non-integer', '1.5'],
    ['zero', '0'],
    ['negative', '-100'],
    ['garbage', 'not-a-number'],
    ['trailing units', '10MB'],
  ])('warns and falls back for %s value', async (_label, value) => {
    process.env['KORINFRA_MCP_MAX_BODY_SIZE'] = value;
    const { getMaxBodySize } = await import('../../../src/mcp/server.js');
    expect(getMaxBodySize()).toEqual({ value: DEFAULT, source: 'default' });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('WARNING'));
  });
});
