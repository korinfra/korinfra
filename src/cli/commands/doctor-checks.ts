import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { testConnection } from '../../aws/credentials.js';
import { loadConfig, ConfigValidationError } from '../../config/index.js';
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { defaultConfigDir } from '../../config/paths.js';

const execFileAsync = promisify(execFile);

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Raw result returned by each check function. */
export interface CheckResult {
  ok: boolean;
  detail?: string;
  optional?: boolean;
  aborted?: boolean;
}

/** Rolled-up outcome stored in the results map returned by runAllChecks. */
interface CheckOutcome {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warn';
  detail?: string | undefined;
  optional: boolean;
}

/** Definition of a single diagnostic check. */
interface CheckDef {
  id: string;
  label: string;
  group: string;
  optional?: boolean;
  /** Command hint shown when check fails, e.g. "aws sso login --profile default" */
  fixHint?: string;
  run: (signal?: AbortSignal) => Promise<CheckResult>;
}

// ─── Internal helper ────────────────────────────────────────────────────────────

function createTimedSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const forwardAbort = () => controller.abort();
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      if (parentSignal !== undefined) {
        parentSignal.removeEventListener('abort', forwardAbort);
      }
    },
    timedOut: () => timedOut,
  };
}

// ─── Check implementations ──────────────────────────────────────────────────────

