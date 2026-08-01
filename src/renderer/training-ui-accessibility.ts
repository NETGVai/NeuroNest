// @ts-nocheck
/**
 * TrainingUIAccessibility — Accessibility enhancements for training UI panels.
 *
 * Provides:
 * 1. ARIA live region management for announcing all training state changes
 *    (job started, checkpoint saved, completed, failed)
 * 2. Text-alternative description generator for loss curve and metrics graphs
 *    (trend: improving, plateauing, diverging + numeric values)
 * 3. Model comparison panel accessibility utilities
 *    (keyboard navigation, labeled response areas, tab order)
 * 4. Color contrast utilities ensuring 4.5:1 ratio + secondary differentiators
 *
 * Requirements: 33.2, 33.3, 33.5
 */

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────

  var STATE_ANNOUNCEMENTS = {
    queued: 'Training job queued, waiting for resources',
    running: 'Training job started',
    paused: 'Training job paused',
    completed: 'Training job completed successfully',
    failed: 'Training job failed',
    cancelled: 'Training job cancelled',
  };

  var CHECKPOINT_ANNOUNCEMENT = 'Checkpoint saved at epoch {epoch}, step {step}';
  var EXPORT_ANNOUNCEMENTS = {
    start: 'Model export started',
    quantizing: 'Model quantization in progress',
    complete: 'Model export completed successfully',
    failed: 'Model export failed',
  };

  /** WCAG 2.1 AA minimum contrast ratio */
  var MIN_CONTRAST_RATIO = 4.5;

  /** Status colors verified against dark background (#1e1e2e) for 4.5:1 contrast */
  var STATUS_COLORS = {
    queued: { bg: 'rgba(251,191,36,0.15)', fg: '#fbbf24', icon: '\u23F3', label: 'Queued' },
    running: { bg: 'rgba(96,165,250,0.15)', fg: '#60a5fa', icon: '\u25B6', label: 'Training' },
    paused: { bg: 'rgba(167,139,250,0.15)', fg: '#a78bfa', icon: '\u23F8', label: 'Paused' },
    completed: { bg: 'rgba(74,222,128,0.15)', fg: '#4ade80', icon: '\u2714', label: 'Completed' },
    failed: { bg: 'rgba(248,113,113,0.15)', fg: '#f87171', icon: '\u2718', label: 'Failed' },
    cancelled: { bg: 'rgba(148,163,184,0.15)', fg: '#94a3b8', icon: '\u2716', label: 'Cancelled' },
  };

  // ─── ARIA Live Region Manager (Req 33.2) ──────────────────────

  /**
   * Manages ARIA live regions for training state change announcements.
   * Creates a visually hidden but screen-reader-accessible region that
   * announces state transitions: job started, checkpoint saved,
   * completed, failed, etc.
   */
  function TrainingLiveRegionManager() {
    this.regions = {};
    this.announcementQueue = [];
    this.debounceTimer = null;
  }

  /**
   * Create and attach an ARIA live region to a container.
   * @param {HTMLElement} container - Parent element to attach live region to.
   * @param {string} id - Unique identifier for this region.
   * @param {string} politeness - 'assertive' for urgent, 'polite' for non-urgent.
   * @returns {HTMLElement} The created live region element.
   */
  TrainingLiveRegionManager.prototype.createRegion = function (container, id, politeness) {
    var region = document.createElement('div');
    region.id = 'training-a11y-live-' + id;
    region.setAttribute('aria-live', politeness || 'assertive');
    region.setAttribute('aria-atomic', 'true');
    region.setAttribute('role', 'status');
    region.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;';
    container.appendChild(region);
    this.regions[id] = region;
    return region;
  };

  /**
   * Announce a training state change via the live region.
   * @param {string} regionId - Which live region to use.
   * @param {string} state - The new state (queued, running, completed, etc.).
   * @param {object} [details] - Optional extra details (jobId, error message).
   */
  TrainingLiveRegionManager.prototype.announceStateChange = function (regionId, state, details) {
    var region = this.regions[regionId];
    if (!region) return;

    var message = STATE_ANNOUNCEMENTS[state] || ('Training job state: ' + state);
    if (details && details.error) {
      message += '. Error: ' + details.error;
    }
    if (details && details.jobId) {
      message = message + ' (Job ' + details.jobId.slice(0, 8) + ')';
    }

    // Clear and set to force re-announcement
    region.textContent = '';
    var self = this;
    setTimeout(function () {
      region.textContent = message;
    }, 50);
  };

  /**
   * Announce a checkpoint save event.
   * @param {string} regionId - Which live region to use.
   * @param {number} epoch - Current epoch number.
   * @param {number} step - Current step number.
   */
  TrainingLiveRegionManager.prototype.announceCheckpoint = function (regionId, epoch, step) {
    var region = this.regions[regionId];
    if (!region) return;

    var message = CHECKPOINT_ANNOUNCEMENT
      .replace('{epoch}', String(epoch))
      .replace('{step}', String(step));

    region.textContent = '';
    setTimeout(function () {
      region.textContent = message;
    }, 50);
  };

  /**
   * Announce export progress event.
   * @param {string} regionId - Which live region to use.
   * @param {string} stage - Export stage (start, quantizing, complete, failed).
   */
  TrainingLiveRegionManager.prototype.announceExport = function (regionId, stage) {
    var region = this.regions[regionId];
    if (!region) return;

    var message = EXPORT_ANNOUNCEMENTS[stage] || ('Export: ' + stage);
    region.textContent = '';
    setTimeout(function () {
      region.textContent = message;
    }, 50);
  };

  /**
   * Get the current region element for a given id.
   * @param {string} id - Region identifier.
   * @returns {HTMLElement|null}
   */
  TrainingLiveRegionManager.prototype.getRegion = function (id) {
    return this.regions[id] || null;
  };

  /**
   * Remove all live regions and clean up.
   */
  TrainingLiveRegionManager.prototype.destroy = function () {
    var keys = Object.keys(this.regions);
    for (var i = 0; i < keys.length; i++) {
      var region = this.regions[keys[i]];
      if (region && region.parentNode) {
        region.parentNode.removeChild(region);
      }
    }
    this.regions = {};
  };

  // ─── Graph Text Alternatives (Req 33.3) ────────────────────────

  /**
   * Generate a text-alternative description for a loss curve graph.
   * Summarizes: current trend (improving, plateauing, diverging),
   * latest numeric values, min, max, and step range.
   *
   * @param {number[]} lossHistory - Array of loss values over time.
   * @param {object} [context] - Optional context (currentStep, totalSteps).
   * @returns {string} Human-readable description for screen readers.
   */
  function generateLossCurveDescription(lossHistory, context) {
    if (!lossHistory || lossHistory.length === 0) {
      return 'Loss curve: No data available yet.';
    }

    if (lossHistory.length === 1) {
      return 'Loss curve: Single data point at ' + lossHistory[0].toFixed(4) + '.';
    }

    var latest = lossHistory[lossHistory.length - 1];
    var first = lossHistory[0];
    var min = Infinity;
    var max = -Infinity;
    for (var i = 0; i < lossHistory.length; i++) {
      if (lossHistory[i] < min) min = lossHistory[i];
      if (lossHistory[i] > max) max = lossHistory[i];
    }

    // Determine trend from recent vs earlier values
    var trend = determineTrend(lossHistory);
    var desc = 'Loss curve: Trend is ' + trend + '. ';
    desc += 'Current loss: ' + latest.toFixed(4) + '. ';
    desc += 'Range: ' + min.toFixed(4) + ' to ' + max.toFixed(4) + '. ';
    desc += lossHistory.length + ' data points recorded.';

    if (context && context.currentStep && context.totalSteps) {
      desc += ' Progress: step ' + context.currentStep + ' of ' + context.totalSteps + '.';
    }

    return desc;
  }

  /**
   * Generate a text-alternative description for a metrics graph
   * (GPU utilization, VRAM usage, temperature over time).
   *
   * @param {string} metricName - Name of the metric (e.g., 'GPU Utilization').
   * @param {number[]} values - Array of metric values over time.
   * @param {string} unit - Unit of measurement (e.g., '%', 'MB', '°C').
   * @returns {string} Human-readable description for screen readers.
   */
  function generateMetricsDescription(metricName, values, unit) {
    if (!values || values.length === 0) {
      return metricName + ' graph: No data available yet.';
    }

    var latest = values[values.length - 1];
    var min = Infinity;
    var max = -Infinity;
    var sum = 0;
    for (var i = 0; i < values.length; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
      sum += values[i];
    }
    var avg = sum / values.length;
    var trend = determineTrend(values);

    var desc = metricName + ' graph: Trend is ' + trend + '. ';
    desc += 'Current: ' + latest.toFixed(1) + unit + '. ';
    desc += 'Average: ' + avg.toFixed(1) + unit + '. ';
    desc += 'Range: ' + min.toFixed(1) + ' to ' + max.toFixed(1) + unit + '.';

    return desc;
  }

  /**
   * Determine the trend of a numeric series.
   * Compares the average of the last 5 values to the first 5.
   *
   * @param {number[]} values - Array of values.
   * @returns {string} 'improving' | 'plateauing' | 'diverging'
   */
  function determineTrend(values) {
    if (!values || values.length < 5) {
      return 'insufficient data';
    }

    var recentCount = Math.min(5, Math.floor(values.length / 2));
    var recent = values.slice(-recentCount);
    var earlier = values.slice(0, recentCount);

    var recentAvg = 0;
    var earlierAvg = 0;
    for (var i = 0; i < recentCount; i++) {
      recentAvg += recent[i];
      earlierAvg += earlier[i];
    }
    recentAvg /= recentCount;
    earlierAvg /= recentCount;

    if (recentAvg < earlierAvg * 0.95) return 'improving';
    if (recentAvg > earlierAvg * 1.05) return 'diverging';
    return 'plateauing';
  }

  // ─── Model Comparison Panel Accessibility (Req 33.5) ───────────

  /**
   * Enhances a model comparison panel container with keyboard navigation,
   * labeled response areas, and proper focus management.
   *
   * The comparison panel shows side-by-side responses from a base model
   * and a fine-tuned model. Each response area must be:
   * - Labeled with the model identity
   * - Navigable via Tab key
   * - Accessible for rating (thumbs up/down)
   *
   * @param {HTMLElement} container - The comparison panel container.
   * @param {object} options - Configuration options.
   * @param {string} options.baseModelName - Name of the base model.
   * @param {string} options.fineTunedModelName - Name of the fine-tuned model.
   */
  function ModelComparisonAccessibility(container, options) {
    this.container = container;
    this.baseModelName = (options && options.baseModelName) || 'Base Model';
    this.fineTunedModelName = (options && options.fineTunedModelName) || 'Fine-tuned Model';
    this.focusableElements = [];
  }

  /**
   * Apply accessibility enhancements to the comparison panel.
   * Sets up ARIA labels, roles, keyboard navigation, and focus management.
   */
  ModelComparisonAccessibility.prototype.enhance = function () {
    var container = this.container;
    if (!container) return;

    // Set panel-level attributes
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', 'Model comparison: ' + this.baseModelName + ' vs ' + this.fineTunedModelName);

    // Set up keyboard navigation
    this.setupKeyboardNavigation();

    // Label response areas
    this.labelResponseAreas();

    // Enhance rating buttons
    this.enhanceRatingButtons();
  };

  /**
   * Set up keyboard navigation within the comparison panel.
   * Implements Tab order: prompt input → base response → base rating →
   * fine-tuned response → fine-tuned rating.
   */
  ModelComparisonAccessibility.prototype.setupKeyboardNavigation = function () {
    var container = this.container;
    var self = this;

    // Collect focusable elements in logical order
    this.focusableElements = [];

    // Prompt input area
    var promptArea = container.querySelector('.mc-prompt-input, [data-role="prompt-input"]');
    if (promptArea) {
      promptArea.setAttribute('tabindex', '0');
      promptArea.setAttribute('aria-label', 'Comparison prompt input');
      this.focusableElements.push(promptArea);
    }

    // Base model response area
    var baseResponse = container.querySelector('.mc-response-base, [data-role="response-base"]');
    if (baseResponse) {
      baseResponse.setAttribute('tabindex', '0');
      baseResponse.setAttribute('role', 'article');
      baseResponse.setAttribute('aria-label', 'Response from ' + this.baseModelName);
      this.focusableElements.push(baseResponse);
    }

    // Base model rating buttons
    var baseRatings = container.querySelectorAll('.mc-rating-base button, [data-role="rating-base"] button');
    for (var i = 0; i < baseRatings.length; i++) {
      baseRatings[i].setAttribute('tabindex', '0');
      this.focusableElements.push(baseRatings[i]);
    }

    // Fine-tuned model response area
    var ftResponse = container.querySelector('.mc-response-finetuned, [data-role="response-finetuned"]');
    if (ftResponse) {
      ftResponse.setAttribute('tabindex', '0');
      ftResponse.setAttribute('role', 'article');
      ftResponse.setAttribute('aria-label', 'Response from ' + this.fineTunedModelName);
      this.focusableElements.push(ftResponse);
    }

    // Fine-tuned model rating buttons
    var ftRatings = container.querySelectorAll('.mc-rating-finetuned button, [data-role="rating-finetuned"] button');
    for (var j = 0; j < ftRatings.length; j++) {
      ftRatings[j].setAttribute('tabindex', '0');
      this.focusableElements.push(ftRatings[j]);
    }

    // Add keyboard event listener for arrow key navigation within the panel
    container.addEventListener('keydown', function (e) {
      self.handleKeydown(e);
    });
  };

  /**
   * Handle keydown events for keyboard navigation within the panel.
   * Supports: Tab/Shift+Tab for sequential navigation,
   * Arrow keys for moving between response areas.
   *
   * @param {KeyboardEvent} e - The keyboard event.
   */
  ModelComparisonAccessibility.prototype.handleKeydown = function (e) {
    var elements = this.focusableElements;
    if (elements.length === 0) return;

    var currentIndex = elements.indexOf(document.activeElement);
    if (currentIndex === -1) return;

    var nextIndex = -1;

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      nextIndex = (currentIndex + 1) % elements.length;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      nextIndex = (currentIndex - 1 + elements.length) % elements.length;
    }

    if (nextIndex >= 0 && elements[nextIndex]) {
      elements[nextIndex].focus();
    }
  };

  /**
   * Label response areas with model identity for screen readers.
   */
  ModelComparisonAccessibility.prototype.labelResponseAreas = function () {
    var container = this.container;

    // Add headings for each response section
    var baseSection = container.querySelector('.mc-section-base, [data-role="section-base"]');
    if (baseSection) {
      var baseHeading = baseSection.querySelector('h3, h4, .mc-section-title');
      if (baseHeading) {
        baseHeading.id = 'mc-heading-base';
        baseSection.setAttribute('aria-labelledby', 'mc-heading-base');
      } else {
        baseSection.setAttribute('aria-label', this.baseModelName + ' response section');
      }
    }

    var ftSection = container.querySelector('.mc-section-finetuned, [data-role="section-finetuned"]');
    if (ftSection) {
      var ftHeading = ftSection.querySelector('h3, h4, .mc-section-title');
      if (ftHeading) {
        ftHeading.id = 'mc-heading-finetuned';
        ftSection.setAttribute('aria-labelledby', 'mc-heading-finetuned');
      } else {
        ftSection.setAttribute('aria-label', this.fineTunedModelName + ' response section');
      }
    }
  };

  /**
   * Enhance rating buttons with proper ARIA attributes.
   * Buttons get: aria-label describing action, aria-pressed state.
   */
  ModelComparisonAccessibility.prototype.enhanceRatingButtons = function () {
    var container = this.container;

    // Base model rating buttons
    var baseThumbsUp = container.querySelector('[data-role="rating-base"] [data-action="thumbs-up"], .mc-rating-base .mc-thumbs-up');
    var baseThumbsDown = container.querySelector('[data-role="rating-base"] [data-action="thumbs-down"], .mc-rating-base .mc-thumbs-down');

    if (baseThumbsUp) {
      baseThumbsUp.setAttribute('aria-label', 'Rate ' + this.baseModelName + ' response as good');
      baseThumbsUp.setAttribute('aria-pressed', 'false');
    }
    if (baseThumbsDown) {
      baseThumbsDown.setAttribute('aria-label', 'Rate ' + this.baseModelName + ' response as poor');
      baseThumbsDown.setAttribute('aria-pressed', 'false');
    }

    // Fine-tuned model rating buttons
    var ftThumbsUp = container.querySelector('[data-role="rating-finetuned"] [data-action="thumbs-up"], .mc-rating-finetuned .mc-thumbs-up');
    var ftThumbsDown = container.querySelector('[data-role="rating-finetuned"] [data-action="thumbs-down"], .mc-rating-finetuned .mc-thumbs-down');

    if (ftThumbsUp) {
      ftThumbsUp.setAttribute('aria-label', 'Rate ' + this.fineTunedModelName + ' response as good');
      ftThumbsUp.setAttribute('aria-pressed', 'false');
    }
    if (ftThumbsDown) {
      ftThumbsDown.setAttribute('aria-label', 'Rate ' + this.fineTunedModelName + ' response as poor');
      ftThumbsDown.setAttribute('aria-pressed', 'false');
    }
  };

  // ─── Status Indicator Utilities (Req 33.4 support) ─────────────

  /**
   * Create an accessible status badge with:
   * - Color meeting 4.5:1 contrast ratio
   * - Secondary differentiator (icon + text label)
   * - ARIA label describing the status
   *
   * @param {string} state - The status state key.
   * @returns {HTMLElement} Accessible status badge element.
   */
  function createAccessibleStatusBadge(state) {
    var info = STATUS_COLORS[state] || STATUS_COLORS.cancelled;
    var badge = document.createElement('span');
    badge.className = 'training-status-badge';
    badge.setAttribute('aria-label', 'Status: ' + info.label);
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:' + info.bg + ';color:' + info.fg + ';';

    // Icon as secondary differentiator (decorative, aria-hidden)
    var icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = info.icon;
    badge.appendChild(icon);

    // Text label (not relying on color alone)
    var label = document.createElement('span');
    label.textContent = info.label;
    badge.appendChild(label);

    return badge;
  }

  /**
   * Check if two colors meet the WCAG 4.5:1 contrast ratio.
   * Uses relative luminance calculation per WCAG 2.1.
   *
   * @param {string} fg - Foreground color hex (e.g., '#60a5fa').
   * @param {string} bg - Background color hex (e.g., '#1e1e2e').
   * @returns {number} Contrast ratio.
   */
  function calculateContrastRatio(fg, bg) {
    var fgLum = getRelativeLuminance(fg);
    var bgLum = getRelativeLuminance(bg);
    var lighter = Math.max(fgLum, bgLum);
    var darker = Math.min(fgLum, bgLum);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * Calculate relative luminance of a hex color per WCAG 2.1.
   * @param {string} hex - Color in hex format (e.g., '#60a5fa').
   * @returns {number} Relative luminance value.
   */
  function getRelativeLuminance(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    var r = parseInt(hex.substring(0, 2), 16) / 255;
    var g = parseInt(hex.substring(2, 4), 16) / 255;
    var b = parseInt(hex.substring(4, 6), 16) / 255;

    r = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
    g = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
    b = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * Check if a status color meets minimum contrast against the panel background.
   * @param {string} state - Status state key.
   * @returns {boolean} True if contrast ratio >= 4.5:1.
   */
  function meetsContrastRequirement(state) {
    var info = STATUS_COLORS[state];
    if (!info) return false;
    var ratio = calculateContrastRatio(info.fg, '#1e1e2e');
    return ratio >= MIN_CONTRAST_RATIO;
  }

  // ─── Export ─────────────────────────────────────────────────────

  window.TrainingUIAccessibility = {
    TrainingLiveRegionManager: TrainingLiveRegionManager,
    ModelComparisonAccessibility: ModelComparisonAccessibility,
    generateLossCurveDescription: generateLossCurveDescription,
    generateMetricsDescription: generateMetricsDescription,
    determineTrend: determineTrend,
    createAccessibleStatusBadge: createAccessibleStatusBadge,
    calculateContrastRatio: calculateContrastRatio,
    meetsContrastRequirement: meetsContrastRequirement,
    STATUS_COLORS: STATUS_COLORS,
    STATE_ANNOUNCEMENTS: STATE_ANNOUNCEMENTS,
    MIN_CONTRAST_RATIO: MIN_CONTRAST_RATIO,
  };

})();
