/**
 * MCP tool: scan_terraform
 * Parses Terraform .tf files in a directory and optionally loads a state file.
 */

import { resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import { parseTerraformDir } from '../terraform/parser.js';
import { parseStateFile, findStateFile, RemoteBackendError } from '../terraform/state.js';
import { jsonResult, errorResult, normalizeTerraformResource } from './types.js';
import type { ToolDefinition } from './types.js';
import { logger } from '../utils/logger.js';
import { redactObject } from '../redaction/redactor.js';

export const scanTerraformTool: ToolDefinition = {
  name: 'scan_terraform',
  description:
    'Parse Terraform .tf files in a directory and extract all resources, data sources, modules, and variables. Optionally loads a terraform.tfstate file to enrich results with real resource IDs and ARNs.',
  inputSchema: {
    type: 'object',
    properties: {
      dir: {
        type: 'string',
        description: 'Path to the directory containing Terraform .tf files.',
      },
      stateFile: {
        type: 'string',
        description:
          'Optional path to a terraform.tfstate file. If omitted and a state file exists in dir, it is loaded automatically.',
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
      const stateFile = typeof args['stateFile'] === 'string' ? args['stateFile'] : undefined;

      // Validate dir: must exist and contain .tf files
      const resolvedDir = resolve(dir);
      if (resolvedDir === '/' || /^[A-Z]:\\?$/i.test(resolvedDir) || /^\\\\./.test(resolvedDir)) {
        return errorResult(`dir must not be a filesystem root: ${resolvedDir}`);
      }
      if (!existsSync(resolvedDir)) {
        return errorResult(`dir does not exist: ${resolvedDir}`);
      }
      const dirEntries = await readdir(resolvedDir);
      if (!dirEntries.some((e) => e.endsWith('.tf') || e.endsWith('.tf.json'))) {
        return errorResult(`dir contains no .tf files: ${resolvedDir}`);
      }

      const resources = redactObject(
        (await parseTerraformDir(resolvedDir)).map((resource) =>
          normalizeTerraformResource(resource),
        ),
        'moderate',
      );

      if (stateFile) {
        const resolvedState = resolve(stateFile);
        if (!resolvedState.endsWith('.tfstate') && !resolvedState.endsWith('.tfstate.backup')) {
          return errorResult(`State file must have a .tfstate extension: ${stateFile}`);
        }
      }

      // Resolve state file: explicit path > auto-discover in dir
      let stateResources = undefined;
      let stateWarning: string | undefined;
      let stateFilePath: string | null;
      try {
        stateFilePath = stateFile ?? (await findStateFile(resolvedDir));
      } catch (e) {
        if (e instanceof RemoteBackendError) {
          stateWarning = e.message;
          stateFilePath = null;
        } else {
          throw e;
        }
      }

      if (stateFilePath !== null && stateFilePath !== undefined) {
        try {
          stateResources = await parseStateFile(stateFilePath);

          // Redact full state resource objects (not just attributes) before returning
          stateResources = stateResources.map(
            (sr) => redactObject(sr, 'moderate') as typeof sr,
          );
        } catch (stateErr) {
          // Non-fatal: proceed without state but warn so the user knows resource classification may be less accurate.
          const msg = stateErr instanceof Error ? stateErr.message : String(stateErr);
          logger.warn({ stateFilePath, err: msg }, 'Failed to parse Terraform state file');
          stateWarning = `Failed to parse state file "${basename(stateFilePath)}": ${msg}. Resource classification may be less accurate.`;
          stateResources = undefined;
        }
      }

      const result: {
        resources: typeof resources;
        stateResources?: typeof stateResources;
        warning?: string;
      } = { resources };

      if (stateResources !== undefined) {
        result.stateResources = stateResources;
      }

      if (stateWarning !== undefined) {
        result.warning = stateWarning;
      }

      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  },
};
