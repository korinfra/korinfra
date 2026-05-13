/**
 * Client-side JavaScript for the HTML scan report.
 * This file contains all interactive logic: tab switching, search, filtering,
 * sorting, pagination, and expandable recommendation rows.
 *
 * Edit this file to change report interactivity.
 * It is embedded verbatim inside a <script> tag — no TypeScript in here,
 * just vanilla JS that runs in the browser.
 *
 * Data injection points (filled by html.ts before embedding):
 *   %%REPORT_JSON%%  — serialised ScanReport (resources, recommendations, costs, summary)
 *   %%CURRENCY%%     — currency code string, e.g. "USD"
 */

export function buildReportClientJS(reportJSON: string, currency: string): string {
  // NOTE: Do NOT use TypeScript template literals (${...}) inside the returned
  // string for JS code. All JS dynamic values go through string concatenation.
  return (
    'const R=' + reportJSON + ';\n' +
    'const CUR=' + JSON.stringify(currency) + ';\n'
  ) + RAW_CLIENT_JS;
}

// ---------------------------------------------------------------------------
// All JS below is raw browser code (no TypeScript).
// It is stored as a plain string constant to keep it syntactically separate
// from TypeScript and to avoid accidental TS interpolation of JS template
// literals.
// ---------------------------------------------------------------------------

