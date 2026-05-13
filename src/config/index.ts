import fs from 'node:fs';
import path from 'node:path';

import { cosmiconfig } from 'cosmiconfig';
import yaml from 'js-yaml';

import { defaults } from './defaults.js';
import { defaultConfigDir, defaultConfigPath, expandPath } from './paths.js';
import { ConfigSchema } from './types.js';
import type { Config } from './types.js';
import { validate, ConfigValidationError } from './validate.js';
import { logger } from '../utils/logger.js';
import { redact } from '../redaction/redactor.js';

export { ConfigValidationError } from './validate.js';
export type { Config, AWSConfig, AWSProfile, AIConfig, TerraformConfig, GitHubConfig, OutputConfig, StorageConfig, ScanConfig, AnomalyConfig, MCPConfig } from './types.js';
export { defaults } from './defaults.js';
export { defaultConfigDir, defaultConfigPath, defaultThresholdsPath, KORINFRA_DIR, defaultStoragePath, expandPath, resolveConfigPath, projectkorinfraDir, projectConfigPath, projectThresholdsPath, projectStoragePath } from './paths.js';
export { validate } from './validate.js';

const SEARCH_PLACES = [
  '.korinfra/config.yaml',
  '.korinfra/config.yml',
  '.korinfra/config.json',
] as const;

async function searchConfigFile(
  explorer: ReturnType<typeof cosmiconfig>,
  configPath?: string,
): Promise<{ config: Record<string, unknown>; filepath: string } | null> {
  if (configPath) {
    const expanded = expandPath(configPath);
    try {
      const result = await explorer.load(expanded);
      if (result?.config) {
        return {
          config: result.config as Record<string, unknown>,
          filepath: result.filepath,
        };
      }
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') {
        logger.debug({ path: expanded, err }, 'Failed to read config file');
        throw new Error('Failed to read configuration file', { cause: err });
      }
    }
    return null;
  }

  // Only search in cwd — config is always project-local (.korinfra/)
  const searchDirs = [process.cwd()];

  for (const dir of searchDirs) {
    try {
      const result = await explorer.search(dir);
      if (result?.config) {
        return {
          config: result.config as Record<string, unknown>,
          filepath: result.filepath,
        };
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(
          {
            err: { message: redact(err instanceof Error ? err.message : String(err), 'moderate') },
            // avoid leaking OS username in path
            dir: redact(dir, 'moderate'),
          },
          'Failed to search config directory'
        );
        throw new ConfigValidationError([`Credential loading failed: ${err instanceof Error ? err.message : String(err)}`]);
      }
    }
  }

  return null;
}

export async function findConfigPath(configPath?: string): Promise<string | null> {
  const forbiddenLoader = (fp: string) => {
    throw new Error(`JS/TS config files are not supported for security reasons: ${fp}. Use .korinfra/config.yaml instead.`);
  };
  const explorer = cosmiconfig('korinfra', {
    searchPlaces: [...SEARCH_PLACES],
    loaders: {
      '.yaml': (_fp: string, content: string) => yaml.load(content, { schema: yaml.JSON_SCHEMA }),
      '.yml': (_fp: string, content: string) => yaml.load(content, { schema: yaml.JSON_SCHEMA }),
      '.js': forbiddenLoader,
      '.mjs': forbiddenLoader,
      '.cjs': forbiddenLoader,
      '.ts': forbiddenLoader,
    },
  });

  const result = await searchConfigFile(explorer, configPath);
  return result?.filepath ?? null;
}

/**
 * Loads scan + anomaly thresholds from thresholds.yaml next to the main config.
 * Returns null if the file doesn't exist.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- synchronous fs ops; async signature kept for future extension
export async function loadThresholds(configDir?: string): Promise<Record<string, unknown> | null> {
  const dir = configDir ?? defaultConfigDir();
  const thresholdsPath = path.join(dir, 'thresholds.yaml');
  try {
    const content = fs.readFileSync(thresholdsPath, 'utf8');
    const parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA });
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    if ('scan' in obj) result['scan'] = obj['scan'];
    if ('anomaly' in obj) result['anomaly'] = obj['anomaly'];
    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return null;
    throw err;
  }
}

// ─── Env prefix ──────────────────────────────────────────────────────────────

const ENV_PREFIX = 'KORINFRA_';

/**
 * Reads environment variables with the KORINFRA_ prefix and returns an object
 * of dot-path overrides. Double underscore (__) becomes a dot separator.
 * e.g. KORINFRA_AI__PROVIDER → ai.provider, KORINFRA_AI__MODEL → ai.model.
 */
function readEnvOverrides(): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined || !key.startsWith(ENV_PREFIX)) continue;
    // KORINFRA_AI__PROVIDER → ai.provider (double underscore = dot separator)
    const dotPath = key.slice(ENV_PREFIX.length).toLowerCase().replace(/__/g, '.');
    overrides[dotPath] = val;
  }
  return overrides;
}

