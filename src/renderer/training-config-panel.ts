// @ts-nocheck
/**
 * TrainingConfigPanel — Training Configuration UI Panel.
 *
 * Provides a configuration interface for setting up training jobs:
 * - Selection of base model, training method, dataset, target hardware
 * - Hyperparameter controls with sensible defaults based on model + hardware
 * - Real-time validation with warnings for problematic configurations
 * - Estimated training time, VRAM requirement, and disk space display
 *
 * IPC channels used:
 * - training:config-get      — get default config for project
 * - training:config-validate — validate hyperparameters
 * - training:hardware-detect — detect hardware capabilities
 * - training:job-start       — start a training job
 *
 * Uses window.electronAPI.invoke(channel, args) for IPC.
 * Follows existing Vanilla JS + DOM manipulation pattern.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 21.1, 21.2
 */

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────

  var TRAINING_METHODS = [
    { value: 'lora', label: 'LoRA', description: 'Low-Rank Adaptation — memory efficient, fast' },
    { value: 'qlora', label: 'QLoRA', description: 'Quantized LoRA — lowest memory usage' },
    { value: 'full-finetune', label: 'Full Fine-Tune', description: 'All parameters — best quality, high memory' },
  ];

  var DATASET_FORMATS = [
    { value: 'instruction', label: 'Instruction Tuning' },
    { value: 'chat', label: 'Chat (Multi-turn)' },
    { value: 'continued-pretraining', label: 'Continued Pre-training' },
    { value: 'grpo', label: 'GRPO (Preference Pairs)' },
  ];

  /** Default hyperparameter ranges for validation */
  var HYPERPARAM_RANGES = {
    learningRate: { min: 1e-7, max: 1e-1, default: 2e-4, warnMin: 1e-6, warnMax: 1e-2, label: 'Learning Rate', step: 'any' },
    batchSize: { min: 1, max: 128, default: 4, warnMax: 64, label: 'Batch Size', step: 1 },
    epochs: { min: 1, max: 100, default: 3, warnMax: 20, label: 'Epochs', step: 1 },
    loraRank: { min: 1, max: 256, default: 16, warnMax: 128, label: 'LoRA Rank', step: 1 },
    loraAlpha: { min: 1, max: 512, default: 32, label: 'LoRA Alpha', step: 1 },
    warmupSteps: { min: 0, max: 1000, default: 10, label: 'Warmup Steps', step: 1 },
    weightDecay: { min: 0, max: 1, default: 0.01, label: 'Weight Decay', step: 0.001 },
    gradientAccumulationSteps: { min: 1, max: 64, default: 4, label: 'Gradient Accumulation', step: 1 },
  };

  /** Common base models for selection */
  var BASE_MODELS = [
    { value: 'unsloth/llama-3-8b-bnb-4bit', label: 'Llama 3 8B (4-bit)', size: 8e9 },
    { value: 'unsloth/mistral-7b-v0.3-bnb-4bit', label: 'Mistral 7B v0.3 (4-bit)', size: 7e9 },
    { value: 'unsloth/gemma-2-9b-bnb-4bit', label: 'Gemma 2 9B (4-bit)', size: 9e9 },
    { value: 'unsloth/phi-3-mini-4k-instruct-bnb-4bit', label: 'Phi-3 Mini 4K (4-bit)', size: 3.8e9 },
    { value: 'unsloth/qwen2-7b-bnb-4bit', label: 'Qwen2 7B (4-bit)', size: 7e9 },
    { value: 'unsloth/codellama-13b-bnb-4bit', label: 'CodeLlama 13B (4-bit)', size: 13e9 },
    { value: 'custom', label: 'Custom Model Path...', size: 7e9 },
  ];

  // ─── Helpers ─────────────────────────────────────────────────────

  function api() { return window.electronAPI; }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function formatDuration(ms) {
    if (ms < 1000) return '< 1s';
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
    return Math.round(ms / 3600000) + 'h ' + Math.round((ms % 3600000) / 60000) + 'm';
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    var val = bytes;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function formatNumber(n) {
    if (n == null) return '—';
    return n.toLocaleString();
  }

  function disableBtn(btn) { btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
  function enableBtn(btn) { btn.disabled = false; btn.setAttribute('aria-disabled', 'false'); btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }

  // ─── Styles ──────────────────────────────────────────────────────

  var styleEl = document.createElement('style');
  styleEl.id = 'training-config-panel-styles';
  styleEl.textContent = [
    '.tc-panel{padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);color:var(--text-primary,#cdd6f4);}',
    '.tc-panel h2{margin:0 0 16px;font-size:16px;font-weight:600;color:var(--text-primary,#cdd6f4);}',
    '.tc-section{margin-bottom:20px;padding:12px;border-radius:8px;background:var(--bg-secondary,#1e1e2e);border:1px solid var(--border-color,#313244);}',
    '.tc-section__title{font-size:13px;font-weight:600;margin:0 0 12px;color:var(--text-secondary,#a6adc8);}',
    '.tc-field{margin-bottom:12px;}',
    '.tc-field:last-child{margin-bottom:0;}',
    '.tc-field label{display:block;font-size:12px;font-weight:500;margin-bottom:4px;color:var(--text-secondary,#a6adc8);}',
    '.tc-field select,.tc-field input{width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border-color,#313244);background:var(--bg-tertiary,#11111b);color:var(--text-primary,#cdd6f4);font-size:13px;box-sizing:border-box;outline:none;transition:border-color 0.2s;}',
    '.tc-field select:focus,.tc-field input:focus{border-color:var(--accent,#93bbfc);}',
    '.tc-field input[type="number"]{font-family:monospace;}',
    '.tc-field__desc{font-size:11px;color:var(--text-muted,#6c7086);margin-top:2px;}',
    '.tc-field__warn{font-size:11px;color:var(--yellow,#fbbf24);margin-top:4px;display:flex;align-items:center;gap:4px;}',
    '.tc-field__error{font-size:11px;color:var(--red,#f87171);margin-top:4px;display:flex;align-items:center;gap:4px;}',
    '.tc-estimates{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;}',
    '.tc-estimate-card{padding:10px;border-radius:6px;background:var(--bg-tertiary,#11111b);border:1px solid var(--border-color,#313244);text-align:center;}',
    '.tc-estimate-card__value{font-size:16px;font-weight:700;color:var(--accent,#93bbfc);font-family:monospace;}',
    '.tc-estimate-card__label{font-size:11px;color:var(--text-muted,#6c7086);margin-top:2px;}',
    '.tc-hardware-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;background:var(--bg-tertiary,#11111b);border:1px solid var(--border-color,#313244);font-size:12px;}',
    '.tc-hardware-badge__icon{font-size:14px;}',
    '.tc-hardware-badge__name{font-weight:500;color:var(--text-primary,#cdd6f4);}',
    '.tc-hardware-badge__mem{color:var(--text-muted,#6c7086);}',
    '.tc-btn{padding:10px 16px;border-radius:6px;font-size:13px;font-weight:600;border:none;cursor:pointer;transition:background 0.2s,opacity 0.2s;width:100%;}',
    '.tc-btn--primary{background:var(--accent,#93bbfc);color:var(--bg-primary,#11111b);}',
    '.tc-btn--primary:hover{background:var(--accent-hover,#b4d0fd);}',
    '.tc-btn--secondary{background:var(--bg-tertiary,#313244);color:var(--text-primary,#cdd6f4);}',
    '.tc-btn--secondary:hover{background:var(--border-color,#45475a);}',
    '.tc-warnings{margin-top:12px;padding:10px;border-radius:6px;background:var(--yellow-container,rgba(251,191,36,0.1));border:1px solid var(--yellow,#fbbf24);}',
    '.tc-warnings__title{font-size:12px;font-weight:600;color:var(--yellow,#fbbf24);margin-bottom:6px;display:flex;align-items:center;gap:4px;}',
    '.tc-warnings__list{margin:0;padding:0 0 0 16px;font-size:11px;color:var(--text-secondary,#a6adc8);}',
    '.tc-warnings__list li{margin-bottom:4px;}',
    '.tc-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
    '.tc-method-card{padding:10px;border-radius:6px;border:2px solid var(--border-color,#313244);cursor:pointer;transition:border-color 0.2s,background 0.2s;}',
    '.tc-method-card:hover{background:var(--bg-tertiary,#11111b);}',
    '.tc-method-card--selected{border-color:var(--accent,#93bbfc);background:rgba(147,187,252,0.05);}',
    '.tc-method-card__name{font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);}',
    '.tc-method-card__desc{font-size:11px;color:var(--text-muted,#6c7086);margin-top:2px;}',
    '.tc-refresh-btn{background:none;border:none;color:var(--accent,#93bbfc);cursor:pointer;font-size:12px;padding:2px 6px;border-radius:4px;}',
    '.tc-refresh-btn:hover{background:rgba(147,187,252,0.1);}',
  ].join('\n');
  if (!document.getElementById('training-config-panel-styles')) {
    document.head.appendChild(styleEl);
  }

  // ─── TrainingConfigPanel Class ───────────────────────────────────

  /**
   * Training Configuration UI Panel.
   *
   * @param {HTMLElement} container - The DOM container to render into.
   */
  function TrainingConfigPanel(container) {
    this.container = container;
    this.hardware = null;
    this.config = {
      baseModel: BASE_MODELS[0].value,
      method: 'lora',
      datasetPath: '',
      datasetFormat: 'instruction',
      hyperparameters: {
        learningRate: HYPERPARAM_RANGES.learningRate.default,
        batchSize: HYPERPARAM_RANGES.batchSize.default,
        epochs: HYPERPARAM_RANGES.epochs.default,
        loraRank: HYPERPARAM_RANGES.loraRank.default,
        loraAlpha: HYPERPARAM_RANGES.loraAlpha.default,
        warmupSteps: HYPERPARAM_RANGES.warmupSteps.default,
        weightDecay: HYPERPARAM_RANGES.weightDecay.default,
        gradientAccumulationSteps: HYPERPARAM_RANGES.gradientAccumulationSteps.default,
      },
    };
    this.warnings = [];
    this.validationDebounce = null;
  }

  /**
   * Render the configuration panel.
   */
  TrainingConfigPanel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.className = 'tc-panel';
    this.container.setAttribute('role', 'form');
    this.container.setAttribute('aria-label', 'Training Configuration');

    // Title
    var title = document.createElement('h2');
    title.textContent = 'Training Configuration';
    this.container.appendChild(title);

    // Load hardware info and defaults
    this.loadDefaults();

    // Hardware section
    this.hardwareSection = this.renderHardwareSection();
    this.container.appendChild(this.hardwareSection);

    // Model selection section
    this.container.appendChild(this.renderModelSection());

    // Training method section
    this.container.appendChild(this.renderMethodSection());

    // Dataset section
    this.container.appendChild(this.renderDatasetSection());

    // Hyperparameters section
    this.hyperparamsSection = this.renderHyperparamsSection();
    this.container.appendChild(this.hyperparamsSection);

    // Warnings area
    this.warningsEl = document.createElement('div');
    this.warningsEl.id = 'tc-warnings-area';
    this.warningsEl.setAttribute('aria-live', 'polite');
    this.container.appendChild(this.warningsEl);

    // Estimates section
    this.estimatesSection = this.renderEstimatesSection();
    this.container.appendChild(this.estimatesSection);

    // Start training button
    var btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'margin-top:16px;';
    this.startBtn = document.createElement('button');
    this.startBtn.className = 'tc-btn tc-btn--primary';
    this.startBtn.textContent = 'Start Training';
    this.startBtn.setAttribute('aria-label', 'Start training job with current configuration');
    this.startBtn.addEventListener('click', function () { self.onStartTraining(); });
    btnContainer.appendChild(this.startBtn);
    this.container.appendChild(btnContainer);
  };

  /**
   * Load default configuration from main process (hardware-aware defaults).
   */
  TrainingConfigPanel.prototype.loadDefaults = function () {
    var self = this;
    var eapi = api();
    if (!eapi) return;

    // Detect hardware
    eapi.invoke('training:hardware-detect', { force: false }).then(function (result) {
      if (result && result.success && result.data) {
        self.hardware = result.data;
        self.updateHardwareDisplay();
        self.updateEstimates();
      }
    }).catch(function () {});

    // Get default config
    eapi.invoke('training:config-get', { projectId: 'current' }).then(function (result) {
      if (result && result.success && result.data) {
        var defaults = result.data;
        if (defaults.hyperparameters) {
          self.config.hyperparameters = Object.assign({}, self.config.hyperparameters, defaults.hyperparameters);
          self.updateHyperparamInputs();
        }
        if (defaults.hardware) {
          self.hardware = defaults.hardware;
          self.updateHardwareDisplay();
        }
        self.updateEstimates();
      }
    }).catch(function () {});
  };

  // ─── Section Renderers ────────────────────────────────────────────

  /**
   * Render the hardware detection section.
   */
  TrainingConfigPanel.prototype.renderHardwareSection = function () {
    var self = this;
    var section = document.createElement('div');
    section.className = 'tc-section';
    section.setAttribute('aria-label', 'Detected Hardware');

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    var titleEl = document.createElement('h3');
    titleEl.className = 'tc-section__title';
    titleEl.textContent = 'Target Hardware';
    header.appendChild(titleEl);

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'tc-refresh-btn';
    refreshBtn.textContent = 'Re-detect';
    refreshBtn.setAttribute('aria-label', 'Re-detect hardware capabilities');
    refreshBtn.addEventListener('click', function () {
      var eapi = api();
      if (!eapi) return;
      eapi.invoke('training:hardware-detect', { force: true }).then(function (result) {
        if (result && result.success && result.data) {
          self.hardware = result.data;
          self.updateHardwareDisplay();
          self.updateEstimates();
        }
      }).catch(function () {});
    });
    header.appendChild(refreshBtn);
    section.appendChild(header);

    this.hardwareBadgeEl = document.createElement('div');
    this.hardwareBadgeEl.className = 'tc-hardware-badge';
    this.hardwareBadgeEl.innerHTML = '<span class="tc-hardware-badge__icon">⏳</span><span class="tc-hardware-badge__name">Detecting...</span>';
    section.appendChild(this.hardwareBadgeEl);

    return section;
  };

  /**
   * Render the base model selection section.
   */
  TrainingConfigPanel.prototype.renderModelSection = function () {
    var self = this;
    var section = document.createElement('div');
    section.className = 'tc-section';

    var titleEl = document.createElement('h3');
    titleEl.className = 'tc-section__title';
    titleEl.textContent = 'Base Model';
    section.appendChild(titleEl);

    var field = document.createElement('div');
    field.className = 'tc-field';

    var label = document.createElement('label');
    label.textContent = 'Select base model';
    label.setAttribute('for', 'tc-model-select');
    field.appendChild(label);

    var select = document.createElement('select');
    select.id = 'tc-model-select';
    select.setAttribute('aria-label', 'Base model selection');
    for (var i = 0; i < BASE_MODELS.length; i++) {
      var opt = document.createElement('option');
      opt.value = BASE_MODELS[i].value;
      opt.textContent = BASE_MODELS[i].label;
      if (BASE_MODELS[i].value === self.config.baseModel) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', function () {
      self.config.baseModel = this.value;
      self.customModelField.style.display = this.value === 'custom' ? 'block' : 'none';
      self.updateEstimates();
    });
    field.appendChild(select);
    section.appendChild(field);

    // Custom model path input (hidden unless "custom" selected)
    this.customModelField = document.createElement('div');
    this.customModelField.className = 'tc-field';
    this.customModelField.style.display = 'none';
    var customLabel = document.createElement('label');
    customLabel.textContent = 'Custom model path or HuggingFace ID';
    customLabel.setAttribute('for', 'tc-custom-model');
    this.customModelField.appendChild(customLabel);
    var customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.id = 'tc-custom-model';
    customInput.placeholder = 'e.g., meta-llama/Llama-3-8B';
    customInput.setAttribute('aria-label', 'Custom model path');
    customInput.addEventListener('input', function () {
      self.config.baseModel = this.value || 'custom';
    });
    this.customModelField.appendChild(customInput);
    section.appendChild(this.customModelField);

    return section;
  };

  /**
   * Render the training method selection section.
   */
  TrainingConfigPanel.prototype.renderMethodSection = function () {
    var self = this;
    var section = document.createElement('div');
    section.className = 'tc-section';

    var titleEl = document.createElement('h3');
    titleEl.className = 'tc-section__title';
    titleEl.textContent = 'Training Method';
    section.appendChild(titleEl);

    var grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;';
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', 'Training method selection');

    this.methodCards = [];
    for (var i = 0; i < TRAINING_METHODS.length; i++) {
      (function (method, index) {
        var card = document.createElement('div');
        card.className = 'tc-method-card' + (self.config.method === method.value ? ' tc-method-card--selected' : '');
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-checked', self.config.method === method.value ? 'true' : 'false');
        card.setAttribute('aria-label', method.label + ': ' + method.description);
        card.setAttribute('tabindex', '0');

        var name = document.createElement('div');
        name.className = 'tc-method-card__name';
        name.textContent = method.label;
        card.appendChild(name);

        var desc = document.createElement('div');
        desc.className = 'tc-method-card__desc';
        desc.textContent = method.description;
        card.appendChild(desc);

        card.addEventListener('click', function () { self.selectMethod(method.value); });
        card.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); self.selectMethod(method.value); }
        });

        grid.appendChild(card);
        self.methodCards.push({ el: card, value: method.value });
      })(TRAINING_METHODS[i], i);
    }

    section.appendChild(grid);
    return section;
  };

  /**
   * Select a training method and update the UI.
   */
  TrainingConfigPanel.prototype.selectMethod = function (method) {
    this.config.method = method;
    for (var i = 0; i < this.methodCards.length; i++) {
      var card = this.methodCards[i];
      if (card.value === method) {
        card.el.classList.add('tc-method-card--selected');
        card.el.setAttribute('aria-checked', 'true');
      } else {
        card.el.classList.remove('tc-method-card--selected');
        card.el.setAttribute('aria-checked', 'false');
      }
    }
    // Show/hide LoRA-specific params
    this.updateLoraFieldsVisibility();
    this.validateAndUpdateWarnings();
    this.updateEstimates();
  };

  /**
   * Render the dataset selection section.
   */
  TrainingConfigPanel.prototype.renderDatasetSection = function () {
    var self = this;
    var section = document.createElement('div');
    section.className = 'tc-section';

    var titleEl = document.createElement('h3');
    titleEl.className = 'tc-section__title';
    titleEl.textContent = 'Dataset';
    section.appendChild(titleEl);

    var row = document.createElement('div');
    row.className = 'tc-row';

    // Dataset format
    var formatField = document.createElement('div');
    formatField.className = 'tc-field';
    var formatLabel = document.createElement('label');
    formatLabel.textContent = 'Format';
    formatLabel.setAttribute('for', 'tc-dataset-format');
    formatField.appendChild(formatLabel);

    var formatSelect = document.createElement('select');
    formatSelect.id = 'tc-dataset-format';
    formatSelect.setAttribute('aria-label', 'Dataset format');
    for (var i = 0; i < DATASET_FORMATS.length; i++) {
      var opt = document.createElement('option');
      opt.value = DATASET_FORMATS[i].value;
      opt.textContent = DATASET_FORMATS[i].label;
      if (DATASET_FORMATS[i].value === self.config.datasetFormat) opt.selected = true;
      formatSelect.appendChild(opt);
    }
    formatSelect.addEventListener('change', function () {
      self.config.datasetFormat = this.value;
    });
    formatField.appendChild(formatSelect);
    row.appendChild(formatField);
    section.appendChild(row);

    // Dataset path
    var pathField = document.createElement('div');
    pathField.className = 'tc-field';
    var pathLabel = document.createElement('label');
    pathLabel.textContent = 'Dataset path (JSONL, JSON, or CSV)';
    pathLabel.setAttribute('for', 'tc-dataset-path');
    pathField.appendChild(pathLabel);

    var pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.id = 'tc-dataset-path';
    pathInput.placeholder = '/path/to/training-data.jsonl';
    pathInput.setAttribute('aria-label', 'Dataset file path');
    pathInput.addEventListener('input', function () {
      self.config.datasetPath = this.value;
    });
    pathField.appendChild(pathInput);
    section.appendChild(pathField);

    return section;
  };

  /**
   * Render the hyperparameters section with inputs for all configurable values.
   */
  TrainingConfigPanel.prototype.renderHyperparamsSection = function () {
    var self = this;
    var section = document.createElement('div');
    section.className = 'tc-section';

    var titleEl = document.createElement('h3');
    titleEl.className = 'tc-section__title';
    titleEl.textContent = 'Hyperparameters';
    section.appendChild(titleEl);

    // Row 1: Learning Rate + Batch Size
    var row1 = document.createElement('div');
    row1.className = 'tc-row';
    row1.appendChild(this.createHyperparamField('learningRate'));
    row1.appendChild(this.createHyperparamField('batchSize'));
    section.appendChild(row1);

    // Row 2: Epochs + Gradient Accumulation
    var row2 = document.createElement('div');
    row2.className = 'tc-row';
    row2.appendChild(this.createHyperparamField('epochs'));
    row2.appendChild(this.createHyperparamField('gradientAccumulationSteps'));
    section.appendChild(row2);

    // Row 3: LoRA Rank + LoRA Alpha (only for LoRA/QLoRA)
    this.loraRow = document.createElement('div');
    this.loraRow.className = 'tc-row';
    this.loraRow.appendChild(this.createHyperparamField('loraRank'));
    this.loraRow.appendChild(this.createHyperparamField('loraAlpha'));
    section.appendChild(this.loraRow);

    // Row 4: Warmup Steps + Weight Decay
    var row4 = document.createElement('div');
    row4.className = 'tc-row';
    row4.appendChild(this.createHyperparamField('warmupSteps'));
    row4.appendChild(this.createHyperparamField('weightDecay'));
    section.appendChild(row4);

    this.updateLoraFieldsVisibility();
    return section;
  };

  /**
   * Create a hyperparameter input field with label, input, and validation feedback.
   */
  TrainingConfigPanel.prototype.createHyperparamField = function (paramKey) {
    var self = this;
    var range = HYPERPARAM_RANGES[paramKey];
    var field = document.createElement('div');
    field.className = 'tc-field';
    field.setAttribute('data-param', paramKey);

    var label = document.createElement('label');
    label.textContent = range.label;
    label.setAttribute('for', 'tc-hp-' + paramKey);
    field.appendChild(label);

    var input = document.createElement('input');
    input.type = 'number';
    input.id = 'tc-hp-' + paramKey;
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.value = String(self.config.hyperparameters[paramKey]);
    input.setAttribute('aria-label', range.label);
    input.setAttribute('aria-describedby', 'tc-hp-desc-' + paramKey);

    input.addEventListener('input', function () {
      var val = parseFloat(this.value);
      if (!isNaN(val)) {
        self.config.hyperparameters[paramKey] = val;
        self.debouncedValidate();
        self.updateEstimates();
      }
    });
    field.appendChild(input);

    // Description text
    var desc = document.createElement('div');
    desc.className = 'tc-field__desc';
    desc.id = 'tc-hp-desc-' + paramKey;
    desc.textContent = 'Range: ' + range.min + ' – ' + range.max + ' (default: ' + range.default + ')';
    field.appendChild(desc);

    // Warning/error feedback slot
    var feedback = document.createElement('div');
    feedback.className = 'tc-field__warn';
    feedback.id = 'tc-hp-feedback-' + paramKey;
    feedback.style.display = 'none';
    feedback.setAttribute('role', 'alert');
    field.appendChild(feedback);

    return field;
  };

  /**
   * Render the resource estimates section.
   */
  TrainingConfigPanel.prototype.renderEstimatesSection = function () {
    var section = document.createElement('div');
    section.className = 'tc-section';
    section.setAttribute('aria-label', 'Training resource estimates');

    var titleEl = document.createElement('h3');
    titleEl.className = 'tc-section__title';
    titleEl.textContent = 'Estimated Resources';
    section.appendChild(titleEl);

    var grid = document.createElement('div');
    grid.className = 'tc-estimates';

    // Training time estimate
    this.estTimeEl = this.createEstimateCard('Training Time', '—');
    grid.appendChild(this.estTimeEl);

    // VRAM requirement
    this.estVramEl = this.createEstimateCard('VRAM Required', '—');
    grid.appendChild(this.estVramEl);

    // Disk space
    this.estDiskEl = this.createEstimateCard('Disk Space', '—');
    grid.appendChild(this.estDiskEl);

    // Power estimate
    this.estPowerEl = this.createEstimateCard('Est. Power', '—');
    grid.appendChild(this.estPowerEl);

    section.appendChild(grid);
    return section;
  };

  /**
   * Create an estimate display card.
   */
  TrainingConfigPanel.prototype.createEstimateCard = function (label, value) {
    var card = document.createElement('div');
    card.className = 'tc-estimate-card';
    card.setAttribute('aria-label', label + ': ' + value);

    var valueEl = document.createElement('div');
    valueEl.className = 'tc-estimate-card__value';
    valueEl.textContent = value;
    card.appendChild(valueEl);

    var labelEl = document.createElement('div');
    labelEl.className = 'tc-estimate-card__label';
    labelEl.textContent = label;
    card.appendChild(labelEl);

    card._valueEl = valueEl;
    return card;
  };

  // ─── Update Methods ───────────────────────────────────────────────

  /**
   * Update the hardware display badge after detection.
   */
  TrainingConfigPanel.prototype.updateHardwareDisplay = function () {
    if (!this.hardware || !this.hardwareBadgeEl) return;
    var hw = this.hardware;
    var icon = '🖥️';
    var name = 'CPU Only';
    var mem = formatNumber(hw.systemMemoryMB) + ' MB System RAM';

    if (hw.vendor === 'nvidia') {
      icon = '🟢';
      name = hw.gpuName || 'NVIDIA GPU';
      mem = (hw.vramMB ? formatNumber(hw.vramMB) + ' MB VRAM' : 'Unknown VRAM');
    } else if (hw.vendor === 'apple') {
      icon = '🍎';
      name = hw.gpuName || 'Apple Silicon';
      mem = (hw.unifiedMemoryMB ? formatNumber(hw.unifiedMemoryMB) + ' MB Unified' : '');
    } else if (hw.vendor === 'amd') {
      icon = '🔴';
      name = hw.gpuName || 'AMD GPU';
      mem = (hw.vramMB ? formatNumber(hw.vramMB) + ' MB VRAM' : 'Unknown VRAM');
    }

    this.hardwareBadgeEl.innerHTML = '';
    var iconSpan = document.createElement('span');
    iconSpan.className = 'tc-hardware-badge__icon';
    iconSpan.textContent = icon;
    this.hardwareBadgeEl.appendChild(iconSpan);

    var nameSpan = document.createElement('span');
    nameSpan.className = 'tc-hardware-badge__name';
    nameSpan.textContent = name;
    this.hardwareBadgeEl.appendChild(nameSpan);

    var memSpan = document.createElement('span');
    memSpan.className = 'tc-hardware-badge__mem';
    memSpan.textContent = mem;
    this.hardwareBadgeEl.appendChild(memSpan);

    this.hardwareBadgeEl.setAttribute('aria-label', 'Detected hardware: ' + name + ', ' + mem);
  };

  /**
   * Update hyperparameter input values (after loading defaults from backend).
   */
  TrainingConfigPanel.prototype.updateHyperparamInputs = function () {
    var hp = this.config.hyperparameters;
    var keys = Object.keys(hp);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var input = document.getElementById('tc-hp-' + key);
      if (input) {
        input.value = String(hp[key]);
      }
    }
  };

  /**
   * Show/hide LoRA-specific fields based on selected method.
   */
  TrainingConfigPanel.prototype.updateLoraFieldsVisibility = function () {
    if (!this.loraRow) return;
    var isLora = (this.config.method === 'lora' || this.config.method === 'qlora');
    this.loraRow.style.display = isLora ? 'grid' : 'none';
  };

  /**
   * Debounced validation to avoid excessive IPC calls.
   */
  TrainingConfigPanel.prototype.debouncedValidate = function () {
    var self = this;
    if (this.validationDebounce) clearTimeout(this.validationDebounce);
    this.validationDebounce = setTimeout(function () {
      self.validateAndUpdateWarnings();
    }, 300);
  };

  /**
   * Validate hyperparameters by calling the IPC handler and display warnings.
   */
  TrainingConfigPanel.prototype.validateAndUpdateWarnings = function () {
    var self = this;
    var hp = this.config.hyperparameters;

    // Local range validation first
    var localWarnings = [];
    var keys = Object.keys(HYPERPARAM_RANGES);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var range = HYPERPARAM_RANGES[key];
      var val = hp[key];
      var feedbackEl = document.getElementById('tc-hp-feedback-' + key);

      if (val === undefined || val === null) continue;

      if (val < range.min || val > range.max) {
        if (feedbackEl) {
          feedbackEl.className = 'tc-field__error';
          feedbackEl.textContent = '⚠ Value out of range (' + range.min + ' – ' + range.max + ')';
          feedbackEl.style.display = 'flex';
        }
        localWarnings.push(range.label + ' is out of acceptable range');
      } else if (range.warnMax && val > range.warnMax) {
        if (feedbackEl) {
          feedbackEl.className = 'tc-field__warn';
          feedbackEl.textContent = '⚡ High value may cause issues';
          feedbackEl.style.display = 'flex';
        }
      } else if (range.warnMin && val < range.warnMin) {
        if (feedbackEl) {
          feedbackEl.className = 'tc-field__warn';
          feedbackEl.textContent = '⚡ Very low value — training may be slow';
          feedbackEl.style.display = 'flex';
        }
      } else {
        if (feedbackEl) {
          feedbackEl.style.display = 'none';
        }
      }
    }

    // Call backend validation for additional checks
    var eapi = api();
    if (eapi) {
      eapi.invoke('training:config-validate', hp).then(function (result) {
        if (result && result.success && result.data) {
          self.warnings = (result.data.warnings || []).concat(localWarnings);
          self.renderWarnings();
        }
      }).catch(function () {
        self.warnings = localWarnings;
        self.renderWarnings();
      });
    } else {
      self.warnings = localWarnings;
      self.renderWarnings();
    }
  };

  /**
   * Render the warnings section.
   */
  TrainingConfigPanel.prototype.renderWarnings = function () {
    if (!this.warningsEl) return;
    this.warningsEl.innerHTML = '';

    if (!this.warnings || this.warnings.length === 0) return;

    var container = document.createElement('div');
    container.className = 'tc-warnings';
    container.setAttribute('role', 'alert');
    container.setAttribute('aria-label', 'Configuration warnings');

    var title = document.createElement('div');
    title.className = 'tc-warnings__title';
    title.textContent = '⚠ Configuration Warnings';
    container.appendChild(title);

    var list = document.createElement('ul');
    list.className = 'tc-warnings__list';
    for (var i = 0; i < this.warnings.length; i++) {
      var li = document.createElement('li');
      li.textContent = this.warnings[i];
      list.appendChild(li);
    }
    container.appendChild(list);
    this.warningsEl.appendChild(container);
  };

  /**
   * Update the resource estimates based on current configuration and hardware.
   * Computes estimated training time, VRAM, disk space, and power consumption.
   *
   * Estimation formula:
   * - Time: Based on model size, dataset samples, epochs, batch size, hardware speed
   * - VRAM: Based on model size, method (LoRA ~20%, QLoRA ~10%, Full ~100%), batch size
   * - Disk: Checkpoints + output model (quantization factor)
   * - Power: Based on hardware TDP and estimated training time
   */
  TrainingConfigPanel.prototype.updateEstimates = function () {
    var hp = this.config.hyperparameters;
    var hw = this.hardware;
    var method = this.config.method;

    // Get model size from selection
    var modelSizeB = 7e9; // Default 7B
    for (var i = 0; i < BASE_MODELS.length; i++) {
      if (BASE_MODELS[i].value === this.config.baseModel) {
        modelSizeB = BASE_MODELS[i].size;
        break;
      }
    }
    var modelSizeMB = (modelSizeB / 1e9) * 1024; // Rough: 1B params ~ 1GB in 4-bit

    // ── VRAM Estimate ──
    var vramMultiplier = 1.0;
    if (method === 'lora') vramMultiplier = 0.2;
    else if (method === 'qlora') vramMultiplier = 0.12;
    // Account for batch size overhead
    var batchOverhead = hp.batchSize * 0.05; // ~5% per sample
    var estimatedVramMB = Math.round(modelSizeMB * vramMultiplier * (1 + batchOverhead));
    // Minimum baseline
    if (estimatedVramMB < 512) estimatedVramMB = 512;

    // ── Training Time Estimate ──
    // Rough: tokens/sec depends on hardware
    var tokensPerSec = 100; // Default for CPU
    if (hw) {
      if (hw.vendor === 'nvidia') {
        tokensPerSec = hw.vramMB > 16000 ? 2000 : (hw.vramMB > 8000 ? 1200 : 600);
      } else if (hw.vendor === 'apple') {
        tokensPerSec = hw.unifiedMemoryMB > 32000 ? 800 : (hw.unifiedMemoryMB > 16000 ? 500 : 300);
      } else if (hw.vendor === 'amd') {
        tokensPerSec = hw.vramMB > 16000 ? 1500 : 700;
      }
    }
    // Estimate total tokens: assume 1000 samples * 512 tokens per sample as baseline
    var estimatedSamples = 1000;
    var tokensPerSample = 512;
    var totalTokens = estimatedSamples * tokensPerSample * hp.epochs;
    var effectiveBatchSize = hp.batchSize * (hp.gradientAccumulationSteps || 1);
    var totalSteps = Math.ceil(estimatedSamples / effectiveBatchSize) * hp.epochs;
    var estimatedTimeMs = Math.round((totalTokens / tokensPerSec) * 1000);
    if (estimatedTimeMs < 60000) estimatedTimeMs = 60000; // Min 1 minute

    // ── Disk Space Estimate ──
    // Checkpoints (3 max) + output model
    var checkpointSizeMB = modelSizeMB * (method === 'full-finetune' ? 1.0 : 0.1);
    var outputSizeMB = modelSizeMB * 0.6; // GGUF quantized output
    var totalDiskMB = Math.round((checkpointSizeMB * 3) + outputSizeMB);

    // ── Power Estimate ──
    var watts = 65; // Default CPU
    if (hw && hw.vendor === 'nvidia') watts = 250;
    else if (hw && hw.vendor === 'apple') watts = 30;
    else if (hw && hw.vendor === 'amd') watts = 200;
    var hoursEstimated = estimatedTimeMs / 3600000;
    var kwhEstimated = (watts * hoursEstimated) / 1000;

    // Update UI
    if (this.estTimeEl && this.estTimeEl._valueEl) {
      this.estTimeEl._valueEl.textContent = formatDuration(estimatedTimeMs);
      this.estTimeEl.setAttribute('aria-label', 'Training Time: ' + formatDuration(estimatedTimeMs));
    }
    if (this.estVramEl && this.estVramEl._valueEl) {
      var vramText = formatBytes(estimatedVramMB * 1024 * 1024);
      this.estVramEl._valueEl.textContent = vramText;
      this.estVramEl.setAttribute('aria-label', 'VRAM Required: ' + vramText);
      // Warn if exceeds available
      if (hw && hw.vramMB && estimatedVramMB > hw.vramMB) {
        this.estVramEl._valueEl.style.color = 'var(--red, #f87171)';
      } else if (hw && hw.unifiedMemoryMB && estimatedVramMB > hw.unifiedMemoryMB * 0.75) {
        this.estVramEl._valueEl.style.color = 'var(--yellow, #fbbf24)';
      } else {
        this.estVramEl._valueEl.style.color = 'var(--accent, #93bbfc)';
      }
    }
    if (this.estDiskEl && this.estDiskEl._valueEl) {
      var diskText = formatBytes(totalDiskMB * 1024 * 1024);
      this.estDiskEl._valueEl.textContent = diskText;
      this.estDiskEl.setAttribute('aria-label', 'Disk Space: ' + diskText);
    }
    if (this.estPowerEl && this.estPowerEl._valueEl) {
      var powerText = kwhEstimated < 0.01 ? '< 0.01 kWh' : kwhEstimated.toFixed(2) + ' kWh';
      this.estPowerEl._valueEl.textContent = powerText;
      this.estPowerEl.setAttribute('aria-label', 'Estimated Power: ' + powerText);
    }
  };

  // ─── Actions ──────────────────────────────────────────────────────

  /**
   * Start a training job with the current configuration.
   */
  TrainingConfigPanel.prototype.onStartTraining = function () {
    var self = this;
    var eapi = api();
    if (!eapi) return;

    // Validate dataset path
    if (!this.config.datasetPath || this.config.datasetPath.trim() === '') {
      this.showToast('Please specify a dataset path', 'error');
      return;
    }

    // Validate base model
    if (!this.config.baseModel || this.config.baseModel === 'custom') {
      var customInput = document.getElementById('tc-custom-model');
      if (!customInput || !customInput.value.trim()) {
        this.showToast('Please specify a model path or select a base model', 'error');
        return;
      }
      this.config.baseModel = customInput.value.trim();
    }

    disableBtn(this.startBtn);
    this.startBtn.textContent = 'Starting...';

    var jobConfig = {
      id: 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      projectId: 'current',
      baseModel: this.config.baseModel,
      method: this.config.method,
      datasetPath: this.config.datasetPath,
      datasetFormat: this.config.datasetFormat,
      hyperparameters: this.config.hyperparameters,
      hardware: this.hardware || { vendor: 'none', cpuCores: 4, systemMemoryMB: 8192 },
      outputDir: '',
      checkpointDir: '',
      scriptPath: '',
      checkpointIntervalEpochs: 1,
      validationSplit: 0.1,
    };

    eapi.invoke('training:job-start', jobConfig).then(function (result) {
      enableBtn(self.startBtn);
      self.startBtn.textContent = 'Start Training';
      if (result && result.success) {
        self.showToast('Training job started: ' + result.data.jobId, 'success');
      } else {
        var msg = (result && result.error && result.error.message) || 'Failed to start training';
        self.showToast(msg, 'error');
      }
    }).catch(function (err) {
      enableBtn(self.startBtn);
      self.startBtn.textContent = 'Start Training';
      self.showToast('Failed to start training: ' + (err.message || err), 'error');
    });
  };

  /**
   * Show a toast notification.
   */
  TrainingConfigPanel.prototype.showToast = function (message, type) {
    // Use wk toast if available
    if (window.wk && window.wk.toast) {
      window.wk.toast(message, type);
      return;
    }
    // Fallback: log to console
    if (type === 'error') {
      console.error('[TrainingConfig]', message);
    } else {
      console.log('[TrainingConfig]', message);
    }
  };

  /**
   * Destroy the panel and clean up resources.
   */
  TrainingConfigPanel.prototype.destroy = function () {
    if (this.validationDebounce) {
      clearTimeout(this.validationDebounce);
    }
    if (this.container) {
      this.container.innerHTML = '';
    }
  };

  // ─── Export ─────────────────────────────────────────────────────

  window.TrainingConfigPanel = TrainingConfigPanel;

})();
