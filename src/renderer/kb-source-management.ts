// @ts-nocheck
/**
 * KBSourceManagement — Renderer UI for managing Knowledge Base sources.
 *
 * Provides:
 * - Add Source form with connector type selection and adaptive configuration fields
 * - Remove Source flow with confirmation dialog
 * - Real-time indexing progress display (chunks processed, ETA, rate)
 * - Aggregate URL bandwidth and storage estimates before confirmation
 * - Reindex action with progress tracking
 *
 * IPC channels used:
 * - kb:source-add     — add and begin indexing a new source
 * - kb:source-remove  — delete source and all data
 * - kb:source-reindex — trigger re-indexing
 *
 * Renderer-bound events listened:
 * - kb:indexing-progress       — real-time indexing progress
 * - kb:source-status-changed   — source state transitions
 *
 * Uses window.wk namespace utilities (toast, confirm, badge, progress).
 * Follows existing Vanilla JS + DOM manipulation pattern.
 *
 * Requirements: 4.2, 4.3, 4.5, 43.5
 */

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────

  var CONNECTOR_TYPES = [
    { value: 'local-files', label: 'Local Files', icon: '📁' },
    { value: 'git-repository', label: 'Git Repository', icon: '🔀' },
    { value: 'url-website', label: 'URL / Website', icon: '🌐' },
    { value: 'pdf-document', label: 'PDF Document', icon: '📄' },
    { value: 'docx-document', label: 'DOCX Document', icon: '📝' },
    { value: 'csv-file', label: 'CSV File', icon: '📊' },
    { value: 'json-file', label: 'JSON File', icon: '{ }' },
    { value: 'markdown-wiki', label: 'Markdown Wiki', icon: '📖' },
  ];

  var AUTH_METHODS = [
    { value: 'none', label: 'None' },
    { value: 'token', label: 'Personal Access Token' },
    { value: 'oauth2', label: 'OAuth 2.0' },
    { value: 'api-key', label: 'API Key' },
    { value: 'ssh-key', label: 'SSH Key' },
  ];

  var SCHEDULE_OPTIONS = [
    { value: 'manual', label: 'Manual' },
    { value: 'on-change', label: 'On Change' },
    { value: 'hourly', label: 'Hourly' },
    { value: 'daily', label: 'Daily' },
  ];

  var CHUNKING_STRATEGIES = [
    { value: 'fixed-size', label: 'Fixed Size' },
    { value: 'semantic-boundary', label: 'Semantic Boundary' },
    { value: 'document-structure', label: 'Document Structure' },
  ];

  /** Connector types that support authentication. */
  var AUTH_CONNECTORS = ['git-repository', 'url-website'];

  /** Default per-document fetch size limit (10 MB). */
  var DEFAULT_MAX_FETCH_SIZE = 10 * 1024 * 1024;

  /** Default aggregate URL storage limit (2 GB). */
  var DEFAULT_MAX_URL_STORAGE = 2 * 1024 * 1024 * 1024;

  /** Default max URL source count. */
  var DEFAULT_MAX_URL_COUNT = 100;

  // ─── Helpers ─────────────────────────────────────────────────────

  function api() { return window.electronAPI; }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i >= units.length) i = units.length - 1;
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  function formatDuration(ms) {
    if (ms < 1000) return 'less than 1s';
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
    return Math.round(ms / 3600000) + 'h ' + Math.round((ms % 3600000) / 60000) + 'm';
  }

  function disableBtn(btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
  function enableBtn(btn) { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }

  // ─── Inject Panel Styles ─────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('kb-source-mgmt-styles')) return;
    var style = document.createElement('style');
    style.id = 'kb-source-mgmt-styles';
    style.textContent = [
      '.kb-src-form{background:var(--surface-container,#1e1e2e);border:1px solid var(--border-color,#313244);border-radius:8px;padding:16px;margin-bottom:12px;animation:kbSlideDown 0.2s ease;}',
      '@keyframes kbSlideDown{from{opacity:0;transform:translateY(-8px);}to{opacity:1;transform:translateY(0);}}',
      '.kb-src-form-row{margin-bottom:12px;}',
      '.kb-src-form-label{display:block;font-size:11px;color:var(--text-dim,#6c7086);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;font-weight:600;}',
      '.kb-src-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
      '.kb-src-form-actions{display:flex;gap:8px;margin-top:16px;justify-content:flex-end;}',
      '.kb-src-estimates{background:var(--surface-container-high,#181825);border:1px solid var(--border-color,#313244);border-radius:6px;padding:12px;margin-top:12px;}',
      '.kb-src-estimates-title{font-size:11px;color:var(--text-dim,#6c7086);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;font-weight:600;}',
      '.kb-src-estimates-row{display:flex;justify-content:space-between;font-size:12px;padding:4px 0;}',
      '.kb-src-estimates-label{color:var(--text-secondary,#a6adc8);}',
      '.kb-src-estimates-value{color:var(--text-primary,#cdd6f4);font-weight:500;}',
      '.kb-src-progress{background:var(--surface-container,#1e1e2e);border:1px solid var(--border-color,#313244);border-radius:8px;padding:12px;margin-top:8px;}',
      '.kb-src-progress-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}',
      '.kb-src-progress-title{font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:500;}',
      '.kb-src-progress-rate{font-size:11px;color:var(--text-secondary,#a6adc8);}',
      '.kb-src-progress-bar{height:4px;background:var(--surface-container-highest,#45475a);border-radius:2px;overflow:hidden;margin-bottom:6px;}',
      '.kb-src-progress-fill{height:100%;background:var(--accent,#89b4fa);transition:width 0.3s ease;border-radius:2px;}',
      '.kb-src-progress-stats{display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim,#6c7086);}',
      '.kb-src-confirm{background:var(--surface-container-high,#181825);border:1px solid var(--red,#f38ba8);border-radius:8px;padding:14px 16px;margin-top:8px;animation:kbSlideDown 0.2s ease;}',
      '.kb-src-confirm-msg{font-size:13px;color:var(--text-primary,#cdd6f4);margin-bottom:12px;}',
      '.kb-src-confirm-actions{display:flex;gap:8px;justify-content:flex-end;}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ─── Add Source Form ─────────────────────────────────────────────

  /**
   * Renders the "Add Source" form with:
   * - Connector type selection
   * - Adaptive configuration fields based on connector type
   * - URI/path input with validation
   * - Authentication method selection (for git/URL connectors)
   * - Schedule selection
   * - Aggregate estimates for URL sources
   *
   * @param container - DOM element to render into
   * @param options - { onAdd, onCancel, existingUrlCount, existingUrlStorage }
   */
  function renderAddSourceForm(container, options) {
    injectStyles();
    options = options || {};
    var onAdd = options.onAdd || function () {};
    var onCancel = options.onCancel || function () {};
    var existingUrlCount = options.existingUrlCount || 0;
    var existingUrlStorage = options.existingUrlStorage || 0;

    var formEl = document.createElement('div');
    formEl.className = 'kb-src-form';
    formEl.setAttribute('role', 'form');
    formEl.setAttribute('aria-label', 'Add Knowledge Source');

    // State
    var state = {
      type: '',
      uri: '',
      label: '',
      authMethod: 'none',
      credentialId: '',
      schedule: 'manual',
      chunkingStrategy: 'semantic-boundary',
      submitting: false,
    };

    function rebuild() {
      formEl.innerHTML = '';
      renderFormContent(formEl, state);
    }

    rebuild();
    container.appendChild(formEl);

    return { el: formEl, destroy: function () { formEl.remove(); } };

    function renderFormContent(parent, st) {
      // ── Connector Type Selection ──
      var typeRow = document.createElement('div');
      typeRow.className = 'kb-src-form-row';
      var typeLabel = document.createElement('label');
      typeLabel.className = 'kb-src-form-label';
      typeLabel.textContent = 'Connector Type';
      typeLabel.setAttribute('for', 'kb-src-type-select');
      typeRow.appendChild(typeLabel);

      var typeSelect = document.createElement('select');
      typeSelect.id = 'kb-src-type-select';
      typeSelect.className = 'wk-select';
      typeSelect.setAttribute('aria-label', 'Select connector type');
      var defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = '-- Select a connector type --';
      defaultOpt.disabled = true;
      defaultOpt.selected = !st.type;
      typeSelect.appendChild(defaultOpt);

      CONNECTOR_TYPES.forEach(function (ct) {
        var opt = document.createElement('option');
        opt.value = ct.value;
        opt.textContent = ct.icon + ' ' + ct.label;
        opt.selected = st.type === ct.value;
        typeSelect.appendChild(opt);
      });

      typeSelect.addEventListener('change', function () {
        st.type = typeSelect.value;
        rebuild();
      });
      typeRow.appendChild(typeSelect);
      parent.appendChild(typeRow);

      // Only show remaining fields if type is selected
      if (!st.type) return;

      // ── URI / Path Input ──
      var uriRow = document.createElement('div');
      uriRow.className = 'kb-src-form-row';
      var uriLabel = document.createElement('label');
      uriLabel.className = 'kb-src-form-label';
      uriLabel.setAttribute('for', 'kb-src-uri-input');
      uriLabel.textContent = getUriLabel(st.type);
      uriRow.appendChild(uriLabel);

      var uriInput = document.createElement('input');
      uriInput.type = 'text';
      uriInput.id = 'kb-src-uri-input';
      uriInput.className = 'wk-input';
      uriInput.placeholder = getUriPlaceholder(st.type);
      uriInput.value = st.uri;
      uriInput.setAttribute('aria-label', getUriLabel(st.type));
      uriInput.addEventListener('input', function () { st.uri = uriInput.value; });
      uriRow.appendChild(uriInput);
      parent.appendChild(uriRow);

      // ── Label (optional) ──
      var labelRow = document.createElement('div');
      labelRow.className = 'kb-src-form-row';
      var labelLabel = document.createElement('label');
      labelLabel.className = 'kb-src-form-label';
      labelLabel.setAttribute('for', 'kb-src-label-input');
      labelLabel.textContent = 'Label (optional)';
      labelRow.appendChild(labelLabel);

      var labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.id = 'kb-src-label-input';
      labelInput.className = 'wk-input';
      labelInput.placeholder = 'Human-readable name for this source';
      labelInput.value = st.label;
      labelInput.setAttribute('aria-label', 'Source label');
      labelInput.addEventListener('input', function () { st.label = labelInput.value; });
      labelRow.appendChild(labelInput);
      parent.appendChild(labelRow);

      // ── Grid: Schedule + Chunking ──
      var gridRow = document.createElement('div');
      gridRow.className = 'kb-src-form-grid';

      // Schedule
      var scheduleCol = document.createElement('div');
      scheduleCol.className = 'kb-src-form-row';
      var scheduleLabel = document.createElement('label');
      scheduleLabel.className = 'kb-src-form-label';
      scheduleLabel.setAttribute('for', 'kb-src-schedule-select');
      scheduleLabel.textContent = 'Sync Schedule';
      scheduleCol.appendChild(scheduleLabel);

      var scheduleSelect = document.createElement('select');
      scheduleSelect.id = 'kb-src-schedule-select';
      scheduleSelect.className = 'wk-select';
      scheduleSelect.setAttribute('aria-label', 'Sync schedule');
      SCHEDULE_OPTIONS.forEach(function (so) {
        var opt = document.createElement('option');
        opt.value = so.value;
        opt.textContent = so.label;
        opt.selected = st.schedule === so.value;
        scheduleSelect.appendChild(opt);
      });
      scheduleSelect.addEventListener('change', function () { st.schedule = scheduleSelect.value; });
      scheduleCol.appendChild(scheduleSelect);
      gridRow.appendChild(scheduleCol);

      // Chunking Strategy
      var chunkCol = document.createElement('div');
      chunkCol.className = 'kb-src-form-row';
      var chunkLabel = document.createElement('label');
      chunkLabel.className = 'kb-src-form-label';
      chunkLabel.setAttribute('for', 'kb-src-chunk-select');
      chunkLabel.textContent = 'Chunking Strategy';
      chunkCol.appendChild(chunkLabel);

      var chunkSelect = document.createElement('select');
      chunkSelect.id = 'kb-src-chunk-select';
      chunkSelect.className = 'wk-select';
      chunkSelect.setAttribute('aria-label', 'Chunking strategy');
      CHUNKING_STRATEGIES.forEach(function (cs) {
        var opt = document.createElement('option');
        opt.value = cs.value;
        opt.textContent = cs.label;
        opt.selected = st.chunkingStrategy === cs.value;
        chunkSelect.appendChild(opt);
      });
      chunkSelect.addEventListener('change', function () { st.chunkingStrategy = chunkSelect.value; });
      chunkCol.appendChild(chunkSelect);
      gridRow.appendChild(chunkCol);
      parent.appendChild(gridRow);

      // ── Authentication (only for git/URL connectors) ──
      if (AUTH_CONNECTORS.indexOf(st.type) !== -1) {
        var authRow = document.createElement('div');
        authRow.className = 'kb-src-form-row';
        var authLabel = document.createElement('label');
        authLabel.className = 'kb-src-form-label';
        authLabel.setAttribute('for', 'kb-src-auth-select');
        authLabel.textContent = 'Authentication';
        authRow.appendChild(authLabel);

        var authSelect = document.createElement('select');
        authSelect.id = 'kb-src-auth-select';
        authSelect.className = 'wk-select';
        authSelect.setAttribute('aria-label', 'Authentication method');
        AUTH_METHODS.forEach(function (am) {
          var opt = document.createElement('option');
          opt.value = am.value;
          opt.textContent = am.label;
          opt.selected = st.authMethod === am.value;
          authSelect.appendChild(opt);
        });
        authSelect.addEventListener('change', function () {
          st.authMethod = authSelect.value;
          rebuild();
        });
        authRow.appendChild(authSelect);
        parent.appendChild(authRow);

        // Credential ID field if auth is not 'none'
        if (st.authMethod !== 'none') {
          var credRow = document.createElement('div');
          credRow.className = 'kb-src-form-row';
          var credLabel = document.createElement('label');
          credLabel.className = 'kb-src-form-label';
          credLabel.setAttribute('for', 'kb-src-cred-input');
          credLabel.textContent = 'Credential ID (from Vault)';
          credRow.appendChild(credLabel);

          var credInput = document.createElement('input');
          credInput.type = 'text';
          credInput.id = 'kb-src-cred-input';
          credInput.className = 'wk-input';
          credInput.placeholder = 'Enter credential identifier';
          credInput.value = st.credentialId;
          credInput.setAttribute('aria-label', 'Credential identifier');
          credInput.addEventListener('input', function () { st.credentialId = credInput.value; });
          credRow.appendChild(credInput);
          parent.appendChild(credRow);
        }
      }

      // ── Aggregate URL Estimates (for URL connectors) ──
      if (st.type === 'url-website') {
        renderUrlEstimates(parent, existingUrlCount, existingUrlStorage);
      }

      // ── Form Actions ──
      var actionsRow = document.createElement('div');
      actionsRow.className = 'kb-src-form-actions';

      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'wk-btn-secondary';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.setAttribute('aria-label', 'Cancel adding source');
      cancelBtn.addEventListener('click', function () {
        formEl.remove();
        onCancel();
      });
      actionsRow.appendChild(cancelBtn);

      var submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.className = 'wk-btn-primary';
      submitBtn.textContent = 'Add Source';
      submitBtn.setAttribute('aria-label', 'Confirm and add knowledge source');
      submitBtn.addEventListener('click', function () {
        handleSubmit(submitBtn, st);
      });
      actionsRow.appendChild(submitBtn);
      parent.appendChild(actionsRow);
    }

    // ── URL Estimates Display (Requirement 43.5) ──
    function renderUrlEstimates(parent, urlCount, urlStorage) {
      var estEl = document.createElement('div');
      estEl.className = 'kb-src-estimates';
      estEl.setAttribute('aria-label', 'URL bandwidth and storage estimates');

      var title = document.createElement('div');
      title.className = 'kb-src-estimates-title';
      title.textContent = 'URL Source Estimates';
      estEl.appendChild(title);

      var rows = [
        { label: 'Current URL sources', value: urlCount + ' / ' + DEFAULT_MAX_URL_COUNT },
        { label: 'Current URL storage', value: formatBytes(urlStorage) + ' / ' + formatBytes(DEFAULT_MAX_URL_STORAGE) },
        { label: 'Estimated bandwidth', value: '~' + formatBytes(DEFAULT_MAX_FETCH_SIZE) + ' (per page)' },
        { label: 'After adding this source', value: (urlCount + 1) + ' / ' + DEFAULT_MAX_URL_COUNT + ' sources' },
      ];

      rows.forEach(function (row) {
        var rowEl = document.createElement('div');
        rowEl.className = 'kb-src-estimates-row';
        var labelEl = document.createElement('span');
        labelEl.className = 'kb-src-estimates-label';
        labelEl.textContent = row.label;
        rowEl.appendChild(labelEl);
        var valueEl = document.createElement('span');
        valueEl.className = 'kb-src-estimates-value';
        valueEl.textContent = row.value;
        rowEl.appendChild(valueEl);
        estEl.appendChild(rowEl);
      });

      // Warning if approaching limits
      if (urlCount >= DEFAULT_MAX_URL_COUNT - 5) {
        var warnEl = document.createElement('div');
        warnEl.style.cssText = 'margin-top:8px;font-size:11px;color:var(--yellow,#fbbf24);';
        warnEl.textContent = 'Warning: Approaching maximum URL source limit (' + DEFAULT_MAX_URL_COUNT + ')';
        warnEl.setAttribute('role', 'alert');
        estEl.appendChild(warnEl);
      }

      parent.appendChild(estEl);
    }

    // ── Form Submission Handler ──
    function handleSubmit(btn, st) {
      // Validate required fields
      if (!st.type) {
        if (window.wk && window.wk.toast) window.wk.toast('Please select a connector type', 'error');
        return;
      }
      if (!st.uri || !st.uri.trim()) {
        if (window.wk && window.wk.toast) window.wk.toast('Please enter a URI or path', 'error');
        return;
      }

      // Build connector config
      var config = {
        type: st.type,
        uri: st.uri.trim(),
        label: st.label.trim() || undefined,
        schedule: st.schedule,
        chunkingStrategy: st.chunkingStrategy,
      };

      if (AUTH_CONNECTORS.indexOf(st.type) !== -1 && st.authMethod !== 'none') {
        config.authentication = {
          method: st.authMethod,
          credentialId: st.credentialId.trim() || undefined,
        };
      }

      // Disable button and submit
      disableBtn(btn);
      btn.textContent = 'Adding...';

      api().invoke('kb:source-add', config).then(function (result) {
        if (result && result.success) {
          if (window.wk && window.wk.toast) window.wk.toast('Source added successfully', 'success');
          formEl.remove();
          onAdd(result.data);
        } else {
          var errMsg = (result && result.error && result.error.message) || 'Failed to add source';
          if (window.wk && window.wk.toast) window.wk.toast(errMsg, 'error');
          enableBtn(btn);
          btn.textContent = 'Add Source';
        }
      }).catch(function (err) {
        if (window.wk && window.wk.toast) window.wk.toast('Error: ' + (err.message || err), 'error');
        enableBtn(btn);
        btn.textContent = 'Add Source';
      });
    }
  }

  // ─── Remove Source Flow ──────────────────────────────────────────

  /**
   * Renders the remove source confirmation dialog.
   * Displays a warning with the source details and requires explicit confirmation.
   *
   * @param container - DOM element to render the dialog into
   * @param source - { id, label, uri, type, chunkCount }
   * @param options - { onRemove, onCancel }
   */
  function renderRemoveSourceConfirm(container, source, options) {
    injectStyles();
    options = options || {};
    var onRemove = options.onRemove || function () {};
    var onCancel = options.onCancel || function () {};

    var confirmEl = document.createElement('div');
    confirmEl.className = 'kb-src-confirm';
    confirmEl.setAttribute('role', 'alertdialog');
    confirmEl.setAttribute('aria-label', 'Confirm source removal');
    confirmEl.setAttribute('aria-describedby', 'kb-src-confirm-msg');

    var msg = document.createElement('div');
    msg.className = 'kb-src-confirm-msg';
    msg.id = 'kb-src-confirm-msg';
    var sourceName = source.label || source.uri || source.id;
    msg.innerHTML = 'Are you sure you want to remove <strong>' + escHtml(sourceName) + '</strong>?'
      + '<br><span style="font-size:12px;color:var(--text-dim,#6c7086);">'
      + 'This will permanently delete all ' + (source.chunkCount || 0) + ' chunks, embeddings, and metadata associated with this source.</span>';
    confirmEl.appendChild(msg);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'kb-src-confirm-actions';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'wk-btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel removal');
    cancelBtn.addEventListener('click', function () {
      confirmEl.remove();
      onCancel();
    });
    actionsRow.appendChild(cancelBtn);

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'wk-btn-danger';
    removeBtn.textContent = 'Remove Source';
    removeBtn.setAttribute('aria-label', 'Confirm removal of ' + escHtml(sourceName));
    removeBtn.addEventListener('click', function () {
      disableBtn(removeBtn);
      removeBtn.textContent = 'Removing...';

      api().invoke('kb:source-remove', { sourceId: source.id }).then(function (result) {
        if (result && result.success) {
          if (window.wk && window.wk.toast) window.wk.toast('Source removed', 'success');
          confirmEl.remove();
          onRemove(source.id);
        } else {
          var errMsg = (result && result.error && result.error.message) || 'Failed to remove source';
          if (window.wk && window.wk.toast) window.wk.toast(errMsg, 'error');
          enableBtn(removeBtn);
          removeBtn.textContent = 'Remove Source';
        }
      }).catch(function (err) {
        if (window.wk && window.wk.toast) window.wk.toast('Error: ' + (err.message || err), 'error');
        enableBtn(removeBtn);
        removeBtn.textContent = 'Remove Source';
      });
    });
    actionsRow.appendChild(removeBtn);
    confirmEl.appendChild(actionsRow);

    container.appendChild(confirmEl);

    // Focus management: trap focus within the dialog, focus cancel button initially
    cancelBtn.focus();

    // Focus trap for modal dialog
    var focusableEls = confirmEl.querySelectorAll('button');
    var firstFocusable = focusableEls[0];
    var lastFocusable = focusableEls[focusableEls.length - 1];

    confirmEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        confirmEl.remove();
        onCancel();
        return;
      }
      if (e.key === 'Tab') {
        if (e.shiftKey) {
          if (document.activeElement === firstFocusable) {
            e.preventDefault();
            lastFocusable.focus();
          }
        } else {
          if (document.activeElement === lastFocusable) {
            e.preventDefault();
            firstFocusable.focus();
          }
        }
      }
    });

    return { el: confirmEl, destroy: function () { confirmEl.remove(); } };
  }

  // ─── Indexing Progress Display ───────────────────────────────────

  /**
   * Renders and manages a real-time indexing progress indicator.
   * Listens to 'kb:indexing-progress' renderer-bound events and updates
   * the display with chunks processed, ETA, and processing rate.
   *
   * @param container - DOM element to render into
   * @param sourceId - The source ID to track progress for
   * @returns controller object with update() and destroy() methods
   */
  function renderIndexingProgress(container, sourceId) {
    injectStyles();

    var progressEl = document.createElement('div');
    progressEl.className = 'kb-src-progress';
    progressEl.setAttribute('role', 'progressbar');
    progressEl.setAttribute('aria-label', 'Indexing progress');
    progressEl.setAttribute('aria-valuenow', '0');
    progressEl.setAttribute('aria-valuemin', '0');
    progressEl.setAttribute('aria-valuemax', '100');

    var headerRow = document.createElement('div');
    headerRow.className = 'kb-src-progress-header';

    var titleEl = document.createElement('span');
    titleEl.className = 'kb-src-progress-title';
    titleEl.textContent = 'Indexing...';
    headerRow.appendChild(titleEl);

    var rateEl = document.createElement('span');
    rateEl.className = 'kb-src-progress-rate';
    rateEl.textContent = '';
    headerRow.appendChild(rateEl);
    progressEl.appendChild(headerRow);

    var barContainer = document.createElement('div');
    barContainer.className = 'kb-src-progress-bar';
    var barFill = document.createElement('div');
    barFill.className = 'kb-src-progress-fill';
    barFill.style.width = '0%';
    barContainer.appendChild(barFill);
    progressEl.appendChild(barContainer);

    var statsRow = document.createElement('div');
    statsRow.className = 'kb-src-progress-stats';

    var chunksEl = document.createElement('span');
    chunksEl.textContent = '0 chunks processed';
    statsRow.appendChild(chunksEl);

    var etaEl = document.createElement('span');
    etaEl.textContent = 'Estimating...';
    statsRow.appendChild(etaEl);
    progressEl.appendChild(statsRow);

    container.appendChild(progressEl);

    // Screen-reader live announcement region
    var announceEl = document.createElement('div');
    announceEl.setAttribute('role', 'status');
    announceEl.setAttribute('aria-live', 'polite');
    announceEl.setAttribute('aria-atomic', 'true');
    announceEl.className = 'sr-only';
    announceEl.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;';
    container.appendChild(announceEl);

    // Track start time for rate calculation
    var startTime = Date.now();
    var destroyed = false;
    var lastAnnouncedPercent = -1;

    /**
     * Update the progress display with new data from kb:indexing-progress event.
     * @param data - { sourceId, chunksProcessed, totalChunks?, ratePerSecond?, etaMs? }
     */
    function update(data) {
      if (destroyed) return;
      if (data.sourceId !== sourceId) return;

      var chunksProcessed = data.chunksProcessed || 0;
      var totalChunks = data.totalChunks || 0;
      var percent = totalChunks > 0 ? Math.min(100, Math.round((chunksProcessed / totalChunks) * 100)) : 0;

      // Calculate rate if not provided
      var elapsedMs = Date.now() - startTime;
      var rate = data.ratePerSecond || (elapsedMs > 0 ? Math.round((chunksProcessed / elapsedMs) * 1000) : 0);

      // Calculate ETA if not provided
      var etaMs = data.etaMs;
      if (etaMs === undefined && totalChunks > 0 && rate > 0) {
        var remaining = totalChunks - chunksProcessed;
        etaMs = Math.round((remaining / rate) * 1000);
      }

      // Update progress bar
      barFill.style.width = percent + '%';
      progressEl.setAttribute('aria-valuenow', String(percent));

      // Update title
      if (totalChunks > 0) {
        titleEl.textContent = 'Indexing (' + percent + '%)';
      } else {
        titleEl.textContent = 'Indexing...';
      }

      // Update rate
      if (rate > 0) {
        rateEl.textContent = rate + ' chunks/s';
      }

      // Update stats
      if (totalChunks > 0) {
        chunksEl.textContent = chunksProcessed + ' / ' + totalChunks + ' chunks';
      } else {
        chunksEl.textContent = chunksProcessed + ' chunks processed';
      }

      if (etaMs !== undefined && etaMs > 0) {
        etaEl.textContent = 'ETA: ' + formatDuration(etaMs);
      } else if (chunksProcessed > 0 && totalChunks > 0 && chunksProcessed >= totalChunks) {
        etaEl.textContent = 'Complete';
        titleEl.textContent = 'Indexing complete';
        barFill.style.background = 'var(--green,#a6e3a1)';
      } else {
        etaEl.textContent = 'Estimating...';
      }

      // Announce significant progress milestones to screen readers
      if (totalChunks > 0) {
        var announcePercent = Math.floor(percent / 25) * 25;
        if (announcePercent > lastAnnouncedPercent && announcePercent > 0) {
          lastAnnouncedPercent = announcePercent;
          announceEl.textContent = 'Indexing ' + percent + '% complete, ' + chunksProcessed + ' of ' + totalChunks + ' chunks processed';
        }
      }
    }

    /**
     * Mark indexing as complete.
     */
    function complete() {
      if (destroyed) return;
      barFill.style.width = '100%';
      barFill.style.background = 'var(--green,#a6e3a1)';
      titleEl.textContent = 'Indexing complete';
      etaEl.textContent = 'Done';
      progressEl.setAttribute('aria-valuenow', '100');
      announceEl.textContent = 'Indexing complete';
    }

    /**
     * Mark indexing as errored.
     */
    function error(message) {
      if (destroyed) return;
      barFill.style.background = 'var(--red,#f38ba8)';
      titleEl.textContent = 'Indexing failed';
      titleEl.style.color = 'var(--red,#f38ba8)';
      etaEl.textContent = message || 'Error';
      announceEl.textContent = 'Indexing failed: ' + (message || 'Unknown error');
    }

    function destroy() {
      destroyed = true;
      progressEl.remove();
      announceEl.remove();
    }

    return { el: progressEl, update: update, complete: complete, error: error, destroy: destroy };
  }

  // ─── Reindex Source Flow ─────────────────────────────────────────

  /**
   * Triggers a reindex for a source and shows progress.
   *
   * @param container - DOM element to render progress into
   * @param sourceId - The source ID to reindex
   * @param options - { onComplete, onError }
   * @returns controller with destroy()
   */
  function triggerReindex(container, sourceId, options) {
    options = options || {};
    var onComplete = options.onComplete || function () {};
    var onError = options.onError || function () {};

    // Show progress indicator
    var progress = renderIndexingProgress(container, sourceId);

    // Start the reindex via IPC
    api().invoke('kb:source-reindex', { sourceId: sourceId }).then(function (result) {
      if (result && result.success) {
        if (window.wk && window.wk.toast) window.wk.toast('Re-indexing started', 'info');
      } else {
        var errMsg = (result && result.error && result.error.message) || 'Failed to start reindex';
        progress.error(errMsg);
        onError(errMsg);
      }
    }).catch(function (err) {
      progress.error(err.message || String(err));
      onError(err.message || String(err));
    });

    return progress;
  }

  // ─── Event Listener Setup ────────────────────────────────────────

  /**
   * Sets up listeners for renderer-bound KB events.
   * Call this once when the KB management panel mounts to start
   * receiving real-time indexing progress and status changes.
   *
   * @param handlers - { onProgress, onStatusChanged }
   * @returns teardown function to remove all listeners
   */
  function setupKBEventListeners(handlers) {
    handlers = handlers || {};
    var onProgress = handlers.onProgress || function () {};
    var onStatusChanged = handlers.onStatusChanged || function () {};

    var progressHandler = function (_event, data) { onProgress(data); };
    var statusHandler = function (_event, data) { onStatusChanged(data); };

    var eApi = api();
    if (eApi && eApi.on) {
      eApi.on('kb:indexing-progress', progressHandler);
      eApi.on('kb:source-status-changed', statusHandler);
    }

    return function teardown() {
      if (eApi && eApi.off) {
        eApi.off('kb:indexing-progress', progressHandler);
        eApi.off('kb:source-status-changed', statusHandler);
      }
    };
  }

  // ─── URI Helpers ─────────────────────────────────────────────────

  function getUriLabel(type) {
    switch (type) {
      case 'local-files': return 'File / Folder Path';
      case 'git-repository': return 'Repository URL';
      case 'url-website': return 'Website URL';
      case 'pdf-document': return 'PDF File Path';
      case 'docx-document': return 'DOCX File Path';
      case 'csv-file': return 'CSV File Path';
      case 'json-file': return 'JSON File Path';
      case 'markdown-wiki': return 'Wiki Directory Path';
      default: return 'URI / Path';
    }
  }

  function getUriPlaceholder(type) {
    switch (type) {
      case 'local-files': return '/path/to/files or /path/to/folder';
      case 'git-repository': return 'https://github.com/org/repo.git';
      case 'url-website': return 'https://docs.example.com';
      case 'pdf-document': return '/path/to/document.pdf';
      case 'docx-document': return '/path/to/document.docx';
      case 'csv-file': return '/path/to/data.csv';
      case 'json-file': return '/path/to/data.json';
      case 'markdown-wiki': return '/path/to/wiki/directory';
      default: return 'Enter URI or file path';
    }
  }

  // ─── Exports ─────────────────────────────────────────────────────

  /**
   * KBSourceManagement namespace exposed on window for use by the
   * KB management panel and panel registry.
   */
  var KBSourceManagement = {
    renderAddSourceForm: renderAddSourceForm,
    renderRemoveSourceConfirm: renderRemoveSourceConfirm,
    renderIndexingProgress: renderIndexingProgress,
    triggerReindex: triggerReindex,
    setupKBEventListeners: setupKBEventListeners,
    CONNECTOR_TYPES: CONNECTOR_TYPES,
    AUTH_METHODS: AUTH_METHODS,
    SCHEDULE_OPTIONS: SCHEDULE_OPTIONS,
  };

  // Expose to window and module system
  if (typeof window !== 'undefined') {
    window.KBSourceManagement = KBSourceManagement;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = KBSourceManagement;
  }

})();
