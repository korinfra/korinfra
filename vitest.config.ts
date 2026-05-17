import { defineConfig } from 'vitest/config';

const isCI = process.env.CI === 'true';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    pool: 'forks',
    poolOptions: {
      forks: {
        // Cap fork count to match the 2-core GitHub-hosted runners.
        // Unbounded forks oversubscribe CPU and cause OOM/contention.
        maxForks: isCI ? 2 : undefined,
        minForks: isCI ? 1 : undefined,
      },
    },
    // In GitHub Actions, also emit annotations inline on the PR diff.
    reporters: isCI ? ['default', 'github-actions'] : ['default'],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.{ts,tsx}', 'src/**/index.ts'],
      reportOnFailure: true,
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
    testTimeout: 30000,
  },
});
