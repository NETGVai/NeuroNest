// @ts-nocheck
/**
 * LaunchModeSettingsControl — edition-neutral application launch preferences.
 *
 * This renderer component uses only the fixed launch-settings preload methods.
 * It deliberately does not read or write edition, entitlements, provider/model,
 * Inspector layout, or any other application state.
 *
 * Requirements: 1.6, 1.7, 1.9, 4.1, 4.3, 4.4
 */

var LAUNCH_MODE_OPTIONS = [
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

function lmscCreateElement(tag, styles, attributes) {
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

function lmscModeName(mode) {
  return mode === 'classic' ? 'Classic' : 'Advanced';
}

function lmscIsValidSettings(settings) {
  return !!settings &&
    (settings.mode === 'classic' || settings.mode === 'advanced' || settings.mode === null) &&
    typeof settings.revision === 'number' &&
    Number.isInteger(settings.revision) &&
    settings.revision > 0;
}

function LaunchModeSettingsControl(container, bridge) {
  this.container = container;
  this.bridge = bridge;
  this.settings = null;
  this.pendingMode = null;
  this.inputs = [];
  this.saveButton = null;
  this.retryButton = null;
  this.statusElement = null;
  this.destroyed = false;
}

LaunchModeSettingsControl.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';

  var introduction = lmscCreateElement(
    'p',
    'margin:0 0 12px;font-size:12px;line-height:1.5;color:var(--text-secondary);',
  );
  introduction.textContent = 'Choose how NeuroNest starts. Both modes are available in every edition.';
  this.container.appendChild(introduction);

  var fieldset = lmscCreateElement(
    'fieldset',
    'margin:0;padding:0;border:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;',
  );
  var legend = lmscCreateElement('legend', 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;');
  legend.textContent = 'Application launch mode';
  fieldset.appendChild(legend);

  this.inputs = [];
  for (var index = 0; index < LAUNCH_MODE_OPTIONS.length; index++) {
    var option = LAUNCH_MODE_OPTIONS[index];
    var label = lmscCreateElement(
      'label',
      'display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-input);cursor:pointer;',
      { 'data-launch-mode-option': option.id },
    );
    var input = lmscCreateElement('input', 'margin-top:3px;accent-color:var(--accent);', {
      type: 'radio',
      name: 'application-launch-mode',
      value: option.id,
    });
    input.disabled = true;
    input.addEventListener('change', function (event) {
      self.pendingMode = event.currentTarget.value;
      self.updateSelectionState();
    });

    var copy = lmscCreateElement('span', 'display:block;min-width:0;');
    var name = lmscCreateElement('span', 'display:block;font-size:13px;font-weight:600;color:var(--text-primary);');
    name.textContent = option.name;
    var description = lmscCreateElement('span', 'display:block;margin-top:3px;font-size:11px;line-height:1.45;color:var(--text-dim);');
    description.textContent = option.description;
    copy.appendChild(name);
    copy.appendChild(description);
    label.appendChild(input);
    label.appendChild(copy);
    fieldset.appendChild(label);
    this.inputs.push(input);
  }
  this.container.appendChild(fieldset);

  var actions = lmscCreateElement('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;');
  this.saveButton = lmscCreateElement('button', '', { type: 'button', class: 'setting-btn' });
  this.saveButton.textContent = 'Save launch mode';
  this.saveButton.disabled = true;
  this.saveButton.addEventListener('click', function () { self.save(); });
  actions.appendChild(this.saveButton);

  this.retryButton = lmscCreateElement('button', '', { type: 'button', class: 'setting-btn' });
  this.retryButton.textContent = 'Retry loading';
  this.retryButton.hidden = true;
  this.retryButton.addEventListener('click', function () { self.load(); });
  actions.appendChild(this.retryButton);

  this.statusElement = lmscCreateElement('span', 'font-size:11px;color:var(--text-dim);', {
    role: 'status',
    'aria-live': 'polite',
  });
  actions.appendChild(this.statusElement);
  this.container.appendChild(actions);

  var restartNotice = lmscCreateElement(
    'p',
    'margin:10px 0 0;font-size:11px;line-height:1.45;color:var(--text-dim);',
    { 'data-launch-mode-next-launch': 'true' },
  );
  restartNotice.textContent = 'Mode switches instantly — no restart required.';
  this.container.appendChild(restartNotice);

  this.load();
  return this;
};

LaunchModeSettingsControl.prototype.setStatus = function (message, color) {
  if (!this.statusElement) return;
  this.statusElement.textContent = message || '';
  this.statusElement.style.color = color || 'var(--text-dim)';
};

LaunchModeSettingsControl.prototype.setBusy = function (busy) {
  for (var index = 0; index < this.inputs.length; index++) {
    this.inputs[index].disabled = !!busy;
  }
  if (this.saveButton) this.saveButton.disabled = !!busy || !this.canSave();
};

LaunchModeSettingsControl.prototype.canSave = function () {
  return !!this.settings &&
    (this.pendingMode === 'classic' || this.pendingMode === 'advanced') &&
    this.pendingMode !== this.settings.mode;
};

LaunchModeSettingsControl.prototype.updateSelectionState = function () {
  for (var index = 0; index < this.inputs.length; index++) {
    var input = this.inputs[index];
    input.checked = input.value === this.pendingMode;
    var optionLabel = input.closest('[data-launch-mode-option]');
    if (optionLabel) {
      optionLabel.style.borderColor = input.checked ? 'var(--accent)' : 'var(--border-color)';
    }
  }
  if (this.saveButton) this.saveButton.disabled = !this.canSave();
};

LaunchModeSettingsControl.prototype.load = function () {
  var self = this;
  var getSettings = this.bridge && this.bridge.getLaunchModeSettings;
  if (typeof getSettings !== 'function') {
    this.setStatus('Launch-mode settings are unavailable.', 'var(--red)');
    if (this.retryButton) this.retryButton.hidden = false;
    return Promise.resolve(null);
  }

  this.setBusy(true);
  if (this.retryButton) this.retryButton.hidden = true;
  this.setStatus('Loading saved launch mode…');
  return Promise.resolve(getSettings.call(this.bridge)).then(function (settings) {
    if (self.destroyed) return null;
    if (!lmscIsValidSettings(settings)) throw new Error('Invalid launch-mode settings response');
    self.settings = settings;
    self.pendingMode = settings.mode;
    self.updateSelectionState();
    self.setBusy(false);
    self.setStatus(settings.mode ? lmscModeName(settings.mode) + ' is saved.' : 'Choose a launch mode to save.');
    return settings;
  }).catch(function () {
    if (self.destroyed) return null;
    self.setBusy(true);
    if (self.retryButton) self.retryButton.hidden = false;
    self.setStatus('Unable to load launch-mode settings. Try again.', 'var(--red)');
    return null;
  });
};

LaunchModeSettingsControl.prototype.save = function () {
  var self = this;
  var updateSettings = this.bridge && this.bridge.updateLaunchMode;
  if (!this.canSave() || typeof updateSettings !== 'function') {
    if (typeof updateSettings !== 'function') {
      this.setStatus('Launch-mode settings are unavailable.', 'var(--red)');
    }
    return Promise.resolve(null);
  }

  var selectedMode = this.pendingMode;
  var request = {
    schemaVersion: 1,
    mode: selectedMode,
    expectedRevision: this.settings.revision,
  };
  this.setBusy(true);
  this.setStatus('Saving…');

  return Promise.resolve(updateSettings.call(this.bridge, request)).then(function (settings) {
    if (self.destroyed) return null;
    if (!lmscIsValidSettings(settings) || settings.mode !== selectedMode) {
      throw new Error('Invalid launch-mode update response');
    }
    self.settings = settings;
    self.pendingMode = settings.mode;
    self.updateSelectionState();
    self.setBusy(false);
    self.setStatus(lmscModeName(settings.mode) + ' mode applied.', 'var(--green)');
    return settings;
  }).catch(function () {
    if (self.destroyed) return null;
    self.setBusy(false);
    self.updateSelectionState();
    self.setStatus('Unable to save. Your selection is retained; try again.', 'var(--red)');
    return null;
  });
};

LaunchModeSettingsControl.prototype.destroy = function () {
  this.destroyed = true;
  this.container.innerHTML = '';
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LAUNCH_MODE_OPTIONS: LAUNCH_MODE_OPTIONS,
    LaunchModeSettingsControl: LaunchModeSettingsControl,
  };
}

if (typeof window !== 'undefined') {
  window.LaunchModeSettingsControl = LaunchModeSettingsControl;
}
