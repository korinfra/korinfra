import os from 'node:os';
import path from 'node:path';

export const KORINFRA_DIR = '.korinfra';

/**
 * Returns the project-local config directory: <cwd>/.korinfra
 * All config, thresholds, DB, and .env files live here — like .git/ or .terraform/.
 */
export function defaultConfigDir(): string {
  return path.join(process.cwd(), KORINFRA_DIR);
}

/** Returns the default config file path: <cwd>/.korinfra/config.yaml */
export function defaultConfigPath(): string {
  return path.join(defaultConfigDir(), 'config.yaml');
}

/** Returns the default thresholds file path: <cwd>/.korinfra/thresholds.yaml */
export function defaultThresholdsPath(): string {
  return path.join(defaultConfigDir(), 'thresholds.yaml');
}

/**
 * Returns `.korinfra` directory in the given cwd (default: process.cwd()).
 * This is the project-local config directory — like .git/, .terraform/, etc.
 */
export function projectkorinfraDir(cwd?: string): string {
  return path.join(cwd ?? process.cwd(), KORINFRA_DIR);
}

/**
 * Returns the project-local config path: <cwd>/.korinfra/config.yaml
 */
export function projectConfigPath(cwd?: string): string {
  return path.join(projectkorinfraDir(cwd), 'config.yaml');
}

/**
 * Returns the project-local thresholds path: <cwd>/.korinfra/thresholds.yaml
 */
export function projectThresholdsPath(cwd?: string): string {
  return path.join(projectkorinfraDir(cwd), 'thresholds.yaml');
}

/**
 * Returns the project-local DB path: <cwd>/.korinfra/data.db
 */
export function projectStoragePath(cwd?: string): string {
  return path.join(projectkorinfraDir(cwd), 'data.db');
}

/** Returns the default SQLite database path: <cwd>/.korinfra/data.db */
export function defaultStoragePath(): string {
  return projectStoragePath();
}

/**
 * Expands a leading ~ or ~/ to the user's home directory.
 * Mirrors Go's expandPath.
 */
export function expandPath(p: string): string {
  if (p === '~') return path.resolve(os.homedir());
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.resolve(path.join(os.homedir(), p.slice(2)));
  }
  return path.resolve(p);
}

/**
 * Returns the given path expanded, or the default config path if blank.
 */
export function resolveConfigPath(p?: string): string {
  if (!p || p.trim() === '') return defaultConfigPath();
  return expandPath(p);
}
