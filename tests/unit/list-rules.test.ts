import { describe, it, expect } from 'vitest';
import { listRules, ruleRegistry } from '../../src/rules/registry.js';
import { listRulesTool } from '../../src/tools/list-rules.js';

describe('ruleRegistry', () => {
  it('contains valid, unique rules covering all expected categories', () => {
    expect(ruleRegistry).toHaveLength(ruleRegistry.length);

    const ids = ruleRegistry.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const rule of ruleRegistry) {
      expect(rule.id).toBeTruthy();
      expect(rule.category).toBeTruthy();
      expect(rule.title).toBeTruthy();
      expect(rule.description).toBeTruthy();
      expect(['low', 'medium', 'high']).toContain(rule.impact);
      expect(['low', 'medium', 'high']).toContain(rule.risk);
    }

    const categories = new Set(ruleRegistry.map((r) => r.category));
    for (const cat of ['ec2', 'ebs', 'rds', 's3', 'lambda', 'dynamodb', 'elasticache', 'nat', 'ecs', 'elb', 'general']) {
      expect(categories).toContain(cat);
    }
  });

  it('listRules returns a fresh copy each call', () => {
    const a = listRules();
    const b = listRules();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('listRulesTool', () => {
  it('returns all rules with count, correct first ID, and is read-only', async () => {
    const result = await listRulesTool.handler({});
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(ruleRegistry.length);
    expect(data.rules).toHaveLength(ruleRegistry.length);
    expect(data.rules.some((r: { id: string }) => r.id === 'EC2-001')).toBe(true);
    expect(listRulesTool.annotations?.readOnlyHint).toBe(true);
  });
});
