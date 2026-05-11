/**
 * CSS for the HTML scan report.
 * Edit this file to change the visual design of exported reports.
 * No build step needed — imported directly by html.ts.
 */
export const REPORT_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --c-primary:#2563eb;--c-primary-d:#1d4ed8;--c-primary-l:#dbeafe;
  --c-success:#059669;--c-success-l:#d1fae5;
  --c-warn:#d97706;--c-warn-l:#fef3c7;
  --c-danger:#dc2626;--c-danger-l:#fee2e2;
  --c-bg:#f1f5f9;
  --c-50:#f8fafc;--c-100:#f1f5f9;--c-200:#e2e8f0;--c-300:#cbd5e1;
  --c-400:#94a3b8;--c-500:#64748b;--c-600:#475569;--c-700:#334155;
  --c-800:#1e293b;--c-900:#0f172a;
  --c-surface:#fff;--c-surface-hover:#eff6ff;
  --shadow-sm:0 1px 2px rgba(0,0,0,.05);
  --shadow:0 1px 3px rgba(0,0,0,.06),0 4px 12px rgba(0,0,0,.05);
  --shadow-md:0 4px 6px rgba(0,0,0,.05),0 10px 20px rgba(0,0,0,.07);
  --r:12px;--r-sm:8px;--r-xs:6px;
  --ease:.18s ease;
}
body{font-family:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;color:var(--c-900);background:var(--c-bg);line-height:1.55}

