/**
 * CostControlsPanel — Renderer UI for real-time cost tracking, budget alerts, and spending summaries.
 *
 * Features:
 * - Real-time cost ticker in UI header showing session spend
 * - Warning alert popup at 80% budget with increase/abort options
 * - Monthly spending summary view with per-provider/model/task breakdown
 *
 * Wires IPC: cost:budget-set, cost:budget-status, cost:alert-config, cost:session-summary
 *
 * Gated behind `cost_controls` feature flag (requires `cost_tracking`).
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as checkpoint-timeline-panel.ts.
 *
 * Requirements: 22.2, 22.3, 22.5, 22.7, 22.8
 */

// ─── Helpers ───────────────────────────────────────────────────────

function costEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function costEapi() {
  return window.electronAPI;
}

function costFormatUsd(amount) {
  if (amount == null || isNaN(amount)) return '$0.0000';
  if (amount < 0.01) return '$' + amount.toFixed(4);
  return '$' + amount.toFixed(2);
}

function costFormatPercent(ratio) {
  if (ratio == null || isNaN(ratio)) return '0%';
  return Math.round(ratio * 100) + '%';
}

// ─── CostTicker class ──────────────────────────────────────────────

/**
 * Real-time cost ticker widget for the UI header.
 * Shows accumulated session spend and budget usage bar.
 *
 * Requirement: 22.2
 */
function CostTicker(container) {
  this.container = container;
  this.costEl = null;
  this.barEl = null;
  this.status = null;
  this.pollInterval = null;
}

CostTicker.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.className = 'cost-ticker';

  var wrapper = document.createElement('div');
  wrapper.className = 'cost-ticker__wrapper';
  wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 12px;border-radius:6px;background:var(--bg-secondary,#1e1e2e);border:1px solid var(--border-color,#313244);font-size:12px;cursor:pointer;';

  // Cost label
  var label = document.createElement('span');
  label.textContent = '💰';
  label.style.cssText = 'font-size:14px;';
  wrapper.appendChild(label);

  // Amount
  this.costEl = document.createElement('span');
  this.costEl.className = 'cost-ticker__amount';
  this.costEl.textContent = '$0.0000';
  this.costEl.style.cssText = 'font-family:monospace;font-weight:600;color:var(--text-primary,#cdd6f4);';
  wrapper.appendChild(this.costEl);

  // Separator
  var sep = document.createElement('span');
  sep.textContent = '/';
  sep.style.cssText = 'color:var(--text-muted,#6c7086);';
  wrapper.appendChild(sep);

  // Limit
  this.limitEl = document.createElement('span');
  this.limitEl.className = 'cost-ticker__limit';
  this.limitEl.textContent = '$5.00';
  this.limitEl.style.cssText = 'font-family:monospace;color:var(--text-muted,#6c7086);';
  wrapper.appendChild(this.limitEl);

  // Progress bar
  var barContainer = document.createElement('div');
  barContainer.style.cssText = 'width:40px;height:4px;background:var(--bg-tertiary,#313244);border-radius:2px;overflow:hidden;';
  this.barEl = document.createElement('div');
  this.barEl.style.cssText = 'height:100%;width:0%;background:#a6e3a1;border-radius:2px;transition:width 0.3s ease,background 0.3s ease;';
  barContainer.appendChild(this.barEl);
  wrapper.appendChild(barContainer);

  // Click opens summary panel
  wrapper.addEventListener('click', function () {
    self.onTickerClick && self.onTickerClick();
  });

  this.container.appendChild(wrapper);
  this.refresh();
  this.startPolling();
};

CostTicker.prototype.refresh = function () {
  var self = this;
  var api = costEapi();
  if (!api) return;
  api.invoke('cost:budget-status').then(function (result) {
    if (!result || !result.success || !result.status) return;
    self.status = result.status;
    self.update(result.status);
  }).catch(function () {});
};

