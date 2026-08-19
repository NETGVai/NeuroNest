// @ts-nocheck
/**
 * Restricted first-run launch-mode selector.
 *
 * This surface deliberately knows only about the fixed launch-settings API. It
 * does not initialize the workspace or query edition/entitlement state.
 *
 * Requirements: 1.2, 1.3, 1.5, 4.1
 */

var FIRST_RUN_LAUNCH_MODE_OPTIONS = [
  {
    id: 'classic',
    name: 'Classic',
    description: 'Hides the right-side Inspector panel for a streamlined workspace.',
  },
  {
    id: 'advanced',
    name: 'Advanced',
    description: 'Shows the complete current interface, including the right-side Inspector panel.',
  },
];

function frmsCreateElement(tag, styles, attributes) {
  var element = document.createElement(tag);
  if (styles) element.style.cssText = styles;
  if (attributes) {
    for (var key in attributes) {
      if (Object.prototype.hasOwnProperty.call(attributes, key)) {
        element.setAttribute(key, attributes[key]);
      }
    }
  }
  return element;
}

function frmsIsValidSettings(settings) {
  return !!settings
    && (settings.mode === null || settings.mode === 'classic' || settings.mode === 'advanced')
    && Number.isInteger(settings.revision)
    && settings.revision > 0;
}

function FirstRunModeSelector(container, bridge, options) {
  this.container = container;
  this.bridge = bridge;
  this.onSaved = options && typeof options.onSaved === 'function'
    ? options.onSaved
    : function () {};
  this.settings = null;
  this.selectedMode = null;
  this.inputs = [];
  this.fieldset = null;
  this.submitButton = null;
  this.statusElement = null;
  this.loadFailed = false;
  this.refreshBeforeRetry = false;
  this.destroyed = false;
}