/**
 * Sets a nested value on an object using a dot-path string.
 * e.g. setByPath(obj, 'ai.provider', 'claude')
 */
// All Object.prototype method names that can be used for prototype pollution.
const DANGEROUS_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toString',
  'toLocaleString',
  'valueOf',
]);

function setByPath(obj: Record<string, unknown>, dotPath: string, value: string): void {
  const parts = dotPath.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] ?? '';
    if (DANGEROUS_KEYS.has(part)) return; // block prototype pollution
    if (typeof cursor[part] !== 'object' || cursor[part] === null) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] ?? '';
  if (DANGEROUS_KEYS.has(last)) return; // block prototype pollution
  // Attempt numeric / boolean coercion so string env vars become proper types
  const lower = value.toLowerCase();
  if (lower === 'true') cursor[last] = true;
  else if (lower === 'false') cursor[last] = false;
  else if (!isNaN(Number(value)) && value.trim() !== '') cursor[last] = Number(value);
  else if (value.includes(',')) cursor[last] = value.split(',').map((s) => s.trim()).filter(Boolean);
  else cursor[last] = value;
}

// ─── String slice normalization ───────────────────────────────────────────────

/**
 * Normalizes a raw config value into a string array.
 * Handles: string[], string (comma/newline/semicolon separated), null/undefined.
 * Mirrors Go's normalizeStringSlice.
 */
export function normalizeStringSlice(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];

  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === 'string' ? item.trim() : String(item).trim()))
      .filter(Boolean);
  }

  if (typeof raw === 'string') {
    const normalized = raw.replace(/[\n;]/g, ',');
    return normalized
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
}

// ─── Deep merge ───────────────────────────────────────────────────────────────

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Deep-merges source into target (mutates target).
 * Arrays in source replace arrays in target entirely (no concatenation).
 * Config fields with array semantics: scan.required_tags, github.pr_labels, aws.profiles.*.regions.
 * To override a default array, provide the full replacement list in your config file.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, srcVal] of Object.entries(source)) {
    // Guard against prototype pollution — reuse the module-level DANGEROUS_KEYS set
    if (DANGEROUS_KEYS.has(key)) continue;
    const tgtVal = target[key];
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      deepMerge(tgtVal, srcVal);
    } else {
      // Arrays in source replace arrays in target entirely
      (target)[key] = srcVal;
    }
  }
  return target;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Loads, merges, and validates korinfra configuration.
 *
 * Priority (highest → lowest):
 *   1. KORINFRA_* environment variables
 *   2. Config file (explicit path, or searched in cwd/.korinfra/)
 *   3. Built-in defaults
 *
 * @param configPath - explicit path to config file (optional)
 */
