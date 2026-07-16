// @ts-nocheck
/**
 * QualityReviewSecurityWorkspacePanel — Consolidated quality, review, and security tools.
 *
 * Tabs:
 * 1. Architecture — scans, state, gates, history, rules, evolution, DSM, test gaps
 * 2. Artifacts — list, detail, history, diffs, delete
 * 3. Benchmarks — profiles, runs, results, compare, trends
 * 4. Review — AI review, code-review pipeline, visual diff, comments, recent, status
 * 5. Security — scans, doctor, remediation stats, firewall
 * 6. Lint/Test — config, manual run, detect, recent, output, rates, auto-fix
 * 7. Evidence & Runbooks — citations, reports, runbooks, predictive alerts
 *
 * IPC channels:
 * - arch:scan, arch:latest, arch:gate-start, arch:gate-end, arch:gate-history, arch:add-rule,
 *   arch:get-rules, arch:toggle-rule, arch:delete-rule, arch:evolution, arch:dsm, arch:test-gaps
 * - artifact:list, artifact:get, artifact:delete, artifact:history, artifact:diff
 * - bench:list-profiles, bench:create-profile, bench:run, bench:results, bench:trends
 * - diff-review:create, diff-review:get, diff-review:list, diff-review:pending, diff-review:accept, diff-review:reject
 * - security:analyze-action, security:remediation-stats
 * - lint-test:get-config, lint-test:set-config, lint-test:run, lint-test:recent-runs, lint-test:stats, lint-test:detect
 * - evidence:cite, evidence:list, reports:create, reports:list, reports:update-status
 * - runbooks:list, runbooks:create, runbooks:toggle, runbooks:delete, runbooks:find-matching
 * - predictive:active, predictive:acknowledge, predictive:analyze
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Requirements: 7.1-7.10
 */

// ─── Constants ─────────────────────────────────────────────────────

var QRS_TABS = [
  { id: 'architecture', label: 'Architecture', icon: '\uD83C\uDFD7' },
  { id: 'artifacts', label: 'Artifacts', icon: '\uD83D\uDCE4' },
  { id: 'benchmarks', label: 'Benchmarks', icon: '\u23F1' },
  { id: 'review', label: 'Review', icon: '\uD83D\uDD0D' },
  { id: 'security', label: 'Security', icon: '\uD83D\uDD12' },
  { id: 'lint-test', label: 'Lint/Test', icon: '\u2705' },
  { id: 'evidence', label: 'Evidence', icon: '\uD83D\uDCCB' },
];

// ─── Helpers ───────────────────────────────────────────────────────

function qrsEsc(s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
function qrsApi() { return window.electronAPI; }
function qrsEl(tag, css, attrs) {
  var el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]); } }
  return el;
}
function qrsBadge(text, color) {
  return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:' + color + '22;color:' + color + ';font-weight:600;">' + qrsEsc(text) + '</span>';
}
function qrsTime(ts) {
  if (!ts) return '-';
  var d = new Date(ts); if (isNaN(d.getTime())) return '-';
  var diff = Date.now() - d.getTime();
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return d.toLocaleDateString();
}

// ─── Panel class ───────────────────────────────────────────────────

function QualityReviewSecurityWorkspacePanel(container, options) {
  this.container = container;
  this.projectId = (options && options.projectId) || 'default';
  this.activeTab = 'architecture';
  this.tabContent = null;
}

QualityReviewSecurityWorkspacePanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.cssText = 'padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);';

  var header = qrsEl('h3', 'margin:0 0 12px;font-size:16px;color:var(--text-primary,#cdd6f4);');
  header.textContent = 'Quality, Review & Security';
  this.container.appendChild(header);

  var tabBar = qrsEl('div', 'display:flex;gap:2px;margin-bottom:16px;border-bottom:1px solid var(--border-color,#45475a);overflow-x:auto;');
  for (var i = 0; i < QRS_TABS.length; i++) {
    (function (tab) {
      var btn = qrsEl('button',
        'padding:6px 10px;border:none;border-bottom:2px solid transparent;background:transparent;' +
        'color:var(--text-secondary,#a6adc8);cursor:pointer;font-size:11px;white-space:nowrap;',
        { 'aria-label': tab.label, role: 'tab' });
      btn.textContent = tab.icon + ' ' + tab.label;
      if (tab.id === self.activeTab) { btn.style.color = 'var(--accent-color,#89b4fa)'; btn.style.borderBottomColor = 'var(--accent-color,#89b4fa)'; }
      btn.addEventListener('click', function () { self.activeTab = tab.id; self.render(); });
      tabBar.appendChild(btn);
    })(QRS_TABS[i]);
  }
  this.container.appendChild(tabBar);
  this.tabContent = qrsEl('div', 'min-height:300px;');
  this.container.appendChild(this.tabContent);
  this.loadTab(this.activeTab);
};