FirstRunModeSelector.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.setAttribute('data-restricted-surface', 'first-run-mode-selector');

  var surface = frmsCreateElement(
    'main',
    'min-height:100%;display:flex;align-items:center;justify-content:center;padding:32px;background:var(--bg-primary,#111827);color:var(--text-primary,#f3f4f6);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Helvetica Neue",sans-serif;',
    { 'aria-labelledby': 'first-run-mode-title' },
  );
  var card = frmsCreateElement(
    'section',
    'width:min(720px,100%);padding:32px;border:1px solid var(--border-color,#374151);border-radius:16px;background:var(--surface-container,#1f2937);box-shadow:0 20px 50px rgba(0,0,0,.28);',
  );
  var eyebrow = frmsCreateElement(
    'p',
    'margin:0 0 8px;color:var(--accent,#60a5fa);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;',
  );
  eyebrow.textContent = 'First-run setup';
  var heading = frmsCreateElement('h1', 'margin:0;font-size:28px;line-height:1.2;', {
    id: 'first-run-mode-title',
  });
  heading.textContent = 'Choose how NeuroNest opens';
  var introduction = frmsCreateElement(
    'p',
    'margin:12px 0 24px;color:var(--text-secondary,#cbd5e1);font-size:14px;line-height:1.6;',
    { id: 'first-run-mode-description' },
  );
  introduction.textContent = 'Classic and Advanced are available in every NeuroNest edition. You must choose a mode before the main workspace opens.';

  var form = frmsCreateElement('form', '', {
    'aria-describedby': 'first-run-mode-description first-run-mode-status',
  });
  this.fieldset = frmsCreateElement(
    'fieldset',
    'margin:0;padding:0;border:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;',
  );
  this.fieldset.disabled = true;
  var legend = frmsCreateElement('legend', 'margin:0 0 12px;font-size:14px;font-weight:700;');
  legend.textContent = 'Application mode';
  this.fieldset.appendChild(legend);

  this.inputs = [];
  for (var index = 0; index < FIRST_RUN_LAUNCH_MODE_OPTIONS.length; index++) {
    var option = FIRST_RUN_LAUNCH_MODE_OPTIONS[index];
    var label = frmsCreateElement(
      'label',
      'display:flex;align-items:flex-start;gap:12px;padding:18px;border:2px solid var(--border-color,#374151);border-radius:12px;background:var(--bg-input,#111827);cursor:pointer;',
      { 'data-launch-mode-option': option.id },
    );
    var input = frmsCreateElement('input', 'margin-top:4px;accent-color:var(--accent,#60a5fa);', {
      id: 'first-run-mode-' + option.id,
      type: 'radio',
      name: 'first-run-launch-mode',
      value: option.id,
      'aria-describedby': 'first-run-mode-' + option.id + '-description',
    });
    input.addEventListener('change', function (event) {
      self.selectedMode = event.currentTarget.value;
      self.refreshBeforeRetry = false;
      self.updateSelectionState();
      self.setStatus('');
    });

    var copy = frmsCreateElement('span', 'display:block;min-width:0;');
    var name = frmsCreateElement('span', 'display:block;font-size:16px;font-weight:700;');
    name.textContent = option.name;
    var description = frmsCreateElement(
      'span',
      'display:block;margin-top:6px;color:var(--text-secondary,#cbd5e1);font-size:13px;line-height:1.5;',
      { id: 'first-run-mode-' + option.id + '-description' },
    );
    description.textContent = option.description;
    copy.appendChild(name);
    copy.appendChild(description);
    label.appendChild(input);
    label.appendChild(copy);
    this.fieldset.appendChild(label);
    this.inputs.push(input);
  }

  this.statusElement = frmsCreateElement(
    'p',
    'min-height:20px;margin:16px 0 0;color:var(--text-secondary,#cbd5e1);font-size:13px;line-height:1.5;',
    {
      id: 'first-run-mode-status',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    },
  );
  this.submitButton = frmsCreateElement(
    'button',
    'width:100%;margin-top:12px;padding:12px 18px;border:0;border-radius:9px;background:var(--accent,#2563eb);color:#fff;font:inherit;font-weight:700;cursor:pointer;',
    { type: 'submit' },
  );
  this.submitButton.textContent = 'Continue';
  this.submitButton.disabled = true;

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (self.loadFailed) {
      self.load();
      return;
    }
    self.save();
  });

  form.appendChild(this.fieldset);
  form.appendChild(this.statusElement);
  form.appendChild(this.submitButton);
  card.appendChild(eyebrow);
  card.appendChild(heading);
  card.appendChild(introduction);
  card.appendChild(form);
  surface.appendChild(card);
  this.container.appendChild(surface);

  this.load();
  return this;
};

FirstRunModeSelector.prototype.setStatus = function (message, isError) {
  if (!this.statusElement) return;
  this.statusElement.textContent = message || '';
  this.statusElement.style.color = isError ? 'var(--red,#fca5a5)' : 'var(--text-secondary,#cbd5e1)';
  this.statusElement.setAttribute('role', isError ? 'alert' : 'status');
};

