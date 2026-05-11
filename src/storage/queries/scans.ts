import type { Driver } from '../drivers/node.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Scan {
  id: string;
  started_at: string;
  completed_at?: string | null;
  status: string;
  terraform_path?: string | null;
  aws_profile?: string | null;
  aws_region?: string | null;
  total_resources: number;
  total_cost: number;
  total_recommendations: number;
  total_savings: number;
  scenario_a_count: number;
  scenario_b_count: number;
  scenario_c_count: number;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeParse(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw as string) as Record<string, unknown>; } catch { return null; }
}

function rowToScan(row: Record<string, unknown>): Scan {
  const r = row as Record<string, string | number | null | undefined>;
  const created_at = r['created_at'] !== null && r['created_at'] !== undefined ? String(r['created_at']) : undefined;
  const result: Record<string, unknown> = {
    id: String(r['id'] ?? ''),
    started_at: String(r['started_at'] ?? ''),
    completed_at: r['completed_at'] !== null && r['completed_at'] !== undefined ? String(r['completed_at']) : null,
    status: String(r['status'] ?? ''),
    terraform_path: r['terraform_path'] !== null && r['terraform_path'] !== undefined ? String(r['terraform_path']) : null,
    aws_profile: r['aws_profile'] !== null && r['aws_profile'] !== undefined ? String(r['aws_profile']) : null,
    aws_region: r['aws_region'] !== null && r['aws_region'] !== undefined ? String(r['aws_region']) : null,
    total_resources: Number(row['total_resources'] ?? 0),
    total_cost: Number(row['total_cost'] ?? 0),
    total_recommendations: Number(row['total_recommendations'] ?? 0),
    total_savings: Number(row['total_savings'] ?? 0),
    scenario_a_count: Number(row['scenario_a_count'] ?? 0),
    scenario_b_count: Number(row['scenario_b_count'] ?? 0),
    scenario_c_count: Number(row['scenario_c_count'] ?? 0),
    metadata: safeParse(row['metadata']),
  };
  if (created_at !== undefined) result['created_at'] = created_at;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result as any as Scan;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function insertScan(db: Driver, scan: Scan): void {
  db.prepare(`
    INSERT INTO scans (id, started_at, completed_at, status, terraform_path,
      aws_profile, aws_region, total_resources, total_cost,
      total_recommendations, total_savings, scenario_a_count,
      scenario_b_count, scenario_c_count, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scan.id,
    scan.started_at,
    scan.completed_at ?? null,
    scan.status,
    scan.terraform_path ?? null,
    scan.aws_profile ?? null,
    scan.aws_region ?? null,
    scan.total_resources,
    scan.total_cost,
    scan.total_recommendations,
    scan.total_savings,
    scan.scenario_a_count,
    scan.scenario_b_count,
    scan.scenario_c_count,
    scan.metadata ? JSON.stringify(scan.metadata) : null,
  );
}

export function getScan(db: Driver, id: string): Scan | null {
  const row = db.prepare(`
    SELECT id, started_at, completed_at, status, terraform_path,
      aws_profile, aws_region, total_resources, total_cost,
      total_recommendations, total_savings, scenario_a_count,
      scenario_b_count, scenario_c_count, metadata, created_at
    FROM scans WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined;
  return row ? rowToScan(row) : null;
}

export function listScans(db: Driver, limit = 50, offset = 0): Scan[] {
  const rows = db.prepare(`
    SELECT id, started_at, completed_at, status, terraform_path,
      aws_profile, aws_region, total_resources, total_cost,
      (SELECT COUNT(*) FROM recommendations WHERE scan_id = scans.id) AS total_recommendations,
      total_savings, scenario_a_count,
      scenario_b_count, scenario_c_count, metadata, created_at
    FROM scans ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(limit, offset) as Array<Record<string, unknown>>;
  return rows.map(rowToScan);
}

export function updateScanStatus(
  db: Driver,
  id: string,
  status: string,
  completedAt?: string | null,
): void {
  db.prepare(
    'UPDATE scans SET status = ?, completed_at = ? WHERE id = ?',
  ).run(status, completedAt ?? null, id);
}

/**
 * Deletes a scan and all its children (resources, costs, recommendations, api_call_log).
 * Children must be deleted before the parent due to foreign key constraints.
 */
export function deleteScan(db: Driver, id: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM api_call_log WHERE scan_id = ?').run(id);
    db.prepare('DELETE FROM recommendations WHERE scan_id = ?').run(id);
    db.prepare('DELETE FROM costs WHERE scan_id = ?').run(id);
    db.prepare('DELETE FROM resources WHERE scan_id = ?').run(id);
    db.prepare('DELETE FROM scans WHERE id = ?').run(id);
  });
}