QualityReviewSecurityWorkspacePanel.prototype.loadTab = function (id) {
  switch (id) {
    case 'architecture': this.renderArch(); break;
    case 'artifacts': this.renderArtifacts(); break;
    case 'benchmarks': this.renderBenchmarks(); break;
    case 'review': this.renderReview(); break;
    case 'security': this.renderSecurity(); break;
    case 'lint-test': this.renderLintTest(); break;
    case 'evidence': this.renderEvidence(); break;
  }
};

// ─── Architecture Tab ──────────────────────────────────────────────

QualityReviewSecurityWorkspacePanel.prototype.renderArch = function () {
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading architecture...</div>';
  var api = qrsApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  Promise.all([api.invoke('arch:latest', {}), api.invoke('arch:get-rules', {})]).then(function (res) {
    el.innerHTML = '';
    var latest = res[0] || {}; var rules = Array.isArray(res[1]) ? res[1] : (res[1] && res[1].rules) || [];

    var card = qrsEl('div', 'padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;');
    card.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;">Latest Scan</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);line-height:1.6;">' +
      '<div>Components: ' + (latest.componentCount || latest.components || 0) + '</div>' +
      '<div>Dependencies: ' + (latest.dependencyCount || 0) + '</div>' +
      '<div>Violations: ' + (latest.violationCount || 0) + '</div>' +
      '<div>Scanned: ' + qrsTime(latest.scannedAt || latest.timestamp) + '</div></div>';
    el.appendChild(card);

    var actions = qrsEl('div', 'display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;');
    var scanBtn = qrsEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    scanBtn.textContent = '\uD83D\uDD0D Scan';
    scanBtn.addEventListener('click', function () { api.invoke('arch:scan', {}).catch(function () {}); });
    actions.appendChild(scanBtn);
    var evolBtn = qrsEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
    evolBtn.textContent = 'Evolution';
    evolBtn.addEventListener('click', function () { api.invoke('arch:evolution', {}).then(function (r) { if (r) alert(JSON.stringify(r, null, 2)); }).catch(function () {}); });
    actions.appendChild(evolBtn);
    var dsmBtn = qrsEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
    dsmBtn.textContent = 'DSM';
    dsmBtn.addEventListener('click', function () { api.invoke('arch:dsm', {}).then(function (r) { if (r) alert(JSON.stringify(r, null, 2)); }).catch(function () {}); });
    actions.appendChild(dsmBtn);
    var gapsBtn = qrsEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
    gapsBtn.textContent = 'Test Gaps';
    gapsBtn.addEventListener('click', function () { api.invoke('arch:test-gaps', {}).then(function (r) { if (r) alert(JSON.stringify(r, null, 2)); }).catch(function () {}); });
    actions.appendChild(gapsBtn);
    el.appendChild(actions);

    // Rules
    if (rules.length > 0) {
      var rulesHeader = qrsEl('div', 'font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:6px;');
      rulesHeader.textContent = 'Rules (' + rules.length + ')';
      el.appendChild(rulesHeader);
      for (var i = 0; i < Math.min(rules.length, 10); i++) {
        var r = rules[i];
        var rEl = qrsEl('div', 'font-size:11px;padding:4px 8px;margin-bottom:4px;background:var(--surface-tertiary,#45475a);border-radius:4px;color:var(--text-secondary,#a6adc8);');
        rEl.innerHTML = qrsEsc(r.name || r.pattern || r.id) + ' ' + qrsBadge(r.enabled !== false ? 'on' : 'off', r.enabled !== false ? '#a6e3a1' : '#6c7086');
        el.appendChild(rEl);
      }
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load architecture data</div>'; });
};

// ─── Artifacts Tab ─────────────────────────────────────────────────

QualityReviewSecurityWorkspacePanel.prototype.renderArtifacts = function () {
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading artifacts...</div>';
  var api = qrsApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  api.invoke('artifact:list', {}).then(function (result) {
    el.innerHTML = '';
    var artifacts = Array.isArray(result) ? result : (result && result.artifacts) || [];
    if (artifacts.length === 0) { el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary,#a6adc8);">\uD83D\uDCE4 No artifacts.</div>'; return; }
    for (var i = 0; i < artifacts.length; i++) {
      var a = artifacts[i];
      var card = qrsEl('div', 'padding:8px 12px;margin-bottom:6px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);font-size:11px;');
      card.innerHTML = '<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-primary,#cdd6f4);font-weight:600;">' + qrsEsc(a.name || a.id) + '</span><span style="color:var(--text-muted,#6c7086);">' + qrsTime(a.createdAt) + '</span></div>' +
        '<div style="color:var(--text-muted,#6c7086);margin-top:2px;">' + qrsEsc(a.type || '') + ' | ' + (a.size || '') + '</div>';
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load artifacts</div>'; });
};

// ─── Benchmarks Tab ────────────────────────────────────────────────

QualityReviewSecurityWorkspacePanel.prototype.renderBenchmarks = function () {
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading benchmarks...</div>';
  var api = qrsApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  Promise.all([api.invoke('bench:list-profiles', {}), api.invoke('bench:results', {})]).then(function (res) {
    el.innerHTML = '';
    var profiles = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].profiles) || [];
    var results = Array.isArray(res[1]) ? res[1] : (res[1] && res[1].results) || [];

    var actions = qrsEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var runBtn = qrsEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    runBtn.textContent = '\u25B6 Run Benchmark';
    runBtn.addEventListener('click', function () { api.invoke('bench:run', {}).catch(function () {}); });
    actions.appendChild(runBtn);
    var trendsBtn = qrsEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
    trendsBtn.textContent = '\uD83D\uDCC8 Trends';
    trendsBtn.addEventListener('click', function () { api.invoke('bench:trends', {}).then(function (r) { if (r) alert(JSON.stringify(r, null, 2)); }).catch(function () {}); });
    actions.appendChild(trendsBtn);
    el.appendChild(actions);

    if (profiles.length > 0) {
      var ph = qrsEl('div', 'font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:6px;');
      ph.textContent = 'Profiles (' + profiles.length + ')';
      el.appendChild(ph);
      for (var i = 0; i < profiles.length; i++) {
        var p = profiles[i];
        var pEl = qrsEl('div', 'font-size:11px;padding:4px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;color:var(--text-secondary,#a6adc8);border:1px solid var(--border-color,#45475a);');
        pEl.textContent = (p.name || p.id) + ' — ' + (p.description || '');
        el.appendChild(pEl);
      }
    }

    if (results.length > 0) {
      var rh = qrsEl('div', 'font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin:12px 0 6px;');
      rh.textContent = 'Recent Results (' + results.length + ')';
      el.appendChild(rh);
      for (var j = 0; j < Math.min(results.length, 5); j++) {
        var r = results[j];
        var rEl = qrsEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);');
        rEl.innerHTML = '<span style="color:var(--text-primary,#cdd6f4);">' + qrsEsc(r.name || r.profile || 'Run') + '</span> — ' +
          '<span style="color:var(--text-muted,#6c7086);">' + qrsTime(r.completedAt || r.timestamp) + '</span>';
        el.appendChild(rEl);
      }
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load benchmarks</div>'; });
};

// ─── Review Tab ────────────────────────────────────────────────────

QualityReviewSecurityWorkspacePanel.prototype.renderReview = function () {
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading reviews...</div>';
  var api = qrsApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  Promise.all([api.invoke('diff-review:list', {}), api.invoke('diff-review:pending', {})]).then(function (res) {
    el.innerHTML = '';
    var reviews = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].reviews) || [];
    var pending = Array.isArray(res[1]) ? res[1] : (res[1] && res[1].pending) || [];

    var actions = qrsEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var createBtn = qrsEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    createBtn.textContent = '+ New Review';
    createBtn.addEventListener('click', function () { api.invoke('diff-review:create', {}).catch(function () {}); });
    actions.appendChild(createBtn);
    el.appendChild(actions);

    if (pending.length > 0) {
      var ph = qrsEl('div', 'font-size:12px;font-weight:600;color:#f9e2af;margin-bottom:6px;');
      ph.textContent = '\u26A0 Pending (' + pending.length + ')';
      el.appendChild(ph);
      for (var i = 0; i < pending.length; i++) {
        var p = pending[i];
        var pEl = qrsEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid #f9e2af44;');
        pEl.innerHTML = '<span style="color:var(--text-primary,#cdd6f4);">' + qrsEsc(p.title || p.id) + '</span> ' + qrsBadge('pending', '#f9e2af');
        el.appendChild(pEl);
      }
    }

    if (reviews.length > 0) {
      var rh = qrsEl('div', 'font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin:12px 0 6px;');
      rh.textContent = 'Recent (' + reviews.length + ')';
      el.appendChild(rh);
      for (var j = 0; j < Math.min(reviews.length, 10); j++) {
        var r = reviews[j];
        var rEl = qrsEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);');
        rEl.innerHTML = '<span style="color:var(--text-primary,#cdd6f4);">' + qrsEsc(r.title || r.id) + '</span> ' + qrsBadge(r.status || 'done', r.status === 'approved' ? '#a6e3a1' : '#89b4fa') +
          '<div style="color:var(--text-muted,#6c7086);margin-top:2px;">' + qrsTime(r.createdAt) + '</div>';
        el.appendChild(rEl);
      }
    } else if (pending.length === 0) {
      el.innerHTML += '<div style="text-align:center;padding:30px;color:var(--text-secondary,#a6adc8);">No reviews yet.</div>';
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load reviews</div>'; });
};

// ─── Security Tab ──────────────────────────────────────────────────

QualityReviewSecurityWorkspacePanel.prototype.renderSecurity = function () {
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading security status...</div>';
  var api = qrsApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  api.invoke('security:remediation-stats', {}).then(function (stats) {
    el.innerHTML = '';
    var s = stats || {};

    var card = qrsEl('div', 'padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;');
    card.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;">\uD83D\uDD12 Security Overview</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);line-height:1.6;">' +
      '<div>Vulnerabilities found: ' + (s.totalVulnerabilities || s.total || 0) + '</div>' +
      '<div>Remediated: ' + (s.remediated || 0) + '</div>' +
      '<div>Pending: ' + (s.pending || 0) + '</div>' +
      '<div>Auto-fixed: ' + (s.autoFixed || 0) + '</div></div>';
    el.appendChild(card);

    var actions = qrsEl('div', 'display:flex;gap:6px;flex-wrap:wrap;');
    var scanBtn = qrsEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    scanBtn.textContent = '\uD83D\uDD0D Run Scan';
    scanBtn.addEventListener('click', function () { api.invoke('security:analyze-action', { action: 'full-scan' }).catch(function () {}); });
    actions.appendChild(scanBtn);
    el.appendChild(actions);
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load security stats</div>'; });
};

// ─── Lint/Test Tab ─────────────────────────────────────────────────

QualityReviewSecurityWorkspacePanel.prototype.renderLintTest = function () {
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading lint/test config...</div>';
  var api = qrsApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  Promise.all([api.invoke('lint-test:get-config', {}), api.invoke('lint-test:stats', {}), api.invoke('lint-test:recent-runs', {})]).then(function (res) {
    el.innerHTML = '';
    var config = res[0] || {}; var stats = res[1] || {}; var recent = Array.isArray(res[2]) ? res[2] : (res[2] && res[2].runs) || [];

    var card = qrsEl('div', 'padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;');
    card.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;">Lint & Test</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);line-height:1.6;">' +
      '<div>Lint command: ' + qrsEsc(config.lintCommand || 'auto-detect') + '</div>' +
      '<div>Test command: ' + qrsEsc(config.testCommand || 'auto-detect') + '</div>' +
      '<div>Pass rate: ' + (stats.passRate != null ? Math.round(stats.passRate * 100) + '%' : 'N/A') + '</div>' +
      '<div>Auto-fix count: ' + (stats.autoFixCount || 0) + '</div></div>';
    el.appendChild(card);

    var actions = qrsEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var runBtn = qrsEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    runBtn.textContent = '\u25B6 Run Now';
    runBtn.addEventListener('click', function () { api.invoke('lint-test:run', {}).catch(function () {}); });
    actions.appendChild(runBtn);
    var detectBtn = qrsEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
    detectBtn.textContent = 'Detect Commands';
    detectBtn.addEventListener('click', function () { api.invoke('lint-test:detect', {}).then(function (r) { if (r) alert(JSON.stringify(r, null, 2)); }).catch(function () {}); });
    actions.appendChild(detectBtn);
    el.appendChild(actions);

    if (recent.length > 0) {
      var rh = qrsEl('div', 'font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:6px;');
      rh.textContent = 'Recent Runs';
      el.appendChild(rh);
      for (var i = 0; i < Math.min(recent.length, 5); i++) {
        var r = recent[i];
        var rEl = qrsEl('div', 'font-size:11px;padding:4px 8px;margin-bottom:4px;background:var(--surface-tertiary,#45475a);border-radius:4px;color:var(--text-secondary,#a6adc8);');
        rEl.innerHTML = qrsBadge(r.passed ? 'pass' : 'fail', r.passed ? '#a6e3a1' : '#f38ba8') + ' ' + qrsTime(r.timestamp || r.completedAt);
        el.appendChild(rEl);
      }
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load lint/test config</div>'; });
};

// ─── Evidence & Runbooks Tab ───────────────────────────────────────

QualityReviewSecurityWorkspacePanel.prototype.renderEvidence = function () {
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading evidence...</div>';
  var api = qrsApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  Promise.all([
    api.invoke('evidence:list', {}),
    api.invoke('runbooks:list', {}),
    api.invoke('predictive:active', {}),
    api.invoke('reports:list', {}),
  ]).then(function (res) {
    el.innerHTML = '';
    var evidence = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].citations) || [];
    var runbooks = Array.isArray(res[1]) ? res[1] : (res[1] && res[1].runbooks) || [];
    var alerts = Array.isArray(res[2]) ? res[2] : (res[2] && res[2].alerts) || [];
    var reports = Array.isArray(res[3]) ? res[3] : (res[3] && res[3].reports) || [];

    // Predictive Alerts
    if (alerts.length > 0) {
      var ah = qrsEl('div', 'font-size:12px;font-weight:600;color:#f9e2af;margin-bottom:6px;');
      ah.textContent = '\u26A0 Active Alerts (' + alerts.length + ')';
      el.appendChild(ah);
      for (var a = 0; a < alerts.length; a++) {
        var alert = alerts[a];
        var aEl = qrsEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:#f9e2af11;border-radius:4px;border:1px solid #f9e2af44;color:var(--text-primary,#cdd6f4);');
        aEl.innerHTML = qrsEsc(alert.message || alert.title || alert.id) +
          ' <button style="font-size:10px;padding:1px 6px;border-radius:3px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;margin-left:6px;">Ack</button>';
        aEl.querySelector('button').addEventListener('click', function () { api.invoke('predictive:acknowledge', { alertId: alert.id }).catch(function () {}); });
        el.appendChild(aEl);
      }
    }

    // Runbooks
    var rbHeader = qrsEl('div', 'font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin:12px 0 6px;');
    rbHeader.textContent = 'Runbooks (' + runbooks.length + ')';
    el.appendChild(rbHeader);

    var rbActions = qrsEl('div', 'display:flex;gap:6px;margin-bottom:8px;');
    var rbCreateBtn = qrsEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    rbCreateBtn.textContent = '+ Create Runbook';
    rbCreateBtn.addEventListener('click', function () { api.invoke('runbooks:create', {}).catch(function () {}); });
    rbActions.appendChild(rbCreateBtn);
    el.appendChild(rbActions);

    for (var rb = 0; rb < runbooks.length; rb++) {
      var r = runbooks[rb];
      var rEl = qrsEl('div', 'font-size:11px;padding:4px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);color:var(--text-secondary,#a6adc8);');
      rEl.innerHTML = qrsEsc(r.name || r.id) + ' ' + qrsBadge(r.enabled !== false ? 'enabled' : 'disabled', r.enabled !== false ? '#a6e3a1' : '#6c7086');
      el.appendChild(rEl);
    }

    // Evidence Citations
    if (evidence.length > 0) {
      var eh = qrsEl('div', 'font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin:12px 0 6px;');
      eh.textContent = 'Evidence Citations (' + evidence.length + ')';
      el.appendChild(eh);
      for (var e = 0; e < Math.min(evidence.length, 8); e++) {
        var ev = evidence[e];
        var eEl = qrsEl('div', 'font-size:11px;padding:4px 8px;margin-bottom:4px;background:var(--surface-tertiary,#45475a);border-radius:4px;color:var(--text-secondary,#a6adc8);');
        eEl.textContent = (ev.source || ev.type || 'citation') + ': ' + (ev.text || ev.content || '').slice(0, 100);
        el.appendChild(eEl);
      }
    }

    // Reports
    if (reports.length > 0) {
      var rph = qrsEl('div', 'font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin:12px 0 6px;');
      rph.textContent = 'Reports (' + reports.length + ')';
      el.appendChild(rph);
      for (var rp = 0; rp < Math.min(reports.length, 5); rp++) {
        var rep = reports[rp];
        var rpEl = qrsEl('div', 'font-size:11px;padding:4px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);color:var(--text-secondary,#a6adc8);');
        rpEl.innerHTML = qrsEsc(rep.title || rep.id) + ' ' + qrsBadge(rep.status || 'draft', '#89b4fa');
        el.appendChild(rpEl);
      }
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load evidence data</div>'; });
};

// ─── Cleanup & Exports ─────────────────────────────────────────────

QualityReviewSecurityWorkspacePanel.prototype.destroy = function () {
  if (this.container) this.container.innerHTML = '';
};

if (typeof window !== 'undefined') {
  window.QualityReviewSecurityWorkspacePanel = QualityReviewSecurityWorkspacePanel;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QualityReviewSecurityWorkspacePanel: QualityReviewSecurityWorkspacePanel };
}