CostTicker.prototype.update = function (status) {
  if (!this.costEl || !this.barEl) return;
  this.costEl.textContent = costFormatUsd(status.sessionCostUsd);
  this.limitEl.textContent = costFormatUsd(status.sessionLimitUsd);

  var pct = Math.min(100, Math.round((status.usageRatio || 0) * 100));
  this.barEl.style.width = pct + '%';

  // Color based on usage
  if (status.budgetExhausted) {
    this.barEl.style.background = '#f38ba8'; // red
    this.costEl.style.color = '#f38ba8';
  } else if (status.downgradeActive) {
    this.barEl.style.background = '#fab387'; // orange
    this.costEl.style.color = '#fab387';
  } else if (status.warningReached) {
    this.barEl.style.background = '#f9e2af'; // yellow
    this.costEl.style.color = '#f9e2af';
  } else {
    this.barEl.style.background = '#a6e3a1'; // green
    this.costEl.style.color = 'var(--text-primary,#cdd6f4)';
  }
};

CostTicker.prototype.startPolling = function () {
  var self = this;
  if (this.pollInterval) clearInterval(this.pollInterval);
  // Poll every 5 seconds for cost updates
  this.pollInterval = setInterval(function () {
    self.refresh();
  }, 5000);

  // Also listen for real-time budget events
  var api = costEapi();
  if (api) {
    api.on('cost:budget-event', function (event) {
      if (event && event.sessionCostUsd !== undefined) {
        self.update({
          sessionCostUsd: event.sessionCostUsd,
          sessionLimitUsd: event.sessionLimitUsd,
          usageRatio: event.usageRatio,
          warningReached: event.usageRatio >= 0.8,
          downgradeActive: event.usageRatio >= 0.9,
          budgetExhausted: event.usageRatio >= 1.0,
        });

        // Show warning popup at 80%
        if (event.type === 'budget-warning' && self.onWarning) {
          self.onWarning(event);
        }
        // Show exhausted popup
        if (event.type === 'budget-exhausted' && self.onExhausted) {
          self.onExhausted(event);
        }
      }
    });
  }
};

CostTicker.prototype.stopPolling = function () {
  if (this.pollInterval) {
    clearInterval(this.pollInterval);
    this.pollInterval = null;
  }
};

CostTicker.prototype.destroy = function () {
  this.stopPolling();
  this.container.innerHTML = '';
};

// ─── CostWarningPopup ──────────────────────────────────────────────

/**
 * Warning alert popup at 80% budget with increase/abort options.
 *
 * Requirement: 22.3
 */
function CostWarningPopup() {
  this.overlayEl = null;
}

