import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: 'hidden',
  treeshake: true,
  minify: true,
  platform: 'node',
  banner: {
    js: '#!/usr/bin/env node',
  },
  checks: {
    pluginTimings: false,
  },
  deps: {
    onlyBundle: false,
    neverBundle: [
      'better-sqlite3',
      'bun:sqlite',
    ],
  },
});
