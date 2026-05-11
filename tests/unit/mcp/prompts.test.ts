/**
 * Tests for src/mcp/prompts.ts — prompt registration, content, and interpolation.
 */

import { describe, it, expect } from 'vitest';
import { registerPrompts } from '../../../src/mcp/prompts.js';
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

type Handler = (request: { params: Record<string, unknown> }) => Promise<unknown>;

function buildServer() {
  const handlerMap = new Map<object, Handler>();
  const server = {
    setRequestHandler(schema: object, handler: Handler) {
      handlerMap.set(schema, handler);
    },
    async list() {
      const handler = handlerMap.get(ListPromptsRequestSchema)!;
      return handler({ params: {} }) as Promise<{ prompts: Array<{ name: string; description: string; arguments?: unknown[] }> }>;
    },
    async get(name: string, args: Record<string, string> = {}) {
      const handler = handlerMap.get(GetPromptRequestSchema)!;
      return handler({ params: { name, arguments: args } }) as Promise<{
        description: string;
        messages: Array<{ role: string; content: { type: string; text: string } }>;
      }>;
    },
  };
  registerPrompts(server as never);
  return server;
}

describe('registerPrompts — list', () => {
  it('registers exactly 3 prompts with correct names and argument schemas', async () => {
    const server = buildServer();
    const result = await server.list();
    expect(result.prompts).toHaveLength(3);

    const names = result.prompts.map(p => p.name);
    expect(names).toContain('analyze-costs');
    expect(names).toContain('find-waste');
    expect(names).toContain('check-scenarios');

    const analyzeCosts = result.prompts.find(p => p.name === 'analyze-costs')!;
    expect((analyzeCosts.arguments as Array<{ name: string }>).map(a => a.name)).toContain('period');

    const findWaste = result.prompts.find(p => p.name === 'find-waste')!;
    expect((findWaste.arguments as Array<{ name: string }>).map(a => a.name)).toContain('resourceType');

    const checkScenarios = result.prompts.find(p => p.name === 'check-scenarios')!;
    expect((checkScenarios.arguments as Array<{ name: string }>).map(a => a.name)).toContain('terraformPath');
  });
});

describe('registerPrompts — check-scenarios scenario descriptions and tool names', () => {
  it('has correct A/B/C scenario descriptions in the right order', async () => {
    const server = buildServer();
    const result = await server.get('check-scenarios', { terraformPath: '/infra' });
    const text = result.messages[0]!.content.text;

    expect(text).toContain('Scenario A: Resource exists in Terraform but NOT in AWS');
    expect(text).toContain('Scenario B: Resource exists in both Terraform and AWS');
    expect(text).toContain('Scenario C: Resource exists in AWS but NOT in Terraform');

    // Scenario A must be TF-only, not AWS-only; Scenario C must be AWS-only, not TF-only
    const scenarioALine = text.split('\n').find(l => l.includes('Scenario A'))!;
    expect(scenarioALine).not.toContain('exists in AWS but NOT in Terraform');
    const scenarioCLine = text.split('\n').find(l => l.includes('Scenario C'))!;
    expect(scenarioCLine).not.toContain('exists in Terraform but NOT in AWS');
  });

  it('references correct tool names in each prompt', async () => {
    const server = buildServer();

    const scenarios = await server.get('check-scenarios');
    expect(scenarios.messages[0]!.content.text).toContain('scan_terraform');
    expect(scenarios.messages[0]!.content.text).toContain('classify_resources');

    const findWaste = await server.get('find-waste');
    expect(findWaste.messages[0]!.content.text).toContain('collect_aws_resources');
    expect(findWaste.messages[0]!.content.text).toContain('evaluate_rules');
    expect(findWaste.messages[0]!.content.text).toContain('detect_cost_anomalies');

    const analyzeCosts = await server.get('analyze-costs');
    expect(analyzeCosts.messages[0]!.content.text).toContain('get_costs');
    expect(analyzeCosts.messages[0]!.content.text).toContain('list_rules');
  });
});

describe('registerPrompts — argument interpolation', () => {
  it('interpolates arguments into messages, uses defaults when omitted, sanitizes newlines, throws for unknown prompt', async () => {
    const server = buildServer();

    expect((await server.get('check-scenarios', { terraformPath: '/home/user/infra' })).messages[0]!.content.text).toContain('/home/user/infra');
    expect((await server.get('analyze-costs', { period: 'last 7 days' })).messages[0]!.content.text).toContain('last 7 days');
    expect((await server.get('find-waste', { resourceType: 'rds' })).messages[0]!.content.text).toContain('rds');

    // Default when omitted
    expect((await server.get('check-scenarios')).messages[0]!.content.text).toContain('the default Terraform path');

    // Sanitizes newlines
    const newlineResult = await server.get('check-scenarios', { terraformPath: 'path\nwith\nnewlines' });
    expect(newlineResult.messages[0]!.content.text).not.toContain('\n\n\n');

    // Throws for unknown prompt
    await expect(server.get('unknown-prompt')).rejects.toThrow('Unknown prompt: unknown-prompt');
  });
});
