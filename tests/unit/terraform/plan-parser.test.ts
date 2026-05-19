import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parsePlanFromString,
  parsePlanFile,
  extractDefaultRegion,
} from '../../../src/terraform/plan-parser.js';

const MINIMAL_PLAN = {
  format_version: '1.2',
  terraform_version: '1.6.0',
  resource_changes: [
    {
      address: 'aws_instance.web',
      type: 'aws_instance',
      change: {
        actions: ['create'],
        before: null,
        after: { instance_type: 't3.micro' },
      },
    },
  ],
  configuration: {
    provider_config: {
      aws: { expressions: { region: { constant_value: 'us-east-1' } } },
    },
  },
};

describe('parsePlanFromString', () => {
  it('parses a minimal plan with a create action', () => {
    const plan = parsePlanFromString(JSON.stringify(MINIMAL_PLAN));
    expect(plan.resource_changes).toHaveLength(1);
    expect(plan.resource_changes[0]?.address).toBe('aws_instance.web');
    expect(plan.resource_changes[0]?.change.actions).toEqual(['create']);
  });

  it('throws on invalid JSON', () => {
    expect(() => parsePlanFromString('not json {')).toThrow(/Invalid JSON/);
  });

  it('throws on schema mismatch', () => {
    expect(() => parsePlanFromString(JSON.stringify({ resource_changes: 'not an array' }))).toThrow(
      /does not match expected schema/,
    );
  });

  it('accepts missing resource_changes (defaults to [])', () => {
    const plan = parsePlanFromString(JSON.stringify({ format_version: '1.2' }));
    expect(plan.resource_changes).toEqual([]);
  });

  it('defaults actions to ["no-op"] when missing', () => {
    const plan = parsePlanFromString(
      JSON.stringify({
        resource_changes: [
          {
            address: 'aws_instance.foo',
            type: 'aws_instance',
            change: { before: null, after: null },
          },
        ],
      }),
    );
    expect(plan.resource_changes[0]?.change.actions).toEqual(['no-op']);
  });

  it('keeps after_unknown when present', () => {
    const plan = parsePlanFromString(
      JSON.stringify({
        resource_changes: [
          {
            address: 'aws_instance.foo',
            type: 'aws_instance',
            change: {
              actions: ['create'],
              before: null,
              after: { instance_type: null },
              after_unknown: { instance_type: true },
            },
          },
        ],
      }),
    );
    expect(plan.resource_changes[0]?.change.after_unknown).toEqual({ instance_type: true });
  });
});

describe('extractDefaultRegion', () => {
  it('extracts region from configuration.provider_config.aws.expressions.region.constant_value', () => {
    const plan = parsePlanFromString(JSON.stringify(MINIMAL_PLAN));
    expect(extractDefaultRegion(plan)).toBe('us-east-1');
  });

  it('returns null when configuration is missing', () => {
    const plan = parsePlanFromString(JSON.stringify({ resource_changes: [] }));
    expect(extractDefaultRegion(plan)).toBeNull();
  });

  it('returns null when the region expression is missing', () => {
    const plan = parsePlanFromString(
      JSON.stringify({
        resource_changes: [],
        configuration: { provider_config: { aws: { expressions: {} } } },
      }),
    );
    expect(extractDefaultRegion(plan)).toBeNull();
  });

  it('returns null when constant_value is not a string', () => {
    const plan = parsePlanFromString(
      JSON.stringify({
        resource_changes: [],
        configuration: {
          provider_config: { aws: { expressions: { region: { constant_value: 42 } } } },
        },
      }),
    );
    expect(extractDefaultRegion(plan)).toBeNull();
  });
});

describe('parsePlanFile', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'korinfra-plan-parser-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reads and parses a plan file', async () => {
    const filePath = join(tmpDir, 'plan.json');
    await writeFile(filePath, JSON.stringify(MINIMAL_PLAN), 'utf8');
    const plan = await parsePlanFile(filePath);
    expect(plan.resource_changes).toHaveLength(1);
  });

  it('throws a clear error when the file does not exist', async () => {
    await expect(parsePlanFile(join(tmpDir, 'missing.json'))).rejects.toThrow(/Failed to read/);
  });

  it('throws on malformed JSON', async () => {
    const filePath = join(tmpDir, 'bad.json');
    await writeFile(filePath, '{ not valid', 'utf8');
    await expect(parsePlanFile(filePath)).rejects.toThrow(/Invalid JSON/);
  });
});
