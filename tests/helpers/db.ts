import { openDriver } from '../../src/storage/drivers/node.js';
import type { Driver } from '../../src/storage/drivers/node.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(_dirname, '../../src/storage/migrations');

export function createTestDb(): Driver {
  const db = openDriver(':memory:');
  db.pragma('foreign_keys = ON');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec(sql);
  }
  return db;
}
