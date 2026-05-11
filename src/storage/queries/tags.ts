import type { Driver } from '../drivers/node.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VirtualTag {
  id?: number;
  resource_id: string;
  resource_type: string;
  dimension: string;
  value: string;
  allocation_pct?: number;
  source?: string;
  confidence?: number;
  created_at?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToTag(row: Record<string, unknown>): VirtualTag {
  const id = row['id'] as number | undefined;
  const created_at = row['created_at'] as string | undefined;
  const result: Record<string, unknown> = {
    resource_id: row['resource_id'],
    resource_type: row['resource_type'],
    dimension: row['dimension'],
    value: row['value'],
    allocation_pct: (row['allocation_pct']) ?? 100.0,
    source: (row['source']) ?? 'manual',
    confidence: (row['confidence']) ?? 1.0,
  };
  if (id !== undefined) result['id'] = id;
  if (created_at !== undefined) result['created_at'] = created_at;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result as any as VirtualTag;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function upsertTag(
  db: Driver,
  resourceId: string,
  resourceType: string,
  dimension: string,
  value: string,
  allocationPct = 100.0,
  source = 'manual',
  confidence = 1.0,
): void {
  db.prepare(`
    INSERT INTO virtual_tags (resource_id, resource_type, dimension, value, allocation_pct, source, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_id, dimension, value) DO UPDATE SET
      resource_type = excluded.resource_type,
      allocation_pct = excluded.allocation_pct,
      source = excluded.source,
      confidence = excluded.confidence
  `).run(resourceId, resourceType, dimension, value, allocationPct, source, confidence);
}

export function listTags(db: Driver, resourceId?: string): VirtualTag[] {
  let rows: Array<Record<string, unknown>>;
  if (resourceId) {
    rows = db.prepare(`
      SELECT id, resource_id, resource_type, dimension, value, allocation_pct, source, confidence, created_at
      FROM virtual_tags WHERE resource_id = ? ORDER BY dimension
    `).all(resourceId) as Array<Record<string, unknown>>;
  } else {
    rows = db.prepare(`
      SELECT id, resource_id, resource_type, dimension, value, allocation_pct, source, confidence, created_at
      FROM virtual_tags ORDER BY resource_id, dimension
    `).all() as Array<Record<string, unknown>>;
  }
  return rows.map(rowToTag);
}

export function listVirtualTags(db: Driver): VirtualTag[] {
  // virtual_tags table only contains virtual (non-native) tags by design
  return listTags(db);
}

export function deleteTag(db: Driver, resourceId: string, dimension: string): void {
  db.prepare('DELETE FROM virtual_tags WHERE resource_id = ? AND dimension = ?').run(
    resourceId,
    dimension,
  );
}
