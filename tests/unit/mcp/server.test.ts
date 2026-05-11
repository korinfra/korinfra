/**
 * Tests for src/mcp/server.ts — buildServer factory, registration, and transport.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
