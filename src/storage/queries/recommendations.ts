/* eslint-disable @typescript-eslint/no-base-to-string, eqeqeq */
import type { Driver } from '../drivers/node.js';
import { redact, redactObject } from '../../redaction/redactor.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Recommendation {
  id: string;
  scan_id: string;
  resource_id?: string | null;
  resource_type?: string | null;
  type: string;
  title: string;
  description?: string | null;
  reasoning?: string | null;
  estimated_savings?: number;
  confidence?: number;
  quality_score?: number;
  impact?: string;
  risk?: string;
  status?: string;
  current_config?: Record<string, unknown> | null;
  suggested_config?: Record<string, unknown> | null;
  patch_content?: string | null;
  file_path?: string | null;
  implementation_steps?: string[] | null;
  ai_model?: string | null;
  scenario?: string | null;
  applied_at?: string | null;
  dismissed_at?: string | null;
  dismiss_reason?: string | null;
  created_at?: string;
}

export interface RecommendationFilters {
  type?: string;
  impact?: string;
  status?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeParse(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw as string) as Record<string, unknown>; } catch { return null; }
}

function rowToRec(row: Record<string, unknown>): Recommendation {
  const created_at = row['created_at'] != null ? String(row['created_at']) : undefined;
  const result: Record<string, unknown> = {
    id: String(row['id'] ?? ''),
    scan_id: String(row['scan_id'] ?? ''),
    resource_id: row['resource_id'] != null ? String(row['resource_id']) : null,
    resource_type: row['resource_type'] != null ? String(row['resource_type']) : null,
    type: String(row['type'] ?? ''),
    title: String(row['title'] ?? ''),
    description: row['description'] != null ? String(row['description']) : null,
    reasoning: row['reasoning'] != null ? String(row['reasoning']) : null,
    estimated_savings: Number(row['estimated_savings'] ?? 0),
    confidence: Number(row['confidence'] ?? 0),
    quality_score: Number(row['quality_score'] ?? 0),
    impact: row['impact'] != null ? String(row['impact']) : 'medium',
    risk: row['risk'] != null ? String(row['risk']) : 'low',
    status: row['status'] != null ? String(row['status']) : 'draft',
    current_config: safeParse(row['current_config']),
    suggested_config: safeParse(row['suggested_config']),
    patch_content: row['patch_content'] != null ? String(row['patch_content']) : null,
    file_path: row['file_path'] != null ? String(row['file_path']) : null,
    implementation_steps: (() => {
      if (!row['implementation_steps']) return null;
      try { return JSON.parse(row['implementation_steps'] as string) as string[]; } catch { return null; }
    })(),
    ai_model: row['ai_model'] != null ? String(row['ai_model']) : null,
    scenario: row['scenario'] != null ? String(row['scenario']) : null,
    applied_at: row['applied_at'] != null ? String(row['applied_at']) : null,
    dismissed_at: row['dismissed_at'] != null ? String(row['dismissed_at']) : null,
    dismiss_reason: row['dismiss_reason'] != null ? String(row['dismiss_reason']) : null,
  };
  if (created_at !== undefined) result['created_at'] = created_at;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result as any as Recommendation;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function insertRecommendations(
  db: Driver,
  scanId: string,
  recs: Recommendation[],
): void {
  const stmt = db.prepare(`
    INSERT INTO recommendations (id, scan_id, resource_id, resource_type, type,
      title, description, reasoning, estimated_savings, confidence,
      quality_score, impact, risk, status, current_config, suggested_config,
      patch_content, file_path, implementation_steps, ai_model, scenario)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const r of recs) {
      stmt.run(
        r.id,
        scanId,
        r.resource_id ?? null,
        r.resource_type ?? null,
        r.type,
        r.title,
        r.description ?? null,
        r.reasoning ?? null,
        r.estimated_savings ?? 0,
        r.confidence ?? 0,
        r.quality_score ?? 0,
        r.impact ?? 'medium',
        r.risk ?? 'low',
        r.status ?? 'draft',
        r.current_config ? JSON.stringify(redactObject(r.current_config, 'moderate')) : null,
        r.suggested_config ? JSON.stringify(redactObject(r.suggested_config, 'moderate')) : null,
        r.patch_content ? redact(r.patch_content, 'minimal') : null,
        r.file_path ?? null,
        r.implementation_steps ? JSON.stringify(r.implementation_steps) : null,
        r.ai_model ?? null,
        r.scenario ?? null,
      );
    }
  });
}

/**
 * Upsert recommendations by (resource_id, type):
 * - If a 'draft' rec for the same resource_id+type already exists, update it
 *   in-place (preserving original id and created_at) so unfixed recommendations
 *   survive re-scans without duplicating.
 * - Recs without resource_id are always inserted (not resource-specific).
 */
export function upsertRecommendations(
  db: Driver,
  scanId: string,
  recs: Recommendation[],
): void {
  const findExisting = db.prepare(`
    SELECT id FROM recommendations
    WHERE resource_id IS NOT NULL AND resource_id = ? AND type = ? AND status = 'draft'
    LIMIT 1
  `);

  const updateStmt = db.prepare(`
    UPDATE recommendations SET
      scan_id = ?, resource_type = ?, title = ?, description = ?, reasoning = ?,
      estimated_savings = ?, confidence = ?, quality_score = ?,
      impact = ?, risk = ?, current_config = ?, suggested_config = ?,
      patch_content = ?, file_path = ?, implementation_steps = ?,
      ai_model = ?, scenario = ?
    WHERE id = ? AND status = 'draft'
  `);

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO recommendations (id, scan_id, resource_id, resource_type, type,
      title, description, reasoning, estimated_savings, confidence,
      quality_score, impact, risk, status, current_config, suggested_config,
      patch_content, file_path, implementation_steps, ai_model, scenario)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const r of recs) {
      const existingRow = r.resource_id != null
        ? (findExisting.get(r.resource_id, r.type) as { id: string } | undefined)
        : undefined;

      if (existingRow != null) {
        updateStmt.run(
          scanId,
          r.resource_type ?? null,
          r.title,
          r.description ?? null,
          r.reasoning ?? null,
          r.estimated_savings ?? 0,
          r.confidence ?? 0,
          r.quality_score ?? 0,
          r.impact ?? 'medium',
          r.risk ?? 'low',
          r.current_config ? JSON.stringify(redactObject(r.current_config, 'moderate')) : null,
          r.suggested_config ? JSON.stringify(redactObject(r.suggested_config, 'moderate')) : null,
          r.patch_content ? redact(r.patch_content, 'minimal') : null,
          r.file_path ?? null,
          r.implementation_steps ? JSON.stringify(r.implementation_steps) : null,
          r.ai_model ?? null,
          r.scenario ?? null,
          existingRow.id,
        );
      } else {
        insertStmt.run(
          r.id,
          scanId,
          r.resource_id ?? null,
          r.resource_type ?? null,
          r.type,
          r.title,
          r.description ?? null,
          r.reasoning ?? null,
          r.estimated_savings ?? 0,
          r.confidence ?? 0,
          r.quality_score ?? 0,
          r.impact ?? 'medium',
          r.risk ?? 'low',
          r.status ?? 'draft',
          r.current_config ? JSON.stringify(redactObject(r.current_config, 'moderate')) : null,
          r.suggested_config ? JSON.stringify(redactObject(r.suggested_config, 'moderate')) : null,
          r.patch_content ? redact(r.patch_content, 'minimal') : null,
          r.file_path ?? null,
          r.implementation_steps ? JSON.stringify(r.implementation_steps) : null,
          r.ai_model ?? null,
          r.scenario ?? null,
        );
      }
    }
  });
}

export function listRecommendations(
  db: Driver,
  scanId: string,
  filters?: RecommendationFilters,
): Recommendation[] {
  let sql = `
    SELECT id, scan_id, resource_id, resource_type, type, title, description,
      reasoning, estimated_savings, confidence, quality_score, impact, risk,
      status, current_config, suggested_config, patch_content, file_path,
      implementation_steps, ai_model, scenario, applied_at, dismissed_at,
      dismiss_reason, created_at
    FROM recommendations WHERE scan_id = ?
  `;
  const params: unknown[] = [scanId];

  if (filters?.type) {
    sql += ' AND type = ?';
    params.push(filters.type);
  }
  if (filters?.impact) {
    sql += ' AND impact = ?';
    params.push(filters.impact);
  }
  if (filters?.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  }

  sql += ` ORDER BY estimated_savings DESC,
    CASE impact WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
    CASE risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
    id DESC`;

  const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>;
  return rows.map(rowToRec);
}

export function updateRecommendationStatus(
  db: Driver,
  id: string,
  status: 'applied' | 'dismissed',
  dismissReason?: string,
): void {
  if (status === 'applied') {
    db.prepare(
      "UPDATE recommendations SET status = 'applied', applied_at = datetime('now') WHERE id = ?",
    ).run(id);
  } else {
    db.prepare(
      "UPDATE recommendations SET status = 'dismissed', dismissed_at = datetime('now'), dismiss_reason = ? WHERE id = ?",
    ).run(dismissReason ?? null, id);
  }
}

export function getRecommendationById(
  db: Driver,
  id: string,
): Recommendation | null {
  const row = db.prepare(
    `SELECT id, scan_id, resource_id, resource_type, type, title, description,
      reasoning, estimated_savings, confidence, quality_score, impact, risk,
      status, current_config, suggested_config, patch_content, file_path,
      implementation_steps, ai_model, scenario, applied_at, dismissed_at,
      dismiss_reason, created_at
     FROM recommendations WHERE id = ?`
  ).get(id) as Record<string, unknown> | undefined;
  return row ? rowToRec(row) : null;
}

export function listPendingRecommendations(
  db: Driver,
  limit = 100,
): Array<Recommendation & { scan_started_at: string }> {
  // Only show recs from the latest completed scan — avoids stale/duplicate data from old scans.
  const latestScan = db.prepare(
    `SELECT id, started_at FROM scans WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1`
  ).get() as { id: string; started_at: string } | undefined;
  if (!latestScan) return [];

  const rows = db.prepare(`
    SELECT r.id, r.scan_id, r.resource_id, r.resource_type, r.type, r.title,
      r.description, r.reasoning, r.estimated_savings, r.confidence,
      r.quality_score, r.impact, r.risk, r.status, r.current_config,
      r.suggested_config, r.patch_content, r.file_path, r.implementation_steps,
      r.ai_model, r.scenario, r.applied_at, r.dismissed_at, r.dismiss_reason,
      r.created_at, s.started_at AS scan_started_at
    FROM recommendations r
    JOIN scans s ON r.scan_id = s.id
    WHERE r.scan_id = ? AND r.status = 'draft'
    ORDER BY r.estimated_savings DESC, r.created_at DESC, r.id DESC
    LIMIT ?
  `).all(latestScan.id, limit) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    ...rowToRec(row),
    scan_started_at: String(row['scan_started_at'] ?? ''),
  }));
}
/* eslint-enable @typescript-eslint/no-base-to-string, eqeqeq */
