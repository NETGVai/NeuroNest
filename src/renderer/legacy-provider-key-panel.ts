// @ts-nocheck
/**
 * LegacyProviderKeyPanel — user-visible cleanup surface for pre-migration
 * cloud provider API-key rows saved before the unified NeuroNest LLM proxy
 * cutover.
 *
 * The panel intentionally exposes no path back to using a Provider_API_Key
 * for cloud inference. Its only responsibilities are:
 *
 *  - Read the non-secret legacy inventory through the fixed preload method
 *    `listLegacyProviderKeys()` (channel `legacy-provider-keys:list-records-v1`).
 *  - Render one row per legacy record with a masked presence indicator and
 *    the mandatory "unused for NeuroNest cloud routing" label required by
 *    Requirement 7.4.
 *  - Provide a Delete control that submits a request through
 *    `deleteLegacyProviderKey()` (channel
 *    `legacy-provider-keys:delete-record-v1`) so the protected secret is
 *    removed transactionally and idempotently (Requirement 7.5). The
 *    resolved credential value is never observed by the renderer.
 *
 * Local providers (Ollama, llama.cpp, OpenMythos) are outside the migration
 * boundary and are never listed here — their endpoint configuration is
 * preserved unchanged in the main provider settings surface.
 *
 * Requirements: 6.3, 6.4, 6.5, 6.6, 7.2, 7.3, 7.4, 7.5
 *
 * Renderer script contract (see `scripts/copy-renderer.mjs`): plain JS only.
 * No ES import statements, no type annotations. Attaches
 * `window.LegacyProviderKeyPanel` and `window.mountLegacyProviderKeyPanel`
 * for consumption by `src/renderer/index.ts`.
 */

var LEGACY_KEY_UNUSED_LABEL = 'Unused for NeuroNest cloud routing';
var LEGACY_KEY_PRESENT_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022';

