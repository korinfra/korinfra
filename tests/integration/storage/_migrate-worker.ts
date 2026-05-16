// Worker invoked by the regression test for issue #21.
// Receives dbPath from argv[2], signals readiness via IPC, waits for the parent
// to send 'go', then opens the DB (which triggers migrate()) and exits.

import { getDb, closeDb } from '../../../src/storage/db.js';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('missing dbPath argument');
  process.exit(2);
}

// Synchronisation barrier: tell parent we're loaded, then wait for the
// release signal so concurrent workers all enter migrate() together.
await new Promise<void>((resolve) => {
  process.on('message', (msg) => {
    if (msg === 'go') resolve();
  });
  process.send?.('ready');
});

try {
  const db = getDb(dbPath);
  db.prepare('SELECT COUNT(*) FROM schema_migrations').get();
  closeDb();
  process.exit(0);
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(1);
}
