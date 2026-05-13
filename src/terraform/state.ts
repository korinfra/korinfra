/**
 * Terraform state file parser.
 * Supports v3 and v4 .tfstate JSON format.
 * Ported from Go internal/terraform/state.go.
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { resolve, join, sep } from 'node:path';

import type { StateResource } from './types.js';
import { logger } from '../utils/logger.js';
import { asStr } from '../utils/coerce.js';

// ---------------------------------------------------------------------------
// State file JSON shapes (v4 format)
// ---------------------------------------------------------------------------

interface TfStateFile {
  version: number;
  terraform_version?: string;
  serial?: number;
  lineage?: string;
  // v4 flat resource list
  resources?: TfStateResourceEntry[];
  // v3 module-nested resource map
  modules?: TfStateV3Module[];
}

interface TfStateV3Module {
  path?: string[];
  resources?: Record<string, TfStateV3Resource>;
}

interface TfStateV3Resource {
  type: string;
  provider?: string;
  primary?: {
    id?: string;
    attributes?: Record<string, string>;
  };
}

interface TfStateResourceEntry {
  module?: string;
  mode: string; // "managed" | "data"
  type: string;
  name: string;
  provider: string;
  instances: TfStateInstance[];
}

interface TfStateInstance {
  index_key?: unknown;
  schema_version?: number;
  attributes?: Record<string, unknown>;
  attributes_flat?: Record<string, string>;
  dependencies?: string[];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function isInsideDir(candidate: string, dir: string): boolean {
  const normalized = dir.endsWith(sep) ? dir : dir + sep;
  return candidate === dir || candidate.startsWith(normalized);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the short provider name from a full provider address.
 *
 * Handles formats:
 *  - v4: `provider["registry.terraform.io/hashicorp/aws"]` → "aws"
 *  - v3: `provider.aws` → "aws"
 *  - plain: `aws` → "aws"
 */
function normalizeProvider(provider: string): string {
  // Strip surrounding provider["..."] wrapper used in v4 state
  const inner = provider.replace(/^provider\["/, '').replace(/"\]$/, '');
  // Now inner is e.g. "registry.terraform.io/hashicorp/aws" or "provider.aws" or "aws"
  const slashParts = inner.split('/');
  const last = slashParts[slashParts.length - 1] ?? inner;
  // Handle dot-notation for v3 format: "provider.aws" → "aws"
  const dotParts = last.split('.');
  return dotParts[dotParts.length - 1] ?? last;
}