function lpkpCssEscape(value) {
  if (typeof globalThis !== 'undefined' && globalThis.CSS && typeof globalThis.CSS.escape === 'function') {
    return globalThis.CSS.escape(value);
  }
  return String(value).replace(/([\0-\x1f\x7f"\\\]\[])/g, '\\$1');
}

function LegacyProviderKeyPanel(container, bridge, options) {
  this.container = container;
  this.bridge = bridge;
  this.logger = (options && typeof options.logger === 'function') ? options.logger : function () {};
  this.destroyed = false;
  this.records = [];
  this.latestStatus = null;
  this.pendingDeleteIds = Object.create(null);
}

LegacyProviderKeyPanel.prototype.render = function () {
  if (this.destroyed) return this;
  this.renderShell('Loading legacy provider keys\u2026');
  var self = this;
  Promise.resolve().then(function () { return self.reload(); }).catch(function () {});
  return this;
};

LegacyProviderKeyPanel.prototype.reload = function () {
  if (this.destroyed) return Promise.resolve(this.records);
  var self = this;
  var call;
  try {
    call = this.bridge.listLegacyProviderKeys();
  } catch (invocationErr) {
    self.records = [];
    self.logger('legacy-provider-key-panel: list failed', invocationErr);
    self.renderError('Legacy provider inventory is unavailable. Cloud requests continue to route through the NeuroNest LLM service.');
    return Promise.resolve(self.records);
  }
  return Promise.resolve(call).then(function (list) {
    if (self.destroyed) return self.records;
    var records = (list && Array.isArray(list.records)) ? list.records : [];
    self.records = records;
    self.renderContent();
    return self.records;
  }, function (error) {
    self.records = [];
    self.logger('legacy-provider-key-panel: list failed', error);
    self.renderError('Legacy provider inventory is unavailable. Cloud requests continue to route through the NeuroNest LLM service.');
    return self.records;
  });
};

LegacyProviderKeyPanel.prototype.dispose = function () {
  this.destroyed = true;
  if (this.container && typeof this.container.replaceChildren === 'function') {
    this.container.replaceChildren();
  } else if (this.container) {
    this.container.innerHTML = '';
  }
};

// Test-friendly accessors — never exposed on the DOM.
LegacyProviderKeyPanel.prototype.getRenderedRecordsForTests = function () {
  return this.records;
};

LegacyProviderKeyPanel.prototype.getStatusForTests = function () {
  return this.latestStatus;
};

LegacyProviderKeyPanel.prototype.renderShell = function (placeholderMessage) {
  if (this.container.replaceChildren) {
    this.container.replaceChildren();
  } else {
    this.container.innerHTML = '';
  }

  var heading = document.createElement('h3');
  heading.textContent = 'Legacy provider keys (cleanup)';
  heading.style.cssText = 'margin:0 0 4px;font-size:14px;color:var(--text-primary);';
  this.container.appendChild(heading);

  var description = document.createElement('p');
  description.style.cssText = 'margin:0 0 12px;font-size:12px;line-height:1.5;color:var(--text-secondary);';
  description.textContent = 'These entries were saved before NeuroNest routed cloud requests through the LLM service. Delete them to remove any stored API key from local storage.';
  this.container.appendChild(description);

  var status = document.createElement('div');
  status.setAttribute('data-role', 'legacy-key-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'font-size:12px;color:var(--text-dim);min-height:16px;margin-bottom:8px;';
  status.textContent = placeholderMessage || '';
  this.container.appendChild(status);
  this.latestStatus = placeholderMessage || null;

  var list = document.createElement('div');
  list.setAttribute('data-role', 'legacy-key-list');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
  this.container.appendChild(list);
};

LegacyProviderKeyPanel.prototype.renderContent = function () {
  this.renderShell('');
  var listEl = this.container.querySelector('div[data-role="legacy-key-list"]');
  var statusEl = this.container.querySelector('div[data-role="legacy-key-status"]');
  if (!listEl || !statusEl) return;

  if (!this.records || this.records.length === 0) {
    statusEl.textContent = 'No legacy provider keys remain. Cloud requests use the NeuroNest LLM service exclusively.';
    this.latestStatus = statusEl.textContent;
    return;
  }

  statusEl.textContent = '';
  this.latestStatus = null;

  for (var i = 0; i < this.records.length; i++) {
    listEl.appendChild(this.buildRow(this.records[i]));
  }
};

LegacyProviderKeyPanel.prototype.renderError = function (message) {
  this.renderShell('');
  var statusEl = this.container.querySelector('div[data-role="legacy-key-status"]');
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.style.color = 'var(--red, #f44)';
  this.latestStatus = message;
};

LegacyProviderKeyPanel.prototype.buildRow = function (record) {
  var self = this;
  var row = document.createElement('div');
  row.setAttribute('data-role', 'legacy-key-row');
  row.setAttribute('data-provider-id', record.providerId);
  row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-input);';

  var left = document.createElement('div');
  left.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;';

  var name = document.createElement('div');
  name.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);';
  name.textContent = record.displayName || record.providerType || record.providerId;
  left.appendChild(name);

  var meta = document.createElement('div');
  meta.style.cssText = 'font-size:11px;color:var(--text-dim);';
  var maskDisplay = (record.hasApiKey && record.apiKeyMask) ? record.apiKeyMask : LEGACY_KEY_PRESENT_MASK;
  var maskText = record.hasApiKey ? ('API key stored: ' + maskDisplay) : 'API key already removed';
  meta.textContent = (String(record.providerType || '').toUpperCase()) + ' \u00b7 ' + maskText;
  left.appendChild(meta);

  var notice = document.createElement('div');
  notice.style.cssText = 'font-size:11px;color:var(--text-secondary);';
  notice.textContent = LEGACY_KEY_UNUSED_LABEL;
  left.appendChild(notice);

  row.appendChild(left);

  var button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('data-action', 'delete-legacy-key');
  button.textContent = 'Delete';
  button.style.cssText = 'padding:6px 12px;font-size:12px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-primary);cursor:pointer;';
  button.disabled = !!this.pendingDeleteIds[record.providerId];
  button.addEventListener('click', function () {
    self.handleDelete(record).catch(function () {});
  });
  row.appendChild(button);

  return row;
};

LegacyProviderKeyPanel.prototype.handleDelete = function (record) {
  var self = this;
  if (this.destroyed) return Promise.resolve(null);
  if (this.pendingDeleteIds[record.providerId]) return Promise.resolve(null);
  this.pendingDeleteIds[record.providerId] = true;
  this.setStatus('Deleting stored key for ' + record.displayName + '\u2026', 'pending');

  var call;
  try {
    call = this.bridge.deleteLegacyProviderKey({
      schemaVersion: 1,
      providerId: record.providerId,
    });
  } catch (invocationErr) {
    self.logger('legacy-provider-key-panel: delete failed', invocationErr);
    self.setStatus('Could not remove the stored key for ' + record.displayName + '. Try again shortly.', 'error');
    delete self.pendingDeleteIds[record.providerId];
    self.reEnableDeleteButton(record.providerId);
    return Promise.resolve(null);
  }

  return Promise.resolve(call).then(function (result) {
    if (self.destroyed) return result;
    return self.reload().then(function () {
      var successMessage;
      if (result && result.deleted) {
        successMessage = 'Removed stored key for ' + record.displayName + '.';
      } else if (result && result.alreadyRemoved) {
        successMessage = 'Stored key for ' + record.displayName + ' was already removed.';
      } else {
        successMessage = 'No stored key was present for ' + record.displayName + '.';
      }
      self.setStatus(successMessage, 'ok');
      delete self.pendingDeleteIds[record.providerId];
      return result;
    });
  }, function (error) {
    self.logger('legacy-provider-key-panel: delete failed', error);
    self.setStatus('Could not remove the stored key for ' + record.displayName + '. Try again shortly.', 'error');
    delete self.pendingDeleteIds[record.providerId];
    self.reEnableDeleteButton(record.providerId);
    return null;
  });
};

LegacyProviderKeyPanel.prototype.reEnableDeleteButton = function (providerId) {
  var selector = 'div[data-role="legacy-key-row"][data-provider-id="' + lpkpCssEscape(providerId) + '"] button[data-action="delete-legacy-key"]';
  var button = this.container.querySelector(selector);
  if (button) button.disabled = false;
};

LegacyProviderKeyPanel.prototype.setStatus = function (message, variant) {
  var statusEl = this.container.querySelector('div[data-role="legacy-key-status"]');
  if (!statusEl) return;
  statusEl.textContent = message;
  var color;
  if (variant === 'error') color = 'var(--red, #f44)';
  else if (variant === 'ok') color = 'var(--green, #38a169)';
  else color = 'var(--text-dim)';
  statusEl.style.color = color;
  this.latestStatus = message;
};

/**
 * Convenience factory: create and immediately render a panel. Callers own
 * the container lifecycle and should invoke `dispose()` on teardown.
 */
function mountLegacyProviderKeyPanel(container, bridge, options) {
  var panel = new LegacyProviderKeyPanel(container, bridge, options || {});
  panel.render();
  return panel;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LEGACY_KEY_UNUSED_LABEL: LEGACY_KEY_UNUSED_LABEL,
    LEGACY_KEY_PRESENT_MASK: LEGACY_KEY_PRESENT_MASK,
    LegacyProviderKeyPanel: LegacyProviderKeyPanel,
    mountLegacyProviderKeyPanel: mountLegacyProviderKeyPanel,
  };
}

if (typeof window !== 'undefined') {
  window.LegacyProviderKeyPanel = LegacyProviderKeyPanel;
  window.mountLegacyProviderKeyPanel = mountLegacyProviderKeyPanel;
}
