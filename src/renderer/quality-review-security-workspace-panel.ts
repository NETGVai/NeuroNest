// @ts-nocheck
/**
 * QualityReviewSecurityWorkspacePanel — Consolidated quality, review, and security tools.
 *
 * Uses window.wk namespace utilities for forms, toasts, cards, badges, toggles, etc.
 * All actions show toast feedback. All buttons disabled during async ops.
 * No alert() calls — all data displayed in-panel via collapsible sections.
 *
 * Tabs: Architecture, Artifacts, Benchmarks, Review, Security, Lint/Test, Evidence
 * Requirements: 1-5, 5.4 (toast, forms, data display, polish, per-panel)
 *
 * IPC channels:
 * - arch:scan, arch:latest, arch:get-rules, arch:toggle-rule, arch:evolution, arch:dsm, arch:test-gaps
 * - artifact:list, artifact:get, artifact:delete
 * - bench:list-profiles, bench:run, bench:results, bench:trends
 * - diff-review:create, diff-review:list, diff-review:pending, diff-review:accept, diff-review:reject
 * - security:analyze-action, security:remediation-stats
 * - lint-test:get-config, lint-test:set-config, lint-test:run, lint-test:recent-runs, lint-test:detect
 * - evidence:list, runbooks:list, runbooks:create, predictive:active, predictive:acknowledge
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 */

