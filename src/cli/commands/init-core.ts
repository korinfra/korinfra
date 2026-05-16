/**
 * Pure logic for initialising korinfra — no Ink/React dependency.
 * Used by both the TUI wizard (init.tsx) and the headless handler (headless.ts).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';

import { saveConfig } from '../../config/index.js';
import { defaults } from '../../config/defaults.js';
import { getDb } from '../../storage/db.js';
import { logger } from '../../utils/logger.js';
import { safeReadFile, safeWriteFile } from '../../utils/safe-fs.js';

// ─── Profile detection ────────────────────────────────────────────────────────

export function detectAwsProfiles(): string[] {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.aws', 'config'),
    path.join(home, '.aws', 'credentials'),
  ];

  const profileSet = new Set<string>();
  let anyFileFound = false;

  for (const file of candidates) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      anyFileFound = true;
      for (const line of content.split('\n')) {
        const m = line.match(/^\[(?:profile\s+)?([^\]]+)\]/);
        if (m?.[1]) profileSet.add(m[1].trim());
      }
    } catch (e) {
      logger.debug({ err: e }, '[init] Could not read AWS profile file');
    }
  }

  if (anyFileFound && !profileSet.has('default')) {
    profileSet.add('default');
  }

  return Array.from(profileSet);
}

// ─── API key validation ───────────────────────────────────────────────────────

export function validateApiKey(provider: 'anthropic', key: string): boolean {
  return provider === 'anthropic' ? /^sk-ant-api/.test(key) : true;
}

// ─── Config write ─────────────────────────────────────────────────────────────

interface WritekorinfraConfigOptions {
  /** AWS profile name; 'default' leaves aws.default_profile blank */
  profile: string;
  /** AI provider selection */
  aiProvider: 'anthropic' | 'none';
  /** Anthropic API key — only used when aiProvider === 'anthropic' */
  aiKey?: string;
  /** GitHub personal access token — written to .korinfra/.env if provided */
  githubToken?: string;
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
}

interface WritekorinfraConfigResult {
  configPath: string;
  envSaved: boolean;
  configExisted: boolean;
}

/**
 * Writes .korinfra/config.yaml, optional .env (for the API key),
 * updates .gitignore, and initialises the SQLite database.
 *
 * This is the same logic that was previously inlined in init.tsx's `writing`
 * useEffect — extracted here so both TUI and headless paths share it.
 */
export async function writekorinfraConfig(
  options: WritekorinfraConfigOptions,
): Promise<WritekorinfraConfigResult> {
  const { profile, aiProvider, aiKey = '', githubToken, cwd = process.cwd() } = options;

  const cfg = defaults();
  if (profile !== 'default') {
    cfg.aws.default_profile = profile;
  }
  if (aiProvider !== 'none' && aiKey) {
    cfg.ai.provider = 'claude';
    cfg.ai.api_key_env = 'ANTHROPIC_API_KEY';
  }

  const projectDir = path.join(cwd, '.korinfra');
  fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  // mkdir mode only applies on creation; tighten an existing .korinfra/ that
  // a previous version may have left at 0o755, and refuse if it is a symlink.
  if (fs.lstatSync(projectDir).isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked .korinfra directory: ${projectDir}`);
  }
  try { fs.chmodSync(projectDir, 0o700); } catch { /* windows */ }

  const outPath = path.join(projectDir, 'config.yaml');
  const thresholdsOutPath = path.join(projectDir, 'thresholds.yaml');
  const configAlreadyExisted = fs.existsSync(outPath);

  cfg.storage.path = path.join(projectDir, 'data.db');
  await saveConfig(cfg, outPath);

  // 'wx' (O_CREAT|O_EXCL) refuses to follow a pre-existing symlink.
  try {
    const thresholdsDefaults = { scan: cfg.scan, anomaly: cfg.anomaly };
    fs.writeFileSync(
      thresholdsOutPath,
      yaml.dump(thresholdsDefaults, { indent: 2, lineWidth: 120, noRefs: true, sortKeys: false }),
      { flag: 'wx', encoding: 'utf8', mode: 0o600 },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // File already exists — another process created it concurrently; skip.
  }

  let envSaved = false;
  if (aiKey) {
    // Validate key: printable ASCII only, no whitespace/control chars
    const safeKey = aiKey.replace(/[^\x21-\x7E]/g, '');
    if (safeKey.length < 10) {
      logger.warn('API key appears invalid (too short after sanitization), skipping .env write');
    } else {
      const envFilePath = path.join(projectDir, '.env');
      safeWriteFile(envFilePath, `ANTHROPIC_API_KEY=${safeKey}\n`, { mode: 0o600, dirMode: 0o700 });
      envSaved = true;

      // Add sensitive files to .gitignore
      const gitignorePath = path.join(cwd, '.gitignore');
      const entriesToAdd = ['.korinfra/.env', '.korinfra/data.db'];
      try {
        const existing = fs.readFileSync(gitignorePath, 'utf8');
        const lines = existing.split('\n').map((l) => l.trim());
        const missing = entriesToAdd.filter((e) => !lines.includes(e));
        if (missing.length > 0) {
          const suffix = existing.endsWith('\n') ? '' : '\n';
          fs.writeFileSync(gitignorePath, existing + suffix + missing.join('\n') + '\n', 'utf8');
        }
      } catch {
        logger.debug({}, '[init] .gitignore not found, creating it');
        fs.writeFileSync(gitignorePath, entriesToAdd.join('\n') + '\n', 'utf8');
      }
    }
  }

  if (githubToken) {
    const safeToken = githubToken.replace(/[^\x21-\x7E]/g, '');
    if (safeToken.length >= 10) {
      const envFilePath = path.join(projectDir, '.env');
      let existing = '';
      try { existing = safeReadFile(envFilePath); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (!existing.includes('GITHUB_TOKEN=')) {
        safeWriteFile(envFilePath, existing + `GITHUB_TOKEN=${safeToken}\n`, { mode: 0o600, dirMode: 0o700 });
      }
    }
  }

  // Eagerly create the DB so data.db exists on disk right away
  try {
    getDb();
  } catch (e) {
    logger.debug({ err: e }, '[init] DB init deferred, will be created on first use');
  }

  return {
    configPath: outPath,
    envSaved,
    configExisted: configAlreadyExisted,
  };
}
