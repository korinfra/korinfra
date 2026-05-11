import type { Formatter, ScanReport } from './formatter.js';

/**
 * Renders the ScanReport as multi-section CSV for Excel/Sheets import.
 * Sections: summary, cost by service (aggregated), resources, recommendations, daily costs.
 * Commas and quotes are escaped per RFC 4180.
 * Formula injection prevented with a leading apostrophe on dangerous cells.
 */
export class CSVFormatter implements Formatter {
  readonly contentType = 'text/csv';
  readonly fileExtension = 'csv';

  format(data: ScanReport): string {
    const currency = data.costs[0]?.currency ?? 'USD';
    const sections: string[] = [];

    // ── Summary ──────────────────────────────────────────────────────────────
    sections.push(row(['scan_id', data.scanId]));
    sections.push(row(['timestamp', data.timestamp]));
    sections.push(row(['total_resources', String(data.summary.totalResources)]));
    sections.push(row(['total_monthly_cost', data.summary.totalMonthlyCost.toFixed(2)]));
    sections.push(row(['potential_savings', data.summary.potentialSavings.toFixed(2)]));
    sections.push(row(['savings_pct',
      data.summary.totalMonthlyCost > 0
        ? `${(data.summary.potentialSavings / data.summary.totalMonthlyCost * 100).toFixed(1)}%`
        : '0%',
    ]));
    sections.push(row(['recommendation_count', String(data.summary.recommendationCount)]));
    sections.push('');

    // ── Resources ────────────────────────────────────────────────────────────
    if (data.resources.length > 0) {
      const sorted = [...data.resources].sort((a, b) => b.monthlyCost - a.monthlyCost);
      sections.push(row(['ID', 'Type', 'Name', 'Region', 'State', 'Instance Type', `Monthly Cost (${currency})`, 'Tags']));
      for (const r of sorted) {
        sections.push(row([
          r.id,
          r.type,
          r.name,
          r.region,
          r.state,
          r.instanceType ?? '',
          r.monthlyCost.toFixed(2),
          formatTags(r.tags),
        ]));
      }
      sections.push('');
    }

    // ── Recommendations ───────────────────────────────────────────────────────
    if (data.recommendations.length > 0) {
      const sorted = [...data.recommendations].sort((a, b) => b.estimatedSavings - a.estimatedSavings);
      sections.push(row(['ID', 'Resource ID', 'Type', 'Title', 'Savings', 'Confidence', 'Impact', 'Risk', 'Status', 'Scenario']));
      for (const rec of sorted) {
        sections.push(row([
          rec.id,
          rec.resourceId,
          rec.type,
          rec.title,
          `${rec.estimatedSavings.toFixed(2)}`,
          `${(rec.confidence * 100).toFixed(0)}%`,
          rec.impact,
          rec.risk,
          rec.status,
          rec.scenario ?? '',
        ]));
      }
      sections.push('');
    }

    // ── Daily Costs ───────────────────────────────────────────────────────────
    if (data.costs.length > 0) {
      const sorted = [...data.costs].sort((a, b) => a.costDate.localeCompare(b.costDate));
      sections.push(row(['Service', 'Region', 'Date', 'Daily Cost', 'Monthly Cost', 'Currency']));
      for (const c of sorted) {
        sections.push(row([
          c.serviceName,
          c.region,
          c.costDate,
          c.dailyCost.toFixed(4),
          c.monthlyCost.toFixed(2),
          c.currency,
        ]));
      }
      sections.push('');
    }

    // ── Cost by Service (Weekly Pivot) ────────────────────────────────────────
    if (data.costs.length > 0) {
      const weekMap = new Map<string, Map<string, number>>();
      for (const cost of data.costs) {
        if (!cost.serviceName) continue;
        const svc = cost.serviceName;
        const date = new Date(cost.costDate);
        if (isNaN(date.getTime())) continue;
        const jan4 = new Date(date.getFullYear(), 0, 4);
        const weekNum = Math.ceil(((date.getTime() - jan4.getTime()) / 86400000 + jan4.getDay() + 1) / 7);
        const weekKey = `${date.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
        if (!weekMap.has(svc)) weekMap.set(svc, new Map());
        const svcWeeks = weekMap.get(svc) as Map<string, number>;
        svcWeeks.set(weekKey, (svcWeeks.get(weekKey) ?? 0) + cost.monthlyCost);
      }

      const allWeeks = [...new Set([...weekMap.values()].flatMap(m => [...m.keys()]))].sort().slice(-4);

      if (allWeeks.length > 0) {
        sections.push(escape('=== Cost by Service (Weekly) ==='));
        sections.push(row(['Service', ...allWeeks]));
        for (const [svc, weekData] of [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          sections.push(row([svc, ...allWeeks.map(w => (weekData.get(w) ?? 0).toFixed(2))]));
        }
        sections.push('');
      }
    }

    // ── Savings by Severity ───────────────────────────────────────────────────
    if (data.recommendations.length > 0) {
      const severities = ['critical', 'high', 'medium', 'low'] as const;
      sections.push(escape('=== Savings by Severity ==='));
      sections.push(row(['Severity', 'Count', `Total Savings (${currency})`]));
      let totalSavings = 0;
      let totalCount = 0;
      for (const sev of severities) {
        const recs = data.recommendations.filter(r => r.impact === sev);
        const savings = recs.reduce((s, r) => s + r.estimatedSavings, 0);
        totalSavings += savings;
        totalCount += recs.length;
        sections.push(row([sev, String(recs.length), savings.toFixed(2)]));
      }
      sections.push(row(['total', String(totalCount), totalSavings.toFixed(2)]));
      sections.push('');
    }

    return sections.join('\n');
  }
}

/** Escape a single CSV field per RFC 4180. */
function escape(field: string): string {
  // Prevent CSV formula injection (Excel/Google Sheets)
  if (typeof field === 'string' && /^[=+\-@\t\r]/.test(field)) {
    field = "'" + field;
  }
  if (field.includes('"') || field.includes(',') || field.includes('\n') || field.includes('\r')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/** Join fields into a CSV row. */
function row(fields: string[]): string {
  return fields.map(escape).join(',');
}

/** Flatten a tag map to key=value; key=value (semicolon-delimited). */
function formatTags(tags: Record<string, string> | undefined): string {
  if (!tags) return '';
  return Object.entries(tags)
    .filter(([k, v]) => k !== null && k !== undefined && v !== null && v !== undefined)
    .map(([k, v]) => `${String(k).replace(/[=;]/g, '_')}=${String(v).replace(/"/g, '""').replace(/;/g, ',')}`)
    .join('; ');
}

// Named exports for testability
export { escape as csvEscape, row as csvRow, formatTags };

