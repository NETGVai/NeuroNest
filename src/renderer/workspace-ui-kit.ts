// @ts-nocheck
/**
 * Workspace UI Kit — Shared UI components for all workspace panels.
 *
 * Exposes window.wk namespace with:
 * - wk.toast(msg, type)       — shorthand for showThemedToast
 * - wk.form(container, fields, onSave, onCancel) — renders themed inline form
 * - wk.card(data, template)   — renders themed data card
 * - wk.emptyState(icon, title, subtitle) — renders empty state
 * - wk.badge(text, variant)   — renders status badge (success/error/warning/info)
 * - wk.progress(value, max)   — renders progress bar
 * - wk.toggle(checked, onChange) — renders toggle switch
 * - wk.confirm(message, onConfirm) — renders inline confirmation dialog
 * - wk.dataView(container, data) — renders formatted object/array display
 * - wk.copyButton(text)       — renders click-to-copy button
 *
 * All components use CSS variables from the NeuroNest theme system.
 * Renderer constraint: Plain JavaScript (var, no type annotations).
 */

(function() {
  'use strict';

  // ─── Inject Styles ───────────────────────────────────────────────

  var styleEl = document.createElement('style');
  styleEl.id = 'wk-ui-kit-styles';
  styleEl.textContent = [
    /* Card component */
    '.wk-card{background:var(--surface-container-high);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:12px 16px;transition:border-color var(--motion-quick),transform var(--motion-quick);}',
    '.wk-card:hover{border-color:var(--accent);transform:scale(1.01);}',

    /* Button variants */
    '.wk-btn-primary{background:var(--accent);color:#fff;border:none;border-radius:var(--radius-xs);padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:all var(--motion-quick);font-family:inherit;}',
    '.wk-btn-primary:hover{background:var(--accent-hover);}',
    '.wk-btn-primary:disabled{opacity:0.5;cursor:not-allowed;}',

    '.wk-btn-secondary{background:transparent;color:var(--text-secondary);border:1px solid var(--border-color);border-radius:var(--radius-xs);padding:6px 14px;font-size:12px;cursor:pointer;transition:all var(--motion-quick);font-family:inherit;}',
    '.wk-btn-secondary:hover{background:var(--surface-hover);}',

    '.wk-btn-danger{background:transparent;color:var(--red);border:1px solid var(--red);border-radius:var(--radius-xs);padding:6px 14px;font-size:12px;cursor:pointer;transition:all var(--motion-quick);font-family:inherit;}',
    '.wk-btn-danger:hover{background:var(--red-container);}',

    /* Input fields */
    '.wk-input{width:100%;padding:8px 12px;border-radius:var(--radius-xs);border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);font-size:12px;font-family:inherit;transition:border-color var(--motion-quick);box-sizing:border-box;}',
    '.wk-input:focus{border-color:var(--accent);outline:none;}',

    '.wk-textarea{width:100%;padding:8px 12px;border-radius:var(--radius-xs);border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);font-size:12px;font-family:inherit;transition:border-color var(--motion-quick);resize:vertical;min-height:60px;box-sizing:border-box;}',
    '.wk-textarea:focus{border-color:var(--accent);outline:none;}',

    '.wk-select{width:100%;padding:8px 12px;border-radius:var(--radius-xs);border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);font-size:12px;font-family:inherit;transition:border-color var(--motion-quick);box-sizing:border-box;-webkit-appearance:none;appearance:none;}',
    '.wk-select:focus{border-color:var(--accent);outline:none;}',

    /* Badge variants */
    '.wk-badge{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;display:inline-block;}',
    '.wk-badge-success{background:var(--green-container);color:var(--green);}',
    '.wk-badge-error{background:var(--red-container);color:var(--red);}',
    '.wk-badge-warning{background:var(--yellow-container);color:var(--yellow);}',
    '.wk-badge-info{background:var(--accent-container);color:var(--accent);}',

    /* Progress bar */
    '.wk-progress{height:4px;background:var(--surface-container-high);border-radius:2px;overflow:hidden;}',
    '.wk-progress-fill{height:100%;background:var(--accent);transition:width var(--motion-standard);border-radius:2px;}',

    /* Toggle switch */
    '.wk-toggle{width:36px;height:20px;border-radius:10px;background:var(--surface-container-highest);cursor:pointer;position:relative;transition:background var(--motion-quick);display:inline-block;vertical-align:middle;border:none;padding:0;}',
    '.wk-toggle.active{background:var(--accent);}',
    ".wk-toggle::after{content:'';position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;top:2px;left:2px;transition:transform var(--motion-quick);box-shadow:0 1px 3px rgba(0,0,0,0.3);}",
    '.wk-toggle.active::after{transform:translateX(16px);}',

    /* Tab bar */
    '.wk-tabs{display:flex;gap:0;border-bottom:1px solid var(--border-color);margin-bottom:16px;}',
    '.wk-tab{padding:8px 14px;font-size:12px;color:var(--text-secondary);border:none;background:none;border-bottom:2px solid transparent;cursor:pointer;transition:all var(--motion-quick);font-family:inherit;}',
    '.wk-tab:hover{color:var(--text-primary);}',
    '.wk-tab.active{color:var(--accent);border-bottom-color:var(--accent);}',

    /* Empty state */
    '.wk-empty{text-align:center;padding:48px 24px;}',
    '.wk-empty-icon{font-size:32px;margin-bottom:12px;opacity:0.6;}',
    '.wk-empty-title{font-size:14px;color:var(--text-primary);font-weight:500;margin-bottom:4px;}',
    '.wk-empty-subtitle{font-size:12px;color:var(--text-dim);}',

    /* Scrollbar */
    '.wk-scroll::-webkit-scrollbar{width:6px;}',
    '.wk-scroll::-webkit-scrollbar-track{background:transparent;}',
    '.wk-scroll::-webkit-scrollbar-thumb{background:var(--surface-container-highest);border-radius:3px;}',

    /* Form */
    '.wk-form{background:var(--surface-container);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:16px;margin-top:8px;margin-bottom:12px;animation:wkSlideDown 0.2s ease;}',
    '.wk-form-row{margin-bottom:10px;}',
    '.wk-form-label{display:block;font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;font-weight:600;}',
    '.wk-form-actions{display:flex;gap:8px;margin-top:12px;}',

    /* Confirm dialog */
    '.wk-confirm{background:var(--surface-container-high);border:1px solid var(--red);border-radius:var(--radius-sm);padding:14px 16px;margin-top:8px;animation:wkSlideDown 0.2s ease;}',
    '.wk-confirm-msg{font-size:13px;color:var(--text-primary);margin-bottom:10px;}',
    '.wk-confirm-actions{display:flex;gap:8px;}',

    /* Data view */
    '.wk-data-view{background:var(--surface-container);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:12px;margin-top:8px;max-height:300px;overflow-y:auto;}',
    '.wk-data-row{display:flex;justify-content:space-between;align-items:flex-start;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px;}',
    '.wk-data-row:last-child{border-bottom:none;}',
    '.wk-data-key{color:var(--text-dim);font-weight:600;flex-shrink:0;margin-right:12px;}',
    ".wk-data-value{color:var(--text-primary);word-break:break-word;text-align:right;flex:1;font-family:'SF Mono',Menlo,monospace;font-size:11px;}",

    /* Copy button */
    '.wk-copy-btn{background:var(--surface-container-high);border:1px solid var(--border-color);border-radius:var(--radius-xs);padding:4px 10px;font-size:11px;color:var(--text-secondary);cursor:pointer;transition:all var(--motion-quick);font-family:inherit;display:inline-flex;align-items:center;gap:4px;}',
    '.wk-copy-btn:hover{border-color:var(--accent);color:var(--accent);}',

    /* Fade-in utility */
    '.wk-fade-in{animation:wkFadeIn 0.3s ease forwards;}',

    /* Loading skeleton shimmer */
    '.wk-skeleton{background:linear-gradient(90deg,var(--surface-container-high) 25%,var(--surface-container-highest) 50%,var(--surface-container-high) 75%);background-size:200% 100%;animation:wkShimmer 1.5s infinite;border-radius:var(--radius-xs);height:16px;margin-bottom:8px;}',

    /* Animation */
    '@keyframes wkSlideDown{from{opacity:0;max-height:0;transform:translateY(-4px);}to{opacity:1;max-height:500px;transform:translateY(0);}}',
    '@keyframes wkFadeIn{from{opacity:0;}to{opacity:1;}}',
    '@keyframes wkShimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}',
  ].join('\n');
  document.head.appendChild(styleEl);

  // ─── Helpers ─────────────────────────────────────────────────────

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  // ─── toast ───────────────────────────────────────────────────────

  function toast(msg, type) {
    if (typeof window.showThemedToast === 'function') {
      window.showThemedToast(msg, type || 'info');
    } else {
      console.log('[wk.toast]', type || 'info', msg);
    }
  }

  // ─── form ────────────────────────────────────────────────────────

  function form(container, fields, onSave, onCancel) {
    var wrapper = document.createElement('div');
    wrapper.className = 'wk-form';

    var inputs = {};

    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var row = document.createElement('div');
      row.className = 'wk-form-row';

      var label = document.createElement('label');
      label.className = 'wk-form-label';
      label.textContent = field.label || field.name;
      row.appendChild(label);

      var input;
      if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.className = 'wk-textarea';
        input.placeholder = field.placeholder || '';
        input.rows = field.rows || 3;
      } else if (field.type === 'select') {
        input = document.createElement('select');
        input.className = 'wk-select';
        if (field.options) {
          for (var j = 0; j < field.options.length; j++) {
            var opt = document.createElement('option');
            var optVal = field.options[j];
            if (typeof optVal === 'object') {
              opt.value = optVal.value;
              opt.textContent = optVal.label;
            } else {
              opt.value = optVal;
              opt.textContent = optVal;
            }
            input.appendChild(opt);
          }
        }
      } else {
        input = document.createElement('input');
        input.className = 'wk-input';
        input.type = field.type || 'text';
        input.placeholder = field.placeholder || '';
      }

      input.setAttribute('data-field', field.name);
      if (field.required) input.required = true;
      if (field.value) input.value = field.value;
      inputs[field.name] = input;
      row.appendChild(input);
      wrapper.appendChild(row);
    }

    var actions = document.createElement('div');
    actions.className = 'wk-form-actions';

    var saveBtn = document.createElement('button');
    saveBtn.className = 'wk-btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.setAttribute('aria-label', 'Save form');
    saveBtn.addEventListener('click', function() {
      var data = {};
      var valid = true;
      for (var key in inputs) {
        if (Object.prototype.hasOwnProperty.call(inputs, key)) {
          data[key] = inputs[key].value;
          if (inputs[key].required && !inputs[key].value.trim()) {
            inputs[key].style.borderColor = 'var(--red)';
            valid = false;
          } else {
            inputs[key].style.borderColor = '';
          }
        }
      }
      if (valid && typeof onSave === 'function') {
        onSave(data);
      }
    });

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'wk-btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel form');
    cancelBtn.addEventListener('click', function() {
      wrapper.remove();
      if (typeof onCancel === 'function') {
        onCancel();
      }
    });

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    wrapper.appendChild(actions);

    // Keyboard accessibility
    wrapper.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        saveBtn.click();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelBtn.click();
      }
    });

    container.appendChild(wrapper);
    // Focus first input
    var firstInput = wrapper.querySelector('input, textarea, select');
    if (firstInput) firstInput.focus();

    return wrapper;
  }

  // ─── card ────────────────────────────────────────────────────────

  function card(data, template) {
    var el = document.createElement('div');
    el.className = 'wk-card';
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', 'Data card');

    if (typeof template === 'function') {
      var content = template(data);
      if (typeof content === 'string') {
        el.innerHTML = content;
      } else if (content instanceof HTMLElement) {
        el.appendChild(content);
      }
    } else if (typeof data === 'object' && data !== null) {
      var keys = Object.keys(data);
      for (var i = 0; i < keys.length; i++) {
        var row = document.createElement('div');
        row.className = 'wk-data-row';
        row.innerHTML = '<span class="wk-data-key">' + escHtml(keys[i]) + '</span><span class="wk-data-value">' + escHtml(data[keys[i]]) + '</span>';
        el.appendChild(row);
      }
    } else {
      el.textContent = String(data);
    }

    return el;
  }

  // ─── emptyState ──────────────────────────────────────────────────

  function emptyState(icon, title, subtitle) {
    var el = document.createElement('div');
    el.className = 'wk-empty';
    el.setAttribute('aria-label', title || 'Nothing here yet');
    el.innerHTML = '<div class="wk-empty-icon">' + escHtml(icon || '📭') + '</div>' +
      '<div class="wk-empty-title">' + escHtml(title || 'Nothing here yet') + '</div>' +
      '<div class="wk-empty-subtitle">' + escHtml(subtitle || '') + '</div>';
    return el;
  }

  // ─── badge ───────────────────────────────────────────────────────

  function badge(text, variant) {
    var el = document.createElement('span');
    var variantClass = 'wk-badge-info';
    if (variant === 'success') variantClass = 'wk-badge-success';
    else if (variant === 'error') variantClass = 'wk-badge-error';
    else if (variant === 'warning') variantClass = 'wk-badge-warning';
    else if (variant === 'info') variantClass = 'wk-badge-info';
    el.className = 'wk-badge ' + variantClass;
    el.textContent = text;
    el.setAttribute('aria-label', (variant || 'info') + ' status: ' + text);
    return el;
  }

  // ─── progress ────────────────────────────────────────────────────

  function progress(value, max) {
    var pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
    var el = document.createElement('div');
    el.className = 'wk-progress';
    el.setAttribute('role', 'progressbar');
    el.setAttribute('aria-valuenow', String(value));
    el.setAttribute('aria-valuemax', String(max));
    el.setAttribute('aria-label', 'Progress: ' + Math.round(pct) + '%');
    var fill = document.createElement('div');
    fill.className = 'wk-progress-fill';
    fill.style.width = pct + '%';
    el.appendChild(fill);
    return el;
  }

  // ─── toggle ──────────────────────────────────────────────────────

  function toggle(checked, onChange) {
    var el = document.createElement('button');
    el.className = 'wk-toggle' + (checked ? ' active' : '');
    el.setAttribute('role', 'switch');
    el.setAttribute('aria-checked', String(!!checked));
    el.setAttribute('aria-label', 'Toggle switch');
    el.addEventListener('click', function() {
      var isActive = el.classList.toggle('active');
      el.setAttribute('aria-checked', String(isActive));
      if (typeof onChange === 'function') {
        onChange(isActive);
      }
    });
    return el;
  }

  // ─── confirm ─────────────────────────────────────────────────────

  function confirm(message, onConfirm) {
    var el = document.createElement('div');
    el.className = 'wk-confirm';
    el.setAttribute('tabindex', '-1');

    var msg = document.createElement('div');
    msg.className = 'wk-confirm-msg';
    msg.textContent = message || 'Are you sure?';
    el.appendChild(msg);

    var actions = document.createElement('div');
    actions.className = 'wk-confirm-actions';

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'wk-btn-danger';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.setAttribute('aria-label', 'Confirm action');
    confirmBtn.addEventListener('click', function() {
      el.remove();
      if (typeof onConfirm === 'function') {
        onConfirm();
      }
    });

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'wk-btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel action');
    cancelBtn.addEventListener('click', function() {
      el.remove();
    });

    actions.appendChild(confirmBtn);
    actions.appendChild(cancelBtn);
    el.appendChild(actions);

    // Escape to cancel
    el.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelBtn.click();
      }
    });

    return el;
  }

  // ─── dataView ────────────────────────────────────────────────────

  function dataView(container, data) {
    var wrapper = document.createElement('div');
    wrapper.className = 'wk-data-view wk-scroll';

    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) {
        var item = data[i];
        if (typeof item === 'object' && item !== null) {
          var itemCard = document.createElement('div');
          itemCard.className = 'wk-card';
          itemCard.style.marginBottom = '8px';
          var keys = Object.keys(item);
          for (var j = 0; j < keys.length; j++) {
            var row = document.createElement('div');
            row.className = 'wk-data-row';
            row.innerHTML = '<span class="wk-data-key">' + escHtml(keys[j]) + '</span><span class="wk-data-value">' + escHtml(item[keys[j]]) + '</span>';
            itemCard.appendChild(row);
          }
          wrapper.appendChild(itemCard);
        } else {
          var textRow = document.createElement('div');
          textRow.className = 'wk-data-row';
          textRow.innerHTML = '<span class="wk-data-key">[' + i + ']</span><span class="wk-data-value">' + escHtml(item) + '</span>';
          wrapper.appendChild(textRow);
        }
      }
    } else if (typeof data === 'object' && data !== null) {
      var objKeys = Object.keys(data);
      for (var k = 0; k < objKeys.length; k++) {
        var row2 = document.createElement('div');
        row2.className = 'wk-data-row';
        var val = data[objKeys[k]];
        var displayVal = (typeof val === 'object') ? JSON.stringify(val, null, 2) : String(val);
        row2.innerHTML = '<span class="wk-data-key">' + escHtml(objKeys[k]) + '</span><span class="wk-data-value">' + escHtml(displayVal) + '</span>';
        wrapper.appendChild(row2);
      }
    } else {
      wrapper.textContent = String(data);
    }

    if (container) {
      container.appendChild(wrapper);
    }
    return wrapper;
  }

  // ─── copyButton ──────────────────────────────────────────────────

  function copyButton(text) {
    var btn = document.createElement('button');
    btn.className = 'wk-copy-btn';
    btn.setAttribute('aria-label', 'Copy to clipboard');
    btn.innerHTML = '📋 Copy';

    btn.addEventListener('click', function() {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          btn.innerHTML = '✓ Copied!';
          toast('Copied to clipboard', 'success');
          setTimeout(function() { btn.innerHTML = '📋 Copy'; }, 2000);
        }).catch(function() {
          fallbackCopy(text, btn);
        });
      } else {
        fallbackCopy(text, btn);
      }
    });

    return btn;
  }

  function fallbackCopy(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      btn.innerHTML = '✓ Copied!';
      toast('Copied to clipboard', 'success');
      setTimeout(function() { btn.innerHTML = '📋 Copy'; }, 2000);
    } catch (e) {
      toast('Failed to copy', 'error');
    }
    document.body.removeChild(ta);
  }

  // ─── skeleton ─────────────────────────────────────────────────────

  function skeleton(lines, container) {
    var wrapper = document.createElement('div');
    wrapper.className = 'wk-fade-in';
    wrapper.setAttribute('aria-label', 'Loading content');
    wrapper.setAttribute('role', 'status');
    var count = lines || 3;
    for (var i = 0; i < count; i++) {
      var line = document.createElement('div');
      line.className = 'wk-skeleton';
      // Vary widths for realism
      line.style.width = (70 + Math.random() * 30) + '%';
      wrapper.appendChild(line);
    }
    if (container) {
      container.appendChild(wrapper);
    }
    return wrapper;
  }

  // ─── Export on window.wk ─────────────────────────────────────────

  window.wk = {
    toast: toast,
    form: form,
    card: card,
    emptyState: emptyState,
    badge: badge,
    progress: progress,
    toggle: toggle,
    confirm: confirm,
    dataView: dataView,
    copyButton: copyButton,
    skeleton: skeleton
  };

})();
