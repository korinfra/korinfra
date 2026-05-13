/**
 * Pure logic for MCP server installation — no Ink/React dependency.
 * Used by both the TUI wizard (mcp.tsx) and the headless handler (headless.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

// ─── Types ────────────────────────────────────────────────────────────────────

interface McpServerEntry {
  type: string;
  command: string;
  args?: string[];
}

/** Per-IDE installed state */
export type IdeInstallState = 'not-installed' | 'installed' | 'differs';

/** Installation scope: user-global or project-local. */
export type InstallScope = 'user' | 'project';

/**
 * JSON shape used by the IDE for MCP server entries.
 *
 *  - 'flat'   — top-level `mcpServers.<name>` (Claude Code, Cursor)
 *  - 'nested' — nested `mcp.servers.<name>` (VS Code settings.json / .vscode/mcp.json)
 */
type ConfigShape = 'flat' | 'nested';

interface IdeTarget {
  id: string;
  label: string;
  configPath: string;
  exists: boolean;
  installState: IdeInstallState;
  existingEntry?: McpServerEntry;
  /** JSON shape for the MCP entry in this IDE's config file. */
  shape: ConfigShape;
  /** Installation scope this target represents. */
  scope: InstallScope;
  /** Whether the user can currently select this target (false for "Other"). */
  manual?: boolean;
}

export interface InstallResult {
  id: string;
  label: string;
  configPath: string;
  action: 'installed' | 'updated' | 'skipped' | 'removed' | 'error';
  detail?: string;
  backupPath?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function korinfraMcpEntry(): McpServerEntry {
  const bin = process.env['KORINFRA_BIN'];
  const command = bin && bin.trim().length > 0 ? bin.trim() : 'korinfra';

  // Validation: warn if KORINFRA_BIN is set but path is not absolute or file doesn't exist
  if (bin && bin.trim().length > 0) {
    const trimmedBin = bin.trim();
    const isAbsolute = path.isAbsolute(trimmedBin);
    const fileExists = isAbsolute && fs.existsSync(trimmedBin);

    if (!isAbsolute) {
      process.stderr.write(
        `[korinfra] WARNING: KORINFRA_BIN="${trimmedBin}" is not an absolute path. ` +
        `IDEs expect absolute paths. Continuing anyway, but the IDE may fail to find the server.\n`,
      );
    } else if (!fileExists) {
      process.stderr.write(
        `[korinfra] WARNING: KORINFRA_BIN="${trimmedBin}" does not exist. ` +
        `Check the file path and ensure it is executable.\n`,
      );
    }
  }

  return {
    type: 'stdio' as const,
    command,
    args: ['serve'],
  };
}

/**
 * Check if 'korinfra' or KORINFRA_BIN resolves on PATH.
 * Returns a warning message if resolution fails, or null if OK.
 */
function checkkorinfraResolution(): string | null {
  const bin = process.env['KORINFRA_BIN'];
  if (bin && bin.trim().length > 0) {
    // KORINFRA_BIN is set — trust it for now (already warned in korinfraMcpEntry)
    return null;
  }

  // Try to resolve 'korinfra' on PATH using cross-platform method
  try {
    // Cross-platform: use 'where korinfra' on Windows, 'which korinfra' on Unix
    const cmd = process.platform === 'win32' ? 'where korinfra' : 'which korinfra';
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
    return null; // Found on PATH
  } catch {
    // Not found on PATH
    return (
      'WARNING: `korinfra` command not found on PATH and KORINFRA_BIN is not set. ' +
      'After install, restart your IDE — if it cannot find the korinfra server, set KORINFRA_BIN=/abs/path/to/korinfra.'
    );
  }
}

function readJsonFile(filePath: string): Record<string, unknown> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${filePath}: ${err instanceof SyntaxError ? err.message : 'parse failed'}. No changes were written. Back up and repair the JSON file, then re-run.`,
      { cause: err },
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object at the root.`);
  }
  return parsed;
}

/**
 * Write JSON atomically. If the file already exists, a `.bak` backup is created
 * before overwriting. Returns the backup path if a backup was created.
 */
function writeJsonFileAtomic(
  filePath: string,
  data: Record<string, unknown>,
): string | undefined {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let backupPath: string | undefined;
  try {
    backupPath = `${filePath}.bak`;
    fs.copyFileSync(filePath, backupPath);
  } catch {
    backupPath = undefined;
  }

  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // ignore temp-file cleanup failures
    }
    throw err;
  }

  return backupPath;
}

function readMcpServers(
  filePath: string,
  data: Record<string, unknown>,
): Record<string, McpServerEntry> {
  const block = data['mcpServers'];
  if (block === undefined) {
    return {};
  }
  if (!isPlainObject(block)) {
    throw new Error(`${filePath} must contain an object at mcpServers.`);
  }
  return block as Record<string, McpServerEntry>;
}

/** Read nested `mcp.servers` (VS Code shape). */
function readNestedMcpServers(
  filePath: string,
  data: Record<string, unknown>,
): Record<string, McpServerEntry> {
  const mcp = data['mcp'];
  if (mcp === undefined) return {};
  if (!isPlainObject(mcp)) {
    throw new Error(`${filePath} must contain an object at mcp.`);
  }
  const servers = mcp['servers'];
  if (servers === undefined) return {};
  if (!isPlainObject(servers)) {
    throw new Error(`${filePath} must contain an object at mcp.servers.`);
  }
  return servers as Record<string, McpServerEntry>;
}

