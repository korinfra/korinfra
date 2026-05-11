/**
 * Patches Ink's Text.d.ts to add `| undefined` to optional color/style props.
 *
 * Ink types these as `prop?: T` (no `| undefined`), which conflicts with
 * `exactOptionalPropertyTypes: true` in tsconfig. With EOPT, passing `undefined`
 * explicitly to a `prop?: T` property is a type error because the property must
 * either be absent or have a value of type T.
 *
 * This patch adds `| undefined` so callers can pass `color={expr ?? undefined}`.
 *
 * Run automatically via `postinstall`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = resolve(__dirname, '../node_modules/ink/build/components/Text.d.ts');

let src;
try {
  src = readFileSync(filePath, 'utf8');
} catch {
  // node_modules not installed yet — will be patched on next install
  process.exit(0);
}

// Props that need | undefined added (only if not already patched)
const propsToFix = ['color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse'];

let patched = src;
for (const prop of propsToFix) {
  // Match: `readonly prop?: SomeType;` where the type does NOT already end with `| undefined`
  const pattern = new RegExp(`(readonly ${prop}\\?:\\s*.+?)(?<!\\| undefined)(;)`, 'g');
  patched = patched.replace(pattern, '$1 | undefined$2');
}

if (patched !== src) {
  writeFileSync(filePath, patched, 'utf8');
  console.log('[patch-ink-types] Applied exactOptionalPropertyTypes patch to ink/build/components/Text.d.ts');
} else {
  console.log('[patch-ink-types] Ink Text.d.ts already patched — no changes needed.');
}