export async function loadConfig(configPath?: string): Promise<Config> {
  // Cast required: deepMerge needs dynamic key access; Config struct is not indexable by string
  const base = defaults() as unknown as Record<string, unknown>;

  // Build cosmiconfig explorer
  const forbiddenLoader = (fp: string) => {
    throw new Error(`JS/TS config files are not supported for security reasons: ${fp}. Use .korinfra/config.yaml instead.`);
  };
  const explorer = cosmiconfig('korinfra', {
    searchPlaces: [...SEARCH_PLACES],
    loaders: {
      '.yaml': (_fp: string, content: string) => yaml.load(content, { schema: yaml.JSON_SCHEMA }),
      '.yml': (_fp: string, content: string) => yaml.load(content, { schema: yaml.JSON_SCHEMA }),
      '.js': forbiddenLoader,
      '.mjs': forbiddenLoader,
      '.cjs': forbiddenLoader,
      '.ts': forbiddenLoader,
    },
  });

  const searchResult = await searchConfigFile(explorer, configPath);

  if (searchResult) {
    const fileData = searchResult.config;

    // Validate raw user input with a partial schema BEFORE merging with defaults.
    const partialResult = ConfigSchema.partial().safeParse(fileData);
    if (!partialResult.success) {
      const issues = partialResult.error.issues.map(
        (i) => `${i.path.join('.')}: ${i.message}`,
      );
      throw new ConfigValidationError(issues);
    }

    deepMerge(base, fileData);

    const thresholdsData = await loadThresholds(path.dirname(searchResult.filepath));
    if (thresholdsData) {
      deepMerge(base, thresholdsData);
    }
  }

  const KNOWN_CONFIG_ROOTS = new Set(['version', 'aws', 'ai', 'terraform', 'github', 'output', 'storage', 'scan', 'anomaly', 'mcp']);

  // Apply KORINFRA_* env overrides
  const envOverrides = readEnvOverrides();
  for (const [dotPath, val] of Object.entries(envOverrides)) {
    const root = dotPath.split('.')[0] ?? '';
    if (!KNOWN_CONFIG_ROOTS.has(root)) {
      const key = ENV_PREFIX + dotPath.toUpperCase().replace(/\./g, '__');
      logger.debug({ key, dotPath }, 'Unrecognized KORINFRA_ env var — ignored');
      continue;
    }
    setByPath(base, dotPath, val);
  }

  // Re-normalize array fields (handles comma-separated strings from env)
  const scanNode = base['scan'] as Record<string, unknown> | undefined;
  if (scanNode) {
    const rawTags = scanNode['required_tags'];
    scanNode['required_tags'] = normalizeStringSlice(rawTags);
  }
  const ghNode = base['github'] as Record<string, unknown> | undefined;
  if (ghNode) {
    const rawLabels = ghNode['pr_labels'];
    ghNode['pr_labels'] = normalizeStringSlice(rawLabels);
  }

  // Expand ~ in paths
  const storageNode = base['storage'] as Record<string, unknown> | undefined;
  if (storageNode && typeof storageNode['path'] === 'string') {
    storageNode['path'] = expandPath(storageNode['path']);
  }
  const tfNode = base['terraform'] as Record<string, unknown> | undefined;
  if (tfNode && typeof tfNode['state_file'] === 'string') {
    tfNode['state_file'] = expandPath(tfNode['state_file']);
  }

  // Normalize provider aliases and reject unsupported providers.
  // Runs before the ENOENT check so bad env-var providers are caught even without a config file.
  const aiNode = base['ai'] as Record<string, unknown> | undefined;
  if (aiNode && typeof aiNode['provider'] === 'string') {
    const PROVIDER_ALIASES: Record<string, string> = {
      anthropic: 'claude',
    };
    const NOT_IMPLEMENTED: Record<string, string> = {
      openai: "ai.provider 'openai' is not yet implemented; use 'claude' or 'none'",
      ollama: "ai.provider 'ollama' is not supported; use 'claude' or 'none'",
      local: "ai.provider 'local' is not supported; use 'claude' or 'none'",
    };
    const p = aiNode['provider'];
    const alias = PROVIDER_ALIASES[p];
    if (alias !== undefined) {
      aiNode['provider'] = alias;
    } else if (p in NOT_IMPLEMENTED) {
      throw new ConfigValidationError([NOT_IMPLEMENTED[p] ?? `ai.provider '${p}' is not supported`]);
    }
  }

  if (!searchResult) {
    // No config file found — signal to the TUI that setup is required.
    const err = new Error('No config file found. Run `korinfra init` to create one.') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }

  // Parse through Zod for coercion and strict validation of enum/range fields
  const parsed = ConfigSchema.parse(base);

  // Auto-resolve storage path if not set
  if (!parsed.storage.path) {
    if (searchResult?.filepath) {
      const configDir = path.dirname(searchResult.filepath);
      parsed.storage.path = path.join(configDir, 'data.db');
    }
  }

  // Business-logic validation (mirrors Go's Validate)
  const configWarnings = validate(parsed);
  for (const warning of configWarnings) {
    logger.warn(warning);
  }

  return parsed;
}

// ─── Saver ────────────────────────────────────────────────────────────────────

function writeSecureFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* windows */ }
}

/**
 * Serializes a Config to YAML and writes it to disk.
 * Creates parent directories as needed.
 *
 * @param cfg    - the config to persist
 * @param cfgPath - target file path (defaults to DefaultConfigPath)
 */
// eslint-disable-next-line @typescript-eslint/require-await -- synchronous fs ops; async signature kept for caller consistency
export async function saveConfig(cfg: Config, cfgPath?: string): Promise<void> {
  const target = cfgPath ? expandPath(cfgPath) : defaultConfigPath();
  const dir = path.dirname(target);

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { /* already exists */ }

  const coreKeys = new Set(['version', 'aws', 'ai', 'terraform', 'github', 'output', 'storage']);
  const coreConfig: Record<string, unknown> = {};
  const thresholdsConfig: Record<string, unknown> = {};

  // Cast required: Object.entries needs a string-indexable type; Config is a Zod output struct
  for (const [k, v] of Object.entries(cfg as unknown as Record<string, unknown>)) {
    if (coreKeys.has(k)) {
      coreConfig[k] = v;
    } else {
      thresholdsConfig[k] = v;
    }
  }

  const dumpOpts = { indent: 2, lineWidth: 120, noRefs: true, sortKeys: false };

  writeSecureFile(target, yaml.dump(coreConfig, dumpOpts));

  if (Object.keys(thresholdsConfig).length > 0) {
    const thresholdsPath = path.join(dir, 'thresholds.yaml');
    writeSecureFile(thresholdsPath, yaml.dump(thresholdsConfig, dumpOpts));
  }
}
