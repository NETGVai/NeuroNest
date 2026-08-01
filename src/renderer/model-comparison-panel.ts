// @ts-nocheck
/**
 * ModelComparisonPanel — Side-by-side model comparison with preference rating.
 *
 * Sends the same prompt to both a base model and a fine-tuned model, displays
 * responses side-by-side, and allows thumbs-up/down rating to store preference
 * data for GRPO training use.
 *
 * IPC channels (invoked):
 *   training:compare-models — send prompt to both models via Provider_Registry
 *   training:store-preference — store preference data in grpo_preferences table
 *   training:jobs-list — list models for selection
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows existing Vanilla JS + DOM manipulation pattern (IIFE, window.electronAPI).
 *
 * Requirements: 13.1, 13.2, 13.3, 33.5
 */

(function () {
  'use strict';

  // ─── Helpers ─────────────────────────────────────────────────────

  function api() { return window.electronAPI; }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function generateId() {
    return 'pref-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ─── Inject Panel Styles ─────────────────────────────────────────

  var styleEl = document.createElement('style');
  styleEl.id = 'model-comparison-panel-styles';
  styleEl.textContent = [
    '.mc-panel{padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);color:var(--text-primary,#cdd6f4);}',
    '.mc-panel h2{margin:0 0 16px;font-size:16px;font-weight:600;}',
    '.mc-model-selectors{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;}',
    '.mc-field{display:flex;flex-direction:column;gap:4px;}',
    '.mc-field label{font-size:12px;font-weight:500;color:var(--text-secondary,#a6adc8);}',
    '.mc-field select{padding:8px 10px;border-radius:6px;border:1px solid var(--border-color,#313244);background:var(--bg-tertiary,#11111b);color:var(--text-primary,#cdd6f4);font-size:13px;outline:none;}',
    '.mc-field select:focus{border-color:var(--accent,#93bbfc);}',
    '.mc-prompt-section{margin-bottom:16px;}',
    '.mc-prompt-section label{display:block;font-size:12px;font-weight:500;color:var(--text-secondary,#a6adc8);margin-bottom:4px;}',
    '.mc-prompt-input{width:100%;min-height:80px;padding:10px;border-radius:6px;border:1px solid var(--border-color,#313244);background:var(--bg-tertiary,#11111b);color:var(--text-primary,#cdd6f4);font-size:13px;resize:vertical;box-sizing:border-box;outline:none;font-family:inherit;}',
    '.mc-prompt-input:focus{border-color:var(--accent,#93bbfc);}',
    '.mc-send-btn{padding:10px 20px;border-radius:6px;font-size:13px;font-weight:600;border:none;cursor:pointer;background:var(--accent,#93bbfc);color:var(--bg-primary,#11111b);transition:background 0.2s,opacity 0.2s;}',
    '.mc-send-btn:hover{background:var(--accent-hover,#b4d0fd);}',
    '.mc-send-btn:disabled{opacity:0.5;cursor:not-allowed;}',
  ].join('\n');
  styleEl.textContent += [
    '',
    '.mc-responses{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px;}',
    '.mc-response-card{padding:14px;border-radius:8px;background:var(--surface-container-high,#1e1e2e);border:1px solid var(--border-color,#313244);display:flex;flex-direction:column;min-height:200px;}',
    '.mc-response-card:focus-within{border-color:var(--accent,#93bbfc);}',
    '.mc-response-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border-color,#313244);}',
    '.mc-response-label{font-size:12px;font-weight:600;color:var(--text-secondary,#a6adc8);}',
    '.mc-response-model{font-size:11px;color:var(--text-muted,#6c7086);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.mc-response-body{flex:1;font-size:13px;line-height:1.5;color:var(--text-primary,#cdd6f4);white-space:pre-wrap;word-break:break-word;overflow-y:auto;max-height:300px;}',
    '.mc-response-body--empty{color:var(--text-muted,#6c7086);font-style:italic;display:flex;align-items:center;justify-content:center;}',
    '.mc-rating-section{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid var(--border-color,#313244);}',
    '.mc-rating-btn{padding:6px 12px;border-radius:4px;font-size:12px;font-weight:500;border:1px solid var(--border-color,#313244);background:var(--bg-tertiary,#11111b);color:var(--text-primary,#cdd6f4);cursor:pointer;display:inline-flex;align-items:center;gap:4px;transition:background 0.2s,border-color 0.2s;}',
    '.mc-rating-btn:hover{background:var(--surface-container,#252538);}',
    '.mc-rating-btn:focus{outline:2px solid var(--accent,#93bbfc);outline-offset:2px;}',
    '.mc-rating-btn--selected-up{background:rgba(74,222,128,0.15);border-color:var(--green,#4ade80);color:var(--green,#4ade80);}',
    '.mc-rating-btn--selected-down{background:rgba(248,113,113,0.15);border-color:var(--red,#f87171);color:var(--red,#f87171);}',
    '.mc-rating-label{font-size:11px;color:var(--text-muted,#6c7086);}',
    '.mc-status{font-size:12px;color:var(--text-muted,#6c7086);margin-top:8px;padding:8px;border-radius:4px;background:var(--bg-tertiary,#11111b);text-align:center;}',
    '.mc-status--success{color:var(--green,#4ade80);}',
    '.mc-status--error{color:var(--red,#f87171);}',
    '.mc-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:20px;color:var(--text-muted,#6c7086);font-size:12px;}',
    '.mc-spinner{width:16px;height:16px;border:2px solid var(--border-color,#313244);border-top-color:var(--accent,#93bbfc);border-radius:50%;animation:mc-spin 0.8s linear infinite;}',
    '@keyframes mc-spin{to{transform:rotate(360deg)}}',
  ].join('\n');

  if (!document.getElementById('model-comparison-panel-styles')) {
    document.head.appendChild(styleEl);
  }

  // ─── ModelComparisonPanel Class ──────────────────────────────────

  /**
   * Model Comparison Panel for side-by-side inference and rating.
   *
   * @param {HTMLElement} container - DOM container to render into.
   * @param {object} options - Panel options.
   * @param {string} options.projectId - Active project identifier.
   */
  function ModelComparisonPanel(container, options) {
    this.container = container;
    this.projectId = (options && options.projectId) || window._neuronestActiveProject || 'default';

    // State
    this.baseModel = '';
    this.fineTunedModel = '';
    this.availableModels = [];
    this.prompt = '';
    this.baseResponse = null;
    this.fineTunedResponse = null;
    this.isLoading = false;
    this.baseRating = null;   // 'up' | 'down' | null
    this.ftRating = null;     // 'up' | 'down' | null
    this.statusMessage = null;
    this.statusType = null;

    // DOM references
    this.promptInput = null;
    this.sendBtn = null;
    this.baseResponseEl = null;
    this.ftResponseEl = null;
    this.statusEl = null;
    this.liveRegion = null;
  }

  // ── Main Render ─────────────────────────────────────────────────

  ModelComparisonPanel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.className = 'mc-panel wk-scroll';
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-label', 'Model Comparison Panel');

    // ARIA live region for announcements (Req 33.5)
    this.liveRegion = document.createElement('div');
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-atomic', 'true');
    this.liveRegion.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;';
    this.container.appendChild(this.liveRegion);

    // Title
    var title = document.createElement('h2');
    title.textContent = 'Model Comparison';
    this.container.appendChild(title);

    // Model selectors
    this.modelSelectorsEl = document.createElement('div');
    this.modelSelectorsEl.className = 'mc-model-selectors';
    this.container.appendChild(this.modelSelectorsEl);

    // Prompt input section
    var promptSection = document.createElement('div');
    promptSection.className = 'mc-prompt-section';

    var promptLabel = document.createElement('label');
    promptLabel.textContent = 'Prompt';
    promptLabel.setAttribute('for', 'mc-prompt-textarea');
    promptSection.appendChild(promptLabel);

    this.promptInput = document.createElement('textarea');
    this.promptInput.id = 'mc-prompt-textarea';
    this.promptInput.className = 'mc-prompt-input';
    this.promptInput.placeholder = 'Enter a prompt to compare model responses...';
    this.promptInput.setAttribute('aria-label', 'Comparison prompt input');
    this.promptInput.addEventListener('input', function () {
      self.prompt = this.value;
    });
    this.promptInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        self.onSendPrompt();
      }
    });
    promptSection.appendChild(this.promptInput);
    this.container.appendChild(promptSection);

    // Send button
    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'mc-send-btn';
    this.sendBtn.textContent = 'Compare Responses';
    this.sendBtn.setAttribute('aria-label', 'Send prompt to both models for comparison');
    this.sendBtn.addEventListener('click', function () { self.onSendPrompt(); });
    this.container.appendChild(this.sendBtn);

    // Response cards container
    this.responsesEl = document.createElement('div');
    this.responsesEl.className = 'mc-responses';
    this.responsesEl.setAttribute('role', 'group');
    this.responsesEl.setAttribute('aria-label', 'Model responses comparison');
    this.container.appendChild(this.responsesEl);

    // Status area
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'mc-status';
    this.statusEl.style.display = 'none';
    this.statusEl.setAttribute('role', 'status');
    this.container.appendChild(this.statusEl);

    // Render initial response cards
    this._renderResponseCards();

    // Fetch available models
    this._fetchModels();
  };

  // ── Fetch Available Models ──────────────────────────────────────

  ModelComparisonPanel.prototype._fetchModels = function () {
    var self = this;
    var eapi = api();
    if (!eapi || !eapi.invoke) return;

    eapi.invoke('training:jobs-list', { projectId: self.projectId }).then(function (result) {
      if (result && result.success && result.data) {
        // Extract models from completed jobs
        var models = [];
        var jobs = result.data;
        for (var i = 0; i < jobs.length; i++) {
          if (jobs[i].state === 'completed' && jobs[i].baseModel) {
            models.push({
              value: jobs[i].baseModel,
              label: jobs[i].baseModel,
              type: 'base',
            });
            if (jobs[i].outputModelName) {
              models.push({
                value: jobs[i].outputModelName,
                label: jobs[i].outputModelName + ' (fine-tuned)',
                type: 'fine-tuned',
              });
            }
          }
        }
        // Deduplicate
        var seen = {};
        self.availableModels = models.filter(function (m) {
          if (seen[m.value]) return false;
          seen[m.value] = true;
          return true;
        });
      }

      // Add default model entries if none found
      if (self.availableModels.length === 0) {
        self.availableModels = [
          { value: 'llama-3-8b', label: 'Llama 3 8B (base)', type: 'base' },
          { value: 'mistral-7b', label: 'Mistral 7B (base)', type: 'base' },
        ];
      }

      self._renderModelSelectors();
    }).catch(function () {
      self.availableModels = [
        { value: 'llama-3-8b', label: 'Llama 3 8B (base)', type: 'base' },
        { value: 'mistral-7b', label: 'Mistral 7B (base)', type: 'base' },
      ];
      self._renderModelSelectors();
    });
  };

  // ── Render Model Selectors ─────────────────────────────────────

  ModelComparisonPanel.prototype._renderModelSelectors = function () {
    var self = this;
    if (!this.modelSelectorsEl) return;
    this.modelSelectorsEl.innerHTML = '';

    // Base model selector
    var baseField = document.createElement('div');
    baseField.className = 'mc-field';

    var baseLabel = document.createElement('label');
    baseLabel.textContent = 'Base Model';
    baseLabel.setAttribute('for', 'mc-base-model-select');
    baseField.appendChild(baseLabel);

    var baseSelect = document.createElement('select');
    baseSelect.id = 'mc-base-model-select';
    baseSelect.setAttribute('aria-label', 'Select base model for comparison');

    var baseOpt = document.createElement('option');
    baseOpt.value = '';
    baseOpt.textContent = '-- Select base model --';
    baseSelect.appendChild(baseOpt);

    for (var i = 0; i < this.availableModels.length; i++) {
      var opt = document.createElement('option');
      opt.value = this.availableModels[i].value;
      opt.textContent = this.availableModels[i].label;
      baseSelect.appendChild(opt);
    }
    baseSelect.addEventListener('change', function () {
      self.baseModel = this.value;
    });
    baseField.appendChild(baseSelect);
    this.modelSelectorsEl.appendChild(baseField);

    // Fine-tuned model selector
    var ftField = document.createElement('div');
    ftField.className = 'mc-field';

    var ftLabel = document.createElement('label');
    ftLabel.textContent = 'Fine-Tuned Model';
    ftLabel.setAttribute('for', 'mc-ft-model-select');
    ftField.appendChild(ftLabel);

    var ftSelect = document.createElement('select');
    ftSelect.id = 'mc-ft-model-select';
    ftSelect.setAttribute('aria-label', 'Select fine-tuned model for comparison');

    var ftOpt = document.createElement('option');
    ftOpt.value = '';
    ftOpt.textContent = '-- Select fine-tuned model --';
    ftSelect.appendChild(ftOpt);

    for (var j = 0; j < this.availableModels.length; j++) {
      var opt2 = document.createElement('option');
      opt2.value = this.availableModels[j].value;
      opt2.textContent = this.availableModels[j].label;
      ftSelect.appendChild(opt2);
    }
    ftSelect.addEventListener('change', function () {
      self.fineTunedModel = this.value;
    });
    ftField.appendChild(ftSelect);
    this.modelSelectorsEl.appendChild(ftField);
  };

  // ── Render Response Cards ──────────────────────────────────────

  ModelComparisonPanel.prototype._renderResponseCards = function () {
    var self = this;
    if (!this.responsesEl) return;
    this.responsesEl.innerHTML = '';

    // Base model response card
    var baseCard = document.createElement('div');
    baseCard.className = 'mc-response-card';
    baseCard.setAttribute('tabindex', '0');
    baseCard.setAttribute('role', 'article');
    baseCard.setAttribute('aria-label', 'Base model response');

    var baseHeader = document.createElement('div');
    baseHeader.className = 'mc-response-header';
    var baseTitle = document.createElement('span');
    baseTitle.className = 'mc-response-label';
    baseTitle.textContent = 'Base Model';
    baseHeader.appendChild(baseTitle);
    var baseModelName = document.createElement('span');
    baseModelName.className = 'mc-response-model';
    baseModelName.textContent = this.baseModel || 'Not selected';
    baseModelName.setAttribute('aria-label', 'Model: ' + (this.baseModel || 'Not selected'));
    baseHeader.appendChild(baseModelName);
    baseCard.appendChild(baseHeader);

    this.baseResponseEl = document.createElement('div');
    this.baseResponseEl.className = 'mc-response-body' + (this.baseResponse ? '' : ' mc-response-body--empty');
    this.baseResponseEl.setAttribute('aria-label', 'Base model response content');
    this.baseResponseEl.setAttribute('tabindex', '0');
    if (this.isLoading && !this.baseResponse) {
      this.baseResponseEl.innerHTML = '<div class="mc-loading"><div class="mc-spinner"></div>Generating...</div>';
    } else {
      this.baseResponseEl.textContent = this.baseResponse || 'Response will appear here...';
    }
    baseCard.appendChild(this.baseResponseEl);

    // Base model rating buttons
    var baseRating = this._createRatingSection('base');
    baseCard.appendChild(baseRating);
    this.responsesEl.appendChild(baseCard);

    // Fine-tuned model response card
    var ftCard = document.createElement('div');
    ftCard.className = 'mc-response-card';
    ftCard.setAttribute('tabindex', '0');
    ftCard.setAttribute('role', 'article');
    ftCard.setAttribute('aria-label', 'Fine-tuned model response');

    var ftHeader = document.createElement('div');
    ftHeader.className = 'mc-response-header';
    var ftTitle = document.createElement('span');
    ftTitle.className = 'mc-response-label';
    ftTitle.textContent = 'Fine-Tuned Model';
    ftHeader.appendChild(ftTitle);
    var ftModelName = document.createElement('span');
    ftModelName.className = 'mc-response-model';
    ftModelName.textContent = this.fineTunedModel || 'Not selected';
    ftModelName.setAttribute('aria-label', 'Model: ' + (this.fineTunedModel || 'Not selected'));
    ftHeader.appendChild(ftModelName);
    ftCard.appendChild(ftHeader);

    this.ftResponseEl = document.createElement('div');
    this.ftResponseEl.className = 'mc-response-body' + (this.fineTunedResponse ? '' : ' mc-response-body--empty');
    this.ftResponseEl.setAttribute('aria-label', 'Fine-tuned model response content');
    this.ftResponseEl.setAttribute('tabindex', '0');
    if (this.isLoading && !this.fineTunedResponse) {
      this.ftResponseEl.innerHTML = '<div class="mc-loading"><div class="mc-spinner"></div>Generating...</div>';
    } else {
      this.ftResponseEl.textContent = this.fineTunedResponse || 'Response will appear here...';
    }
    ftCard.appendChild(this.ftResponseEl);

    // Fine-tuned model rating buttons
    var ftRating = this._createRatingSection('ft');
    ftCard.appendChild(ftRating);
    this.responsesEl.appendChild(ftCard);
  };

  // ── Rating Section ─────────────────────────────────────────────

  /**
   * Create rating buttons for a model response.
   * @param {string} side - 'base' or 'ft'
   */
  ModelComparisonPanel.prototype._createRatingSection = function (side) {
    var self = this;
    var section = document.createElement('div');
    section.className = 'mc-rating-section';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', (side === 'base' ? 'Base' : 'Fine-tuned') + ' model response rating');

    var label = document.createElement('span');
    label.className = 'mc-rating-label';
    label.textContent = 'Rate:';
    section.appendChild(label);

    // Thumbs up button
    var upBtn = document.createElement('button');
    upBtn.className = 'mc-rating-btn';
    var currentRating = (side === 'base') ? this.baseRating : this.ftRating;
    if (currentRating === 'up') upBtn.className += ' mc-rating-btn--selected-up';
    upBtn.innerHTML = '\uD83D\uDC4D <span>Better</span>';
    upBtn.setAttribute('aria-label', 'Thumbs up - this response is better');
    upBtn.setAttribute('aria-pressed', currentRating === 'up' ? 'true' : 'false');
    upBtn.addEventListener('click', function () { self._onRate(side, 'up'); });
    section.appendChild(upBtn);

    // Thumbs down button
    var downBtn = document.createElement('button');
    downBtn.className = 'mc-rating-btn';
    if (currentRating === 'down') downBtn.className += ' mc-rating-btn--selected-down';
    downBtn.innerHTML = '\uD83D\uDC4E <span>Worse</span>';
    downBtn.setAttribute('aria-label', 'Thumbs down - this response is worse');
    downBtn.setAttribute('aria-pressed', currentRating === 'down' ? 'true' : 'false');
    downBtn.addEventListener('click', function () { self._onRate(side, 'down'); });
    section.appendChild(downBtn);

    return section;
  };

  // ── Send Prompt ─────────────────────────────────────────────────

  /**
   * Send the current prompt to both models via Provider_Registry.
   * Routes inference via IPC channel training:compare-models (Req 13.2).
   */
  ModelComparisonPanel.prototype.onSendPrompt = function () {
    var self = this;
    var eapi = api();
    if (!eapi || !eapi.invoke) return;

    // Validate inputs
    if (!this.prompt || this.prompt.trim() === '') {
      this._showStatus('Please enter a prompt.', 'error');
      return;
    }
    if (!this.baseModel) {
      this._showStatus('Please select a base model.', 'error');
      return;
    }
    if (!this.fineTunedModel) {
      this._showStatus('Please select a fine-tuned model.', 'error');
      return;
    }

    // Reset state
    this.baseResponse = null;
    this.fineTunedResponse = null;
    this.baseRating = null;
    this.ftRating = null;
    this.isLoading = true;
    this.sendBtn.disabled = true;
    this.sendBtn.textContent = 'Comparing...';
    this._renderResponseCards();
    this._hideStatus();

    // Announce to screen readers
    if (this.liveRegion) {
      this.liveRegion.textContent = 'Sending prompt to both models for comparison...';
    }

    // Send same prompt to both models simultaneously via Provider_Registry
    var payload = {
      prompt: this.prompt.trim(),
      baseModel: this.baseModel,
      fineTunedModel: this.fineTunedModel,
      projectId: this.projectId,
    };

    eapi.invoke('training:compare-models', payload).then(function (result) {
      self.isLoading = false;
      self.sendBtn.disabled = false;
      self.sendBtn.textContent = 'Compare Responses';

      if (result && result.success && result.data) {
        self.baseResponse = result.data.baseResponse || '(No response)';
        self.fineTunedResponse = result.data.fineTunedResponse || '(No response)';
        self._renderResponseCards();

        if (self.liveRegion) {
          self.liveRegion.textContent = 'Both model responses received. Use tab to navigate between responses and rate them.';
        }
      } else {
        var msg = (result && result.error && result.error.message) || 'Failed to get model responses';
        self._showStatus(msg, 'error');
        self._renderResponseCards();
        if (self.liveRegion) {
          self.liveRegion.textContent = 'Error: ' + msg;
        }
      }
    }).catch(function (err) {
      self.isLoading = false;
      self.sendBtn.disabled = false;
      self.sendBtn.textContent = 'Compare Responses';
      self._showStatus('Error: ' + (err.message || err), 'error');
      self._renderResponseCards();
    });
  };

  // ── Rating Handler ─────────────────────────────────────────────

  /**
   * Handle thumbs-up/down rating for a model response.
   * Stores preference data in grpo_preferences table for GRPO training (Req 13.3).
   *
   * @param {string} side - 'base' or 'ft'
   * @param {string} rating - 'up' or 'down'
   */
  ModelComparisonPanel.prototype._onRate = function (side, rating) {
    var self = this;
    var eapi = api();
    if (!eapi || !eapi.invoke) return;

    // Can't rate if no responses yet
    if (!this.baseResponse || !this.fineTunedResponse) {
      this._showStatus('Generate responses before rating.', 'error');
      return;
    }

    // Toggle rating (click same button again to deselect)
    var currentRating = (side === 'base') ? this.baseRating : this.ftRating;
    var newRating = (currentRating === rating) ? null : rating;

    if (side === 'base') {
      this.baseRating = newRating;
    } else {
      this.ftRating = newRating;
    }

    // Re-render response cards to update button states
    this._renderResponseCards();

    // If we now have a preference (one rated up, other rated down, or explicit preference)
    // store the preference data
    if (newRating) {
      var chosenResponse, rejectedResponse;

      if (side === 'base' && newRating === 'up') {
        chosenResponse = this.baseResponse;
        rejectedResponse = this.fineTunedResponse;
      } else if (side === 'base' && newRating === 'down') {
        chosenResponse = this.fineTunedResponse;
        rejectedResponse = this.baseResponse;
      } else if (side === 'ft' && newRating === 'up') {
        chosenResponse = this.fineTunedResponse;
        rejectedResponse = this.baseResponse;
      } else if (side === 'ft' && newRating === 'down') {
        chosenResponse = this.baseResponse;
        rejectedResponse = this.fineTunedResponse;
      }

      if (chosenResponse && rejectedResponse) {
        var preferenceData = {
          id: generateId(),
          projectId: this.projectId,
          prompt: this.prompt.trim(),
          chosenResponse: chosenResponse,
          rejectedResponse: rejectedResponse,
          source: 'comparison-panel',
        };

        eapi.invoke('training:store-preference', preferenceData).then(function (result) {
          if (result && result.success) {
            self._showStatus('Preference saved for GRPO training.', 'success');
            if (self.liveRegion) {
              self.liveRegion.textContent = 'Preference rating saved successfully.';
            }
          } else {
            var msg = (result && result.error && result.error.message) || 'Failed to save preference';
            self._showStatus(msg, 'error');
          }
        }).catch(function (err) {
          self._showStatus('Error saving preference: ' + (err.message || err), 'error');
        });
      }
    }
  };

  // ── Status Display ─────────────────────────────────────────────

  ModelComparisonPanel.prototype._showStatus = function (message, type) {
    if (!this.statusEl) return;
    this.statusEl.textContent = message;
    this.statusEl.className = 'mc-status' + (type === 'success' ? ' mc-status--success' : type === 'error' ? ' mc-status--error' : '');
    this.statusEl.style.display = 'block';
  };

  ModelComparisonPanel.prototype._hideStatus = function () {
    if (!this.statusEl) return;
    this.statusEl.style.display = 'none';
  };

  // ── Cleanup ─────────────────────────────────────────────────────

  ModelComparisonPanel.prototype.destroy = function () {
    if (this.container) {
      this.container.innerHTML = '';
    }
  };

  // ── Expose on window ────────────────────────────────────────────

  window.ModelComparisonPanel = ModelComparisonPanel;
})();