CostWarningPopup.prototype.show = function (event, onIncrease, onAbort) {
  var self = this;
  if (this.overlayEl) this.dismiss();

  this.overlayEl = document.createElement('div');
  this.overlayEl.className = 'cost-warning-overlay';
  this.overlayEl.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';

  var dialog = document.createElement('div');
  dialog.className = 'cost-warning-dialog';
  dialog.style.cssText = 'background:var(--bg-primary,#1e1e2e);border:1px solid var(--border-color,#313244);border-radius:12px;padding:24px;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);';

  var icon = document.createElement('div');
  icon.textContent = '⚠️';
  icon.style.cssText = 'font-size:32px;text-align:center;margin-bottom:12px;';
  dialog.appendChild(icon);

  var title = document.createElement('h3');
  title.textContent = 'Budget Warning';
  title.style.cssText = 'margin:0 0 8px;color:var(--text-primary,#cdd6f4);font-size:18px;text-align:center;';
  dialog.appendChild(title);

  var msg = document.createElement('p');
  msg.textContent = event.message || 'Session cost has reached 80% of your budget.';
  msg.style.cssText = 'margin:0 0 16px;color:var(--text-secondary,#a6adc8);font-size:14px;text-align:center;line-height:1.5;';
  dialog.appendChild(msg);

  var costLine = document.createElement('div');
  costLine.style.cssText = 'text-align:center;margin-bottom:20px;font-family:monospace;font-size:16px;color:var(--text-primary,#cdd6f4);';
  costLine.textContent = costFormatUsd(event.sessionCostUsd) + ' / ' + costFormatUsd(event.sessionLimitUsd) + ' (' + costFormatPercent(event.usageRatio) + ')';
  dialog.appendChild(costLine);

  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';

  var increaseBtn = document.createElement('button');
  increaseBtn.textContent = 'Increase Budget';
  increaseBtn.style.cssText = 'padding:8px 16px;border-radius:6px;border:none;background:#a6e3a1;color:#1e1e2e;font-weight:600;cursor:pointer;font-size:14px;';
  increaseBtn.addEventListener('click', function () {
    self.dismiss();
    if (onIncrease) onIncrease();
  });
  btnRow.appendChild(increaseBtn);

  var abortBtn = document.createElement('button');
  abortBtn.textContent = 'Abort Execution';
  abortBtn.style.cssText = 'padding:8px 16px;border-radius:6px;border:1px solid #f38ba8;background:transparent;color:#f38ba8;font-weight:600;cursor:pointer;font-size:14px;';
  abortBtn.addEventListener('click', function () {
    self.dismiss();
    if (onAbort) onAbort();
  });
  btnRow.appendChild(abortBtn);

  var dismissBtn = document.createElement('button');
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.style.cssText = 'padding:8px 16px;border-radius:6px;border:1px solid var(--border-color,#313244);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;font-size:14px;';
  dismissBtn.addEventListener('click', function () {
    self.dismiss();
  });
  btnRow.appendChild(dismissBtn);

  dialog.appendChild(btnRow);
  this.overlayEl.appendChild(dialog);
  document.body.appendChild(this.overlayEl);
};

CostWarningPopup.prototype.dismiss = function () {
  if (this.overlayEl && this.overlayEl.parentNode) {
    this.overlayEl.parentNode.removeChild(this.overlayEl);
  }
  this.overlayEl = null;
};

// ─── CostSummaryPanel ──────────────────────────────────────────────

/**
 * Monthly spending summary view with per-provider/model/task breakdown.
 *
 * Requirement: 22.5, 22.7
 */
function CostSummaryPanel(container) {
  this.container = container;
  this.summary = null;
}

CostSummaryPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.cssText = 'padding:16px;';

  var header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;';

  var title = document.createElement('h3');
  title.textContent = 'Cost Controls & Spending Summary';
  title.style.cssText = 'margin:0;color:var(--text-primary,#cdd6f4);font-size:16px;';
  header.appendChild(title);

  var refreshBtn = document.createElement('button');
  refreshBtn.textContent = '↻ Refresh';
  refreshBtn.style.cssText = 'padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#313244);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;font-size:12px;';
  refreshBtn.addEventListener('click', function () { self.loadSummary(); });
  header.appendChild(refreshBtn);

  this.container.appendChild(header);

  // Content area (populated by loadSummary)
  this.contentEl = document.createElement('div');
  this.contentEl.className = 'cost-summary__content';
  this.container.appendChild(this.contentEl);

  this.loadSummary();
};

CostSummaryPanel.prototype.loadSummary = function () {
  var self = this;
  var api = costEapi();
  if (!api) return;

  this.contentEl.innerHTML = '<p style="color:var(--text-muted,#6c7086);font-size:13px;">Loading...</p>';

  api.invoke('cost:session-summary').then(function (result) {
    if (!result || !result.success) {
      self.contentEl.innerHTML = '<p style="color:var(--text-muted,#6c7086);font-size:13px;">' +
        costEscHtml(result?.error || 'Could not load summary. Enable the cost_controls feature flag.') + '</p>';
      return;
    }
    self.summary = result.summary;
    self.renderContent(result.summary);
  }).catch(function (err) {
    self.contentEl.innerHTML = '<p style="color:#f38ba8;font-size:13px;">Error: ' + costEscHtml(err?.message || 'Unknown') + '</p>';
  });
};

