#!/usr/bin/env tsx
/**
 * Cross-platform binary compilation using `bun build --compile`.
 *
 * Uses bun:sqlite (built into Bun's runtime) instead of better-sqlite3,
 * so the resulting binary has zero native addon dependencies.
 *
 * Targets:
 *   linux-x64
 *   darwin-x64
 *   darwin-arm64
 *   windows-x64
 */

import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

interface Target {
  target: string;
  outName: string;
}

const targets: Target[] = [
  { target: 'bun-linux-x64',    outName: 'korinfra-linux-x64' },
  { target: 'bun-darwin-x64',   outName: 'korinfra-darwin-x64' },
  { target: 'bun-darwin-arm64', outName: 'korinfra-darwin-arm64' },
  { target: 'bun-windows-x64',  outName: 'korinfra-windows-x64.exe' },
];

// Verify bun is installed before attempting compilation
try {
  execSync('bun --version', { stdio: 'pipe' });
} catch {
  console.error(
    'Error: bun is not installed.\n\n' +
    'Binary compilation requires Bun (https://bun.sh).\n' +
    'Install it with:  npm install -g bun\n' +
    '              or:  curl -fsSL https://bun.sh/install | bash\n',
  );
  process.exit(1);
}

const outDir = join(process.cwd(), 'bin');
mkdirSync(outDir, { recursive: true });

const entryPoint = join(process.cwd(), 'src', 'index.ts');

for (const { target, outName } of targets) {
  const outPath = join(outDir, outName);
  console.log(`Compiling ${target} → bin/${outName}`);

  execSync(
    [
      'bun build --compile',
      `--target ${target}`,
      `--outfile "${outPath}"`,
      // Externals — packages incompatible with Bun's bundler:
      // - performance: @cdktf/hcl2json WASM bridge polyfill (Bun has it built-in)
      // Note: pino is NOT externalized — logger.ts detects Bun compiled mode
      // and falls back to a minimal console logger, avoiding thread-stream/real-require.
      '--external performance',
      `"${entryPoint}"`,
    ].join(' '),
    { stdio: 'inherit' },
  );
}

console.log('\nAll binaries compiled to bin/');