(function () {
  'use strict';

  var TABS = [
    { id: 'architecture', label: 'Architecture' },
    { id: 'artifacts', label: 'Artifacts' },
    { id: 'benchmarks', label: 'Benchmarks' },
    { id: 'review', label: 'Review' },
    { id: 'security', label: 'Security' },
    { id: 'lint-test', label: 'Lint/Test' },
    { id: 'evidence', label: 'Evidence' },
  ];

  function api() { return window.electronAPI; }

  // ─── Helpers ─────────────────────────────────────────────────────

  function disableBtn(btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; }
  function enableBtn(btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.pointerEvents = ''; }

  function asyncAction(btn, promise, successMsg) {
    disableBtn(btn);
    return promise.then(function (r) {
      enableBtn(btn);
      wk.toast(successMsg, 'success');
      return r;
    }).catch(function (err) {
      enableBtn(btn);
      wk.toast((err && err.message) || 'Action failed', 'error');
      throw err;
    });
  }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function fmtTime(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '-';
    var diff = Date.now() - d.getTime();
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return d.toLocaleDateString();
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function makeCollapsible(title, contentEl) {
    var section = document.createElement('div');
    section.style.cssText = 'margin-bottom:12px;border:1px solid var(--border-color);border-radius:var(--radius-sm);overflow:hidden;';

    var header = document.createElement('button');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;border:none;background:var(--surface-container);color:var(--text-primary);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;text-align:left;';
    header.innerHTML = '<span style="transition:transform var(--motion-quick);display:inline-block;">▶</span> ' + escHtml(title);
    header.setAttribute('aria-expanded', 'false');
    header.setAttribute('aria-label', 'Toggle ' + title);

    var body = document.createElement('div');
    body.style.cssText = 'max-height:0;overflow:hidden;transition:max-height var(--motion-standard);padding:0 14px;';
    body.appendChild(contentEl);

    var expanded = false;
    header.addEventListener('click', function () {
      expanded = !expanded;
      header.setAttribute('aria-expanded', String(expanded));
      var arrow = header.querySelector('span');
      if (expanded) {
        arrow.style.transform = 'rotate(90deg)';
        body.style.maxHeight = '600px';
        body.style.padding = '10px 14px';
      } else {
        arrow.style.transform = '';
        body.style.maxHeight = '0';
        body.style.padding = '0 14px';
      }
    });

    section.appendChild(header);
    section.appendChild(body);
    return section;
  }

  function makeStatCard(label, value, color) {
    var card = document.createElement('div');
    card.className = 'wk-card';
    card.style.cssText = 'flex:1;min-width:100px;text-align:center;';
    card.innerHTML = '<div style="font-size:22px;font-weight:700;color:' + (color || 'var(--accent)') + ';">' + escHtml(value) + '</div>' +
      '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;text-transform:uppercase;letter-spacing:0.5px;">' + escHtml(label) + '</div>';
    return card;
  }

  function makeGaugeCard(label, value, color) {
    var card = document.createElement('div');
    card.className = 'wk-card';
    card.style.cssText = 'flex:1;min-width:80px;text-align:center;border-top:3px solid ' + color + ';';
    card.innerHTML = '<div style="font-size:20px;font-weight:700;color:' + color + ';">' + escHtml(value) + '</div>' +
      '<div style="font-size:10px;color:var(--text-dim);margin-top:4px;font-weight:600;text-transform:uppercase;">' + escHtml(label) + '</div>';
    return card;
  }

  // ─── Panel Constructor ────────────────────────────────────────────

  function QualityReviewSecurityWorkspacePanel(container, options) {
    this.container = container;
    this.activeTab = 'architecture';
    this.formContainer = null;
    this.listContainer = null;
  }

  QualityReviewSecurityWorkspacePanel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:var(--font-family);overflow:hidden;';

    // Tab bar
    var tabBar = document.createElement('div');
    tabBar.className = 'wk-tabs';
    for (var i = 0; i < TABS.length; i++) {
      (function (tab) {
        var btn = document.createElement('button');
        btn.className = 'wk-tab' + (tab.id === self.activeTab ? ' active' : '');
        btn.textContent = tab.label;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-label', tab.label + ' tab');
        btn.addEventListener('click', function () {
          self.activeTab = tab.id;
          self.render();
        });
        tabBar.appendChild(btn);
      })(TABS[i]);
    }
    this.container.appendChild(tabBar);

    // Scrollable content area
    var content = document.createElement('div');
    content.className = 'wk-scroll';
    content.style.cssText = 'flex:1;overflow-y:auto;padding:0 4px;';
    this.container.appendChild(content);

    this.formContainer = document.createElement('div');
    content.appendChild(this.formContainer);

    this.listContainer = document.createElement('div');
    content.appendChild(this.listContainer);

    this.loadTab(this.activeTab);
  };

  QualityReviewSecurityWorkspacePanel.prototype.loadTab = function (id) {
    this.formContainer.innerHTML = '';
    this.listContainer.innerHTML = '';
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
    var self = this;
    var list = this.listContainer;
    list.innerHTML = '';

    var loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    loading.textContent = 'Loading architecture...';
    list.appendChild(loading);

    var ipc = api();
    if (!ipc) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('🏗', 'IPC Unavailable', 'Cannot connect to architecture service.'));
      return;
    }

    Promise.all([
      ipc.invoke('arch:latest', {}),
      ipc.invoke('arch:get-rules', {})
    ]).then(function (res) {
      list.innerHTML = '';
      var latest = res[0] || {};
      var rules = Array.isArray(res[1]) ? res[1] : (res[1] && res[1].rules) || [];

      // Stats as 3 metric cards
      var statsRow = document.createElement('div');
      statsRow.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';
      statsRow.appendChild(makeStatCard('Components', latest.componentCount || latest.components || 0, 'var(--accent)'));
      statsRow.appendChild(makeStatCard('Dependencies', latest.dependencyCount || 0, 'var(--green)'));
      statsRow.appendChild(makeStatCard('Violations', latest.violationCount || 0, 'var(--red)'));
      list.appendChild(statsRow);

      // Action buttons
      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;';

      var scanBtn = document.createElement('button');
      scanBtn.className = 'wk-btn-primary';
      scanBtn.textContent = 'Scan';
      scanBtn.setAttribute('aria-label', 'Run architecture scan');
      scanBtn.addEventListener('click', function () {
        wk.toast('Running architecture scan...', 'info');
        asyncAction(scanBtn, ipc.invoke('arch:scan', {}), 'Architecture scan complete').then(function () {
          self.renderArch();
        }).catch(function () {});
      });
      actions.appendChild(scanBtn);

      var evolBtn = document.createElement('button');
      evolBtn.className = 'wk-btn-secondary';
      evolBtn.textContent = 'Evolution';
      evolBtn.setAttribute('aria-label', 'Show architecture evolution');
      evolBtn.addEventListener('click', function () {
        asyncAction(evolBtn, ipc.invoke('arch:evolution', {}), 'Evolution data loaded').then(function (r) {
          showCollapsibleResult('evolution', r);
        }).catch(function () {});
      });
      actions.appendChild(evolBtn);

      var dsmBtn = document.createElement('button');
      dsmBtn.className = 'wk-btn-secondary';
      dsmBtn.textContent = 'DSM';
      dsmBtn.setAttribute('aria-label', 'Show dependency structure matrix');
      dsmBtn.addEventListener('click', function () {
        asyncAction(dsmBtn, ipc.invoke('arch:dsm', {}), 'DSM data loaded').then(function (r) {
          showCollapsibleResult('dsm', r);
        }).catch(function () {});
      });
      actions.appendChild(dsmBtn);

      var gapsBtn = document.createElement('button');
      gapsBtn.className = 'wk-btn-secondary';
      gapsBtn.textContent = 'Test Gaps';
      gapsBtn.setAttribute('aria-label', 'Show test coverage gaps');
      gapsBtn.addEventListener('click', function () {
        asyncAction(gapsBtn, ipc.invoke('arch:test-gaps', {}), 'Test gaps data loaded').then(function (r) {
          showCollapsibleResult('gaps', r);
        }).catch(function () {});
      });
      actions.appendChild(gapsBtn);

      list.appendChild(actions);

      // Results container for collapsible sections
      var resultsArea = document.createElement('div');
      resultsArea.id = 'arch-results-area';
      list.appendChild(resultsArea);

      function showCollapsibleResult(key, data) {
        // Remove existing section for this key if present
        var existing = resultsArea.querySelector('[data-section="' + key + '"]');
        if (existing) existing.remove();

        if (!data) return;
        var contentEl = document.createElement('div');
        contentEl.style.cssText = 'font-size:12px;';
        wk.dataView(contentEl, data);

        var section = makeCollapsible(key.charAt(0).toUpperCase() + key.slice(1) + ' Results', contentEl);
        section.setAttribute('data-section', key);
        resultsArea.appendChild(section);

        // Auto-expand
        section.querySelector('button').click();
      }

      // Rules as toggleable list
      if (rules.length > 0) {
        var rulesHeader = document.createElement('div');
        rulesHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin:16px 0 8px;';
        rulesHeader.textContent = 'Rules (' + rules.length + ')';
        list.appendChild(rulesHeader);

        for (var i = 0; i < rules.length; i++) {
          (function (rule) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;margin-bottom:4px;background:var(--surface-container);border-radius:var(--radius-xs);border:1px solid var(--border-color);';

            var left = document.createElement('div');
            left.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-primary);';
            var severityIcon = rule.severity === 'error' ? '🔴' : rule.severity === 'warning' ? '🟡' : '🔵';
            left.innerHTML = '<span>' + severityIcon + '</span><span>' + escHtml(rule.name || rule.pattern || rule.id) + '</span>';
            row.appendChild(left);

            var toggle = wk.toggle(rule.enabled !== false, function (active) {
              ipc.invoke('arch:toggle-rule', { ruleId: rule.id, enabled: active }).then(function () {
                wk.toast('Rule ' + (active ? 'enabled' : 'disabled'), 'success');
              }).catch(function (err) {
                wk.toast((err && err.message) || 'Failed to toggle rule', 'error');
              });
            });
            row.appendChild(toggle);

            list.appendChild(row);
          })(rules[i]);
        }
      } else {
        list.appendChild(wk.emptyState('📏', 'No Rules', 'No architecture rules configured.'));
      }
    }).catch(function () {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('⚠️', 'Load Failed', 'Failed to load architecture data.'));
    });
  };

  // ─── Artifacts Tab ─────────────────────────────────────────────────

  QualityReviewSecurityWorkspacePanel.prototype.renderArtifacts = function () {
    var self = this;
    var list = this.listContainer;
    list.innerHTML = '';

    var loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    loading.textContent = 'Loading artifacts...';
    list.appendChild(loading);

    var ipc = api();
    if (!ipc) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('📦', 'IPC Unavailable', 'Cannot connect to artifact service.'));
      return;
    }

    ipc.invoke('artifact:list', {}).then(function (result) {
      list.innerHTML = '';
      var artifacts = Array.isArray(result) ? result : (result && result.artifacts) || [];

      if (artifacts.length === 0) {
        list.appendChild(wk.emptyState('📦', 'No Artifacts', 'No build artifacts found.'));
        return;
      }

      for (var i = 0; i < artifacts.length; i++) {
        (function (artifact) {
          var typeIcons = { binary: '⚙️', archive: '📁', report: '📄', image: '🖼', log: '📝' };
          var icon = typeIcons[artifact.type] || '📦';

          var card = wk.card(artifact, function () {
            var el = document.createElement('div');

            // Header row
            var header = document.createElement('div');
            header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
            header.innerHTML = '<div style="display:flex;align-items:center;gap:8px;">' +
              '<span style="font-size:16px;">' + icon + '</span>' +
              '<span style="font-size:12px;font-weight:600;color:var(--text-primary);">' + escHtml(artifact.name || artifact.id) + '</span></div>' +
              '<div style="font-size:11px;color:var(--text-dim);">' + fmtTime(artifact.createdAt) + '</div>';
            el.appendChild(header);

            // Meta row
            var meta = document.createElement('div');
            meta.style.cssText = 'display:flex;gap:12px;margin-top:6px;font-size:11px;color:var(--text-secondary);';
            meta.innerHTML = '<span>' + escHtml(artifact.type || 'unknown') + '</span>' +
              '<span>' + fmtSize(artifact.size) + '</span>';
            el.appendChild(meta);

            // Expandable detail
            var detailWrap = document.createElement('div');
            detailWrap.style.cssText = 'max-height:0;overflow:hidden;transition:max-height var(--motion-standard);';
            el.appendChild(detailWrap);

            // Detail content (lazy loaded on expand)
            var expanded = false;
            el.style.cursor = 'pointer';
            el.addEventListener('click', function (e) {
              if (e.target.tagName === 'BUTTON') return;
              expanded = !expanded;
              if (expanded) {
                detailWrap.style.maxHeight = '200px';
                if (!detailWrap.hasChildNodes()) {
                  ipc.invoke('artifact:get', { id: artifact.id }).then(function (detail) {
                    wk.dataView(detailWrap, detail || artifact);
                  }).catch(function () {
                    detailWrap.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--text-dim);">No details available</div>';
                  });
                }
              } else {
                detailWrap.style.maxHeight = '0';
              }
            });

            // Delete button
            var delBtn = document.createElement('button');
            delBtn.className = 'wk-btn-danger';
            delBtn.textContent = 'Delete';
            delBtn.style.cssText += 'margin-top:8px;font-size:11px;padding:4px 10px;';
            delBtn.setAttribute('aria-label', 'Delete artifact ' + (artifact.name || artifact.id));
            delBtn.addEventListener('click', function (e) {
              e.stopPropagation();
              var confirmEl = wk.confirm('Delete artifact "' + (artifact.name || artifact.id) + '"?', function () {
                asyncAction(delBtn, ipc.invoke('artifact:delete', { id: artifact.id }), 'Artifact deleted').then(function () {
                  self.renderArtifacts();
                }).catch(function () {});
              });
              card.appendChild(confirmEl);
            });
            el.appendChild(delBtn);

            return el;
          });
          card.style.marginBottom = '8px';
          list.appendChild(card);
        })(artifacts[i]);
      }
    }).catch(function () {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('⚠️', 'Load Failed', 'Failed to load artifacts.'));
    });
  };

  // ─── Benchmarks Tab ────────────────────────────────────────────────

  QualityReviewSecurityWorkspacePanel.prototype.renderBenchmarks = function () {
    var self = this;
    var list = this.listContainer;
    list.innerHTML = '';

    var loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    loading.textContent = 'Loading benchmarks...';
    list.appendChild(loading);

    var ipc = api();
    if (!ipc) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('⏱', 'IPC Unavailable', 'Cannot connect to benchmark service.'));
      return;
    }

    Promise.all([
      ipc.invoke('bench:list-profiles', {}),
      ipc.invoke('bench:results', {})
    ]).then(function (res) {
      list.innerHTML = '';
      var profiles = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].profiles) || [];
      var results = Array.isArray(res[1]) ? res[1] : (res[1] && res[1].results) || [];

      // Action buttons
      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';

      var runBtn = document.createElement('button');
      runBtn.className = 'wk-btn-primary';
      runBtn.textContent = 'Run Benchmark';
      runBtn.setAttribute('aria-label', 'Run benchmark');
      runBtn.addEventListener('click', function () {
        wk.toast('Running benchmarks...', 'info');
        asyncAction(runBtn, ipc.invoke('bench:run', {}), 'Benchmark complete').then(function () {
          self.renderBenchmarks();
        }).catch(function () {});
      });
      actions.appendChild(runBtn);

      var trendsBtn = document.createElement('button');
      trendsBtn.className = 'wk-btn-secondary';
      trendsBtn.textContent = 'Trends';
      trendsBtn.setAttribute('aria-label', 'Show benchmark trends');
      trendsBtn.addEventListener('click', function () {
        asyncAction(trendsBtn, ipc.invoke('bench:trends', {}), 'Trends loaded').then(function (r) {
          // Show trends in-panel
          var existing = list.querySelector('[data-section="trends"]');
          if (existing) existing.remove();
          if (r) {
            var contentEl = document.createElement('div');
            wk.dataView(contentEl, r);
            var section = makeCollapsible('Benchmark Trends', contentEl);
            section.setAttribute('data-section', 'trends');
            list.appendChild(section);
            section.querySelector('button').click();
          }
        }).catch(function () {});
      });
      actions.appendChild(trendsBtn);
      list.appendChild(actions);

      // Profiles as cards
      if (profiles.length > 0) {
        var profilesHeader = document.createElement('div');
        profilesHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;';
        profilesHeader.textContent = 'Profiles (' + profiles.length + ')';
        list.appendChild(profilesHeader);

        for (var i = 0; i < profiles.length; i++) {
          var p = profiles[i];
          var pCard = wk.card(p, function (data) {
            var el = document.createElement('div');
            el.innerHTML = '<div style="font-size:12px;font-weight:600;color:var(--text-primary);">' + escHtml(data.name || data.id) + '</div>' +
              '<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">' + escHtml(data.description || '') + '</div>';
            return el;
          });
          pCard.style.marginBottom = '6px';
          list.appendChild(pCard);
        }
      }

      // Recent results
      if (results.length > 0) {
        var resultsHeader = document.createElement('div');
        resultsHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin:16px 0 8px;';
        resultsHeader.textContent = 'Recent Results';
        list.appendChild(resultsHeader);

        for (var j = 0; j < Math.min(results.length, 5); j++) {
          var r = results[j];
          var rCard = wk.card(r, function (data) {
            var el = document.createElement('div');
            el.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
            el.innerHTML = '<span style="font-size:12px;color:var(--text-primary);">' + escHtml(data.name || data.profile || 'Run') + '</span>' +
              '<span style="font-size:11px;color:var(--text-dim);">' + fmtTime(data.completedAt || data.timestamp) + '</span>';
            return el;
          });
          rCard.style.marginBottom = '4px';
          list.appendChild(rCard);
        }
      } else if (profiles.length === 0) {
        list.appendChild(wk.emptyState('⏱', 'No Benchmarks', 'No benchmark profiles or results.'));
      }
    }).catch(function () {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('⚠️', 'Load Failed', 'Failed to load benchmarks.'));
    });
  };

  // ─── Review Tab ────────────────────────────────────────────────────

  QualityReviewSecurityWorkspacePanel.prototype.renderReview = function () {
    var self = this;
    var formArea = this.formContainer;
    var list = this.listContainer;
    list.innerHTML = '';

    // Create review button
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var createBtn = document.createElement('button');
    createBtn.className = 'wk-btn-primary';
    createBtn.textContent = '+ New Review';
    createBtn.setAttribute('aria-label', 'Create new review');
    createBtn.addEventListener('click', function () {
      formArea.innerHTML = '';
      wk.form(formArea, [
        { name: 'title', label: 'Title', placeholder: 'Review title', required: true },
        { name: 'description', label: 'Description', type: 'textarea', placeholder: 'Describe what to review...' },
        { name: 'scope', label: 'Scope', placeholder: 'e.g. src/auth/**' },
      ], function (data) {
        asyncAction(createBtn, api().invoke('diff-review:create', data), 'Review created').then(function () {
          formArea.innerHTML = '';
          self.renderReview();
        }).catch(function () {});
      }, function () {
        formArea.innerHTML = '';
      });
    });
    actions.appendChild(createBtn);
    list.appendChild(actions);

    // Loading
    var loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    loading.textContent = 'Loading reviews...';
    list.appendChild(loading);

    var ipc = api();
    if (!ipc) {
      list.innerHTML = '';
      list.appendChild(actions);
      list.appendChild(wk.emptyState('🔍', 'IPC Unavailable', 'Cannot connect to review service.'));
      return;
    }

    Promise.all([
      ipc.invoke('diff-review:list', {}),
      ipc.invoke('diff-review:pending', {})
    ]).then(function (res) {
      loading.remove();
      var reviews = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].reviews) || [];
      var pending = Array.isArray(res[1]) ? res[1] : (res[1] && res[1].pending) || [];

      // Pending section with approve/reject + comment input
      if (pending.length > 0) {
        var pendingHeader = document.createElement('div');
        pendingHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--yellow);margin-bottom:8px;';
        pendingHeader.textContent = 'Pending (' + pending.length + ')';
        list.appendChild(pendingHeader);

        for (var i = 0; i < pending.length; i++) {
          (function (item) {
            var card = wk.card(item, function () {
              var el = document.createElement('div');

              var titleRow = document.createElement('div');
              titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;';
              titleRow.innerHTML = '<span style="font-size:12px;font-weight:600;color:var(--text-primary);">' + escHtml(item.title || item.id) + '</span>';
              var pendingBadge = wk.badge('pending', 'warning');
              titleRow.appendChild(pendingBadge);
              el.appendChild(titleRow);

              // Comment input
              var commentInput = document.createElement('input');
              commentInput.className = 'wk-input';
              commentInput.placeholder = 'Add comment (optional)...';
              commentInput.style.marginBottom = '8px';
              el.appendChild(commentInput);

              // Approve/Reject buttons
              var btnRow = document.createElement('div');
              btnRow.style.cssText = 'display:flex;gap:8px;';

              var approveBtn = document.createElement('button');
              approveBtn.className = 'wk-btn-primary';
              approveBtn.textContent = 'Approve';
              approveBtn.style.fontSize = '11px';
              approveBtn.setAttribute('aria-label', 'Approve review');
              approveBtn.addEventListener('click', function () {
                var comment = commentInput.value.trim();
                asyncAction(approveBtn, ipc.invoke('diff-review:accept', { id: item.id, comment: comment }), 'Review approved').then(function () {
                  self.renderReview();
                }).catch(function () {});
              });
              btnRow.appendChild(approveBtn);

              var rejectBtn = document.createElement('button');
              rejectBtn.className = 'wk-btn-danger';
              rejectBtn.textContent = 'Reject';
              rejectBtn.style.fontSize = '11px';
              rejectBtn.setAttribute('aria-label', 'Reject review');
              rejectBtn.addEventListener('click', function () {
                var comment = commentInput.value.trim();
                asyncAction(rejectBtn, ipc.invoke('diff-review:reject', { id: item.id, comment: comment }), 'Review rejected').then(function () {
                  self.renderReview();
                }).catch(function () {});
              });
              btnRow.appendChild(rejectBtn);

              el.appendChild(btnRow);
              return el;
            });
            card.style.marginBottom = '8px';
            card.style.borderColor = 'var(--yellow)';
            list.appendChild(card);
          })(pending[i]);
        }
      }

      // Recent reviews with status badges
      if (reviews.length > 0) {
        var recentHeader = document.createElement('div');
        recentHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin:16px 0 8px;';
        recentHeader.textContent = 'Recent (' + reviews.length + ')';
        list.appendChild(recentHeader);

        for (var j = 0; j < Math.min(reviews.length, 10); j++) {
          var r = reviews[j];
          var rCard = wk.card(r, function (data) {
            var el = document.createElement('div');
            el.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';

            var left = document.createElement('div');
            left.innerHTML = '<div style="font-size:12px;color:var(--text-primary);font-weight:500;">' + escHtml(data.title || data.id) + '</div>' +
              '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">' + fmtTime(data.createdAt) + '</div>';
            el.appendChild(left);

            var statusVariant = 'info';
            if (data.status === 'approved') statusVariant = 'success';
            else if (data.status === 'rejected') statusVariant = 'error';
            else if (data.status === 'pending') statusVariant = 'warning';
            var statusBadge = wk.badge(data.status || 'done', statusVariant);
            el.appendChild(statusBadge);

            return el;
          });
          rCard.style.marginBottom = '4px';
          list.appendChild(rCard);
        }
      } else if (pending.length === 0) {
        list.appendChild(wk.emptyState('🔍', 'No Reviews', 'No code reviews yet. Create one to get started.'));
      }
    }).catch(function () {
      loading.remove();
      list.appendChild(wk.emptyState('⚠️', 'Load Failed', 'Failed to load reviews.'));
    });
  };

  // ─── Security Tab ──────────────────────────────────────────────────

  QualityReviewSecurityWorkspacePanel.prototype.renderSecurity = function () {
    var self = this;
    var list = this.listContainer;
    list.innerHTML = '';

    var loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    loading.textContent = 'Loading security status...';
    list.appendChild(loading);

    var ipc = api();
    if (!ipc) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('🔒', 'IPC Unavailable', 'Cannot connect to security service.'));
      return;
    }

    ipc.invoke('security:remediation-stats', {}).then(function (stats) {
      list.innerHTML = '';
      var s = stats || {};

      // 4 severity gauge cards in a row
      var gaugeRow = document.createElement('div');
      gaugeRow.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';
      gaugeRow.appendChild(makeGaugeCard('Critical', s.critical || 0, 'var(--red)'));
      gaugeRow.appendChild(makeGaugeCard('High', s.high || 0, '#ff8c42'));
      gaugeRow.appendChild(makeGaugeCard('Medium', s.medium || 0, 'var(--yellow)'));
      gaugeRow.appendChild(makeGaugeCard('Low', s.low || 0, 'var(--green)'));
      list.appendChild(gaugeRow);

      // Scan button with progress
      var scanRow = document.createElement('div');
      scanRow.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:16px;';

      var scanBtn = document.createElement('button');
      scanBtn.className = 'wk-btn-primary';
      scanBtn.textContent = 'Run Security Scan';
      scanBtn.setAttribute('aria-label', 'Run security scan');

      var progressWrap = document.createElement('div');
      progressWrap.style.cssText = 'flex:1;display:none;';

      scanBtn.addEventListener('click', function () {
        wk.toast('Running security scan...', 'info');
        disableBtn(scanBtn);
        progressWrap.style.display = 'block';
        progressWrap.innerHTML = '';
        progressWrap.appendChild(wk.progress(50, 100));

        ipc.invoke('security:analyze-action', { action: 'full-scan' }).then(function () {
          enableBtn(scanBtn);
          progressWrap.style.display = 'none';
          wk.toast('Security scan complete', 'success');
          self.renderSecurity();
        }).catch(function (err) {
          enableBtn(scanBtn);
          progressWrap.style.display = 'none';
          wk.toast((err && err.message) || 'Scan failed', 'error');
        });
      });

      scanRow.appendChild(scanBtn);
      scanRow.appendChild(progressWrap);
      list.appendChild(scanRow);

      // Summary stats
      var summaryCard = wk.card(null, function () {
        var el = document.createElement('div');
        el.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Summary</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px;color:var(--text-secondary);">' +
          '<div>Total: <strong style="color:var(--text-primary);">' + (s.totalVulnerabilities || s.total || 0) + '</strong></div>' +
          '<div>Remediated: <strong style="color:var(--green);">' + (s.remediated || 0) + '</strong></div>' +
          '<div>Pending: <strong style="color:var(--yellow);">' + (s.pending || 0) + '</strong></div>' +
          '<div>Auto-fixed: <strong style="color:var(--accent);">' + (s.autoFixed || 0) + '</strong></div>' +
          '</div>';
        return el;
      });
      list.appendChild(summaryCard);
    }).catch(function () {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('⚠️', 'Load Failed', 'Failed to load security data.'));
    });
  };

  // ─── Lint/Test Tab ─────────────────────────────────────────────────

  QualityReviewSecurityWorkspacePanel.prototype.renderLintTest = function () {
    var self = this;
    var list = this.listContainer;
    list.innerHTML = '';

    var loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    loading.textContent = 'Loading lint/test config...';
    list.appendChild(loading);

    var ipc = api();
    if (!ipc) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('✅', 'IPC Unavailable', 'Cannot connect to lint/test service.'));
      return;
    }

    Promise.all([
      ipc.invoke('lint-test:get-config', {}),
      ipc.invoke('lint-test:stats', {}),
      ipc.invoke('lint-test:recent-runs', {})
    ]).then(function (res) {
      list.innerHTML = '';
      var config = res[0] || {};
      var stats = res[1] || {};
      var recent = Array.isArray(res[2]) ? res[2] : (res[2] && res[2].runs) || [];

      // Action buttons
      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';

      var runBtn = document.createElement('button');
      runBtn.className = 'wk-btn-primary';
      runBtn.textContent = 'Run';
      runBtn.setAttribute('aria-label', 'Run lint and tests');
      runBtn.addEventListener('click', function () {
        wk.toast('Running lint/test...', 'info');
        asyncAction(runBtn, ipc.invoke('lint-test:run', {}), 'Lint/test complete').then(function () {
          self.renderLintTest();
        }).catch(function () {});
      });
      actions.appendChild(runBtn);

      var detectBtn = document.createElement('button');
      detectBtn.className = 'wk-btn-secondary';
      detectBtn.textContent = 'Detect Commands';
      detectBtn.setAttribute('aria-label', 'Auto-detect lint and test commands');
      detectBtn.addEventListener('click', function () {
        asyncAction(detectBtn, ipc.invoke('lint-test:detect', {}), 'Commands detected').then(function (r) {
          if (r) {
            var existing = list.querySelector('[data-section="detect"]');
            if (existing) existing.remove();
            var contentEl = document.createElement('div');
            wk.dataView(contentEl, r);
            var section = makeCollapsible('Detected Commands', contentEl);
            section.setAttribute('data-section', 'detect');
            list.appendChild(section);
            section.querySelector('button').click();
          }
        }).catch(function () {});
      });
      actions.appendChild(detectBtn);
      list.appendChild(actions);

      // Editable config fields
      var configHeader = document.createElement('div');
      configHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;';
      configHeader.textContent = 'Configuration';
      list.appendChild(configHeader);

      var configCard = document.createElement('div');
      configCard.className = 'wk-card';
      configCard.style.marginBottom = '16px';

      var lintRow = document.createElement('div');
      lintRow.className = 'wk-form-row';
      lintRow.innerHTML = '<label class="wk-form-label">Lint Command</label>';
      var lintInput = document.createElement('input');
      lintInput.className = 'wk-input';
      lintInput.value = config.lintCommand || '';
      lintInput.placeholder = 'e.g. eslint .';
      lintRow.appendChild(lintInput);
      configCard.appendChild(lintRow);

      var testRow = document.createElement('div');
      testRow.className = 'wk-form-row';
      testRow.innerHTML = '<label class="wk-form-label">Test Command</label>';
      var testInput = document.createElement('input');
      testInput.className = 'wk-input';
      testInput.value = config.testCommand || '';
      testInput.placeholder = 'e.g. vitest run';
      testRow.appendChild(testInput);
      configCard.appendChild(testRow);

      var saveConfigBtn = document.createElement('button');
      saveConfigBtn.className = 'wk-btn-primary';
      saveConfigBtn.textContent = 'Save Config';
      saveConfigBtn.style.cssText = 'margin-top:8px;font-size:11px;';
      saveConfigBtn.setAttribute('aria-label', 'Save lint/test configuration');
      saveConfigBtn.addEventListener('click', function () {
        var payload = { lintCommand: lintInput.value.trim(), testCommand: testInput.value.trim() };
        asyncAction(saveConfigBtn, ipc.invoke('lint-test:set-config', payload), 'Config saved').catch(function () {});
      });
      configCard.appendChild(saveConfigBtn);
      list.appendChild(configCard);

      // Stats row
      var statsRow = document.createElement('div');
      statsRow.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';
      statsRow.appendChild(makeStatCard('Pass Rate', stats.passRate != null ? Math.round(stats.passRate * 100) + '%' : 'N/A', 'var(--green)'));
      statsRow.appendChild(makeStatCard('Auto-fixes', stats.autoFixCount || 0, 'var(--accent)'));
      statsRow.appendChild(makeStatCard('Total Runs', stats.totalRuns || recent.length || 0, 'var(--text-primary)'));
      list.appendChild(statsRow);

      // Recent runs
      if (recent.length > 0) {
        var recentHeader = document.createElement('div');
        recentHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;';
        recentHeader.textContent = 'Recent Runs';
        list.appendChild(recentHeader);

        for (var i = 0; i < Math.min(recent.length, 8); i++) {
          var r = recent[i];
          var rCard = wk.card(r, function (data) {
            var el = document.createElement('div');
            el.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
            var statusBadge = wk.badge(data.passed ? 'pass' : 'fail', data.passed ? 'success' : 'error');
            var left = document.createElement('div');
            left.style.cssText = 'display:flex;align-items:center;gap:8px;';
            left.appendChild(statusBadge);
            var timeSpan = document.createElement('span');
            timeSpan.style.cssText = 'font-size:11px;color:var(--text-dim);';
            timeSpan.textContent = fmtTime(data.timestamp || data.completedAt);
            left.appendChild(timeSpan);
            el.appendChild(left);
            if (data.duration) {
              var durSpan = document.createElement('span');
              durSpan.style.cssText = 'font-size:11px;color:var(--text-secondary);';
              durSpan.textContent = data.duration + 'ms';
              el.appendChild(durSpan);
            }
            return el;
          });
          rCard.style.marginBottom = '4px';
          list.appendChild(rCard);
        }
      }
    }).catch(function () {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('⚠️', 'Load Failed', 'Failed to load lint/test config.'));
    });
  };

  // ─── Evidence & Runbooks Tab ───────────────────────────────────────

  QualityReviewSecurityWorkspacePanel.prototype.renderEvidence = function () {
    var self = this;
    var formArea = this.formContainer;
    var list = this.listContainer;
    list.innerHTML = '';

    var loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    loading.textContent = 'Loading evidence...';
    list.appendChild(loading);

    var ipc = api();
    if (!ipc) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('📋', 'IPC Unavailable', 'Cannot connect to evidence service.'));
      return;
    }

    Promise.all([
      ipc.invoke('evidence:list', {}),
      ipc.invoke('runbooks:list', {}),
      ipc.invoke('predictive:active', {})
    ]).then(function (res) {
      list.innerHTML = '';
      var evidence = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].citations) || [];
      var runbooks = Array.isArray(res[1]) ? res[1] : (res[1] && res[1].runbooks) || [];
      var alerts = Array.isArray(res[2]) ? res[2] : (res[2] && res[2].alerts) || [];

      // Predictive Alerts with severity + ack button + toast
      if (alerts.length > 0) {
        var alertsHeader = document.createElement('div');
        alertsHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--yellow);margin-bottom:8px;';
        alertsHeader.textContent = 'Active Alerts (' + alerts.length + ')';
        list.appendChild(alertsHeader);

        for (var a = 0; a < alerts.length; a++) {
          (function (alertItem) {
            var severityColors = { critical: 'var(--red)', high: '#ff8c42', medium: 'var(--yellow)', low: 'var(--green)' };
            var severity = alertItem.severity || 'medium';
            var color = severityColors[severity] || 'var(--yellow)';

            var alertCard = wk.card(alertItem, function () {
              var el = document.createElement('div');
              el.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';

              var left = document.createElement('div');
              left.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;';
              var severityBadge = wk.badge(severity, severity === 'critical' || severity === 'high' ? 'error' : 'warning');
              left.appendChild(severityBadge);
              var msgSpan = document.createElement('span');
              msgSpan.style.cssText = 'font-size:12px;color:var(--text-primary);';
              msgSpan.textContent = alertItem.message || alertItem.title || alertItem.id;
              left.appendChild(msgSpan);
              el.appendChild(left);

              var ackBtn = document.createElement('button');
              ackBtn.className = 'wk-btn-secondary';
              ackBtn.textContent = 'Ack';
              ackBtn.style.fontSize = '11px';
              ackBtn.setAttribute('aria-label', 'Acknowledge alert');
              ackBtn.addEventListener('click', function () {
                asyncAction(ackBtn, ipc.invoke('predictive:acknowledge', { alertId: alertItem.id }), 'Alert acknowledged').then(function () {
                  self.renderEvidence();
                }).catch(function () {});
              });
              el.appendChild(ackBtn);

              return el;
            });
            alertCard.style.marginBottom = '6px';
            alertCard.style.borderLeftColor = color;
            alertCard.style.borderLeftWidth = '3px';
            list.appendChild(alertCard);
          })(alerts[a]);
        }
      }

      // Runbooks section with create form
      var runbookHeader = document.createElement('div');
      runbookHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin:16px 0 8px;display:flex;align-items:center;justify-content:space-between;';
      runbookHeader.innerHTML = '<span>Runbooks (' + runbooks.length + ')</span>';

      var createRbBtn = document.createElement('button');
      createRbBtn.className = 'wk-btn-primary';
      createRbBtn.textContent = '+ Create';
      createRbBtn.style.fontSize = '11px';
      createRbBtn.setAttribute('aria-label', 'Create new runbook');
      createRbBtn.addEventListener('click', function () {
        formArea.innerHTML = '';
        wk.form(formArea, [
          { name: 'name', label: 'Runbook Name', placeholder: 'e.g. Incident Response', required: true },
          { name: 'description', label: 'Description', type: 'textarea', placeholder: 'Describe the runbook steps...' },
          { name: 'trigger', label: 'Trigger Condition', placeholder: 'e.g. security:critical' },
        ], function (data) {
          asyncAction(createRbBtn, ipc.invoke('runbooks:create', data), 'Runbook created').then(function () {
            formArea.innerHTML = '';
            self.renderEvidence();
          }).catch(function () {});
        }, function () {
          formArea.innerHTML = '';
        });
      });
      runbookHeader.appendChild(createRbBtn);
      list.appendChild(runbookHeader);

      for (var rb = 0; rb < runbooks.length; rb++) {
        var r = runbooks[rb];
        var rbCard = wk.card(r, function (data) {
          var el = document.createElement('div');
          el.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
          el.innerHTML = '<span style="font-size:12px;color:var(--text-primary);">' + escHtml(data.name || data.id) + '</span>';
          var statusBadge = wk.badge(data.enabled !== false ? 'enabled' : 'disabled', data.enabled !== false ? 'success' : 'info');
          el.appendChild(statusBadge);
          return el;
        });
        rbCard.style.marginBottom = '4px';
        list.appendChild(rbCard);
      }

      // Evidence Citations list
      if (evidence.length > 0) {
        var evidenceHeader = document.createElement('div');
        evidenceHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin:16px 0 8px;';
        evidenceHeader.textContent = 'Citations (' + evidence.length + ')';
        list.appendChild(evidenceHeader);

        for (var e = 0; e < Math.min(evidence.length, 10); e++) {
          var ev = evidence[e];
          var evCard = wk.card(ev, function (data) {
            var el = document.createElement('div');
            el.innerHTML = '<div style="font-size:11px;color:var(--text-dim);margin-bottom:2px;">' + escHtml(data.source || data.type || 'citation') + '</div>' +
              '<div style="font-size:12px;color:var(--text-primary);">' + escHtml((data.text || data.content || '').slice(0, 150)) + '</div>';
            return el;
          });
          evCard.style.marginBottom = '4px';
          list.appendChild(evCard);
        }
      } else if (runbooks.length === 0 && alerts.length === 0) {
        list.appendChild(wk.emptyState('📋', 'No Evidence', 'No citations, runbooks, or alerts found.'));
      }
    }).catch(function () {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('⚠️', 'Load Failed', 'Failed to load evidence data.'));
    });
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

})();