FirstRunModeSelector.prototype.setBusy = function (busy) {
  if (this.fieldset) this.fieldset.disabled = !!busy || !this.settings || this.loadFailed;
  if (this.submitButton) {
    this.submitButton.disabled = !!busy || (!this.loadFailed && !this.selectedMode);
    this.submitButton.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
};

FirstRunModeSelector.prototype.updateSelectionState = function () {
  for (var index = 0; index < this.inputs.length; index++) {
    var input = this.inputs[index];
    input.checked = input.value === this.selectedMode;
    var label = input.closest('[data-launch-mode-option]');
    if (label) {
      label.style.borderColor = input.checked ? 'var(--accent,#60a5fa)' : 'var(--border-color,#374151)';
    }
  }
  this.setBusy(false);
};

FirstRunModeSelector.prototype.finish = function (settings) {
  this.settings = settings;
  this.selectedMode = settings.mode;
  this.updateSelectionState();
  this.setBusy(true);
  this.setStatus((settings.mode === 'classic' ? 'Classic' : 'Advanced') + ' saved. Opening NeuroNest…');
  this.onSaved(settings);
};

FirstRunModeSelector.prototype.load = function () {
  var self = this;
  var readSettings = this.bridge && this.bridge.getLaunchModeSettings;
  this.loadFailed = false;
  this.settings = null;
  this.setBusy(true);
  this.setStatus('Loading launch-mode settings…');
  if (this.submitButton) this.submitButton.textContent = 'Continue';

  if (typeof readSettings !== 'function') {
    this.showLoadFailure();
    return Promise.resolve(null);
  }

  return Promise.resolve(readSettings.call(this.bridge)).then(function (settings) {
    if (self.destroyed) return null;
    if (!frmsIsValidSettings(settings)) throw new Error('Invalid launch-mode settings response');
    if (settings.mode === 'classic' || settings.mode === 'advanced') {
      self.finish(settings);
      return settings;
    }
    self.settings = settings;
    self.selectedMode = null;
    self.updateSelectionState();
    self.setStatus('Choose a mode to continue.');
    if (self.inputs[0]) self.inputs[0].focus();
    return settings;
  }).catch(function () {
    if (self.destroyed) return null;
    self.showLoadFailure();
    return null;
  });
};

FirstRunModeSelector.prototype.showLoadFailure = function () {
  this.loadFailed = true;
  this.settings = null;
  this.setBusy(false);
  if (this.fieldset) this.fieldset.disabled = true;
  if (this.submitButton) {
    this.submitButton.disabled = false;
    this.submitButton.textContent = 'Retry loading';
  }
  this.setStatus('Unable to load launch-mode settings. The workspace remains closed; try again.', true);
};

FirstRunModeSelector.prototype.save = function () {
  var self = this;
  var readSettings = this.bridge && this.bridge.getLaunchModeSettings;
  var updateMode = this.bridge && this.bridge.updateLaunchMode;
  if (!this.selectedMode || typeof updateMode !== 'function' || !this.settings) return Promise.resolve(null);

  var selectedMode = this.selectedMode;
  this.setBusy(true);
  this.setStatus(this.refreshBeforeRetry ? 'Refreshing settings before retry…' : 'Saving launch mode…');

  var settingsPromise = this.refreshBeforeRetry && typeof readSettings === 'function'
    ? Promise.resolve(readSettings.call(this.bridge))
    : Promise.resolve(this.settings);

  return settingsPromise.then(function (settings) {
    if (!frmsIsValidSettings(settings)) throw new Error('Invalid launch-mode settings response');
    if (settings.mode === selectedMode) {
      self.finish(settings);
      return settings;
    }
    return Promise.resolve(updateMode.call(self.bridge, {
      schemaVersion: 1,
      mode: selectedMode,
      expectedRevision: settings.revision,
    })).then(function (updated) {
      if (!frmsIsValidSettings(updated) || updated.mode !== selectedMode) {
        throw new Error('Invalid launch-mode update response');
      }
      self.finish(updated);
      return updated;
    });
  }).catch(function () {
    if (self.destroyed) return null;
    self.refreshBeforeRetry = true;
    self.loadFailed = false;
    self.setBusy(false);
    self.updateSelectionState();
    if (self.submitButton) self.submitButton.textContent = 'Retry saving';
    self.setStatus('Unable to save. Your selection is retained and the workspace remains closed. Try again.', true);
    return null;
  });
};

FirstRunModeSelector.prototype.destroy = function () {
  this.destroyed = true;
  this.container.innerHTML = '';
};

function mountFirstRunModeSelector() {
  var root = document.getElementById('first-run-mode-selector-root');
  if (!root || !window.electronAPI) return null;
  return new FirstRunModeSelector(root, window.electronAPI).render();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FIRST_RUN_LAUNCH_MODE_OPTIONS: FIRST_RUN_LAUNCH_MODE_OPTIONS,
    FirstRunModeSelector: FirstRunModeSelector,
    mountFirstRunModeSelector: mountFirstRunModeSelector,
  };
}

if (typeof window !== 'undefined') {
  window.FirstRunModeSelector = FirstRunModeSelector;
  window.mountFirstRunModeSelector = mountFirstRunModeSelector;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountFirstRunModeSelector, { once: true });
  } else {
    mountFirstRunModeSelector();
  }
}
