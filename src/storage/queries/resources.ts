/* eslint-disable @typescript-eslint/no-base-to-string, eqeqeq */
import type { Driver } from '../drivers/node.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Resource {
  id?: string; // composite pk: "{scanId}:{resourceId}"
  scan_id?: string;
  resource_id: string;
  arn?: string | null;
  type: string;
  name?: string | null;
  region?: string | null;
  state?: string | null;
  instance_type?: string | null;
  monthly_cost?: number;
  monthly_cost_source?: 'cost_explorer' | 'pricing_api' | null;
  tags?: Record<string, string> | null;
  utilization?: Record<string, unknown> | null;
  configuration?: Record<string, unknown> | null;
  scenario?: string | null;
  terraform_address?: string | null;
  collected_at?: string | null;
  created_at?: string;
}

export interface ResourceFilters {
  type?: string;
  region?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeParse(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw as string) as Record<string, unknown>; } catch { return null; }
}

function rowToResource(row: Record<string, unknown>): Resource {
  const id = row['id'] != null ? String(row['id']) : undefined;
  const scan_id = row['scan_id'] != null ? String(row['scan_id']) : undefined;
  const created_at = row['created_at'] != null ? String(row['created_at']) : undefined;
  const result: Record<string, unknown> = {
    resource_id: String(row['resource_id'] ?? ''),
    arn: row['arn'] != null ? String(row['arn']) : null,
    type: String(row['type'] ?? ''),
    name: row['name'] != null ? String(row['name']) : null,
    region: row['region'] != null ? String(row['region']) : null,
    state: row['state'] != null ? String(row['state']) : null,
    instance_type: row['instance_type'] != null ? String(row['instance_type']) : null,
    monthly_cost: Number(row['monthly_cost'] ?? 0),
    monthly_cost_source: (row['monthly_cost_source']) ?? null,
    tags: safeParse(row['tags']),
    utilization: safeParse(row['utilization']),
    configuration: safeParse(row['configuration']),
    scenario: row['scenario'] != null ? String(row['scenario']) : null,
    terraform_address: row['terraform_address'] != null ? String(row['terraform_address']) : null,
    collected_at: row['collected_at'] != null ? String(row['collected_at']) : null,
  };
  if (id !== undefined) result['id'] = id;
  if (scan_id !== undefined) result['scan_id'] = scan_id;
  if (created_at !== undefined) result['created_at'] = created_at;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result as any as Resource;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 500;

export function insertResources(db: Driver, scanId: string, resources: Resource[]): void {
  const stmt = db.prepare(`
    INSERT INTO resources (id, scan_id, resource_id, arn, type, name, region,
      state, instance_type, monthly_cost, monthly_cost_source, tags, utilization, configuration,
      scenario, terraform_address, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      scan_id = excluded.scan_id,
      resource_id = excluded.resource_id,
      arn = excluded.arn,
      type = excluded.type,
      name = excluded.name,
      region = excluded.region,
      state = excluded.state,
      instance_type = excluded.instance_type,
      monthly_cost = excluded.monthly_cost,
      monthly_cost_source = excluded.monthly_cost_source,
      tags = excluded.tags,
      utilization = excluded.utilization,
      configuration = excluded.configuration,
      scenario = excluded.scenario,
      terraform_address = excluded.terraform_address,
      collected_at = excluded.collected_at
  `);

  db.transaction(() => {
    for (let i = 0; i < resources.length; i += CHUNK_SIZE) {
      const chunk = resources.slice(i, i + CHUNK_SIZE);
      for (const r of chunk) {
        const rowId = `${scanId}:${r.resource_id}`;
        stmt.run(
          rowId,
          scanId,
          r.resource_id,
          r.arn ?? null,
          r.type,
          r.name ?? null,
          r.region ?? null,
          r.state ?? null,
          r.instance_type ?? null,
          r.monthly_cost ?? 0,
          r.monthly_cost_source ?? null,
          r.tags ? JSON.stringify(r.tags) : null,
          r.utilization ? JSON.stringify(r.utilization) : null,
          r.configuration ? JSON.stringify(r.configuration) : null,
          r.scenario ?? null,
          r.terraform_address ?? null,
          r.collected_at ?? null,
        );
      }
    }
  });
}

export function listResources(
  db: Driver,
  scanId: string,
  filters?: ResourceFilters,
): Resource[] {
  let sql = `
    SELECT id, scan_id, resource_id, arn, type, name, region,
      state, instance_type, monthly_cost, monthly_cost_source, tags, utilization, configuration,
      scenario, terraform_address, collected_at, created_at
    FROM resources WHERE scan_id = ?
  `;
  const params: Array<string | number> = [scanId];

  if (filters?.type) {
    sql += ' AND type = ?';
    params.push(filters.type);
  }
  if (filters?.region) {
    sql += ' AND region = ?';
    params.push(filters.region);
  }

  sql += ' ORDER BY monthly_cost DESC, resource_id ASC';

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToResource);
}
/* eslint-enable @typescript-eslint/no-base-to-string, eqeqeq */