/** Safely extract a non-empty string from an attributes map. */
function stringFromAttrs(
  attrs: Record<string, unknown> | undefined,
  key: string,
): string {
  if (attrs === null || attrs === undefined) return '';
  const v = attrs[key];
  if (typeof v === 'string' && v !== '') return v;
  return '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse terraform state JSON content (string or Buffer) into StateResource[]. */
export function parseStateFromString(content: string): StateResource[] {
  let state: TfStateFile;
  try {
    state = JSON.parse(content) as TfStateFile;
  } catch (err) {
    throw new Error(`parsing state JSON: ${String(err)}`, { cause: err });
  }

  if (state.version !== 3 && state.version !== 4) {
    throw new Error(
      `Only Terraform state v3/v4 supported (got v${state.version})`,
    );
  }

  // v3: resources are nested inside modules as a keyed map
  if (state.version === 3) {
    const resources: StateResource[] = [];
    for (const mod of state.modules ?? []) {
      const modulePath = mod.path && mod.path.length > 1
        ? mod.path.slice(1).join('.')
        : undefined;
      for (const [resKey, res] of Object.entries(mod.resources ?? {})) {
        // resKey format: "aws_instance.web" or "module.foo.aws_instance.web"
        const parts = resKey.split('.');
        const resType = parts[parts.length - 2] ?? resKey;
        const resName = parts[parts.length - 1] ?? resKey;
        const name = modulePath ? `${modulePath}.${resType}.${resName}` : resName;
        const address = modulePath ? `module.${name}` : `${resType}.${resName}`;
        const attrs: Record<string, unknown> = res.primary?.attributes ?? {};
        const id = res.primary?.id ?? stringFromAttrs(attrs, 'id');
        const arn = stringFromAttrs(attrs, 'arn');
        const provider = normalizeProvider(res.provider ?? resType.split('_')[0] ?? '');
        resources.push({ address, type: resType, name, provider, arn, id, attributes: attrs });
      }
    }
    return resources;
  }

  const resources: StateResource[] = [];

  for (const res of state.resources ?? []) {
    // Skip data sources — only managed resources matter for resource classification.
    if (res.mode === 'data') continue;

    const provider = normalizeProvider(res.provider);

    for (const inst of res.instances ?? []) {
      const attrs = inst.attributes ?? {};
      const id = stringFromAttrs(attrs, 'id');
      const arn = stringFromAttrs(attrs, 'arn');

      // Build base name: prepend module path if present (matches Go behaviour).
      const baseName =
        res.module !== undefined && res.module !== ''
          ? `${res.module}.${res.name}`
          : res.name;

      // For count/for_each resources, each instance has a distinct index_key
      // (numeric for count, string for for_each).  Incorporate it so that
      // stateByTypeName entries are unique and don't overwrite each other.
      const name =
        inst.index_key !== undefined
          ? `${baseName}[${asStr(inst.index_key)}]`
          : baseName;

      // Build address: <type>.<name> (module prefix already in name)
      const address = `${res.type}.${name}`;

      resources.push({
        address,
        type: res.type,
        name,
        provider,
        arn,
        id,
        attributes: attrs,
      });
    }
  }

  return resources;
}

const MAX_STATE_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Read a .tfstate file from disk and parse it. */
export async function parseStateFile(path: string): Promise<StateResource[]> {
  const absPath = resolve(path);
  if (!/\.tfstate(\.backup)?$/.test(absPath)) {
    throw new Error(
      `parseStateFile: expected a .tfstate or .tfstate.backup file, got: ${absPath}`,
    );
  }
  // Read as Buffer first (single atomic operation) then check size — avoids TOCTOU
  // race between a separate stat() call and the subsequent readFile() call.
  let buffer: Buffer;
  try {
    buffer = await readFile(absPath);
  } catch (err) {
    throw new Error(`reading state file ${absPath}: ${String(err)}`, { cause: err });
  }
  if (buffer.length > MAX_STATE_FILE_BYTES) {
    throw new Error(`State file too large: ${buffer.length} bytes (max ${MAX_STATE_FILE_BYTES})`);
  }
  return parseStateFromString(buffer.toString('utf8'));
}

/**
 * Look for a terraform.tfstate or terraform.tfstate.backup in dir.
 * Also checks terraform.tfstate.d/<workspace>/terraform.tfstate for workspace state files.
 * If `workspace` is provided, only that workspace directory is checked.
 * Returns the path of the first one found, or null.
 */
export async function findStateFile(dir: string, workspace?: string): Promise<string | null> {
  const absDir = resolve(dir);
  for (const name of ['terraform.tfstate', 'terraform.tfstate.backup']) {
    const candidate = join(absDir, name);
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // not found, try next
    }
  }

  // Check workspace state files under terraform.tfstate.d/
  const workspaceDir = resolve(absDir, 'terraform.tfstate.d');
  let workspaceEntries: Dirent[] | undefined;
  try {
    workspaceEntries = readdirSync(workspaceDir, { withFileTypes: true });
  } catch { /* directory does not exist — no workspace state */ }

  if (workspaceEntries !== undefined) {
    if (workspace !== undefined && workspace !== '') {
      // Specific workspace requested
      const wsState = resolve(workspaceDir, workspace, 'terraform.tfstate');
      if (!isInsideDir(wsState, workspaceDir)) {
        throw new Error('Invalid workspace path');
      }
      if (existsSync(wsState)) return wsState;
    } else {
      // Scan all workspace subdirectories; return the first valid state found
      const resolvedWorkspaceDir = resolve(workspaceDir);
      for (const entry of workspaceEntries) {
        if (entry.isDirectory()) {
          const resolvedEntry = resolve(workspaceDir, entry.name);
          if (!isInsideDir(resolvedEntry, resolvedWorkspaceDir)) {
            continue; // skip symlinks pointing outside
          }
          const wsState = resolve(resolvedEntry, 'terraform.tfstate');
          if (existsSync(wsState)) return wsState;
        }
      }
    }
  }

  // No local state found — check for a remote backend pointer file.
  // .terraform/terraform.tfstate is written by `terraform init` when a remote
  // backend is configured. Its presence means state lives remotely.
  const backendPointer = join(absDir, '.terraform', 'terraform.tfstate');
  if (existsSync(backendPointer)) {
    logger.warn(
      { dir: absDir, backendPointer },
      'No local .tfstate found but a remote backend pointer exists. ' +
        'Run `terraform state pull > terraform.tfstate` to obtain local state for resource classification.',
    );
    throw new RemoteBackendError(
      'Remote backend detected. Run `terraform state pull > terraform.tfstate` to obtain local state for resource classification.',
    );
  }

  return null;
}

export class RemoteBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteBackendError';
  }
}
