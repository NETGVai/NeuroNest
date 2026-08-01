// @ts-nocheck
/**
 * TrainingProgressPanel — Real-time training progress display panel.
 *
 * Displays training metrics during active training jobs:
 * - Loss value, loss curve graph (inline SVG), learning rate, step count,
 *   total steps, ETA, elapsed time
 * - GPU utilization, VRAM usage, temperature (when available)
 * - Completion summary (final loss, total time, steps, export status)
 * - Queue position and estimated start time for queued jobs
 *
 * Update rate is throttled to max once per second to avoid overwhelming
 * the renderer IPC channel.
 *
 * IPC channels (listened):
 *   training:progress-update    — real-time training metrics
 *   training:job-state-changed  — job state transitions
 *   training:metrics-update     — GPU/loss metrics snapshot
 *   training:export-progress    — export progress
 *
 * IPC channels (invoked):
 *   training:job-status         — fetch current job status
 *   training:jobs-list          — list all jobs (for queue info)
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 39.4
 */

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────

  var THROTTLE_INTERVAL_MS = 1000; // Max update rate: once per second (Req 9.4)
  var LOSS_HISTORY_MAX = 100;      // Max points in loss curve
  var SVG_WIDTH = 280;
  var SVG_HEIGHT = 80;

  var STATE_LABELS = {
    queued: { label: 'Queued', color: '#fbbf24', icon: '\u23F3' },
    running: { label: 'Training', color: '#60a5fa', icon: '\u25B6' },
    paused: { label: 'Paused', color: '#a78bfa', icon: '\u23F8' },
    completed: { label: 'Completed', color: '#4ade80', icon: '\u2714' },
    failed: { label: 'Failed', color: '#f87171', icon: '\u2718' },
    cancelled: { label: 'Cancelled', color: '#94a3b8', icon: '\u2716' },
  };

  // ─── Helpers ─────────────────────────────────────────────────────

  function api() { return window.electronAPI; }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function formatMs(ms) {
    if (ms == null || ms <= 0) return '--';
    var totalSec = Math.floor(ms / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function formatNumber(n) {
    if (n == null) return '--';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function formatLoss(loss) {
    if (loss == null || isNaN(loss)) return '--';
    return loss.toFixed(4);
  }

  function formatLR(lr) {
    if (lr == null || isNaN(lr)) return '--';
    return lr.toExponential(2);
  }

  function formatPercent(val) {
    if (val == null || isNaN(val)) return '--';
    return Math.round(val) + '%';
  }

  function formatTemp(temp) {
    if (temp == null || isNaN(temp)) return '--';
    return Math.round(temp) + '\u00B0C';
  }

  function formatVRAM(mb) {
    if (mb == null || isNaN(mb)) return '--';
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
    return Math.round(mb) + ' MB';
  }

  // ─── Loss Curve SVG Renderer ─────────────────────────────────────

  function renderLossCurve(container, lossHistory) {
    if (!lossHistory || lossHistory.length < 2) {
      container.innerHTML = '<div style="text-align:center;color:var(--text-dim);font-size:11px;padding:16px 0;">Waiting for data...</div>';
      return;
    }

    var points = lossHistory;
    var minLoss = Infinity;
    var maxLoss = -Infinity;
    for (var i = 0; i < points.length; i++) {
      if (points[i] < minLoss) minLoss = points[i];
      if (points[i] > maxLoss) maxLoss = points[i];
    }

    // Ensure range is meaningful
    var range = maxLoss - minLoss;
    if (range < 0.0001) { range = 1; minLoss = maxLoss - 1; }

    var padding = 4;
    var w = SVG_WIDTH - padding * 2;
    var h = SVG_HEIGHT - padding * 2;

    var pathParts = [];
    for (var j = 0; j < points.length; j++) {
      var x = padding + (j / (points.length - 1)) * w;
      var y = padding + (1 - (points[j] - minLoss) / range) * h;
      pathParts.push((j === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1));
    }

    // Determine trend for accessible text
    var trend = 'stable';
    if (points.length >= 5) {
      var recent = points.slice(-5);
      var earlier = points.slice(0, 5);
      var recentAvg = recent.reduce(function (a, b) { return a + b; }, 0) / recent.length;
      var earlierAvg = earlier.reduce(function (a, b) { return a + b; }, 0) / earlier.length;
      if (recentAvg < earlierAvg * 0.95) trend = 'improving';
      else if (recentAvg > earlierAvg * 1.05) trend = 'diverging';
      else trend = 'plateauing';
    }

    var trendLabel = 'Loss trend: ' + trend + '. Current: ' + formatLoss(points[points.length - 1]) +
      ', Min: ' + formatLoss(minLoss) + ', Max: ' + formatLoss(maxLoss);

    var svg = '<svg width="' + SVG_WIDTH + '" height="' + SVG_HEIGHT + '" role="img" ' +
      'aria-label="' + escHtml(trendLabel) + '" ' +
      'style="display:block;width:100%;max-width:' + SVG_WIDTH + 'px;height:auto;">' +
      '<rect width="' + SVG_WIDTH + '" height="' + SVG_HEIGHT + '" fill="var(--surface-container-high,#1e1e2e)" rx="4"/>' +
      '<path d="' + pathParts.join(' ') + '" fill="none" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<text x="' + padding + '" y="' + (SVG_HEIGHT - 2) + '" font-size="9" fill="var(--text-dim,#888)">' + formatLoss(minLoss) + '</text>' +
      '<text x="' + padding + '" y="' + (padding + 8) + '" font-size="9" fill="var(--text-dim,#888)">' + formatLoss(maxLoss) + '</text>' +
      '</svg>';

    container.innerHTML = svg;

    // Add accessible description below the graph (Req 33.3)
    var desc = document.createElement('div');
    desc.setAttribute('aria-live', 'polite');
    desc.className = 'tp-chart-desc';
    desc.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:4px;text-align:center;';
    desc.textContent = trendLabel;
    container.appendChild(desc);
  }

  // ─── Inject Panel Styles ─────────────────────────────────────────

  var styleEl = document.createElement('style');
  styleEl.id = 'training-progress-panel-styles';
  styleEl.textContent = [
    '.tp-panel{padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);}',
    '.tp-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}',
    '.tp-title{margin:0;font-size:16px;font-weight:600;color:var(--text-primary);}',
    '.tp-state-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 10px;border-radius:10px;font-weight:600;}',
    '.tp-section{background:var(--surface-container-high);border:1px solid var(--border-color);border-radius:var(--radius-sm,6px);padding:12px 14px;margin-bottom:10px;}',
    '.tp-section-title{font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;}',
    '.tp-metrics-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;}',
    '.tp-metric{text-align:center;}',
    '.tp-metric-value{font-size:16px;font-weight:700;color:var(--text-primary);font-variant-numeric:tabular-nums;}',
    '.tp-metric-label{font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.3px;margin-top:2px;}',
    '.tp-progress-bar-container{height:6px;background:var(--border-color);border-radius:3px;overflow:hidden;margin-top:8px;}',
    '.tp-progress-bar{height:100%;background:var(--accent,#60a5fa);border-radius:3px;transition:width 0.3s ease;}',
    '.tp-gpu-section{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}',
    '.tp-gpu-stat{text-align:center;padding:6px;background:var(--surface-container,#252538);border-radius:4px;}',
    '.tp-gpu-val{font-size:14px;font-weight:600;color:var(--text-primary);}',
    '.tp-gpu-label{font-size:9px;color:var(--text-dim);margin-top:2px;}',
    '.tp-queue-info{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--yellow-container,rgba(251,191,36,0.1));border:1px solid var(--yellow,#fbbf24);border-radius:var(--radius-sm,6px);margin-bottom:10px;font-size:12px;color:var(--text-primary);}',
    '.tp-queue-icon{font-size:18px;}',
    '.tp-completion-banner{padding:12px 14px;background:var(--green-container,rgba(74,222,128,0.1));border:1px solid var(--green,#4ade80);border-radius:var(--radius-sm,6px);margin-bottom:10px;}',
    '.tp-completion-title{font-size:12px;font-weight:600;color:var(--green,#4ade80);margin-bottom:8px;}',
    '.tp-completion-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;}',
    '.tp-completion-item{font-size:11px;color:var(--text-secondary);}',
    '.tp-completion-item strong{color:var(--text-primary);font-weight:600;}',
    '.tp-empty{text-align:center;padding:48px 24px;color:var(--text-secondary);}',
    '.tp-empty-icon{font-size:32px;margin-bottom:8px;}',
  ].join('\n');
  if (!document.getElementById('training-progress-panel-styles')) {
    document.head.appendChild(styleEl);
  }

  // ─── TrainingProgressPanel Class ─────────────────────────────────

  function TrainingProgressPanel(container, options) {
    this.container = container;
    this.projectId = (options && options.projectId) || window._neuronestActiveProject || 'default';
    this.jobId = (options && options.jobId) || null;

    // State
    this.progress = null;
    this.lossHistory = [];
    this.completionData = null;
    this.queueInfo = null;
    this.exportProgress = null;
    this.lastUpdateTime = 0;
    this.pendingUpdate = null;

    // DOM references
    this.contentEl = null;
    this.liveRegion = null;

    // Bind event handlers for cleanup
    this._onProgressUpdate = this._throttledUpdate.bind(this, 'progress');
    this._onStateChanged = this._handleStateChanged.bind(this);
    this._onMetricsUpdate = this._throttledUpdate.bind(this, 'metrics');
    this._onExportProgress = this._handleExportProgress.bind(this);
  }

  // ── Throttle logic (Req 9.4: max once per second) ───────────────

  TrainingProgressPanel.prototype._throttledUpdate = function (type, data) {
    var self = this;
    var now = Date.now();

    if (type === 'progress') {
      this.progress = data;
      if (typeof data.loss === 'number' && !isNaN(data.loss)) {
        this.lossHistory.push(data.loss);
        if (this.lossHistory.length > LOSS_HISTORY_MAX) {
          this.lossHistory.shift();
        }
      }
    } else if (type === 'metrics') {
      // Merge metrics into progress
      if (this.progress && data.jobId === (this.progress.jobId || this.jobId)) {
        if (data.loss != null) this.progress.loss = data.loss;
        if (data.learningRate != null) this.progress.learningRate = data.learningRate;
        if (data.gpuUtilization != null) this.progress.gpuUtilization = data.gpuUtilization;
        if (data.vramUsageMB != null) this.progress.vramUsageMB = data.vramUsageMB;
        if (data.gpuTemperature != null) this.progress.gpuTemperature = data.gpuTemperature;
      }
    }

    // Throttle updates to once per second
    if (now - this.lastUpdateTime < THROTTLE_INTERVAL_MS) {
      if (!this.pendingUpdate) {
        this.pendingUpdate = setTimeout(function () {
          self.pendingUpdate = null;
          self.lastUpdateTime = Date.now();
          self._renderContent();
        }, THROTTLE_INTERVAL_MS - (now - self.lastUpdateTime));
      }
      return;
    }

    this.lastUpdateTime = now;
    this._renderContent();
  };

  TrainingProgressPanel.prototype._handleStateChanged = function (data) {
    if (!data) return;

    // Announce state change via ARIA live region (Req 33.2)
    if (this.liveRegion) {
      var label = STATE_LABELS[data.state] || { label: data.state };
      this.liveRegion.textContent = 'Training job ' + label.label + (data.error ? ': ' + data.error : '');
    }

    if (data.state === 'completed' && this.progress) {
      this.completionData = {
        finalLoss: this.progress.loss,
        totalTime: this.progress.elapsedMs,
        totalSteps: this.progress.currentStep,
        exportStatus: 'pending',
      };
    }

    if (this.progress) {
      this.progress.state = data.state;
    }

    this._renderContent();
  };

  TrainingProgressPanel.prototype._handleExportProgress = function (data) {
    if (!data) return;
    this.exportProgress = data;

    if (data.stage === 'complete' && this.completionData) {
      this.completionData.exportStatus = 'success';
    } else if (data.stage === 'failed' && this.completionData) {
      this.completionData.exportStatus = 'failed';
    }

    this._renderContent();
  };

  // ── IPC Subscriptions ───────────────────────────────────────────

  TrainingProgressPanel.prototype._subscribe = function () {
    var eapi = api();
    if (!eapi || !eapi.on) return;

    eapi.on('training:progress-update', this._onProgressUpdate);
    eapi.on('training:job-state-changed', this._onStateChanged);
    eapi.on('training:metrics-update', this._onMetricsUpdate);
    eapi.on('training:export-progress', this._onExportProgress);
  };

  TrainingProgressPanel.prototype._unsubscribe = function () {
    var eapi = api();
    if (!eapi || !eapi.off) return;

    eapi.off('training:progress-update', this._onProgressUpdate);
    eapi.off('training:job-state-changed', this._onStateChanged);
    eapi.off('training:metrics-update', this._onMetricsUpdate);
    eapi.off('training:export-progress', this._onExportProgress);
  };

  // ── Initial Data Fetch ──────────────────────────────────────────

  TrainingProgressPanel.prototype._fetchInitialState = function () {
    var self = this;
    var eapi = api();
    if (!eapi || !eapi.invoke) return;

    // Fetch jobs list to find active/queued job
    eapi.invoke('training:jobs-list', { projectId: self.projectId }).then(function (result) {
      if (!result || !result.success || !result.data) return;

      var jobs = result.data;
      var activeJob = null;
      var queuedJobs = [];

      for (var i = 0; i < jobs.length; i++) {
        if (jobs[i].state === 'running') {
          activeJob = jobs[i];
        } else if (jobs[i].state === 'queued') {
          queuedJobs.push(jobs[i]);
        }
      }

      // If we have a specific jobId, look for it
      if (self.jobId) {
        for (var k = 0; k < jobs.length; k++) {
          if (jobs[k].id === self.jobId) {
            activeJob = jobs[k];
            break;
          }
        }
      } else if (activeJob) {
        self.jobId = activeJob.id;
      } else if (queuedJobs.length > 0) {
        self.jobId = queuedJobs[0].id;
      }

      // Set queue info for queued jobs (Req 39.4)
      if (queuedJobs.length > 0 && (!activeJob || activeJob.state === 'queued')) {
        var targetJob = self.jobId ? queuedJobs.find(function (j) { return j.id === self.jobId; }) : queuedJobs[0];
        if (targetJob) {
          var position = queuedJobs.indexOf(targetJob) + 1;
          self.queueInfo = {
            position: position,
            totalQueued: queuedJobs.length,
            estimatedStartTime: null, // Calculated if running job has ETA
          };
        }
      }

      // If we have an active/running job, fetch its status
      if (self.jobId) {
        return eapi.invoke('training:job-status', { jobId: self.jobId });
      }
      return null;
    }).then(function (result) {
      if (result && result.success && result.data) {
        self.progress = result.data;
        if (result.data.state === 'completed') {
          self.completionData = {
            finalLoss: result.data.loss,
            totalTime: result.data.elapsedMs,
            totalSteps: result.data.currentStep,
            exportStatus: 'success',
          };
        }
      }
      self._renderContent();
    }).catch(function () {
      self._renderContent();
    });
  };

  // ── Main Render ─────────────────────────────────────────────────

  TrainingProgressPanel.prototype.render = function () {
    this.container.innerHTML = '';
    this.container.className = 'tp-panel wk-scroll';

    // ARIA live region for state announcements (Req 33.2)
    this.liveRegion = document.createElement('div');
    this.liveRegion.setAttribute('aria-live', 'assertive');
    this.liveRegion.setAttribute('aria-atomic', 'true');
    this.liveRegion.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;';
    this.container.appendChild(this.liveRegion);

    // Content container
    this.contentEl = document.createElement('div');
    this.container.appendChild(this.contentEl);

    // Subscribe to IPC events
    this._subscribe();

    // Fetch initial state
    this._fetchInitialState();
  };

  // ── Content Render ──────────────────────────────────────────────

  TrainingProgressPanel.prototype._renderContent = function () {
    if (!this.contentEl) return;

    var progress = this.progress;

    // No active job — show empty state
    if (!progress) {
      this.contentEl.innerHTML =
        '<div class="tp-empty">' +
        '<div class="tp-empty-icon" aria-hidden="true">\uD83C\uDFCB</div>' +
        '<div style="font-size:13px;font-weight:500;">No Active Training</div>' +
        '<div style="font-size:11px;margin-top:4px;color:var(--text-dim);">Start a training job to see progress here.</div>' +
        '</div>';
      return;
    }

    var html = '';

    // ── Header with state badge ──
    var stateInfo = STATE_LABELS[progress.state] || { label: progress.state, color: '#94a3b8', icon: '?' };
    html += '<div class="tp-header">';
    html += '<h3 class="tp-title" aria-label="Training Progress Panel">Training Progress</h3>';
    html += '<span class="tp-state-badge" style="background:' + stateInfo.color + '22;color:' + stateInfo.color + ';" aria-label="Status: ' + escHtml(stateInfo.label) + '">';
    html += '<span aria-hidden="true">' + stateInfo.icon + '</span> ' + escHtml(stateInfo.label);
    html += '</span>';
    html += '</div>';

    // ── Queue info (Req 39.4) ──
    if (progress.state === 'queued' && this.queueInfo) {
      html += '<div class="tp-queue-info" role="status" aria-label="Queue position ' + this.queueInfo.position + ' of ' + this.queueInfo.totalQueued + '">';
      html += '<span class="tp-queue-icon" aria-hidden="true">\u23F3</span>';
      html += '<div>';
      html += '<div style="font-weight:600;">Queue Position: #' + this.queueInfo.position + '</div>';
      html += '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">';
      if (this.queueInfo.estimatedStartTime) {
        html += 'Estimated start: ' + new Date(this.queueInfo.estimatedStartTime).toLocaleTimeString();
      } else {
        html += 'Waiting for resources...';
      }
      html += '</div></div></div>';
    }

    // ── Completion summary (Req 9.3) ──
    if (progress.state === 'completed' && this.completionData) {
      html += '<div class="tp-completion-banner" role="status" aria-label="Training completed successfully">';
      html += '<div class="tp-completion-title">\u2714 Training Complete</div>';
      html += '<div class="tp-completion-grid">';
      html += '<div class="tp-completion-item"><strong>Final Loss:</strong> ' + formatLoss(this.completionData.finalLoss) + '</div>';
      html += '<div class="tp-completion-item"><strong>Total Time:</strong> ' + formatMs(this.completionData.totalTime) + '</div>';
      html += '<div class="tp-completion-item"><strong>Total Steps:</strong> ' + formatNumber(this.completionData.totalSteps) + '</div>';
      html += '<div class="tp-completion-item"><strong>Export:</strong> ' + escHtml(this.completionData.exportStatus) + '</div>';
      html += '</div></div>';
    }

    // ── Training metrics section (Req 9.1) ──
    if (progress.state === 'running' || progress.state === 'paused') {
      // Progress bar
      var pct = progress.totalSteps > 0 ? Math.round((progress.currentStep / progress.totalSteps) * 100) : 0;
      html += '<div class="tp-section">';
      html += '<div class="tp-section-title">Progress</div>';
      html += '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-secondary);margin-bottom:4px;">';
      html += '<span>Step ' + formatNumber(progress.currentStep) + ' / ' + formatNumber(progress.totalSteps) + '</span>';
      html += '<span>' + pct + '%</span>';
      html += '</div>';
      html += '<div class="tp-progress-bar-container" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100" aria-label="Training progress ' + pct + ' percent">';
      html += '<div class="tp-progress-bar" style="width:' + pct + '%;"></div>';
      html += '</div>';
      html += '</div>';

      // Key metrics grid
      html += '<div class="tp-section">';
      html += '<div class="tp-section-title">Metrics</div>';
      html += '<div class="tp-metrics-grid">';
      html += '<div class="tp-metric"><div class="tp-metric-value">' + formatLoss(progress.loss) + '</div><div class="tp-metric-label">Loss</div></div>';
      html += '<div class="tp-metric"><div class="tp-metric-value">' + formatLR(progress.learningRate) + '</div><div class="tp-metric-label">Learning Rate</div></div>';
      html += '<div class="tp-metric"><div class="tp-metric-value">' + formatNumber(progress.currentStep) + '</div><div class="tp-metric-label">Step</div></div>';
      html += '<div class="tp-metric"><div class="tp-metric-value">' + formatNumber(progress.totalSteps) + '</div><div class="tp-metric-label">Total Steps</div></div>';
      html += '<div class="tp-metric"><div class="tp-metric-value">' + formatMs(progress.etaMs) + '</div><div class="tp-metric-label">ETA</div></div>';
      html += '<div class="tp-metric"><div class="tp-metric-value">' + formatMs(progress.elapsedMs) + '</div><div class="tp-metric-label">Elapsed</div></div>';
      html += '</div></div>';

      // Loss curve section
      html += '<div class="tp-section">';
      html += '<div class="tp-section-title">Loss Curve</div>';
      html += '<div id="tp-loss-curve-container"></div>';
      html += '</div>';
    }

    // ── GPU metrics section (Req 9.2) ──
    if ((progress.state === 'running' || progress.state === 'paused') &&
        (progress.gpuUtilization != null || progress.vramUsageMB != null || progress.gpuTemperature != null)) {
      html += '<div class="tp-section">';
      html += '<div class="tp-section-title">GPU Hardware</div>';
      html += '<div class="tp-gpu-section">';

      if (progress.gpuUtilization != null) {
        html += '<div class="tp-gpu-stat" aria-label="GPU Utilization ' + formatPercent(progress.gpuUtilization) + '">';
        html += '<div class="tp-gpu-val">' + formatPercent(progress.gpuUtilization) + '</div>';
        html += '<div class="tp-gpu-label">GPU Util</div>';
        html += '</div>';
      }

      if (progress.vramUsageMB != null) {
        html += '<div class="tp-gpu-stat" aria-label="VRAM Usage ' + formatVRAM(progress.vramUsageMB) + '">';
        html += '<div class="tp-gpu-val">' + formatVRAM(progress.vramUsageMB) + '</div>';
        html += '<div class="tp-gpu-label">VRAM</div>';
        html += '</div>';
      }

      if (progress.gpuTemperature != null) {
        html += '<div class="tp-gpu-stat" aria-label="GPU Temperature ' + formatTemp(progress.gpuTemperature) + '">';
        html += '<div class="tp-gpu-val">' + formatTemp(progress.gpuTemperature) + '</div>';
        html += '<div class="tp-gpu-label">Temp</div>';
        html += '</div>';
      }

      html += '</div></div>';
    }

    // ── Export progress ──
    if (this.exportProgress && this.exportProgress.stage !== 'complete') {
      html += '<div class="tp-section">';
      html += '<div class="tp-section-title">Export Progress</div>';
      html += '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-secondary);margin-bottom:4px;">';
      html += '<span>' + escHtml(this.exportProgress.stage) + '</span>';
      html += '<span>' + this.exportProgress.percent + '%</span>';
      html += '</div>';
      html += '<div class="tp-progress-bar-container" role="progressbar" aria-valuenow="' + this.exportProgress.percent + '" aria-valuemin="0" aria-valuemax="100" aria-label="Export progress">';
      html += '<div class="tp-progress-bar" style="width:' + this.exportProgress.percent + '%;background:var(--green,#4ade80);"></div>';
      html += '</div></div>';
    }

    // Apply HTML
    this.contentEl.innerHTML = html;

    // Render loss curve into its container (needs DOM reference)
    var curveContainer = this.contentEl.querySelector('#tp-loss-curve-container');
    if (curveContainer) {
      renderLossCurve(curveContainer, this.lossHistory);
    }
  };

  // ── Cleanup ─────────────────────────────────────────────────────

  TrainingProgressPanel.prototype.destroy = function () {
    this._unsubscribe();
    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate);
      this.pendingUpdate = null;
    }
    this.container.innerHTML = '';
  };

  // ── Expose on window ────────────────────────────────────────────

  window.TrainingProgressPanel = TrainingProgressPanel;
})();
