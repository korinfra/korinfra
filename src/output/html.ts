import type { Formatter, ScanReport, CostEntry, RecommendationEntry } from './formatter.js';
import { escapeXml } from './formatter.js';
import { renderPieChartSVG } from './svg.js';
import { REPO_URL } from '../config/types.js';
import { REPORT_CSS } from './report-styles.js';
import { buildReportClientJS } from './report-client.js';
import { formatMoneyExact } from '../cli/ui/format.js';

/**
 * Renders a fully interactive, self-contained HTML report.
 * CSS lives in report-styles.ts — edit it to change visual design.
 * Client-side JS lives in report-client.ts — edit it to change interactivity.
 * This file contains only the data-driven HTML section builders.
 */
export class HTMLFormatter implements Formatter {
  readonly contentType = 'text/html';
  readonly fileExtension = 'html';

  format(data: ScanReport): string {
    return buildHTMLReport(data);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function impactColor(impact: string): string {
  switch (impact.toLowerCase()) {
    case 'critical': return '#dc2626';
    case 'high':     return '#ea580c';
    case 'medium':   return '#ca8a04';
    default:         return '#16a34a';
  }
}

const CHART_PALETTE = [
  '#0075ca', '#7057ff', '#008672', '#e11d48',
  '#f97316', '#06b6d4', '#84cc16', '#a855f7',
  '#ec4899', '#eab308',
];
function chartColor(i: number): string { return CHART_PALETTE[i % CHART_PALETTE.length] as string; }

// ── Aggregation helpers ───────────────────────────────────────────────────────

function buildServiceMap(costs: CostEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of costs) m.set(c.serviceName, (m.get(c.serviceName) ?? 0) + c.monthlyCost);
  return m;
}

function uniqueRegions(data: ScanReport): string[] {
  const s = new Set<string>();
  for (const r of data.resources) s.add(r.region);
  for (const c of data.costs) s.add(c.region);
  return [...s].filter(Boolean);
}

interface ReportAggregates {
  serviceMap: Map<string, number>;
  regions: string[];
}

// ── Chart builders ────────────────────────────────────────────────────────────

function buildPieChartSVG(serviceMap: Map<string, number>): string {
  if (serviceMap.size === 0) return '';
  const pieData = [...serviceMap.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
  const total = pieData.reduce((s, d) => s + d.value, 0);
  if (total === 0) return '';
  // Use a wide viewBox so the legend on the right side is never clipped
  return renderPieChartSVG(pieData, 540, 300);
}

function buildSparklineSVG(costs: CostEntry[]): string {
  if (costs.length < 2) return '';

  const dailyMap = new Map<string, number>();
  for (const c of costs) {
    const d = c.costDate.slice(0, 10);
    dailyMap.set(d, (dailyMap.get(d) ?? 0) + c.dailyCost);
  }
  const dates = [...dailyMap.keys()].sort().slice(-30);
  const pts   = dates.map(d => dailyMap.get(d) ?? 0);
  if (pts.length < 2) return '';

  const W = 960; const H = 160;
  const padL = 72; const padR = 24; const padT = 16; const padB = 32;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const n      = pts.length;

  const minVal   = Math.min(...pts);
  const maxVal   = Math.max(...pts);
  const valRange = maxVal === minVal ? 1 : maxVal - minVal;

  const toX = (i: number): number => padL + (i * chartW) / (n - 1);
  const toY = (v: number): number => padT + chartH * (1 - (v - minVal) / valRange);

  const lastPt = pts[pts.length - 1] as number;
  const firstPt = pts[0] as number;
  const isUp      = lastPt >= firstPt;
  const lineColor = isUp ? '#e11d48' : '#008672';

  const gridLines: string[] = [];
  for (let g = 0; g <= 2; g++) {
    const gv  = minVal + (valRange * g) / 2;
    const gy  = toY(gv);
    const lbl = gv < 1 ? `$${gv.toFixed(3)}` : `$${gv.toFixed(2)}`;
    gridLines.push(
      `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" style="stroke:var(--c-200)" stroke-width="1"/>`,
      `<text x="${padL - 6}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="10" style="fill:var(--c-400)">${escapeXml(lbl)}</text>`,
    );
  }

  const areaPoints = pts.map((p, i) => `${toX(i).toFixed(1)},${toY(p).toFixed(1)}`).join(' ');
  const areaPath =
    `M${toX(0).toFixed(1)},${(padT + chartH).toFixed(1)} ` +
    pts.map((p, i) => `L${toX(i).toFixed(1)},${toY(p).toFixed(1)}`).join(' ') +
    ` L${toX(n - 1).toFixed(1)},${(padT + chartH).toFixed(1)} Z`;
  const areaClass = isUp ? 'trend-area-up' : 'trend-area-dn';

  const markerIdxs = [0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1]
    .filter((v, i, a) => a.indexOf(v) === i);
  const dateMarkers = markerIdxs.map(i => {
    const short = (dates[i] ?? '').slice(5);
    return `<text x="${toX(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" style="fill:var(--c-400)">${escapeXml(short)}</text>`;
  });

  const ex  = toX(n - 1).toFixed(1);
  const ey  = toY(lastPt).toFixed(1);
  const lv  = formatMoneyExact(lastPt);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${W} ${H}" style="display:block">`,
    `<style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif}</style>`,
    ...gridLines,
    `<path d="${areaPath}" class="${areaClass}"/>`,
    `<polyline points="${areaPoints}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`,
    `<circle cx="${ex}" cy="${ey}" r="4" fill="${lineColor}"/>`,
    `<text x="${ex}" y="${(Number(ey) - 9).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="600" style="fill:${lineColor}">${escapeXml(lv)}</text>`,
    ...dateMarkers,
    `</svg>`,
  ].join('');
}

// ── Section builders (static HTML, built in TypeScript) ──────────────────────

function renderKPIGrid(data: ScanReport, aggregates: ReportAggregates): string {
  const { summary } = data;

  const savingsPct = summary.totalMonthlyCost > 0
    ? `<span class="stat-sub">${(summary.potentialSavings / summary.totalMonthlyCost * 100).toFixed(1)}% of spend</span>`
    : '';

  const regions = aggregates.regions;
  const svcMap = aggregates.serviceMap;
  const activeCount = data.resources.filter(r => {
    const s = r.state.toLowerCase();
    return s === 'running' || s === 'active' || s === 'available';
  }).length;

  const healthRatio = summary.totalResources > 0 ? summary.recommendationCount / summary.totalResources : 0;
  const healthLabel = healthRatio === 0 ? 'Excellent' : healthRatio < 0.25 ? 'Good' : healthRatio < 0.5 ? 'Fair' : 'Needs attention';
  const healthColor = healthRatio === 0 ? '#059669' : healthRatio < 0.25 ? '#16a34a' : healthRatio < 0.5 ? '#ca8a04' : '#dc2626';

  const cards: Array<{ value: string; label: string; cls: string; sub: string }> = [
    {
      value: escapeXml(formatMoneyExact(summary.totalMonthlyCost)),
      label: 'Monthly Spend', cls: 'stat-spend',
      sub: '',
    },
    {
      value: escapeXml(formatMoneyExact(summary.potentialSavings)),
      label: 'Potential Savings', cls: 'stat-savings',
      sub: savingsPct,
    },
    {
      value: String(summary.totalResources),
      label: 'Total Resources', cls: '',
      sub: activeCount > 0 ? `<span class="stat-sub">${activeCount} active</span>` : '',
    },
    {
      value: String(summary.recommendationCount),
      label: 'Recommendations', cls: 'stat-recs',
      sub: '',
    },
    {
      value: String(regions.length),
      label: 'Regions', cls: '',
      sub: regions.slice(0, 2).map(r => `<span class="stat-sub">${escapeXml(r)}</span>`).join(''),
    },
    {
      value: String(svcMap.size),
      label: 'Services', cls: '',
      sub: '',
    },
    {
      value: `<span style="color:${healthColor}">${escapeXml(healthLabel)}</span>`,
      label: 'Infra Health', cls: 'stat-health',
      sub: `<span class="stat-sub">${summary.recommendationCount} rec${summary.recommendationCount !== 1 ? 's' : ''} / ${summary.totalResources} resources</span>`,
    },
  ];

  const html = cards.map(c => `
  <div class="stat ${escapeXml(c.cls)}">
    <div class="stat-label">${c.label}</div>
    <div class="stat-value">${c.value}</div>
    ${c.sub ? `<div class="stat-sub-wrap">${c.sub}</div>` : ''}
  </div>`).join('');

  return `<div class="summary-grid">${html}</div>`;
}

function renderDashboardCharts(aggregates: ReportAggregates): string {
  const pieChartSVG  = buildPieChartSVG(aggregates.serviceMap);

  if (!pieChartSVG) return '';

  // Service cost table — shown alongside pie chart
  let servicePanelHTML = '';
  if (aggregates.serviceMap.size > 0) {
    const sorted  = [...aggregates.serviceMap.entries()].sort((a, b) => b[1] - a[1]);
    const total   = sorted.reduce((s, e) => s + e[1], 0);
    const rows    = sorted.map(([name, cost], i) => {
      const pct  = total > 0 ? (cost / total * 100) : 0;
      const barW = Math.round(pct);
      const col  = chartColor(i);
      return `
        <tr>
          <td><span class="svc-dot" style="background:${col}"></span>${escapeXml(name)}</td>
          <td class="cost-cell"><strong>${escapeXml(formatMoneyExact(cost))}</strong></td>
          <td>
            <div class="pct-wrap">
              <div class="pct-bar"><div class="pct-fill" style="width:${barW}%;background:${col}"></div></div>
              <span class="pct-label">${pct.toFixed(1)}%</span>
            </div>
          </td>
        </tr>`;
    }).join('');
    servicePanelHTML = `
    <div class="chart-box service-table-panel">
      <div class="chart-label">Cost Breakdown by Service</div>
      <table class="svc-table">
        <thead><tr><th>Service</th><th>Monthly</th><th style="width:180px">Share</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  const pieSection = pieChartSVG
    ? `<div class="chart-box chart-box-pie"><div class="chart-label">Spend Distribution</div>${pieChartSVG}</div>`
    : '';

  const chartsRow = (pieSection || servicePanelHTML)
    ? `<div class="charts-row">${pieSection}${servicePanelHTML}</div>`
    : '';

  return `
<div class="card">
  <div class="card-header">Cost Analytics</div>
  <div class="card-body">
    ${chartsRow}
  </div>
</div>`;
}

function renderSparklineSection(data: ScanReport): string {
  const sparklineSVG = buildSparklineSVG(data.costs);

  if (!sparklineSVG) return '';

  return `
<div class="card">
  <div class="card-header">30-Day Daily Cost Trend</div>
  <div class="card-body">
    <div class="sparkline-box">${sparklineSVG}</div>
  </div>
</div>`;
}

function renderTopWinsSection(recs: RecommendationEntry[]): string {
  if (recs.length === 0) return '';
  const topRecs = [...recs].sort((a, b) => b.estimatedSavings - a.estimatedSavings).slice(0, 3);
  const allSavingsZero = topRecs.every(r => r.estimatedSavings === 0);

  const cards = topRecs.map((r, i) => {
    const accentColor = impactColor(r.impact);
    // Show full description — CSS line-clamp handles visual overflow cleanly
    const desc = r.description
      ? `<div class="win-desc">${escapeXml(r.description)}</div>`
      : '';
    const resourceId = r.resourceId
      ? `<div class="win-resource">${escapeXml(r.resourceId)}</div>`
      : '';
    return `
    <div class="win-card" style="border-top:3px solid ${accentColor}">
      <div class="win-rank" style="background:${accentColor}">#${i + 1}</div>
      <div class="win-title">${escapeXml(r.title)}</div>
      ${desc}
      <div class="win-savings">${escapeXml(formatMoneyExact(r.estimatedSavings))}<span class="win-per">/mo</span></div>
      <div class="win-footer">
        <span class="badge badge-${escapeXml(r.impact)}">${escapeXml(r.impact.toUpperCase())}</span>
        ${resourceId}
      </div>
    </div>`;
  }).join('');

  const emptyStateNote = allSavingsZero
    ? '<p class="empty-note">No cost optimization opportunities with quantified savings detected. Recommendations may still contain best practices.</p>'
    : '';

  return `
<div class="card">
  <div class="card-header">Top Savings Opportunities <span class="count-chip">${topRecs.length}</span></div>
  <div class="card-body">
    <div class="wins-grid">${cards}</div>
    ${emptyStateNote}
  </div>
</div>`;
}

// ── HTML shell builder ────────────────────────────────────────────────────────

function buildHTMLReport(data: ScanReport): string {
  const aggregates: ReportAggregates = {
    serviceMap: buildServiceMap(data.costs),
    regions: uniqueRegions(data),
  };

  const generatedAt = escapeXml(new Date(data.timestamp).toUTCString());
  const scanId      = escapeXml(data.scanId);
  const shortId     = escapeXml(data.scanId.slice(0, 8));

  // Pre-build filter dropdown options (server-side so they're available immediately)
  const makeOptions = (values: Set<string>): string =>
    [...values].sort().map(v => `<option value="${escapeXml(v)}">${escapeXml(v)}</option>`).join('');

  const typeOpts   = makeOptions(new Set(data.resources.map(r => r.type)));
  const regionOpts = makeOptions(new Set(data.resources.map(r => r.region)));
  const stateOpts  = makeOptions(new Set(data.resources.map(r => r.state)));
  const impactOpts = makeOptions(new Set(data.recommendations.map(r => r.impact)));
  const riskOpts   = makeOptions(new Set(data.recommendations.map(r => r.risk)));

  // Embed report data as JSON — unicode-escape </script> and & so HTML parser can't
  // break out of the <script> tag. Do NOT HTML-entity-encode per-field: HTML entities
  // are not decoded inside <script> content, which would cause double-encoding in the
  // client's esc() calls (e.g. "&amp;" → "&amp;amp;" in display).
  const reportJSON = JSON.stringify({
    resources:       data.resources,
    recommendations: data.recommendations,
    costs:           data.costs,
    summary:         data.summary,
  })
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp(' ', 'g'), '\u2028')
    .replace(new RegExp(' ', 'g'), '\u2029');

  const currency = data.costs.length > 0 ? (data.costs[0]?.currency ?? 'USD') : 'USD';
  const inlineJS = buildReportClientJS(reportJSON, currency);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>korinfra Report &mdash; ${shortId}</title>
<style>
${REPORT_CSS}
</style>
</head>
<body>

<!-- ── Header ─────────────────────────────────────────────────────────────── -->
<div class="header">
  <div class="header-brand">
    <div class="header-logo">⚡</div>
    <div>
      <h1>korinfra</h1>
      <p>AWS FinOps &bull; Scan Report</p>
    </div>
  </div>
  <div class="header-meta">
    <span>Scan: ${scanId}</span>
    <span>Generated: ${generatedAt}</span>
    <button class="theme-toggle" id="theme-toggle-btn" onclick="toggleTheme()" title="Toggle dark/light mode">☀</button>
  </div>
</div>

<!-- ── Tab bar ────────────────────────────────────────────────────────────── -->
<div class="tab-nav" role="tablist">
  <button id="btn-dashboard" class="tab-btn active" role="tab" aria-selected="true" onclick="switchTab('dashboard')">Dashboard</button>
  ${data.resources.length > 0
    ? `<button id="btn-resources" class="tab-btn" role="tab" aria-selected="false" onclick="switchTab('resources')">Resources <span class="tab-btn-badge">${data.resources.length}</span></button>`
    : ''}
  ${data.recommendations.length > 0
    ? `<button id="btn-recommendations" class="tab-btn" role="tab" aria-selected="false" onclick="switchTab('recommendations')">Recommendations <span class="tab-btn-badge">${data.recommendations.length}</span></button>`
    : ''}
  ${data.costs.length > 0
    ? `<button id="btn-costs" class="tab-btn" role="tab" aria-selected="false" onclick="switchTab('costs')">Costs</button>`
    : ''}
</div>

<!-- ════════════════════════════════════════════════════════════════════════ -->
<!-- DASHBOARD TAB                                                           -->
<!-- ════════════════════════════════════════════════════════════════════════ -->
<div id="tab-dashboard" class="tab-pane active">
  <div class="container">
    ${renderKPIGrid(data, aggregates)}
    ${renderDashboardCharts(aggregates)}
    ${renderTopWinsSection(data.recommendations)}
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════════════════ -->
<!-- RESOURCES TAB                                                           -->
<!-- ════════════════════════════════════════════════════════════════════════ -->
${data.resources.length > 0 ? `
<div id="tab-resources" class="tab-pane">
  <div class="container">
    <div class="card">
      <div class="card-header">Resource Inventory</div>
      <div class="table-toolbar">
        <div class="toolbar-search">
          <input type="text" id="res-search-input"
            placeholder="Search by ID, name, type, region, instance type…"
            oninput="RS.onSearch(this.value)">
        </div>
        <div class="toolbar-filter">
          <select onchange="RS.onType(this.value)">
            <option value="">All Types</option>
            ${typeOpts}
          </select>
          <select onchange="RS.onRegion(this.value)">
            <option value="">All Regions</option>
            ${regionOpts}
          </select>
          <select onchange="RS.onState(this.value)">
            <option value="">All States</option>
            ${stateOpts}
          </select>
        </div>
        <div class="toolbar-pagination">
          <select onchange="RS.onPerPage(this.value)">
            <option value="25">25 / page</option>
            <option value="50">50 / page</option>
            <option value="100">100 / page</option>
          </select>
          <button class="export-btn" onclick="downloadResourcesCSV()">↓ Export CSV</button>
          <span id="res-count" class="count-label"></span>
        </div>
      </div>
      <div class="card-body no-pad">
        <table style="table-layout:fixed">
          <colgroup>
            <col style="width:18%">
            <col style="width:12%">
            <col style="width:18%">
            <col style="width:12%">
            <col style="width:14%">
            <col style="width:10%">
          </colgroup>
          <thead>
            <tr>
              <th onclick="onResourcesSort('id')" id="res-th-id">ID</th>
              <th onclick="onResourcesSort('type')" id="res-th-type">Type</th>
              <th onclick="onResourcesSort('name')" id="res-th-name">Name</th>
              <th onclick="onResourcesSort('region')" id="res-th-region">Region</th>
              <th onclick="onResourcesSort('state')" id="res-th-state">State</th>
              <th onclick="onResourcesSort('monthlyCost')" id="res-th-monthlyCost" style="text-align:right">Cost/mo</th>
            </tr>
          </thead>
          <tbody id="resources-tbody"></tbody>
        </table>
      </div>
      <div class="pagination">
        <button id="res-prev-btn" class="page-btn" onclick="RS.prevPage()">&#8592; Prev</button>
        <div id="res-page-nums" style="display:flex;gap:4px;align-items:center"></div>
        <button id="res-next-btn" class="page-btn" onclick="RS.nextPage()">Next &#8594;</button>
        <span id="res-page-info" class="page-info"></span>
      </div>
    </div>
  </div>
</div>` : ''}

<!-- ════════════════════════════════════════════════════════════════════════ -->
<!-- RECOMMENDATIONS TAB                                                     -->
<!-- ════════════════════════════════════════════════════════════════════════ -->
${data.recommendations.length > 0 ? `
<div id="tab-recommendations" class="tab-pane">
  <div class="container">
    <div class="card">
      <div class="card-header">All Recommendations</div>
      <div class="table-toolbar">
        <div class="toolbar-search">
          <input type="text" id="rec-search-input"
            placeholder="Search by title, description, resource…"
            oninput="RC.onSearch(this.value)">
        </div>
        <div class="toolbar-filter">
          <select onchange="RC.onImpact(this.value)">
            <option value="">All Impacts</option>
            ${impactOpts}
          </select>
          <select onchange="RC.onRisk(this.value)">
            <option value="">All Risks</option>
            ${riskOpts}
          </select>
        </div>
        <div class="toolbar-pagination">
          <select onchange="RC.onPerPage(this.value)">
            <option value="25">25 / page</option>
            <option value="50">50 / page</option>
            <option value="100">100 / page</option>
          </select>
          <button class="export-btn" onclick="downloadRecsCSV()">↓ Export CSV</button>
          <span id="rec-count" class="count-label"></span>
        </div>
      </div>
      <div class="card-body no-pad">
        <table style="table-layout:fixed">
          <colgroup>
            <col style="width:28px">
            <col><!-- title takes remaining space -->
            <col style="width:110px">
            <col style="width:130px">
            <col style="width:90px">
            <col style="width:80px">
          </colgroup>
          <thead>
            <tr>
              <th></th>
              <th onclick="onRecommendationsSort('title')" id="rec-th-title">Title</th>
              <th onclick="onRecommendationsSort('estimatedSavings')" id="rec-th-estimatedSavings" style="text-align:right">Savings/mo</th>
              <th onclick="onRecommendationsSort('confidence')" id="rec-th-confidence">Confidence</th>
              <th onclick="onRecommendationsSort('impact')" id="rec-th-impact">Impact</th>
              <th onclick="onRecommendationsSort('risk')" id="rec-th-risk">Risk</th>
            </tr>
          </thead>
          <tbody id="recommendations-tbody"></tbody>
        </table>
      </div>
      <div class="pagination">
        <button id="rec-prev-btn" class="page-btn" onclick="RC.prevPage()">&#8592; Prev</button>
        <div id="rec-page-nums" style="display:flex;gap:4px;align-items:center"></div>
        <button id="rec-next-btn" class="page-btn" onclick="RC.nextPage()">Next &#8594;</button>
        <span id="rec-page-info" class="page-info"></span>
      </div>
    </div>
  </div>
</div>` : ''}

<!-- ════════════════════════════════════════════════════════════════════════ -->
<!-- COSTS TAB                                                               -->
<!-- ════════════════════════════════════════════════════════════════════════ -->
${data.costs.length > 0 ? `
<div id="tab-costs" class="tab-pane">
  <div class="container">
    ${renderSparklineSection(data)}
    <div class="card">
      <div class="card-header">Daily Cost Detail</div>
      <div class="table-toolbar">
        <div class="toolbar-search">
          <input type="text" id="dc-search-input"
            placeholder="Search by service…"
            oninput="DC.onSearch(this.value)">
        </div>
        <div class="toolbar-filter">
          <select onchange="DC.onRegion(this.value)">
            <option value="">All Regions</option>
            ${makeOptions(new Set(data.costs.map(c => c.region)))}
          </select>
        </div>
        <div class="toolbar-pagination">
          <select onchange="DC.onPerPage(this.value)">
            <option value="25">25 / page</option>
            <option value="50">50 / page</option>
            <option value="100">100 / page</option>
          </select>
          <span id="dc-count" class="count-label"></span>
        </div>
      </div>
      <div class="card-body no-pad">
        <table style="table-layout:fixed">
          <colgroup>
            <col style="width:110px">
            <col>
            <col style="width:120px">
            <col style="width:110px">
            <col style="width:110px">
          </colgroup>
          <thead>
            <tr>
              <th id="dc-th-costDate" onclick="onDailyCostsSort('costDate')">Date</th>
              <th id="dc-th-serviceName" onclick="onDailyCostsSort('serviceName')">Service</th>
              <th id="dc-th-region" onclick="onDailyCostsSort('region')">Region</th>
              <th id="dc-th-dailyCost" onclick="onDailyCostsSort('dailyCost')" style="text-align:right">Daily Cost</th>
              <th id="dc-th-monthlyProj" onclick="onDailyCostsSort('monthlyProj')" style="text-align:right">Monthly Proj</th>
            </tr>
          </thead>
          <tbody id="dc-tbody"></tbody>
        </table>
      </div>
      <div class="pagination">
        <button id="dc-prev-btn" class="page-btn" onclick="DC.prevPage()">&#8592; Prev</button>
        <div id="dc-page-nums" style="display:flex;gap:4px;align-items:center"></div>
        <button id="dc-next-btn" class="page-btn" onclick="DC.nextPage()">Next &#8594;</button>
        <span id="dc-page-info" class="page-info"></span>
      </div>
    </div>
  </div>
</div>` : ''}

<!-- ── Footer ─────────────────────────────────────────────────────────────── -->
<div class="footer">
  Generated by <a href="${escapeXml(REPO_URL)}">korinfra</a> &mdash; ${generatedAt}
</div>

<script>
${inlineJS}
</script>
</body>
</html>`;
}

