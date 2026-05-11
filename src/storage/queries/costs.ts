import type { Driver } from '../drivers/node.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CostEntry {
  id?: number;
  scan_id?: string;
  service_name: string;
  region?: string | null;
  cost_date: string; // DATE: "YYYY-MM-DD"
  daily_cost?: number;
  monthly_cost?: number;
  currency?: string | null;
  usage_type?: string | null;
  tags?: Record<string, string> | null;
  created_at?: string;
}

export interface CostByService {
  service_name: string;
  total_monthly_cost: number;
  total_daily_cost: number;
  entry_count: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeParse(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw as string) as Record<string, unknown>; } catch { return null; }
}

/* eslint-disable @typescript-eslint/no-base-to-string, eqeqeq */
function rowToCost(row: Record<string, unknown>): CostEntry {
  const id = row['id'] != null ? Number(row['id']) : undefined;
  const created_at = row['created_at'] != null ? String(row['created_at']) : undefined;
  const result: Record<string, unknown> = {
    scan_id: String(row['scan_id'] ?? ''),
    service_name: String(row['service_name'] ?? ''),
    region: row['region'] != null ? String(row['region']) : null,
    cost_date: String(row['cost_date'] ?? ''),
    daily_cost: Number(row['daily_cost'] ?? 0),
    monthly_cost: Number(row['monthly_cost'] ?? 0),
    currency: row['currency'] != null ? String(row['currency']) : null,
    usage_type: row['usage_type'] != null ? String(row['usage_type']) : null,
    tags: safeParse(row['tags']),
  };
  if (id !== undefined) result['id'] = id;
  if (created_at !== undefined) result['created_at'] = created_at;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result as any as CostEntry;
}
/* eslint-enable @typescript-eslint/no-base-to-string, eqeqeq */

// ─── Queries ──────────────────────────────────────────────────────────────────

export function insertCosts(db: Driver, scanId: string, costs: CostEntry[]): void {
  const stmt = db.prepare(`
    INSERT INTO costs (scan_id, service_name, region, cost_date,
      daily_cost, monthly_cost, currency, usage_type, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const c of costs) {
      stmt.run(
        scanId,
        c.service_name,
        c.region ?? null,
        c.cost_date,
        c.daily_cost ?? 0,
        c.monthly_cost ?? 0,
        c.currency ?? 'USD',
        c.usage_type ?? null,
        c.tags ? JSON.stringify(c.tags) : null,
      );
    }
  });
}

export function listCosts(db: Driver, scanId: string, limit = 500): CostEntry[] {
  const rows = db.prepare(`
    SELECT id, scan_id, service_name, region, cost_date,
      daily_cost, monthly_cost, currency, usage_type, tags, created_at
    FROM costs WHERE scan_id = ? ORDER BY monthly_cost DESC, id ASC
    LIMIT ?
  `).all(scanId, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToCost);
}

export function aggregateCostsByService(db: Driver, scanId: string): CostByService[] {
  return db.prepare(`
    SELECT service_name,
      SUM(monthly_cost) AS total_monthly_cost,
      SUM(daily_cost)   AS total_daily_cost,
      COUNT(*)          AS entry_count
    FROM costs WHERE scan_id = ?
    GROUP BY service_name
    ORDER BY total_monthly_cost DESC
  `).all(scanId) as CostByService[];
}
