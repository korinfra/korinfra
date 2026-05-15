#!/usr/bin/env node
/**
 * Prepends a new versioned entry to CHANGELOG.md.
 * Usage: node scripts/update-changelog.mjs <version> <notes-file>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , version, notesFile] = process.argv;

if (!version || !notesFile) {
  console.error('Usage: update-changelog.mjs <version> <notes-file>');
  process.exit(1);
}

const notes = readFileSync(notesFile, 'utf8').trim();
const date = new Date().toISOString().split('T')[0];
const newEntry = `## [${version}] — ${date}\n\n${notes}`;

const existing = readFileSync('CHANGELOG.md', 'utf8');

// Insert before the first ## section so it becomes the newest entry.
// Match both `## ` at start of file and `\n## ` further down.
const firstSection = existing.search(/^## /m);
let updated;
if (firstSection !== -1) {
  updated =
    existing.slice(0, firstSection) +
    newEntry +
    '\n\n' +
    existing.slice(firstSection);
} else {
  updated = existing.trimEnd() + '\n\n' + newEntry + '\n';
}

writeFileSync('CHANGELOG.md', updated);
console.log(`CHANGELOG.md updated with entry for ${version}`);
