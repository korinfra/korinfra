import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../helpers/db.js';
import {
  upsertTag,
  listTags,
  listVirtualTags,
  deleteTag,
} from '../../../src/storage/queries/tags.js';
import type { Driver } from '../../../src/storage/drivers/node.js';

// ─── tags CRUD ───────────────────────────────────────────────────────────────

describe('storage — tags CRUD', () => {
  let db: Driver;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('inserts, upserts, isolates, deletes, and applies defaults', () => {
    // basic insert + retrieve
    upsertTag(db, 'i-0a1b2c3d4e5f67890', 'ec2_instance', 'Environment', 'production');
    const tags = listTags(db, 'i-0a1b2c3d4e5f67890');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.resource_type).toBe('ec2_instance');
    expect(tags[0]!.dimension).toBe('Environment');
    expect(tags[0]!.value).toBe('production');

    // default fields
    expect(tags[0]!.allocation_pct).toBe(100);
    expect(tags[0]!.source).toBe('manual');
    expect(tags[0]!.confidence).toBe(1.0);

    // upsert same (resource_id, dimension, value) → updates metadata
    upsertTag(db, 'i-0a1b2c3d4e5f67890', 'ec2_instance', 'Environment', 'production', 90, 'inferred', 0.95);
    const upserted = listTags(db, 'i-0a1b2c3d4e5f67890');
    expect(upserted).toHaveLength(1);
    expect(upserted[0]!.allocation_pct).toBe(90);
    expect(upserted[0]!.source).toBe('inferred');

    // same dimension different values → separate rows
    upsertTag(db, 'i-0a1b2c3d4e5f67890', 'ec2_instance', 'Environment', 'staging');
    expect(listTags(db, 'i-0a1b2c3d4e5f67890')).toHaveLength(2);

    // per-resource isolation
    upsertTag(db, 'prod-postgres-01', 'rds_instance', 'Team', 'data');
    expect(listTags(db, 'i-0a1b2c3d4e5f67890').every((t) => t.resource_id === 'i-0a1b2c3d4e5f67890')).toBe(true);
    expect(listTags(db, 'prod-postgres-01')).toHaveLength(1);

    // returns empty for unknown resource
    expect(listTags(db, 'unknown-resource')).toHaveLength(0);

    // listTags without resourceId returns all
    const allTags = listTags(db);
    expect(allTags.length).toBeGreaterThanOrEqual(3);

    // deleteTag removes specific dimension
    upsertTag(db, 'i-del', 'ec2_instance', 'Name', 'prod-web-01');
    upsertTag(db, 'i-del', 'ec2_instance', 'Environment', 'production');
    deleteTag(db, 'i-del', 'Name');
    const after = listTags(db, 'i-del');
    expect(after).toHaveLength(1);
    expect(after[0]!.dimension).toBe('Environment');

    // deleteTag on non-existent does not throw
    expect(() => deleteTag(db, 'i-nonexistent', 'Name')).not.toThrow();
  });
});

// ─── listVirtualTags ─────────────────────────────────────────────────────────

describe('storage — listVirtualTags', () => {
  let db: Driver;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns all virtual tags across all resources and empty when none', () => {
    expect(listVirtualTags(db)).toHaveLength(0);

    upsertTag(db, 'i-0a1b2c3d4e5f67890', 'ec2_instance', 'Team', 'platform');
    upsertTag(db, 'prod-postgres-01', 'rds_instance', 'Team', 'data');
    expect(listVirtualTags(db)).toHaveLength(2);
  });
});
