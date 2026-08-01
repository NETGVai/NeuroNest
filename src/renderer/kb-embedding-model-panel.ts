// @ts-nocheck
/**
 * KBEmbeddingModelPanel — Renderer UI for embedding model selection and configuration.
 *
 * Allows users to:
 * - View the currently active embedding model and its configuration (provider, dimensions)
 * - Select from available embedding models (ONNX local, Ollama, TF-IDF fallback)
 * - See a re-embedding warning and duration estimate when changing the model
 * - Confirm the model change before proceeding
 *
 * Communicates with main process through IPC channels:
 * - kb:status           — get current KB status including active embedding model
 * - kb:config-update    — persist embedding model change
 *
 * Gated behind NEURONEST_KB_SYSTEM feature flag.
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as memory-panel.ts.
 *
 * Requirements: 31.2, 31.4
 */

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────

  /**
   * Available embedding model options.
   * Each entry describes a backend with its characteristics.
   */
  var EMBEDDING_MODELS = [
    {
      id: 'onnx-local',
      label: 'ONNX Local',
      description: 'File-based ONNX model loaded from disk. No network required.',
      modelId: 'all-MiniLM-L6-v2',
      provider: 'onnx-local',
      dimensions: 384,
      icon: '🧠',
      requiresNetwork: false,
      throughputChunksPerSec: 50,
    },
    {
      id: 'ollama',
      label: 'Ollama',
      description: 'API-based embedding via local Ollama instance. Requires running Ollama.',
      modelId: 'nomic-embed-text',
      provider: 'ollama',
      dimensions: 768,
      icon: '🦙',
      requiresNetwork: false,
      throughputChunksPerSec: 30,
    },
    {
      id: 'tfidf',
      label: 'TF-IDF Fallback',
      description: 'Lightweight term-frequency fallback. No ML model needed.',
      modelId: 'tfidf-fallback',
      provider: 'onnx-local',
      dimensions: 384,
      icon: '📊',
      requiresNetwork: false,
      throughputChunksPerSec: 200,
    },
  ];

  /**
   * Estimated re-embedding time per chunk (in milliseconds) by provider.
   */
  var RE_EMBED_MS_PER_CHUNK = {
    'onnx-local': 20,
    'ollama': 33,
    'tfidf': 5,
  };

  // ─── Helpers ─────────────────────────────────────────────────────

  function embApi() { return window.electronAPI; }

  function embEscHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function embDisableBtn(btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
  function embEnableBtn(btn) { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }

  /**
   * Format milliseconds into a human-readable duration string.
   */
  function embFormatDuration(ms) {
    if (ms < 1000) return 'less than a second';
    if (ms < 60000) return Math.ceil(ms / 1000) + ' seconds';
    if (ms < 3600000) {
      var mins = Math.ceil(ms / 60000);
      return mins + ' minute' + (mins === 1 ? '' : 's');
    }
    var hours = Math.floor(ms / 3600000);
    var remainMins = Math.ceil((ms % 3600000) / 60000);
    return hours + ' hour' + (hours === 1 ? '' : 's') + (remainMins > 0 ? ' ' + remainMins + ' min' : '');
  }

  /**
   * Estimate re-embedding duration given chunk count and target provider.
   */
  function embEstimateDuration(chunkCount, provider) {
    var msPerChunk = RE_EMBED_MS_PER_CHUNK[provider] || RE_EMBED_MS_PER_CHUNK['tfidf'];
    return chunkCount * msPerChunk;
  }

  /**
   * Get the project ID from localStorage or URL.
   */
  function embGetProjectId() {
    try {
      var stored = window.localStorage.getItem('neuronest_active_project_id');
      if (stored) return stored;
    } catch (e) { /* ignore */ }
    return 'default';
  }

  // ─── Inject Panel Styles ─────────────────────────────────────────

  var styleEl = document.createElement('style');
  styleEl.id = 'kb-embedding-panel-styles';
  styleEl.textContent = [
    '.kb-emb-panel{padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);}',
    '.kb-emb-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;}',
    '.kb-emb-title{margin:0;font-size:16px;font-weight:600;color:var(--text-primary,#cdd6f4);}',
    '.kb-emb-current{padding:12px 16px;background:var(--surface-container-high,#1e1e2e);border:1px solid var(--border-color,#313244);border-radius:8px;margin-bottom:16px;}',
    '.kb-emb-current-label{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted,#6c7086);margin-bottom:6px;}',
    '.kb-emb-current-value{font-size:14px;font-weight:500;color:var(--text-primary,#cdd6f4);display:flex;align-items:center;gap:8px;}',
    '.kb-emb-current-meta{font-size:11px;color:var(--text-secondary,#a6adc8);margin-top:4px;}',
    '.kb-emb-options{display:flex;flex-direction:column;gap:8px;margin-bottom:16px;}',
    '.kb-emb-option{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;background:var(--surface-container-high,#1e1e2e);border:2px solid var(--border-color,#313244);border-radius:8px;cursor:pointer;transition:border-color 0.15s ease,background 0.15s ease;}',
    '.kb-emb-option:hover{border-color:var(--accent,#89b4fa);background:var(--surface-container-highest,#252536);}',
    '.kb-emb-option:focus-visible{outline:2px solid var(--accent,#89b4fa);outline-offset:2px;}',
    '.kb-emb-option:focus{outline:none;}',
    '.kb-emb-option.active{border-color:var(--accent,#89b4fa);background:var(--surface-container-highest,#252536);}',
    '.kb-emb-option.selected{border-color:var(--green,#a6e3a1);background:var(--surface-container-highest,#252536);}',
    '.kb-emb-option-icon{font-size:24px;flex-shrink:0;line-height:1;}',
    '.kb-emb-option-body{flex:1;min-width:0;}',
    '.kb-emb-option-label{font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:2px;}',
    '.kb-emb-option-desc{font-size:11px;color:var(--text-secondary,#a6adc8);line-height:1.4;}',
    '.kb-emb-option-meta{font-size:10px;color:var(--text-muted,#6c7086);margin-top:4px;}',
    '.kb-emb-option-radio{width:16px;height:16px;border-radius:50%;border:2px solid var(--border-color,#313244);flex-shrink:0;margin-top:2px;display:flex;align-items:center;justify-content:center;transition:border-color 0.15s ease;}',
    '.kb-emb-option-radio.checked{border-color:var(--green,#a6e3a1);}',
    '.kb-emb-option-radio.checked::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--green,#a6e3a1);}',
    '.kb-emb-warning{padding:12px 16px;background:var(--warning-bg,#45350a);border:1px solid var(--warning-border,#f9e2af);border-radius:8px;margin-bottom:16px;display:none;}',
    '.kb-emb-warning.visible{display:block;}',
    '.kb-emb-warning-title{font-size:12px;font-weight:600;color:var(--warning-text,#f9e2af);margin-bottom:6px;display:flex;align-items:center;gap:6px;}',
    '.kb-emb-warning-body{font-size:11px;color:var(--text-secondary,#a6adc8);line-height:1.5;}',
    '.kb-emb-warning-estimate{font-size:12px;font-weight:500;color:var(--text-primary,#cdd6f4);margin-top:8px;}',
    '.kb-emb-actions{display:flex;gap:8px;align-items:center;}',
    '.kb-emb-btn{padding:8px 16px;border-radius:6px;font-size:12px;font-weight:500;border:none;cursor:pointer;transition:background 0.15s ease,opacity 0.15s ease;}',
    '.kb-emb-btn-primary{background:var(--accent,#89b4fa);color:var(--on-accent,#1e1e2e);}',
    '.kb-emb-btn-primary:hover{background:var(--accent-hover,#74a8f8);}',
    '.kb-emb-btn-secondary{background:var(--surface-container-highest,#313244);color:var(--text-primary,#cdd6f4);}',
    '.kb-emb-btn-secondary:hover{background:var(--surface-container-high,#3b3b52);}',
    '.kb-emb-section-label{font-size:12px;font-weight:600;color:var(--text-secondary,#a6adc8);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;}',
  ].join('\n');

  if (!document.getElementById('kb-embedding-panel-styles')) {
    document.head.appendChild(styleEl);
  }

  // ─── KBEmbeddingModelPanel class ─────────────────────────────────

  /**
   * Panel component for embedding model selection.
   *
   * @param {HTMLElement} container - The container element to render into
   */
  function KBEmbeddingModelPanel(container) {
    this.container = container;
    this.currentConfig = null;   // { provider, modelId, dimensions }
    this.selectedModel = null;   // Model ID of the user's new selection
    this.totalChunks = 0;        // Total chunk count for duration estimate
    this.projectId = embGetProjectId();
    this.warningEl = null;
    this.confirmBtn = null;
    this.cancelBtn = null;
    this.optionEls = [];
  }

  KBEmbeddingModelPanel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.className = 'kb-emb-panel';
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-labelledby', 'kb-emb-panel-title');

    // Header
    var header = document.createElement('div');
    header.className = 'kb-emb-header';
    var title = document.createElement('h2');
    title.className = 'kb-emb-title';
    title.textContent = 'Embedding Model';
    title.setAttribute('id', 'kb-emb-panel-title');
    header.appendChild(title);
    this.container.appendChild(header);

    // Current model display
    this.currentSection = document.createElement('div');
    this.currentSection.className = 'kb-emb-current';
    this.currentSection.setAttribute('role', 'status');
    this.currentSection.setAttribute('aria-label', 'Currently active embedding model');
    this.container.appendChild(this.currentSection);

    // Section label
    var optionsLabel = document.createElement('div');
    optionsLabel.className = 'kb-emb-section-label';
    optionsLabel.textContent = 'Available Models';
    optionsLabel.setAttribute('id', 'kb-emb-options-label');
    this.container.appendChild(optionsLabel);

    // Model options
    var optionsContainer = document.createElement('div');
    optionsContainer.className = 'kb-emb-options';
    optionsContainer.setAttribute('role', 'radiogroup');
    optionsContainer.setAttribute('aria-labelledby', 'kb-emb-options-label');
    this.optionEls = [];

    for (var i = 0; i < EMBEDDING_MODELS.length; i++) {
      var model = EMBEDDING_MODELS[i];
      var optionEl = this.createOptionElement(model, i);
      optionsContainer.appendChild(optionEl);
      this.optionEls.push({ el: optionEl, model: model });
    }

    // Arrow key navigation within radiogroup
    optionsContainer.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        self.moveFocus(1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        self.moveFocus(-1);
      }
    });

    this.container.appendChild(optionsContainer);

    // Warning section (initially hidden)
    this.warningEl = document.createElement('div');
    this.warningEl.className = 'kb-emb-warning';
    this.warningEl.setAttribute('role', 'alert');
    this.warningEl.setAttribute('aria-live', 'assertive');
    this.warningEl.setAttribute('aria-atomic', 'true');
    this.warningEl.innerHTML = [
      '<div class="kb-emb-warning-title">⚠️ Re-embedding Required</div>',
      '<div class="kb-emb-warning-body">Changing the embedding model requires all existing chunks to be re-embedded. This process runs in the background but may take some time depending on the number of chunks and the selected model.</div>',
      '<div class="kb-emb-warning-estimate" id="kb-emb-estimate"></div>',
    ].join('');
    this.container.appendChild(this.warningEl);

    // Action buttons
    var actionsRow = document.createElement('div');
    actionsRow.className = 'kb-emb-actions';

    this.confirmBtn = document.createElement('button');
    this.confirmBtn.className = 'kb-emb-btn kb-emb-btn-primary';
    this.confirmBtn.textContent = 'Confirm Change';
    this.confirmBtn.setAttribute('aria-label', 'Confirm embedding model change');
    this.confirmBtn.style.display = 'none';
    this.confirmBtn.addEventListener('click', function () { self.confirmModelChange(); });
    actionsRow.appendChild(this.confirmBtn);

    this.cancelBtn = document.createElement('button');
    this.cancelBtn.className = 'kb-emb-btn kb-emb-btn-secondary';
    this.cancelBtn.textContent = 'Cancel';
    this.cancelBtn.setAttribute('aria-label', 'Cancel embedding model change');
    this.cancelBtn.style.display = 'none';
    this.cancelBtn.addEventListener('click', function () { self.cancelSelection(); });
    actionsRow.appendChild(this.cancelBtn);

    this.container.appendChild(actionsRow);

    // Load current state
    this.loadCurrentConfig();
  };

  /**
   * Create an option element for a single embedding model.
   */
  KBEmbeddingModelPanel.prototype.createOptionElement = function (model, index) {
    var self = this;
    var el = document.createElement('div');
    el.className = 'kb-emb-option';
    el.setAttribute('role', 'radio');
    el.setAttribute('aria-checked', 'false');
    el.setAttribute('aria-label', model.label + ': ' + model.description);
    // Only the first radio in the group should be tabbable by default (roving tabindex)
    el.setAttribute('tabindex', index === 0 ? '0' : '-1');
    el.setAttribute('data-model-id', model.id);
    el.setAttribute('data-option-index', String(index));

    el.innerHTML = [
      '<div class="kb-emb-option-radio" aria-hidden="true"></div>',
      '<div class="kb-emb-option-icon" aria-hidden="true">' + model.icon + '</div>',
      '<div class="kb-emb-option-body">',
      '  <div class="kb-emb-option-label">' + embEscHtml(model.label) + '</div>',
      '  <div class="kb-emb-option-desc">' + embEscHtml(model.description) + '</div>',
      '  <div class="kb-emb-option-meta">Dimensions: ' + model.dimensions + ' | ~' + model.throughputChunksPerSec + ' chunks/sec</div>',
      '</div>',
    ].join('');

    el.addEventListener('click', function () { self.selectModel(model); });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        self.selectModel(model);
      }
    });

    return el;
  };

  /**
   * Move focus within the radiogroup by direction (+1 or -1).
   * Implements roving tabindex pattern.
   */
  KBEmbeddingModelPanel.prototype.moveFocus = function (direction) {
    var focused = document.activeElement;
    var currentIndex = -1;
    for (var i = 0; i < this.optionEls.length; i++) {
      if (this.optionEls[i].el === focused) {
        currentIndex = i;
        break;
      }
    }
    if (currentIndex === -1) currentIndex = 0;
    var nextIndex = (currentIndex + direction + this.optionEls.length) % this.optionEls.length;
    // Update tabindex (roving tabindex pattern)
    for (var j = 0; j < this.optionEls.length; j++) {
      this.optionEls[j].el.setAttribute('tabindex', j === nextIndex ? '0' : '-1');
    }
    this.optionEls[nextIndex].el.focus();
  };

  /**
   * Load the current embedding configuration from the main process.
   */
  KBEmbeddingModelPanel.prototype.loadCurrentConfig = function () {
    var self = this;
    var api = embApi();
    if (!api) return;

    api.invoke('kb:status', { projectId: this.projectId }).then(function (result) {
      if (result && result.success && result.data) {
        self.currentConfig = {
          provider: result.data.embeddingModel || 'tfidf',
          dimensions: result.data.dimensions || 384,
        };
        self.totalChunks = result.data.totalChunks || 0;
        self.updateCurrentDisplay();
        self.updateOptionStates();
      }
    }).catch(function () {
      // Fallback if IPC fails
      self.currentConfig = { provider: 'tfidf', dimensions: 384 };
      self.updateCurrentDisplay();
      self.updateOptionStates();
    });
  };

  /**
   * Update the "current model" display section.
   */
  KBEmbeddingModelPanel.prototype.updateCurrentDisplay = function () {
    if (!this.currentSection || !this.currentConfig) return;

    var provider = this.currentConfig.provider;
    var activeModel = null;

    for (var i = 0; i < EMBEDDING_MODELS.length; i++) {
      // Match by provider (map tfidf stored as 'onnx-local' with special model back to tfidf)
      if (EMBEDDING_MODELS[i].provider === provider || EMBEDDING_MODELS[i].id === provider) {
        activeModel = EMBEDDING_MODELS[i];
        break;
      }
    }

    // If provider is 'onnx-local' and no match was found specifically, check for ONNX
    if (!activeModel) {
      activeModel = EMBEDDING_MODELS[0]; // default to ONNX
    }

    this.currentSection.innerHTML = [
      '<div class="kb-emb-current-label">Active Model</div>',
      '<div class="kb-emb-current-value">',
      '  <span aria-hidden="true">' + activeModel.icon + '</span>',
      '  <span>' + embEscHtml(activeModel.label) + '</span>',
      '</div>',
      '<div class="kb-emb-current-meta">',
      '  Provider: ' + embEscHtml(provider) + ' | Dimensions: ' + this.currentConfig.dimensions + ' | Chunks: ' + this.totalChunks,
      '</div>',
    ].join('');
  };

  /**
   * Update option visual states based on current config.
   */
  KBEmbeddingModelPanel.prototype.updateOptionStates = function () {
    if (!this.currentConfig) return;

    for (var i = 0; i < this.optionEls.length; i++) {
      var entry = this.optionEls[i];
      var el = entry.el;
      var model = entry.model;
      var radio = el.querySelector('.kb-emb-option-radio');
      var isActive = this.isCurrentModel(model);

      el.classList.toggle('active', isActive);
      el.setAttribute('aria-checked', isActive ? 'true' : 'false');
      if (radio) {
        radio.classList.toggle('checked', isActive);
      }
    }
  };

  /**
   * Check if a model matches the current active config.
   */
  KBEmbeddingModelPanel.prototype.isCurrentModel = function (model) {
    if (!this.currentConfig) return false;
    var provider = this.currentConfig.provider;
    // Handle tfidf stored as onnx-local
    if (provider === 'tfidf' && model.id === 'tfidf') return true;
    if (provider === 'onnx-local' && model.id === 'onnx-local') return true;
    if (provider === 'ollama' && model.id === 'ollama') return true;
    return model.id === provider;
  };

  /**
   * Handle user selecting a new embedding model.
   * Shows warning and duration estimate if different from current.
   */
  KBEmbeddingModelPanel.prototype.selectModel = function (model) {
    // If same as current, ignore
    if (this.isCurrentModel(model)) {
      this.cancelSelection();
      return;
    }

    this.selectedModel = model;

    // Update selection visual state
    for (var i = 0; i < this.optionEls.length; i++) {
      var entry = this.optionEls[i];
      var isSelected = entry.model.id === model.id;
      var isActive = this.isCurrentModel(entry.model);
      entry.el.classList.toggle('selected', isSelected);
      entry.el.classList.toggle('active', isActive && !isSelected);
      entry.el.setAttribute('aria-checked', isSelected ? 'true' : (isActive ? 'mixed' : 'false'));
      var radio = entry.el.querySelector('.kb-emb-option-radio');
      if (radio) {
        radio.classList.toggle('checked', isSelected);
      }
    }

    // Show warning with duration estimate
    this.showReembeddingWarning(model);

    // Show action buttons
    this.confirmBtn.style.display = '';
    this.cancelBtn.style.display = '';
  };

  /**
   * Show the re-embedding warning with estimated duration.
   */
  KBEmbeddingModelPanel.prototype.showReembeddingWarning = function (model) {
    if (!this.warningEl) return;

    var estimateMs = embEstimateDuration(this.totalChunks, model.id);
    var estimateText = this.totalChunks > 0
      ? 'Estimated duration: ' + embFormatDuration(estimateMs) + ' (' + this.totalChunks + ' chunks)'
      : 'No existing chunks to re-embed.';

    var estimateEl = this.warningEl.querySelector('#kb-emb-estimate');
    if (estimateEl) {
      estimateEl.textContent = estimateText;
    }

    this.warningEl.classList.add('visible');
  };

  /**
   * Cancel the model selection, revert to showing current state.
   */
  KBEmbeddingModelPanel.prototype.cancelSelection = function () {
    this.selectedModel = null;

    // Hide warning and buttons
    if (this.warningEl) this.warningEl.classList.remove('visible');
    if (this.confirmBtn) this.confirmBtn.style.display = 'none';
    if (this.cancelBtn) this.cancelBtn.style.display = 'none';

    // Restore option states
    this.updateOptionStates();
  };

  /**
   * Confirm the embedding model change.
   * Calls kb:config-update IPC to persist the change.
   */
  KBEmbeddingModelPanel.prototype.confirmModelChange = function () {
    var self = this;
    if (!this.selectedModel) return;

    var api = embApi();
    if (!api) return;

    var model = this.selectedModel;

    // Disable buttons during request
    embDisableBtn(this.confirmBtn);
    embDisableBtn(this.cancelBtn);
    this.confirmBtn.textContent = 'Updating...';

    var configPayload = {
      projectId: this.projectId,
      config: {
        modelId: model.modelId,
        provider: model.provider,
        dimensions: model.dimensions,
      },
    };

    api.invoke('kb:config-update', configPayload).then(function (result) {
      if (result && result.success) {
        // Update current state
        self.currentConfig = {
          provider: model.id,
          dimensions: model.dimensions,
        };
        self.selectedModel = null;
        self.updateCurrentDisplay();
        self.cancelSelection();

        // Show toast if available
        if (window.wk && window.wk.toast) {
          window.wk.toast('Embedding model changed to ' + model.label, 'success');
        }
      } else {
        // Show error
        var errMsg = (result && result.error && result.error.message) || 'Failed to update embedding model';
        if (window.wk && window.wk.toast) {
          window.wk.toast(errMsg, 'error');
        }
      }
    }).catch(function (err) {
      if (window.wk && window.wk.toast) {
        window.wk.toast('Error: ' + (err.message || String(err)), 'error');
      }
    }).finally(function () {
      // Re-enable buttons
      embEnableBtn(self.confirmBtn);
      embEnableBtn(self.cancelBtn);
      self.confirmBtn.textContent = 'Confirm Change';
    });
  };

  /**
   * Destroy the panel and clean up.
   */
  KBEmbeddingModelPanel.prototype.destroy = function () {
    this.container.innerHTML = '';
    this.currentConfig = null;
    this.selectedModel = null;
    this.optionEls = [];
  };

  // ─── Export ──────────────────────────────────────────────────────

  /**
   * Factory function to render the KB embedding model panel.
   * Follows the PanelModule contract: { render(container, options), destroy() }
   */
  function renderKBEmbeddingModelPanel(container, options) {
    var panel = new KBEmbeddingModelPanel(container);
    panel.render();
    return panel;
  }

  // Expose on window for panel registry integration
  window.KBEmbeddingModelPanel = KBEmbeddingModelPanel;
  window.renderKBEmbeddingModelPanel = renderKBEmbeddingModelPanel;

})();