async function checkAwsCredentials(signal?: AbortSignal): Promise<CheckResult> {
  const ctx = createTimedSignal(signal, 10_000);
  try {
    const identity = await testConnection({ regions: ['us-east-1'] }, ctx.signal);
    return { ok: true, detail: `Account ****${identity.account?.slice(-4) ?? '****'}` };
  } catch (err) {
    if (signal?.aborted) {
      return { ok: false, aborted: true, detail: 'Cancelled' };
    }
    if (ctx.timedOut()) {
      return { ok: false, detail: 'AWS credentials check timed out after 10s' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    const isExpired = /ExpiredToken|InvalidClientTokenId|InvalidToken|token.*expir|expir.*token/i.test(msg);
    return {
      ok: false,
      detail: isExpired
        ? 'Credentials expired — run: aws sso login  (or aws configure)'
        : msg,
    };
  } finally {
    ctx.cleanup();
  }
}

async function checkAwsConnectivity(signal?: AbortSignal): Promise<CheckResult> {
  const ctx = createTimedSignal(signal, 10_000);
  try {
    const client = new EC2Client({ region: 'us-east-1', requestHandler: new NodeHttpHandler({ connectionTimeout: 3_000, socketTimeout: 15_000 }), maxAttempts: 1 });
    const res = await client.send(new DescribeRegionsCommand({ AllRegions: false }), { abortSignal: ctx.signal });
    const count = res.Regions?.length ?? 0;
    return { ok: count > 0, detail: `${count} regions reachable` };
  } catch (err) {
    if (signal?.aborted) {
      return { ok: false, aborted: true, detail: 'Cancelled' };
    }
    if (ctx.timedOut()) {
      return { ok: false, detail: 'AWS connectivity check timed out after 10s' };
    }
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    ctx.cleanup();
  }
}

async function checkTerraform(signal?: AbortSignal): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync('terraform', ['version'], { timeout: 5000, signal });
    const version = stdout.split('\n')[0]?.trim() ?? 'unknown';
    return { ok: true, detail: version };
  } catch {
    if (signal?.aborted) {
      return { ok: false, aborted: true, detail: 'Cancelled' };
    }
    return { ok: false, detail: 'Not found in PATH — optional feature', optional: true };
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- synchronous fs ops, implements async CheckFn interface
async function checkSqlite(storagePath: string, _signal?: AbortSignal): Promise<CheckResult> {
  try {
    const dir = storagePath.replace(/[/\\][^/\\]+$/, '');
    if (!fs.existsSync(dir)) {
      return { ok: false, detail: `Storage directory does not exist: ${dir}` };
    }
    fs.accessSync(dir, fs.constants.W_OK);
    return { ok: true, detail: storagePath };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- synchronous fs ops, implements async CheckFn interface
async function checkConfigFile(_signal?: AbortSignal): Promise<CheckResult> {
  const searchNames = ['.korinfra/config.yaml', '.korinfra/config.yml', '.korinfra/config.json'];
  const searchDirs = [process.cwd(), defaultConfigDir()];

  for (const dir of searchDirs) {
    for (const name of searchNames) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return { ok: true, detail: candidate };
      }
    }
  }
  return { ok: false, detail: 'Use init to create one' };
}

async function checkConfigValidation(_signal?: AbortSignal): Promise<CheckResult> {
  try {
    await loadConfig();
    return { ok: true, detail: 'No issues found' };
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      return { ok: false, detail: err.issues.join('; ') };
    }
    // ENOENT = config file absent; handled by the 'config' check (dependency below)
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, detail: 'No config file to validate' };
    }
    // ZodError, parse failure, or any other error counts as a failure
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkAiProvider(_signal?: AbortSignal): Promise<CheckResult> {
  // Distinguish keys loaded from .korinfra/.env vs shell env.
  // loadProjectEnv has already run by this point (index.ts line ~46), so
  // process.env is already populated. We identify the source by checking the .env file.
  const dotEnvPath = path.join(process.cwd(), '.korinfra', '.env');

  function isKeyInDotEnv(keyName: string): boolean {
    try {
      if (!fs.existsSync(dotEnvPath)) return false;
      const contents = fs.readFileSync(dotEnvPath, 'utf8');
      return contents.split('\n').some((line) => line.startsWith(`${keyName}=`));
    } catch {
      return false;
    }
  }

  const anthropic = process.env['ANTHROPIC_API_KEY'];
  const openai = process.env['OPENAI_API_KEY'];

  // If provider is set to 'none', AI is intentionally disabled — surface that clearly.
  let providerNone = false;
  try {
    const cfg = await loadConfig();
    providerNone = cfg.ai?.provider === 'none';
  } catch { /* ignore */ }

  if (anthropic) {
    const fromDotEnv = isKeyInDotEnv('ANTHROPIC_API_KEY');
    const src = fromDotEnv ? 'API key configured (loaded from .korinfra/.env)' : 'ANTHROPIC_API_KEY (shell env)';
    return { ok: true, detail: providerNone ? `${src} — ai.provider is 'none' (AI disabled)` : src };
  }
  if (openai) {
    const fromDotEnv = isKeyInDotEnv('OPENAI_API_KEY');
    const src = fromDotEnv ? 'API key configured (loaded from .korinfra/.env)' : 'OPENAI_API_KEY (shell env)';
    return { ok: true, detail: providerNone ? `${src} — ai.provider is 'none' (AI disabled)` : src };
  }

  // Also check config file for api_key_env override
  try {
    const config = await loadConfig();
    const keyEnvName = config.ai?.api_key_env;
    if (keyEnvName && keyEnvName !== 'ANTHROPIC_API_KEY' && keyEnvName !== 'OPENAI_API_KEY') {
      const customKey = process.env[keyEnvName];
      if (customKey) {
        const fromDotEnv = isKeyInDotEnv(keyEnvName);
        return { ok: true, detail: fromDotEnv ? `API key configured (loaded from .korinfra/.env)` : `${keyEnvName} (shell env)` };
      }
    }
    if (config.ai?.provider && config.ai.provider !== 'none') {
      const keyEnv = keyEnvName ?? 'ANTHROPIC_API_KEY';
      return { ok: false, detail: `Provider "${config.ai.provider}" configured but ${keyEnv} not set` };
    }
  } catch {
    // Config load failure is non-fatal for this check
  }

  return { ok: false, detail: 'No API key set — AI features disabled' };
}

async function checkNetwork(signal?: AbortSignal): Promise<CheckResult> {
  const ctx = createTimedSignal(signal, 5000);
  try {
    const res = await fetch('https://ec2.us-east-1.amazonaws.com/', {
      method: 'HEAD',
      signal: ctx.signal,
    });
    return { ok: res.status < 500, detail: 'AWS endpoint reachable' };
  } catch (err) {
    if (signal?.aborted) {
      return { ok: false, aborted: true, detail: 'Cancelled' };
    }
    if (ctx.timedOut() || (err instanceof Error && err.name === 'AbortError')) {
      return { ok: false, detail: 'AWS endpoint unreachable (5s timeout)' };
    }
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    ctx.cleanup();
  }
}

// ─── Check definitions ──────────────────────────────────────────────────────────

export function buildChecks(storagePath: string): CheckDef[] {
  return [
    // Required: AWS
    { id: 'aws-creds', label: 'AWS credentials', group: 'aws-auth', fixHint: 'aws sso login --profile default', run: checkAwsCredentials },
    { id: 'aws-sdk', label: 'AWS connectivity', group: 'aws-auth', fixHint: 'aws configure', run: checkAwsConnectivity },
    { id: 'network', label: 'Network', group: 'aws-auth', fixHint: 'Check VPN or firewall settings', run: checkNetwork },
    // Required: Config + DB
    { id: 'config', label: 'Config file', group: 'config', fixHint: 'korinfra init', run: checkConfigFile },
    { id: 'config-valid', label: 'Config validation', group: 'config', fixHint: 'Edit .korinfra/config.yaml', run: checkConfigValidation },
    { id: 'sqlite', label: 'Database', group: 'config', fixHint: 'Check storage directory permissions', run: (signal) => checkSqlite(storagePath, signal) },
    // Optional: AI
    { id: 'ai-key', label: 'AI provider key', group: 'ai', optional: true, fixHint: 'Add ANTHROPIC_API_KEY to .korinfra/.env  or  export ANTHROPIC_API_KEY=sk-ant-...', run: checkAiProvider },
    // Optional: Tools
    { id: 'terraform', label: 'Terraform CLI', group: 'tools', optional: true, fixHint: 'brew install terraform  (or see terraform.io/downloads)', run: checkTerraform },
  ];
}

// ─── Dependency map ─────────────────────────────────────────────────────────────

/** Checks that depend on other checks passing first. */
const CHECK_DEPENDENCIES: Record<string, string[]> = {
  'aws-sdk': ['aws-creds'],    // connectivity depends on credentials
  'network': ['aws-creds'],    // network check depends on credentials
  'config-valid': ['config'],  // only validate when config file exists
};

// ─── runAllChecks ───────────────────────────────────────────────────────────────

/**
 * Runs all doctor checks sequentially with dependency handling.
 * Returns a map of check id → CheckOutcome with rolled-up pass/fail/warn status.
 */
export async function runAllChecks(
  storagePath: string,
  signal?: AbortSignal,
): Promise<Map<string, CheckOutcome>> {
  const defs = buildChecks(storagePath);
  const results = new Map<string, CheckOutcome>();
  const failedIds = new Set<string>();

  for (const def of defs) {
    if (signal?.aborted) break;

    // Check if any dependency failed — skip with warn if so
    const deps = CHECK_DEPENDENCIES[def.id] ?? [];
    const failedDep = deps.find((d) => failedIds.has(d));
    if (failedDep !== undefined) {
      const depLabel = defs.find((d) => d.id === failedDep)?.label ?? failedDep;
      results.set(def.id, {
        id: def.id,
        label: def.label,
        status: 'warn',
        detail: `Skipped: requires ${depLabel} (failed above)`,
        optional: def.optional === true,
      });
      continue;
    }

    let raw: CheckResult;
    try {
      raw = await def.run(signal);
    } catch (err) {
      raw = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    if (signal?.aborted || raw.aborted) break;

    const isOptional = def.optional === true || raw.optional === true;
    const status: 'pass' | 'fail' | 'warn' = raw.ok
      ? 'pass'
      : isOptional
        ? 'warn'
        : 'fail';

    if (status === 'fail') {
      failedIds.add(def.id);
    }

    results.set(def.id, {
      id: def.id,
      label: def.label,
      status,
      detail: raw.detail,
      optional: isOptional,
    });
  }

  return results;
}
