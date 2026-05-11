import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', async () => {
  const actual = await vi.importActual('node:util');
  return {
    ...actual,
    promisify: (fn: unknown) => fn,
  };
});

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(() => Promise.resolve(['main.tf'])),
}));

vi.mock('node:path', async () => {
  const actual = await vi.importActual('node:path');
  return {
    ...actual,
    resolve: (p: string) => (p.startsWith('/') ? p : `/tmp/tf/${p}`),
  };
});

vi.mock('../../../src/tools/types.js', async () => {
  const actual = await vi.importActual('../../../src/tools/types.js');
  return {
    ...actual,
    assertInsideRoot: vi.fn(),
  };
});

import { terraformValidateTool } from '../../../src/tools/terraform-validate.js';

const mockExecFile = vi.mocked(execFile);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('terraform_validate tool — metadata', () => {
  it('has correct name', () => {
    expect(terraformValidateTool.name).toBe('terraform_validate');
  });

  it('is read-only', () => {
    expect(terraformValidateTool.annotations?.readOnlyHint).toBe(true);
  });

  it('has no args in inputSchema', () => {
    expect(terraformValidateTool.inputSchema?.['properties']).not.toHaveProperty('args');
    expect(terraformValidateTool.inputSchema?.['required']).toEqual(['dir']);
  });
});

describe('terraform_validate tool — valid output', () => {
  it('parses single JSON object from stdout', async () => {
    const validateResult = { valid: true, error_count: 0, warning_count: 0, diagnostics: [] };
    mockExecFile.mockResolvedValue({ stdout: JSON.stringify(validateResult), stderr: '' } as never);

    const result = await terraformValidateTool.handler({ dir: '/tmp/tf' });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed['valid']).toBe(true);
    expect(parsed['error_count']).toBe(0);
    expect(parsed['diagnostics']).toEqual([]);
  });

  it('parses invalid HCL output (exit 1, stdout has JSON)', async () => {
    const validateResult = {
      valid: false,
      error_count: 1,
      warning_count: 0,
      diagnostics: [{ severity: 'error', summary: 'Unsupported argument', detail: 'foo' }],
    };
    const execErr = Object.assign(new Error('Command failed'), {
      stdout: JSON.stringify(validateResult),
      stderr: '',
      code: 1,
    });
    mockExecFile.mockRejectedValue(execErr as never);

    const result = await terraformValidateTool.handler({ dir: '/tmp/tf' });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed['valid']).toBe(false);
    expect(parsed['error_count']).toBe(1);
  });

  it('returns errorResult when execFile rejects with no stdout', async () => {
    mockExecFile.mockRejectedValue(new Error('terraform not found') as never);

    const result = await terraformValidateTool.handler({ dir: '/tmp/tf' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('terraform not found');
  });
});

describe('terraform_validate tool — stderr handling', () => {
  it('includes stderr in result when non-empty', async () => {
    const validateResult = { valid: true, error_count: 0, warning_count: 0, diagnostics: [] };
    mockExecFile.mockResolvedValue({ stdout: JSON.stringify(validateResult), stderr: 'some warning' } as never);

    const result = await terraformValidateTool.handler({ dir: '/tmp/tf' });

    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed['stderr']).toBe('some warning');
  });

  it('excludes stderr from result when empty', async () => {
    const validateResult = { valid: true, error_count: 0, warning_count: 0, diagnostics: [] };
    mockExecFile.mockResolvedValue({ stdout: JSON.stringify(validateResult), stderr: '' } as never);

    const result = await terraformValidateTool.handler({ dir: '/tmp/tf' });

    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('stderr');
  });
});

describe('terraform_validate tool — non-JSON output', () => {
  it('returns errorResult when stdout is not valid JSON', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'not json at all', stderr: '' } as never);

    const result = await terraformValidateTool.handler({ dir: '/tmp/tf' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('non-JSON output');
  });
});
