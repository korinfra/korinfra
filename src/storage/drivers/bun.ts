import type { Driver } from './node.js';

// Stub: bun:sqlite support is planned but not yet implemented.
// Use the node driver (better-sqlite3) instead.
export function openDriver(_path: string): Driver {
  throw new Error('bun:sqlite driver is not yet implemented — use the node driver (better-sqlite3)');
}