CostSummaryPanel.prototype.renderContent = function (summary) {
  var self = this;
  this.contentEl.innerHTML = '';

  // ── Session Status Card ──
  var sessionCard = document.createElement('div');
  sessionCard.style.cssText = 'background:var(--bg-secondary,#181825);border:1px solid var(--border-color,#313244);border-radius:8px;padding:16px;margin-bottom:16px;';

  var sessionTitle = document.createElement('div');
  sessionTitle.style.cssText = 'font-size:13px;color:var(--text-muted,#6c7086);margin-bottom:8px;';
  sessionTitle.textContent = 'Current Session';
  sessionCard.appendChild(sessionTitle);

  var costRow = document.createElement('div');
  costRow.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin-bottom:12px;';
  var costAmount = document.createElement('span');
  costAmount.style.cssText = 'font-size:24px;font-weight:700;font-family:monospace;color:var(--text-primary,#cdd6f4);';
  costAmount.textContent = costFormatUsd(summary.sessionCostUsd);
  costRow.appendChild(costAmount);
  var costLimit = document.createElement('span');
  costLimit.style.cssText = 'font-size:14px;color:var(--text-muted,#6c7086);';
  costLimit.textContent = 'of ' + costFormatUsd(summary.sessionLimitUsd) + ' limit';
  costRow.appendChild(costLimit);
  sessionCard.appendChild(costRow);

  // Progress bar
  var barOuter = document.createElement('div');
  barOuter.style.cssText = 'height:6px;background:var(--bg-tertiary,#313244);border-radius:3px;overflow:hidden;margin-bottom:12px;';
  var barInner = document.createElement('div');
  var pct = Math.min(100, Math.round((summary.usageRatio || 0) * 100));
  var barColor = summary.budgetExhausted ? '#f38ba8' : summary.downgradeActive ? '#fab387' : summary.warningReached ? '#f9e2af' : '#a6e3a1';
  barInner.style.cssText = 'height:100%;width:' + pct + '%;background:' + barColor + ';border-radius:3px;transition:width 0.3s;';
  barOuter.appendChild(barInner);
  sessionCard.appendChild(barOuter);

  // Status badges
  var badges = document.createElement('div');
  badges.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  if (summary.budgetExhausted) {
    badges.innerHTML += '<span style="padding:2px 8px;border-radius:4px;background:#f38ba8;color:#1e1e2e;font-size:11px;font-weight:600;">EXHAUSTED</span>';
  } else if (summary.downgradeActive) {
    badges.innerHTML += '<span style="padding:2px 8px;border-radius:4px;background:#fab387;color:#1e1e2e;font-size:11px;font-weight:600;">DOWNGRADED</span>';
  } else if (summary.warningReached) {
    badges.innerHTML += '<span style="padding:2px 8px;border-radius:4px;background:#f9e2af;color:#1e1e2e;font-size:11px;font-weight:600;">WARNING</span>';
  } else {
    badges.innerHTML += '<span style="padding:2px 8px;border-radius:4px;background:#a6e3a1;color:#1e1e2e;font-size:11px;font-weight:600;">OK</span>';
  }
  badges.innerHTML += '<span style="padding:2px 8px;border-radius:4px;background:var(--bg-tertiary,#313244);color:var(--text-secondary,#a6adc8);font-size:11px;">' + costFormatPercent(summary.usageRatio) + ' used</span>';
  sessionCard.appendChild(badges);

  // Budget edit
  var editRow = document.createElement('div');
  editRow.style.cssText = 'margin-top:12px;display:flex;gap:8px;align-items:center;';
  var input = document.createElement('input');
  input.type = 'number';
  input.step = '0.5';
  input.min = '0';
  input.value = String(summary.sessionLimitUsd || 5);
  input.style.cssText = 'width:80px;padding:4px 8px;border-radius:4px;border:1px solid var(--border-color,#313244);background:var(--bg-primary,#1e1e2e);color:var(--text-primary,#cdd6f4);font-size:13px;font-family:monospace;';
  editRow.appendChild(input);
  var setBtn = document.createElement('button');
  setBtn.textContent = 'Set Budget';
  setBtn.style.cssText = 'padding:4px 10px;border-radius:4px;border:none;background:#89b4fa;color:#1e1e2e;font-weight:600;cursor:pointer;font-size:12px;';
  setBtn.addEventListener('click', function () {
    var val = parseFloat(input.value);
    if (isNaN(val) || val < 0) return;
    costEapi().invoke('cost:budget-set', { limitUsd: val }).then(function () {
      self.loadSummary();
    });
  });
  editRow.appendChild(setBtn);
  sessionCard.appendChild(editRow);

  this.contentEl.appendChild(sessionCard);

  // ── Monthly Summary Card ──
  if (summary.monthlySummary) {
    var monthCard = document.createElement('div');
    monthCard.style.cssText = 'background:var(--bg-secondary,#181825);border:1px solid var(--border-color,#313244);border-radius:8px;padding:16px;';

    var monthTitle = document.createElement('div');
    monthTitle.style.cssText = 'font-size:13px;color:var(--text-muted,#6c7086);margin-bottom:8px;';
    monthTitle.textContent = 'Monthly Spending';
    monthCard.appendChild(monthTitle);

    var totalMonth = document.createElement('div');
    totalMonth.style.cssText = 'font-size:20px;font-weight:700;font-family:monospace;color:var(--text-primary,#cdd6f4);margin-bottom:16px;';
    totalMonth.textContent = costFormatUsd(summary.monthlySummary.totalCostUsd);
    monthCard.appendChild(totalMonth);

    // Provider breakdown
    if (summary.monthlySummary.byProvider && summary.monthlySummary.byProvider.length > 0) {
      monthCard.appendChild(this.renderBreakdownSection('By Provider', summary.monthlySummary.byProvider, 'provider'));
    }

    // Model breakdown
    if (summary.monthlySummary.byModel && summary.monthlySummary.byModel.length > 0) {
      monthCard.appendChild(this.renderBreakdownSection('By Model', summary.monthlySummary.byModel, 'model'));
    }

    // Task breakdown
    if (summary.monthlySummary.byTask && summary.monthlySummary.byTask.length > 0) {
      monthCard.appendChild(this.renderBreakdownSection('By Project', summary.monthlySummary.byTask, 'taskType'));
    }

    this.contentEl.appendChild(monthCard);
  }
};

