import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  name: string;
  version: string;
  description: string;
}

export interface VersionInfo {
  version: string;
  name: string;
  description: string;
}

let cached: PackageJson | undefined;

function readPackageJson(): PackageJson {
  if (cached) return cached;

  try {
    // Walk up from the current file to find package.json
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'package.json');
      try {
        cached = JSON.parse(fs.readFileSync(candidate, 'utf8')) as PackageJson;
        return cached;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        // ENOENT — try parent directory
      }
      dir = path.dirname(dir);
    }

    // Fallback: try cwd
    try {
      cached = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as PackageJson;
      return cached;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  } catch (err: unknown) {
    // logger may not be initialized yet, use console.warn (allowed by lint rule)
    if (process.env['KORINFRA_DEBUG']) {
      console.warn('[version] Failed to read package.json:', err instanceof Error ? err.message : String(err));
    }
    return { name: 'korinfra', version: 'unknown', description: '' };
  }

  cached = { name: 'korinfra', version: 'unknown', description: '' };
  return cached;
}

/** Returns the package version string, e.g. "0.1.0". */
export function getVersion(): string {
  return readPackageJson().version;
}

/** Returns name, version, and description from package.json. */
export function getVersionInfo(): VersionInfo {
  const pkg = readPackageJson();
  return {
    version: pkg.version,
    name: pkg.name,
    description: pkg.description,
  };
}
