/* eslint-disable eqeqeq */
import type { Driver } from '../drivers/node.js';
import { redact } from '../../redaction/redactor.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum byte length for any logged payload string before truncation. */
const MAX_PAYLOAD_SIZE = 256 * 1024; // 256 KB

function truncatePayload(value: string): string {
  if (value.length <= MAX_PAYLOAD_SIZE) return value;
  return value.slice(0, MAX_PAYLOAD_SIZE) + '...[TRUNCATED]';
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApiCallEntry {
  id?: number;
  scan_id?: string | null;
  service: string;
  operation: string;
  region?: string | null;
  estimated_cost?: number;
  duration_ms?: number | null;
  status: string;
  error_message?: string | null;
  created_at?: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function insertApiCall(db: Driver, entry: ApiCallEntry): void {
  db.prepare(`
    INSERT INTO api_call_log (scan_id, service, operation, region,
      estimated_cost, duration_ms, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.scan_id ?? null,
    entry.service,
    entry.operation,
    entry.region ?? null,
    entry.estimated_cost ?? 0,
    entry.duration_ms ?? null,
    entry.status,
    entry.error_message != null ? redact(truncatePayload(entry.error_message).slice(0, 2048), 'strict') : null,
  );
}

export function listApiCalls(
  db: Driver,
  since?: string,
  service?: string,
  limit: number = 1000,
): ApiCallEntry[] {
  let sql = `
    SELECT id, scan_id, service, operation, region,
      estimated_cost, duration_ms, status, error_message, created_at
    FROM api_call_log WHERE 1=1
  `;
  const params: Array<string | number> = [];

  if (since) {
    sql += ' AND created_at >= ?';
    params.push(since);
  }
  if (service) {
    sql += ' AND service = ?';
    params.push(service);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const id = row['id'] as number | undefined;
    const created_at = row['created_at'] as string | undefined;
    return {
      ...(id !== undefined ? { id } : {}),
      scan_id: row['scan_id'] as string | null,
      service: row['service'] as string,
      operation: row['operation'] as string,
      region: row['region'] as string | null,
      estimated_cost: (row['estimated_cost'] as number) ?? 0,
      duration_ms: row['duration_ms'] as number | null,
      status: row['status'] as string,
      error_message: row['error_message'] as string | null,
      ...(created_at !== undefined ? { created_at } : {}),
    };
  });
}
/* eslint-enable eqeqeq */
