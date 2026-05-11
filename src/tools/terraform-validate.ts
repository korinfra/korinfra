/**
 * MCP tool: terraform_validate
 * Runs `terraform validate -json` via child_process.execFile and returns the parsed JSON output.
 * Does NOT require AWS credentials, backend access, or deployed AWS state.
 */

import { execFile } from 'node:child_process';
import type { ExecException } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import { jsonResult, errorResult, assertInsideRoot } from './types.js';
import type { ToolDefinition } from './types.js';
import { redact, redactObject } from '../redaction/redactor.js';

const execFileAsync = promisify(execFile);

export const terraformValidateTool: ToolDefinition = {
  name: 'terraform_validate',
  description:
    'Run `terraform validate -json` in the specified directory. Validates HCL syntax and provider schema. Does NOT require AWS credentials, backend access, or deployed AWS state. Returns { valid, error_count, warning_count, diagnostics[] }.',
  inputSchema: {
    type: 'object',
    properties: {
      dir: {
        type: 'string',
        description: 'Path to a Terraform directory (root module or reusable module). Must contain at least one .tf file.',
      },
    },
    required: ['dir'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    try {
      if (typeof args['dir'] !== 'string' || !args['dir']) return errorResult('dir must be a non-empty string');
      const dir = args['dir'];

      // Validate dir: must exist and contain at least one .tf file
      const resolvedDir = resolve(dir);
      try { assertInsideRoot(resolvedDir, 'dir'); }
      catch (e) { return errorResult(e instanceof Error ? e.message : String(e)); }
      if (!existsSync(resolvedDir)) {
        return errorResult(`dir does not exist: ${resolvedDir}`);
      }
      // Dereference symlinks and re-validate containment to prevent symlink path traversal
      try {
        const realDir = realpathSync(resolvedDir);
        try { assertInsideRoot(realDir, 'dir'); }
        catch (e) { return errorResult(e instanceof Error ? e.message : String(e)); }
      } catch (e) {
        if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
          return errorResult(`dir contains dangling symlink: ${resolvedDir}`);
        }
        // Any other realpathSync failure (EACCES, ELOOP, etc.) — reject; containment unverifiable
        return errorResult(`dir symlink resolution failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const dirEntries = await readdir(resolvedDir);
      if (!dirEntries.some((e) => e.endsWith('.tf') || e.endsWith('.tf.json'))) {
        return errorResult(`dir contains no .tf files: ${resolvedDir}`);
      }

      // Auto-init if .terraform/ directory is missing (required before validate can run)
      const terraformDir = resolve(resolvedDir, '.terraform');
      if (!existsSync(terraformDir)) {
        try {
          await execFileAsync('terraform', ['init', '-backend=false', '-no-color'], {
            cwd: resolvedDir,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 120_000,
          });
        } catch (initErr) {
          const initMsg = initErr instanceof Error ? initErr.message : String(initErr);
          return errorResult(`terraform init failed (required before validate): ${initMsg}`);
        }
      }

      let stdout = '';
      let stderr = '';
      try {
        ({ stdout, stderr } = await execFileAsync('terraform', ['validate', '-json'], {
          cwd: resolvedDir,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60_000,
        }));
      } catch (err) {
        // terraform validate exits 1 when invalid — stdout still contains JSON
        const execErr = err as ExecException & { stdout?: string; stderr?: string };
        stdout = execErr.stdout ?? '';
        stderr = execErr.stderr ?? '';
        if (!stdout) return errorResult(execErr);
      }

      let result: unknown;
      try {
        result = JSON.parse(stdout.trim());
      } catch {
        return errorResult(`terraform validate produced non-JSON output: ${stdout.slice(0, 200)}`);
      }

      const redacted = redactObject(result, 'moderate') as Record<string, unknown>;
      const redactedStderr = stderr.length > 0 ? redact(stderr, 'moderate') : undefined;
      return jsonResult({
        ...redacted,
        ...(redactedStderr && { stderr: redactedStderr }),
      });
    } catch (err) {
      if ((err as ExecException).killed || (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        return errorResult('terraform validate timed out after 60 seconds');
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return errorResult(
          'Terraform CLI not found. Install it from https://developer.hashicorp.com/terraform/install and ensure it is on PATH.',
        );
      }
      return errorResult(err);
    }
  },
};