const RAW_CLIENT_JS = `
// ── Utilities ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fc(n) {
  if (n == null || isNaN(n)) return CUR === 'USD' ? '$0.00' : CUR + ' 0.00';
  var sym = CUR === 'USD' ? '$' : CUR + ' ';
  if (n === 0) return sym + '0.00';
  if (n < 1)   return sym + n.toFixed(4);
  return sym + n.toFixed(2);
}
function stateColor(s) {
  switch ((s || '').toLowerCase()) {
    case 'running': case 'active': case 'available': return '#16a34a';
    case 'stopped': case 'stopping': return '#dc2626';
    case 'pending': return '#ca8a04';
    default: return '#64748b';
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-pane').forEach(function(p) { p.style.display = 'none'; });
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    b.classList.remove('active');
    b.setAttribute('aria-selected', 'false');
  });
  var pane = document.getElementById('tab-' + name);
  var btn  = document.getElementById('btn-' + name);
  if (pane) pane.style.display = 'block';
  if (btn) {
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
  }
  try { history.replaceState(null, '', '?tab=' + name); } catch(e) { console.warn('[korinfra-report] history.replaceState failed', e); }
}

// ── Smart page range ──────────────────────────────────────────────────────────
// Returns array of page numbers and '...' separators, e.g. [1,'...',4,5,6,'...',20]
function pageRange(cur, total) {
  if (total <= 7) {
    var a = [];
    for (var i = 1; i <= total; i++) a.push(i);
    return a;
  }
  var r = [1];
  if (cur > 4) r.push('...');
  var lo = Math.max(2, cur - 2);
  var hi = Math.min(total - 1, cur + 2);
  for (var j = lo; j <= hi; j++) r.push(j);
  if (cur < total - 3) r.push('...');
  r.push(total);
  return r;
}

function renderPageBtns(containerId, cur, total, onPage) {
  var cont = document.getElementById(containerId);
  if (!cont) return;
  var range = pageRange(cur, total);
  var html = '';
  range.forEach(function(p) {
    if (p === '...') {
      html += '<span class="muted-text" style="padding:0 4px;line-height:34px">&#8230;</span>';
    } else {
      html += '<button class="page-btn' + (p === cur ? ' active' : '') + '" onclick="(' + onPage.toString() + ')(' + p + ')">' + p + '</button>';
    }
  });
  cont.innerHTML = html;
}

// ── Resources tab ─────────────────────────────────────────────────────────────
var RS = {
  search: '', type: '', region: '', state: '',
  sortField: 'monthlyCost', sortAsc: false,
  page: 1, perPage: 25,
  expanded: {},

  filtered: function() {
    var q = this.search.toLowerCase();
    return R.resources.filter(function(r) {
      if (q && !(
        r.id.toLowerCase().indexOf(q) >= 0 ||
        r.name.toLowerCase().indexOf(q) >= 0 ||
        r.type.toLowerCase().indexOf(q) >= 0 ||
        (r.region || '').toLowerCase().indexOf(q) >= 0 ||
        (r.instanceType || '').toLowerCase().indexOf(q) >= 0
      )) return false;
      if (RS.type   && r.type   !== RS.type)   return false;
      if (RS.region && r.region !== RS.region) return false;
      if (RS.state  && r.state  !== RS.state)  return false;
      return true;
    });
  },
  sorted: function() {
    var f = this.sortField, asc = this.sortAsc;
    return this.filtered().slice().sort(function(a, b) {
      var av = a[f] == null ? '' : a[f];
      var bv = b[f] == null ? '' : b[f];
      if (typeof av === 'number') return asc ? av - bv : bv - av;
      return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
  },

  toggleRow: function(id) {
    this.expanded[id] = !this.expanded[id];
    this.render();
  },

  render: function() {
    var sorted  = this.sorted();
    var total   = sorted.length;
    var start   = (this.page - 1) * this.perPage;
    var page    = sorted.slice(start, start + this.perPage);
    var totalPages = Math.max(1, Math.ceil(total / this.perPage));
    if (this.page > totalPages) this.page = totalPages;

    // Count badge + page info
    var countEl = document.getElementById('res-count');
    if (countEl) countEl.textContent = total + ' of ' + R.resources.length + ' resources';
    var infoEl = document.getElementById('res-page-info');
    if (infoEl) infoEl.textContent = total > 0 ? 'Showing ' + (start + 1) + '–' + Math.min(start + this.perPage, total) + ' of ' + total : 'No results';

    // Sort indicators on headers
    ['id','type','name','region','state','monthlyCost'].forEach(function(f) {
      var th = document.getElementById('res-th-' + f);
      if (!th) return;
      th.className = '';
      if (RS.sortField === f) th.className = RS.sortAsc ? 'sorted-asc' : 'sorted-desc';
    });

    // Rows
    var tbody = document.getElementById('resources-tbody');
    if (!tbody) return;
    if (page.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No resources match your filters</td></tr>';
    } else {
      var rows = '';
      page.forEach(function(r) {
        var itype = r.instanceType ? '<span class="instance-type">' + esc(r.instanceType) + '</span>' : '';
        var tags  = r.tags ? Object.keys(r.tags).length : 0;
        var tagBadge = tags > 0
          ? '<span class="tag-count-badge">' + tags + ' tag' + (tags !== 1 ? 's' : '') + '</span>'
          : '';
        var isExp = !!RS.expanded[r.id];
        rows += '<tr class="res-row" data-id="' + esc(r.id) + '" onclick="RS.toggleRow(this.dataset.id)">' +
          '<td><code>' + esc(r.id) + '</code></td>' +
          '<td class="type-cell">' + esc(r.type) + itype + '</td>' +
          '<td>' + esc(r.name) + '</td>' +
          '<td class="region-cell">' + esc(r.region || '') + '</td>' +
          '<td><span class="state-dot" style="background:' + stateColor(r.state) + '"></span>' +
            '<span class="state-text">' + esc(r.state) + '</span>' + tagBadge + '</td>' +
          '<td class="cost-cell">' + esc(fc(r.monthlyCost)) + '</td>' +
          '</tr>';
        if (isExp) {
          var tagsHtml = '';
          if (r.tags && Object.keys(r.tags).length > 0) {
            tagsHtml = '<div class="tag-grid">' +
              Object.entries(r.tags).map(function(kv) {
                return '<span class="tag-pill">' + esc(kv[0]) + '=' + esc(kv[1]) + '</span>';
              }).join('') +
              '</div>';
          } else {
            tagsHtml = '<div class="tag-grid"><span class="muted-text" style="font-style:italic">No tags</span></div>';
          }
          rows += '<tr class="res-expanded"><td colspan="6"><div class="res-expanded-content">' +
            tagsHtml +
            '<div class="res-meta">' +
            '<span class="ml">ID</span> <code>' + esc(r.id) + '</code>' +
            ' &nbsp;&middot;&nbsp; <span class="ml">Type</span> ' + esc(r.type) +
            ' &nbsp;&middot;&nbsp; <span class="ml">Instance</span> ' + esc(r.instanceType || '—') +
            ' &nbsp;&middot;&nbsp; <span class="ml">Region</span> ' + esc(r.region || '—') +
            ' &nbsp;&middot;&nbsp; <span class="ml">State</span> ' + esc(r.state || '—') +
            ' &nbsp;&middot;&nbsp; <span class="ml">Cost/mo</span> ' + fc(r.monthlyCost) +
            '</div></div></td></tr>';
        }
      });
      tbody.innerHTML = rows;
    }

    // Pagination
    var prevBtn = document.getElementById('res-prev-btn');
    var nextBtn = document.getElementById('res-next-btn');
    if (prevBtn) prevBtn.disabled = this.page <= 1;
    if (nextBtn) nextBtn.disabled = this.page >= totalPages;
    renderPageBtns('res-page-nums', this.page, totalPages, function(p) { RS.page = p; RS.render(); });
  },

  onSearch:    function(v) { this.search = v; this.page = 1; this.render(); },
  onType:      function(v) { this.type   = v; this.page = 1; this.render(); },
  onRegion:    function(v) { this.region = v; this.page = 1; this.render(); },
  onState:     function(v) { this.state  = v; this.page = 1; this.render(); },
  onPerPage:   function(v) { this.perPage = parseInt(v, 10); this.page = 1; this.render(); },
  onSort:      function(f) {
    if (this.sortField === f) { this.sortAsc = !this.sortAsc; } else { this.sortField = f; this.sortAsc = false; }
    this.render();
  },
  prevPage:    function() { if (this.page > 1) { this.page--; this.render(); } },
  nextPage:    function() { var tp = Math.ceil(this.sorted().length / this.perPage); if (this.page < tp) { this.page++; this.render(); } }
};

// ── Recommendations tab ───────────────────────────────────────────────────────
var RC = {
  search: '', impact: '', risk: '',
  sortField: 'estimatedSavings', sortAsc: false,
  page: 1, perPage: 25,
  expanded: {},

  filtered: function() {
    var q = this.search.toLowerCase();
    return R.recommendations.filter(function(r) {
      if (q && !(
        r.title.toLowerCase().indexOf(q) >= 0 ||
        (r.description || '').toLowerCase().indexOf(q) >= 0 ||
        (r.resourceId  || '').toLowerCase().indexOf(q) >= 0
      )) return false;
      if (RC.impact && r.impact !== RC.impact) return false;
      if (RC.risk   && r.risk   !== RC.risk)   return false;
      return true;
    });
  },
  sorted: function() {
    var f = this.sortField, asc = this.sortAsc;
    return this.filtered().slice().sort(function(a, b) {
      var av = a[f] == null ? '' : a[f];
      var bv = b[f] == null ? '' : b[f];
      if (typeof av === 'number') return asc ? av - bv : bv - av;
      return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
  },

  toggle: function(id) {
    this.expanded[id] = !this.expanded[id];
    this.render();
  },

  render: function() {
    var sorted     = this.sorted();
    var total      = sorted.length;
    var start      = (this.page - 1) * this.perPage;
    var page       = sorted.slice(start, start + this.perPage);
    var totalPages = Math.max(1, Math.ceil(total / this.perPage));
    if (this.page > totalPages) this.page = totalPages;

    var countEl = document.getElementById('rec-count');
    if (countEl) countEl.textContent = total + ' of ' + R.recommendations.length + ' recommendations';
    var infoEl = document.getElementById('rec-page-info');
    if (infoEl) infoEl.textContent = total > 0 ? 'Showing ' + (start + 1) + '–' + Math.min(start + this.perPage, total) + ' of ' + total : 'No results';

    ['title','estimatedSavings','confidence','impact','risk'].forEach(function(f) {
      var th = document.getElementById('rec-th-' + f);
      if (!th) return;
      th.className = '';
      if (RC.sortField === f) th.className = RC.sortAsc ? 'sorted-asc' : 'sorted-desc';
    });

    var tbody = document.getElementById('recommendations-tbody');
    if (!tbody) return;
    if (page.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No recommendations match your filters</td></tr>';
    } else {
      var rows = '';
      page.forEach(function(r) {
        var pct      = Math.round((r.confidence || 0) * 100);
        var barColor = pct >= 80 ? '#008672' : pct >= 50 ? '#ca8a04' : '#e11d48';
        var isExp    = !!RC.expanded[r.id];
        var icon     = isExp ? '&#8964;' : '&#8250;';

        var annual = fc(r.estimatedSavings * 12);
        rows += '<tr class="rec-row" data-id="' + esc(r.id) + '" onclick="RC.toggle(this.dataset.id)">' +
          '<td class="rec-expand-col" style="font-size:16px">' + icon + '</td>' +
          '<td><div class="rec-title-cell">' + esc(r.title) + '</div>' +
            (r.resourceId ? '<div class="rec-resource-hint">' + esc(r.resourceId) + '</div>' : '') +
          '</td>' +
          '<td class="rec-savings">' + esc(fc(r.estimatedSavings)) + '<span class="per">/mo</span><div class="rec-savings-annual">~' + esc(annual) + '/yr</div></td>' +
          '<td><div class="conf-wrap">' +
            '<div class="conf-bar"><div class="conf-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div>' +
            '<span class="conf-pct">' + pct + '%</span></div></td>' +
          '<td><span class="badge badge-' + esc(r.impact) + '">' + esc((r.impact || '').toUpperCase()) + '</span></td>' +
          '<td><span class="badge badge-' + esc(r.risk)   + '">' + esc((r.risk   || '').toUpperCase()) + '</span></td>' +
          '</tr>';

        if (isExp) {
          rows += '<tr class="rec-expanded"><td colspan="6"><div class="rec-expanded-content">' +
            (r.description ? '<div class="rec-desc">' + esc(r.description) + '</div>' : '') +
            '<div class="rec-meta">' +
              '<span class="ml">Resource</span> <code>' + esc(r.resourceId || '—') + '</code>' +
              ' &nbsp;&middot;&nbsp; <span class="ml">Type</span> ' + esc(r.type || '—') +
              ' &nbsp;&middot;&nbsp; <span class="ml">Status</span> ' + esc(r.status || '—') +
            '</div>' +
            '</div></td></tr>';
        }
      });
      tbody.innerHTML = rows;
    }

    var prevBtn = document.getElementById('rec-prev-btn');
    var nextBtn = document.getElementById('rec-next-btn');
    if (prevBtn) prevBtn.disabled = this.page <= 1;
    if (nextBtn) nextBtn.disabled = this.page >= totalPages;
    renderPageBtns('rec-page-nums', this.page, totalPages, function(p) { RC.page = p; RC.render(); });
  },

  onSearch:  function(v) { this.search = v; this.page = 1; this.render(); },
  onImpact:  function(v) { this.impact = v; this.page = 1; this.render(); },
  onRisk:    function(v) { this.risk   = v; this.page = 1; this.render(); },
  onPerPage: function(v) { this.perPage = parseInt(v, 10); this.page = 1; this.render(); },
  onSort:    function(f) {
    if (this.sortField === f) { this.sortAsc = !this.sortAsc; } else { this.sortField = f; this.sortAsc = false; }
    this.render();
  },
  prevPage:  function() { if (this.page > 1) { this.page--; this.render(); } },
  nextPage:  function() { var tp = Math.ceil(this.sorted().length / this.perPage); if (this.page < tp) { this.page++; this.render(); } }
};

// ── Daily Costs tab ──────────────────────────────────────────────────────────────
var DC = {
  search: '', region: '',
  sortField: 'costDate', sortAsc: false,
  page: 1, perPage: 50,

  filtered: function() {
    var q = this.search.toLowerCase();
    return R.costs.filter(function(c) {
      if (q && c.serviceName.toLowerCase().indexOf(q) < 0) return false;
      if (DC.region && c.region !== DC.region) return false;
      return true;
    });
  },
  sorted: function() {
    var f = this.sortField, asc = this.sortAsc;
    return this.filtered().slice().sort(function(a, b) {
      var av = f === 'monthlyProj' ? a.dailyCost * 30 : (a[f] == null ? '' : a[f]);
      var bv = f === 'monthlyProj' ? b.dailyCost * 30 : (b[f] == null ? '' : b[f]);
      if (typeof av === 'number') return asc ? av - bv : bv - av;
      return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
  },

  render: function() {
    var sorted  = this.sorted();
    var total   = sorted.length;
    var start   = (this.page - 1) * this.perPage;
    var page    = sorted.slice(start, start + this.perPage);
    var totalPages = Math.max(1, Math.ceil(total / this.perPage));
    if (this.page > totalPages) this.page = totalPages;

    var countEl = document.getElementById('dc-count');
    if (countEl) countEl.textContent = total + ' of ' + R.costs.length + ' daily costs';
    var infoEl = document.getElementById('dc-page-info');
    if (infoEl) infoEl.textContent = total > 0 ? 'Showing ' + (start + 1) + '–' + Math.min(start + this.perPage, total) + ' of ' + total : 'No results';

    ['costDate','serviceName','region','dailyCost','monthlyProj'].forEach(function(f) {
      var th = document.getElementById('dc-th-' + f);
      if (!th) return;
      th.className = '';
      if (DC.sortField === f) th.className = DC.sortAsc ? 'sorted-asc' : 'sorted-desc';
    });

    var tbody = document.getElementById('dc-tbody');
    if (!tbody) return;
    if (page.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No daily costs match your filters</td></tr>';
    } else {
      tbody.innerHTML = page.map(function(c) {
        var proj = c.dailyCost * 30;
        return '<tr>' +
          '<td>' + esc(c.costDate) + '</td>' +
          '<td>' + esc(c.serviceName) + '</td>' +
          '<td class="region-cell">' + esc(c.region || '') + '</td>' +
          '<td class="cost-cell" style="text-align:right">' + fc(c.dailyCost) + '</td>' +
          '<td class="cost-cell" style="text-align:right">' + fc(proj) + '</td>' +
          '</tr>';
      }).join('');
    }

    var prevBtn = document.getElementById('dc-prev-btn');
    var nextBtn = document.getElementById('dc-next-btn');
    if (prevBtn) prevBtn.disabled = this.page <= 1;
    if (nextBtn) nextBtn.disabled = this.page >= totalPages;
    renderPageBtns('dc-page-nums', this.page, totalPages, function(p) { DC.page = p; DC.render(); });
  },

  onSearch:    function(v) { this.search = v; this.page = 1; this.render(); },
  onRegion:    function(v) { this.region = v; this.page = 1; this.render(); },
  onPerPage:   function(v) { this.perPage = parseInt(v, 10); this.page = 1; this.render(); },
  onSort:      function(f) {
    if (this.sortField === f) { this.sortAsc = !this.sortAsc; } else { this.sortField = f; this.sortAsc = false; }
    this.render();
  },
  prevPage:    function() { if (this.page > 1) { this.page--; this.render(); } },
  nextPage:    function() { var tp = Math.ceil(this.sorted().length / this.perPage); if (this.page < tp) { this.page++; this.render(); } }
};

// ── CSV Export ─────────────────────────────────────────────────────────────────
function triggerDownload(content, filename, mimeType) {
  var blob = new Blob([content], { type: mimeType });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadResourcesCSV() {
  var data = RS.sorted();
  var lines = [
    ['ID', 'Type', 'Name', 'Region', 'State', 'Instance Type', 'Monthly Cost', 'Tags'].map(function(h) { return '"' + h.replace(/"/g, '""') + '"'; }).join(',')
  ];
  data.forEach(function(r) {
    var tags = '';
    if (r.tags) {
      tags = Object.entries(r.tags).map(function(kv) { return kv[0] + '=' + kv[1]; }).join('; ');
    }
    lines.push([
      r.id,
      r.type,
      r.name,
      r.region || '',
      r.state,
      r.instanceType || '',
      r.monthlyCost.toFixed(2),
      tags
    ].map(function(f) {
      var s = String(f || '');
      if (/^[=+\\-@\\t\\r]/.test(s)) s = "'" + s;
      if (s.includes('"') || s.includes(',') || s.includes('\\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join(','));
  });
  triggerDownload(lines.join('\\n'), 'korinfra-resources.csv', 'text/csv');
}

function downloadRecsCSV() {
  var data = RC.sorted();
  var lines = [
    ['Title', 'Description', 'Resource', 'Type', 'Savings/mo', 'Annual Proj', 'Confidence%', 'Impact', 'Risk', 'Status'].map(function(h) { return '"' + h.replace(/"/g, '""') + '"'; }).join(',')
  ];
  data.forEach(function(r) {
    var pct = Math.round((r.confidence || 0) * 100);
    var annual = (r.estimatedSavings * 12).toFixed(2);
    lines.push([
      r.title,
      r.description || '',
      r.resourceId || '',
      r.type || '',
      r.estimatedSavings.toFixed(2),
      annual,
      pct,
      r.impact,
      r.risk,
      r.status
    ].map(function(f) {
      var s = String(f || '');
      if (/^[=+\\-@\\t\\r]/.test(s)) s = "'" + s;
      if (s.includes('"') || s.includes(',') || s.includes('\\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join(','));
  });
  triggerDownload(lines.join('\\n'), 'korinfra-recommendations.csv', 'text/csv');
}

// ── Global wrapper functions for onclick handlers ─────────────────────────────
function onResourcesSort(f) { RS.onSort(f); }
function onRecommendationsSort(f) { RC.onSort(f); }
function onDailyCostsSort(f) { DC.onSort(f); }

// ── Theme toggle ────────────────────────────────────────────────────────────
function toggleTheme() {
  var html = document.documentElement;
  var current = html.getAttribute('data-theme');
  var next = current === 'dark' ? 'light' : (current === 'light' ? 'dark' :
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark'));
  html.setAttribute('data-theme', next);
  var btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.textContent = next === 'dark' ? '☀' : '☾';
  try { localStorage.setItem('iw-theme', next); } catch(e) {}
}
// Apply saved theme on load
(function() {
  try {
    var saved = localStorage.getItem('iw-theme');
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
      var btn = document.getElementById('theme-toggle-btn');
      if (btn) btn.textContent = saved === 'dark' ? '☀' : '☾';
    }
  } catch(e) {}
})();

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', function() {
  var tab = (new URLSearchParams(window.location.search).get('tab')) || 'dashboard';
  switchTab(tab);
  try { RS.render(); } catch(e) { console.error('Resources render failed:', e); }
  try { RC.render(); } catch(e) { console.error('Recommendations render failed:', e); }
  try { DC.render(); } catch(e) { console.error('Costs render failed:', e); }
});
`;