CostSummaryPanel.prototype.renderBreakdownSection = function (title, items, labelKey) {
  var section = document.createElement('div');
  section.style.cssText = 'margin-bottom:12px;';

  var heading = document.createElement('div');
  heading.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary,#a6adc8);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;';
  heading.textContent = title;
  section.appendChild(heading);

  var list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

  for (var i = 0; i < Math.min(items.length, 5); i++) {
    var item = items[i];
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 8px;border-radius:4px;background:var(--bg-primary,#1e1e2e);';

    var label = document.createElement('span');
    label.style.cssText = 'font-size:12px;color:var(--text-primary,#cdd6f4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;';
    label.textContent = item[labelKey] || 'unknown';
    row.appendChild(label);

    var stats = document.createElement('span');
    stats.style.cssText = 'font-size:11px;font-family:monospace;color:var(--text-muted,#6c7086);white-space:nowrap;';
    stats.textContent = costFormatUsd(item.costUsd) + ' (' + (item.callCount || 0) + ' calls)';
    row.appendChild(stats);

    list.appendChild(row);
  }

  section.appendChild(list);
  return section;
};

// ─── Exports ───────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CostTicker: CostTicker, CostWarningPopup: CostWarningPopup, CostSummaryPanel: CostSummaryPanel };
}