/* ── Header ──────────────────────────────────────────────────────── */
.header{
  background:#0f172a;
  background-image:radial-gradient(rgba(255,255,255,.065) 1px,transparent 1px),linear-gradient(135deg,#0f172a 0%,#1a2744 50%,#0c1a38 100%);
  background-size:22px 22px,100%;
  color:#fff;padding:22px 32px;display:flex;align-items:center;justify-content:space-between;gap:20px;
  border-bottom:1px solid rgba(255,255,255,.07)
}
.header-brand{display:flex;align-items:center;gap:14px}
.header-logo{width:40px;height:40px;background:linear-gradient(135deg,#3b82f6,#4f46e5);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:19px;flex-shrink:0;box-shadow:0 0 0 1px rgba(255,255,255,.1),0 4px 12px rgba(59,130,246,.35)}
.header-brand h1{font-size:19px;font-weight:700;letter-spacing:-.03em;color:#fff;line-height:1.2}
.header-brand p{font-size:11.5px;color:rgba(255,255,255,.45);margin-top:2px;letter-spacing:.01em}
.header-meta{font-size:11px;color:rgba(255,255,255,.45);text-align:right;font-family:"Courier New",monospace;line-height:1.9}
.header-meta span{display:block}

/* ── Tab bar ─────────────────────────────────────────────────────── */
.tab-nav{background:var(--c-surface);border-bottom:1px solid var(--c-200);display:flex;gap:0;position:sticky;top:0;z-index:99;box-shadow:0 1px 8px rgba(0,0,0,.06);padding:0 8px}
.tab-btn{background:none;border:none;border-bottom:2px solid transparent;padding:13px 16px;cursor:pointer;font-size:13px;font-weight:500;color:var(--c-500);transition:color var(--ease),border-color var(--ease),background var(--ease);white-space:nowrap;letter-spacing:.005em;font-family:inherit}
.tab-btn:hover{color:var(--c-primary);background:rgba(37,99,235,.04)}
.tab-btn.active{color:var(--c-primary);font-weight:600;border-bottom-color:var(--c-primary)}
.tab-btn-badge{background:var(--c-primary-l);color:var(--c-primary-d);border-radius:20px;font-size:10px;font-weight:700;padding:1px 7px;margin-left:5px;vertical-align:middle}

/* ── Container ───────────────────────────────────────────────────── */
.container{max-width:1200px;margin:0 auto;padding:24px 20px}

/* ── Cards ───────────────────────────────────────────────────────── */
.card{background:var(--c-surface);border-radius:var(--r);box-shadow:var(--shadow);margin-bottom:20px;overflow:hidden;border:1px solid var(--c-200)}
.card-header{background:var(--c-50);padding:13px 20px;font-weight:600;font-size:12px;border-bottom:1px solid var(--c-200);color:var(--c-600);display:flex;align-items:center;gap:8px;text-transform:uppercase;letter-spacing:.06em}
.card-body{padding:20px}
.card-body.no-pad{padding:0}
.count-chip{background:var(--c-primary-l);color:var(--c-primary-d);border-radius:20px;padding:2px 10px;font-size:11px;font-weight:700;text-transform:none;letter-spacing:0}

/* ── KPI grid ────────────────────────────────────────────────────── */
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:14px;margin-bottom:20px}
.stat{background:var(--c-surface);border-radius:var(--r);border:1px solid var(--c-200);padding:18px;box-shadow:var(--shadow-sm);position:relative;overflow:hidden}
.stat::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--c-200);border-radius:var(--r) var(--r) 0 0}
.stat-label{font-size:10.5px;font-weight:600;color:var(--c-500);text-transform:uppercase;letter-spacing:.07em;line-height:1.3;margin-bottom:8px}
.stat-value{font-size:28px;font-weight:700;color:var(--c-800);letter-spacing:-.04em;line-height:1.05;font-variant-numeric:tabular-nums}
.stat-sub-wrap{margin-top:5px}
.stat-sub{font-size:10.5px;color:var(--c-400);display:block}
.stat-spend::before{background:var(--c-primary)}.stat-spend .stat-value{color:var(--c-primary)}
.stat-savings::before{background:var(--c-success)}.stat-savings .stat-value{color:var(--c-success)}
.stat-recs::before{background:var(--c-warn)}.stat-recs .stat-value{color:var(--c-warn)}
.stat-health .stat-value{font-size:18px;font-weight:700}

/* ── Top wins ────────────────────────────────────────────────────── */
.wins-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.win-card{background:var(--c-surface);border-radius:var(--r);border:1px solid var(--c-200);padding:20px;position:relative;box-shadow:var(--shadow-sm)}
.win-rank{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;font-size:12px;font-weight:700;color:#fff;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,.18)}
.win-title{font-size:13.5px;font-weight:600;color:var(--c-900);line-height:1.45;margin-bottom:6px}
.win-desc{font-size:12px;color:var(--c-600);line-height:1.65}
.win-savings{font-size:26px;font-weight:700;color:var(--c-success);margin:14px 0 8px;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.win-per{font-size:13px;font-weight:400;color:var(--c-400);margin-left:1px}
.win-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.win-resource{font-size:10px;color:var(--c-400);font-family:"Courier New",monospace;word-break:break-all}

/* ── Tables & toolbars ───────────────────────────────────────────── */
.table-toolbar{background:var(--c-50);padding:12px 16px;border-bottom:1px solid var(--c-200);display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.toolbar-search{flex:1;min-width:200px}
.toolbar-search input{width:100%;padding:8px 10px 8px 34px;border:1px solid var(--c-200);border-radius:var(--r-xs);font-size:13px;background:var(--c-surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' fill='none' viewBox='0 0 24 24'%3E%3Ccircle cx='11' cy='11' r='8' stroke='%2394a3b8' stroke-width='2'/%3E%3Cpath d='m21 21-4.35-4.35' stroke='%2394a3b8' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat 11px center;outline:none;transition:border-color var(--ease),box-shadow var(--ease);font-family:inherit;color:var(--c-800)}
.toolbar-search input:focus{border-color:var(--c-primary);box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.toolbar-search input::placeholder{color:var(--c-400)}
.toolbar-filter{display:flex;gap:8px;flex-wrap:wrap}
.toolbar-filter select,.toolbar-pagination select{border:1px solid var(--c-200);border-radius:var(--r-xs);font-size:12px;background:var(--c-surface);color:var(--c-600);cursor:pointer;outline:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2394a3b8'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;transition:border-color var(--ease);font-family:inherit}
.toolbar-filter select{padding:7px 28px 7px 10px}
.toolbar-filter select:focus{border-color:var(--c-primary);box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.toolbar-pagination{display:flex;gap:8px;align-items:center;margin-left:auto}
.toolbar-pagination select{padding:6px 28px 6px 10px}

table{width:100%;border-collapse:collapse;font-size:13px}
thead th{background:var(--c-50);padding:10px 16px;text-align:left;font-weight:600;font-size:11px;color:var(--c-500);border-bottom:1px solid var(--c-200);white-space:nowrap;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;user-select:none;transition:background var(--ease),color var(--ease)}
thead th:hover{background:var(--c-100);color:var(--c-700)}
thead th.sorted-asc::after{content:" ↑";color:var(--c-primary);font-size:10px}
thead th.sorted-desc::after{content:" ↓";color:var(--c-primary);font-size:10px}
tbody td{padding:11px 16px;border-bottom:1px solid var(--c-50);vertical-align:middle;color:var(--c-800);transition:background var(--ease)}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--c-50)}

/* ── Expandable rows ─────────────────────────────────────────────── */
.rec-row,.res-row{cursor:pointer}
.rec-row:hover td{background:var(--c-surface-hover)!important}
.res-row:hover td{background:var(--c-surface-hover)!important}
.rec-expanded td,.res-expanded td{background:var(--c-surface-hover);border-bottom:1px solid var(--c-primary-l)!important}
.rec-expanded-content,.res-expanded-content{padding:12px 0 4px;display:grid;gap:8px}
.rec-desc{line-height:1.7;word-break:break-word;color:var(--c-700)}
.rec-meta,.res-meta{font-size:12px;color:var(--c-500);line-height:1.65}
.rec-expand-col{width:28px;text-align:center;color:var(--c-400);font-size:14px}
.ml{font-size:11px;color:var(--c-400);font-weight:600;text-transform:uppercase;letter-spacing:.04em}

/* ── Badges ──────────────────────────────────────────────────────── */
.badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.02em}
.badge-critical{background:#fee2e2;color:#991b1b}
.badge-high{background:#fff7ed;color:#9a3412}
.badge-medium{background:#fefce8;color:#92400e}
.badge-low{background:#f0fdf4;color:#166534}
.badge-info{background:#eff6ff;color:#1e40af}
.tag-count-badge{background:#f0fdf4;color:#15803d;border-radius:4px;padding:1px 5px;font-size:10px;font-weight:600;margin-left:5px}

/* ── Resource table cells ────────────────────────────────────────── */
.type-cell{font-size:12px;color:var(--c-600)}
.instance-type{display:inline-block;margin-left:5px;background:#eff6ff;color:#1d4ed8;border-radius:4px;padding:1px 5px;font-size:10px;font-weight:600}
.svc-table tbody td{border-bottom-color:var(--c-50)}
.region-cell{font-size:12px;color:var(--c-500);font-family:"Courier New",monospace}
.cost-cell{font-weight:700;color:var(--c-800);white-space:nowrap;font-variant-numeric:tabular-nums}
.state-dot{display:inline-block;width:7px;height:7px;border-radius:50%;vertical-align:middle;margin-right:5px}
.state-text{vertical-align:middle}

/* ── Recommendation cells ────────────────────────────────────────── */
.rec-title-cell{font-weight:600;color:var(--c-900);line-height:1.4}
.rec-resource-hint{font-size:11px;color:var(--c-400);font-family:"Courier New",monospace;margin-top:2px}
.rec-savings{white-space:nowrap;color:var(--c-800);font-weight:700;font-variant-numeric:tabular-nums}
.per{font-size:11px;color:var(--c-400);margin-left:1px;font-weight:400}
.rec-savings-annual{font-size:10px;color:var(--c-400);margin-top:2px;font-variant-numeric:tabular-nums}
.conf-wrap{display:flex;align-items:center;gap:8px}
.conf-bar{background:var(--c-200);border-radius:4px;height:5px;overflow:hidden;width:64px;flex-shrink:0}
.conf-fill{height:5px;border-radius:4px}
.conf-pct{font-size:12px;color:var(--c-500);min-width:32px;font-variant-numeric:tabular-nums}

/* ── Pagination ──────────────────────────────────────────────────── */
.pagination{padding:12px 16px;border-top:1px solid var(--c-200);display:flex;gap:5px;align-items:center;flex-wrap:wrap;background:var(--c-50)}
.page-btn{background:var(--c-surface);border:1px solid var(--c-200);color:var(--c-600);padding:5px 11px;border-radius:var(--r-xs);cursor:pointer;font-size:12px;font-weight:500;transition:all var(--ease);min-width:34px;text-align:center;font-family:inherit}
.page-btn:hover:not(:disabled){background:var(--c-100);border-color:var(--c-300);color:var(--c-800)}
.page-btn.active{background:var(--c-primary);color:#fff;border-color:var(--c-primary);font-weight:600;box-shadow:0 2px 6px rgba(37,99,235,.3)}
.page-btn:disabled{opacity:.35;cursor:not-allowed}
.page-info{margin-left:auto;font-size:12px;color:var(--c-400)}

/* ── Charts ──────────────────────────────────────────────────────── */
.charts-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.chart-box{background:var(--c-50);border-radius:var(--r);border:1px solid var(--c-200);padding:16px 12px}
.chart-box-pie{display:flex;flex-direction:column;align-items:flex-start;overflow:visible}
.chart-box-pie svg{width:100%;height:auto;overflow:visible}
.chart-label{font-size:11px;font-weight:700;color:var(--c-500);text-transform:uppercase;letter-spacing:.07em;margin-bottom:12px}
.sparkline-box{background:var(--c-50);border-radius:var(--r);border:1px solid var(--c-200);padding:16px;overflow:hidden}

/* ── Service cost table ──────────────────────────────────────────── */
.service-table-panel{padding:16px 0 0}
.service-table-panel .chart-label{padding:0 16px}
.svc-table{font-size:12px}
.svc-table thead th{font-size:10px;padding:7px 12px;background:transparent;border-bottom:1px solid var(--c-200);text-transform:uppercase;letter-spacing:.04em;color:var(--c-400);cursor:default;user-select:none}
.svc-table tbody td{padding:8px 12px;border-bottom:1px solid #f8fafc}
.svc-table tbody tr:last-child td{border-bottom:none}
.svc-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.pct-wrap{display:flex;align-items:center;gap:8px}
.pct-bar{flex:1;background:var(--c-200);border-radius:4px;height:5px;overflow:hidden;min-width:40px}
.pct-fill{height:5px;border-radius:4px}
.pct-label{font-size:11px;color:var(--c-500);min-width:38px;text-align:right;font-variant-numeric:tabular-nums}

/* ── Tab panes ───────────────────────────────────────────────────── */
.tab-pane{display:none}
.tab-pane.active{display:block}

/* ── Code ────────────────────────────────────────────────────────── */
code{background:var(--c-100);padding:2px 6px;border-radius:4px;font-size:11px;font-family:"Courier New",monospace;color:var(--c-600);word-break:break-all}

/* ── Export button ───────────────────────────────────────────────── */
.export-btn{background:var(--c-success-l);border:1px solid #a7f3d0;color:#065f46;padding:6px 12px;border-radius:var(--r-xs);cursor:pointer;font-size:12px;font-weight:600;transition:all var(--ease);font-family:inherit}
.export-btn:hover{background:#a7f3d0;border-color:#6ee7b7;box-shadow:0 2px 6px rgba(5,150,105,.15)}

/* ── Trend sparkline areas ───────────────────────────────────────── */
.trend-area-up{fill:#fee2e2;opacity:0.6}
.trend-area-dn{fill:#dcfce7;opacity:0.6}

/* ── Count label ─────────────────────────────────────────────────── */
.count-label{font-size:12px;color:var(--c-500)}

/* ── Muted text & empty state ─────────────────────────────────────── */
.muted-text{color:var(--c-400)}
.empty-state{text-align:center;padding:40px;color:var(--c-400)}

/* ── Empty note ──────────────────────────────────────────────────── */
.empty-note{font-size:12px;color:var(--c-400);margin-top:8px;text-align:center}

/* ── Theme toggle button ─────────────────────────────────────────── */
.theme-toggle{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:rgba(255,255,255,.8);border-radius:8px;padding:6px 10px;cursor:pointer;font-size:15px;transition:all var(--ease);line-height:1;flex-shrink:0}
.theme-toggle:hover{background:rgba(255,255,255,.2);color:#fff}

/* ── Tag pills ───────────────────────────────────────────────────── */
.tag-pill{display:inline-block;background:var(--c-100);border:1px solid var(--c-200);border-radius:4px;padding:2px 7px;font-size:11px;color:var(--c-600);font-family:"Courier New",monospace;margin:2px 3px}
.tag-grid{padding:10px 16px 14px;display:flex;flex-wrap:wrap;gap:4px;background:var(--c-50);border-bottom:1px solid var(--c-200)}

/* ── Footer ──────────────────────────────────────────────────────── */
.footer{text-align:center;color:var(--c-400);font-size:12px;padding:28px 0;border-top:1px solid var(--c-200);margin-top:8px}
.footer a{color:var(--c-primary);text-decoration:none}
.footer a:hover{text-decoration:underline}

/* ── Responsive ──────────────────────────────────────────────────── */
@media(max-width:780px){
  .charts-row{grid-template-columns:1fr}
  .wins-grid{grid-template-columns:1fr}
  .header{flex-direction:column;gap:14px;text-align:center;padding:18px 20px}
  .header-brand{flex-direction:column;align-items:center}
  .header-meta{text-align:center}
  .summary-grid{grid-template-columns:repeat(2,1fr)}
  .tab-nav{overflow-x:auto;padding:0 4px}
  .table-toolbar{flex-direction:column;align-items:stretch}
  .toolbar-pagination{margin-left:0}
}
@media print{
  :root{color-scheme:light;--c-surface:#fff;--c-bg:#fff}
  body{background:#fff;color:#0f172a}
  .header{background:#0f172a!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .card{break-inside:avoid;box-shadow:none;border:1px solid var(--c-200)}
  .stat{box-shadow:none}
  .tab-nav,.table-toolbar,.pagination,.export-btn{display:none}
  .tab-pane{display:block!important}
}

/* ── Dark mode (via data-theme attribute) ─────────────────────────── */
:root[data-theme="dark"] {
  --c-bg: #0f172a;
  --c-50: #1e293b; --c-100: #1e293b; --c-200: #334155; --c-300: #475569;
  --c-400: #64748b; --c-500: #94a3b8; --c-600: #cbd5e1; --c-700: #e2e8f0;
  --c-800: #f1f5f9; --c-900: #f8fafc;
  --c-primary: #60a5fa; --c-primary-d: #3b82f6; --c-primary-l: #1e3a5f;
  --c-success: #34d399; --c-success-l: #064e3b;
  --c-warn: #fbbf24; --c-warn-l: #451a03;
  --c-danger: #f87171; --c-danger-l: #450a0a;
  --c-surface: #1e293b; --c-surface-hover: rgba(96,165,250,.08);
}
:root[data-theme="dark"] body { background: var(--c-bg); color: var(--c-900); }
:root[data-theme="dark"] .card { background: #1e293b; border-color: #334155; }
:root[data-theme="dark"] .card-header { background: #0f172a; border-color: #334155; }
:root[data-theme="dark"] .stat { background: #1e293b; border-color: #334155; }
:root[data-theme="dark"] .tab-nav { background: var(--c-surface); }
:root[data-theme="dark"] .win-card { background: var(--c-surface); }
:root[data-theme="dark"] .toolbar-search input { background-color: var(--c-surface); color: var(--c-900); }
:root[data-theme="dark"] .toolbar-filter select, :root[data-theme="dark"] .toolbar-pagination select { background-color: var(--c-surface); color: var(--c-900); }
:root[data-theme="dark"] .page-btn { background: var(--c-surface); color: var(--c-900); border-color: var(--c-200); }
:root[data-theme="dark"] .page-btn:hover:not(:disabled) { background: var(--c-100); border-color: var(--c-300); color: var(--c-900); }
:root[data-theme="dark"] .badge-critical { background: #450a0a; color: #fca5a5; }
:root[data-theme="dark"] .badge-high { background: #5a2410; color: #fed7aa; }
:root[data-theme="dark"] .badge-medium { background: #4a3728; color: #fde047; }
:root[data-theme="dark"] .badge-low { background: #064e3b; color: #86efac; }
:root[data-theme="dark"] .badge-info { background: #1e3a8a; color: #93c5fd; }
:root[data-theme="dark"] .tag-count-badge { background: #064e3b; color: #34d399; }
:root[data-theme="dark"] .instance-type { background: #1e3a8a; color: #93c5fd; }
:root[data-theme="dark"] .rec-row:hover td, :root[data-theme="dark"] .res-row:hover td { background: var(--c-surface-hover)!important; }
:root[data-theme="dark"] .rec-expanded td, :root[data-theme="dark"] .res-expanded td { background: var(--c-surface-hover); border-color: var(--c-primary-l)!important; }
:root[data-theme="dark"] tbody td { border-bottom-color: #334155; }
:root[data-theme="dark"] .svc-table tbody td { border-bottom-color: #334155; }
:root[data-theme="dark"] .trend-area-up { fill: #450a0a; opacity: 1; }
:root[data-theme="dark"] .trend-area-dn { fill: #064e3b; opacity: 1; }
:root[data-theme="dark"] .export-btn { background: #064e3b; border-color: #047857; color: #34d399; }
:root[data-theme="dark"] .export-btn:hover { background: #047857; border-color: #059669; box-shadow: 0 2px 6px rgba(52,211,153,.15); }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --c-bg: #0f172a;
    --c-50: #1e293b; --c-100: #1e293b; --c-200: #334155; --c-300: #475569;
    --c-400: #64748b; --c-500: #94a3b8; --c-600: #cbd5e1; --c-700: #e2e8f0;
    --c-800: #f1f5f9; --c-900: #f8fafc;
    --c-primary: #60a5fa; --c-primary-d: #3b82f6; --c-primary-l: #1e3a5f;
    --c-success: #34d399; --c-success-l: #064e3b;
    --c-warn: #fbbf24; --c-warn-l: #451a03;
    --c-danger: #f87171; --c-danger-l: #450a0a;
    --c-surface: #1e293b; --c-surface-hover: rgba(96,165,250,.08);
  }
  :root:not([data-theme="light"]) body { background: var(--c-bg); color: var(--c-900); }
  :root:not([data-theme="light"]) .card { background: #1e293b; border-color: #334155; }
  :root:not([data-theme="light"]) .card-header { background: #0f172a; border-color: #334155; }
  :root:not([data-theme="light"]) .stat { background: #1e293b; border-color: #334155; }
  :root:not([data-theme="light"]) .tab-nav { background: var(--c-surface); }
  :root:not([data-theme="light"]) .win-card { background: var(--c-surface); }
  :root:not([data-theme="light"]) .toolbar-search input { background-color: var(--c-surface); color: var(--c-900); }
  :root:not([data-theme="light"]) .toolbar-filter select, :root:not([data-theme="light"]) .toolbar-pagination select { background-color: var(--c-surface); color: var(--c-900); }
  :root:not([data-theme="light"]) .page-btn { background: var(--c-surface); color: var(--c-900); border-color: var(--c-200); }
  :root:not([data-theme="light"]) .page-btn:hover:not(:disabled) { background: var(--c-100); border-color: var(--c-300); color: var(--c-900); }
  :root:not([data-theme="light"]) .badge-critical { background: #450a0a; color: #fca5a5; }
  :root:not([data-theme="light"]) .badge-high { background: #5a2410; color: #fed7aa; }
  :root:not([data-theme="light"]) .badge-medium { background: #4a3728; color: #fde047; }
  :root:not([data-theme="light"]) .badge-low { background: #064e3b; color: #86efac; }
  :root:not([data-theme="light"]) .badge-info { background: #1e3a8a; color: #93c5fd; }
  :root:not([data-theme="light"]) .tag-count-badge { background: #064e3b; color: #34d399; }
  :root:not([data-theme="light"]) .instance-type { background: #1e3a8a; color: #93c5fd; }
  :root:not([data-theme="light"]) .rec-row:hover td, :root:not([data-theme="light"]) .res-row:hover td { background: var(--c-surface-hover)!important; }
  :root:not([data-theme="light"]) .rec-expanded td, :root:not([data-theme="light"]) .res-expanded td { background: var(--c-surface-hover); border-color: var(--c-primary-l)!important; }
  :root:not([data-theme="light"]) tbody td { border-bottom-color: #334155; }
  :root:not([data-theme="light"]) .svc-table tbody td { border-bottom-color: #334155; }
  :root:not([data-theme="light"]) .trend-area-up { fill: #450a0a; opacity: 1; }
  :root:not([data-theme="light"]) .trend-area-dn { fill: #064e3b; opacity: 1; }
  :root:not([data-theme="light"]) .export-btn { background: #064e3b; border-color: #047857; color: #34d399; }
  :root:not([data-theme="light"]) .export-btn:hover { background: #047857; border-color: #059669; box-shadow: 0 2px 6px rgba(52,211,153,.15); }
}
`.trim();
