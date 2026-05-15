#!/usr/bin/env node
/**
 * Extracts the body of a specific version's entry from CHANGELOG.md.
 * Usage: node scripts/extract-changelog-entry.mjs <version>
 * Output: entry body (without the ## header line) written to stdout
 */
import { readFileSync } from 'node:fs';

const [, , version] = process.argv;

if (!version) {
  console.error('Usage: extract-changelog-entry.mjs <version>');
  process.exit(1);
}

const changelog = readFileSync('CHANGELOG.md', 'utf8');

// Match content between this version's header and the next ## [ section (or EOF).
// Semver build metadata can contain `+` and other regex-special chars, so escape all.
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(
  `## \\[${escaped}\\][^\n]*\n(.*?)(?=\n## \\[|$)`,
  's',
);
const match = changelog.match(pattern);

if (!match) {
  process.stderr.write(`Version ${version} not found in CHANGELOG.md\n`);
  process.exit(1);
}

process.stdout.write(match[1].trim());