function readServersForShape(
  shape: ConfigShape,
  filePath: string,
  data: Record<string, unknown>,
): Record<string, McpServerEntry> {
  return shape === 'nested' ? readNestedMcpServers(filePath, data) : readMcpServers(filePath, data);
}

function writeServersForShape(
  shape: ConfigShape,
  data: Record<string, unknown>,
  servers: Record<string, McpServerEntry>,
): Record<string, unknown> {
  if (shape === 'nested') {
    const existingMcp = isPlainObject(data['mcp']) ? (data['mcp']) : {};
    return { ...data, mcp: { ...existingMcp, servers } };
  }
  return { ...data, mcpServers: servers };
}

// ─── IDE target resolution ────────────────────────────────────────────────────

/** All supported IDE IDs (headless/CLI filter). */
export const SUPPORTED_IDE_IDS = ['claude-code', 'cursor', 'vscode', 'jetbrains'] as const;
/** Resolve the user-scope settings file for VS Code per OS. */
function vscodeUserSettingsPath(home: string): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User', 'settings.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  return path.join(home, '.config', 'Code', 'User', 'settings.json');
}

interface IdeCandidate {
  id: string;
  label: string;
  configPath: string;
  shape: ConfigShape;
  scope: InstallScope;
  manual?: boolean;
}

/**
 * Build the list of IDE candidates.
 *
 * `scope` selects user-global vs project-local config paths where the IDE
 * distinguishes the two (currently only VS Code).
 */
function ideCandidates(scope: InstallScope = 'user'): IdeCandidate[] {
  const home = os.homedir();
  const cwd = process.cwd();

  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      configPath: path.join(home, '.claude.json'),
      shape: 'flat',
      scope: 'user',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      shape: 'flat',
      scope: 'user',
    },
    {
      id: 'vscode',
      label: 'VS Code',
      configPath: scope === 'project'
        ? path.join(cwd, '.vscode', 'mcp.json')
        : vscodeUserSettingsPath(home),
      shape: 'nested',
      scope,
    },
    {
      id: 'jetbrains',
      label: 'JetBrains',
      configPath: path.join(home, '.config', 'JetBrains', 'mcp.json'),
      shape: 'flat',
      scope: 'user',
    },
  ];
}

export function resolveIdeTargets(filter?: string[], scope: InstallScope = 'user'): IdeTarget[] {
  const candidates = ideCandidates(scope);
  const filtered = filter !== undefined ? candidates.filter((c) => filter.includes(c.id)) : candidates;

  return filtered.map((t) => {
    let exists = false;
    let installState: IdeInstallState = 'not-installed';
    let existingEntry: McpServerEntry | undefined;

    try {
      // Single atomic read — avoids TOCTOU between existsSync and readJsonFile.
      // readJsonFile returns {} on ENOENT; any other error is rethrown.
      const raw = fs.readFileSync(t.configPath, 'utf8');
      exists = true;
      const data = JSON.parse(raw) as Record<string, unknown>;
      const servers = readServersForShape(t.shape, t.configPath, data);
      const entry = servers['korinfra'];
      if (entry !== undefined) {
        existingEntry = entry;
        const expected = korinfraMcpEntry();
        if (
          entry.command === expected.command &&
          JSON.stringify(entry.args) === JSON.stringify(expected.args)
        ) {
          installState = 'installed';
        } else {
          installState = 'differs';
        }
      }
    } catch (err) {
      // ENOENT → exists stays false; parse/other errors → exists=true, not-installed
      if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        exists = true;
      }
    }

    return { ...t, exists, installState, ...(existingEntry !== undefined ? { existingEntry } : {}) };
  });
}

// ─── Install / uninstall ──────────────────────────────────────────────────────

export function installIntoConfig(target: IdeTarget): InstallResult {
  try {
    // Emit PATH preflight warning if resolution fails (before writing any config)
    const pathWarning = checkkorinfraResolution();
    if (pathWarning) {
      process.stderr.write(`[korinfra] ${pathWarning}\n`);
    }

    const data = readJsonFile(target.configPath);
    const servers = { ...readServersForShape(target.shape, target.configPath, data) };
    const existed = 'korinfra' in servers;
    servers['korinfra'] = korinfraMcpEntry();

    const backupPath = writeJsonFileAtomic(target.configPath, writeServersForShape(target.shape, data, servers));

    return {
      id: target.id,
      label: target.label,
      configPath: target.configPath,
      action: existed ? 'updated' : 'installed',
      ...(backupPath !== undefined ? { backupPath } : {}),
    };
  } catch (err) {
    return {
      id: target.id,
      label: target.label,
      configPath: target.configPath,
      action: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function uninstallFromConfig(target: IdeTarget): InstallResult {
  try {
    const data = readJsonFile(target.configPath);
    const servers = readServersForShape(target.shape, target.configPath, data);

    if (!('korinfra' in servers)) {
      return {
        id: target.id,
        label: target.label,
        configPath: target.configPath,
        action: 'skipped',
        detail: 'korinfra entry not found',
      };
    }

    const remaining = { ...servers };
    delete remaining['korinfra'];
    writeJsonFileAtomic(target.configPath, writeServersForShape(target.shape, data, remaining));

    return {
      id: target.id,
      label: target.label,
      configPath: target.configPath,
      action: 'removed',
    };
  } catch (err) {
    return {
      id: target.id,
      label: target.label,
      configPath: target.configPath,
      action: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
