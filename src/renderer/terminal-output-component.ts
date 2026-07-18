// @ts-nocheck
/**
 * TerminalOutputComponent — Streaming terminal output with ANSI color support.
 *
 * Streams command output into a workspace panel terminal pane with monospace font,
 * ANSI color rendering, elapsed time display, kill button for long-running commands,
 * color-coded exit codes, and auto-scroll-to-bottom during streaming.
 *
 * Exposed as window.TerminalOutputComponent for workspace panels.
 *
 * API:
 *   var term = new window.TerminalOutputComponent(container, options)
 *   term.start(command)        // Start showing a command being executed
 *   term.appendOutput(text)    // Append streamed output text (supports ANSI codes)
 *   term.finish(exitCode)      // Mark command as complete with exit code
 *   term.kill()                // Programmatically trigger kill
 *   term.clear()               // Clear all output
 *   term.destroy()             // Remove from DOM and clean up
 *
 * Options:
 *   onKill: function()         // Called when kill button clicked
 *   showElapsed: boolean       // Show elapsed time (default: true)
 *   maxLines: number           // Max lines to keep in buffer (default: 5000)
 *
 * Requirements: 8.1-8.5
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 */

(function () {
  'use strict';

  // ─── Inject Component Styles ─────────────────────────────────────

  var styleId = 'terminal-output-component-styles';
  if (!document.getElementById(styleId)) {
    var styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.textContent = [
      '.toc-container{font-family:"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;border:1px solid var(--border-color);border-radius:var(--radius-sm);overflow:hidden;background:var(--bg-primary);display:flex;flex-direction:column;max-height:400px;}',
      '.toc-header{display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--surface-container-high);border-bottom:1px solid var(--border-color);flex-shrink:0;}',
      '.toc-command{font-size:11px;color:var(--accent);font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.toc-command::before{content:"$ ";color:var(--text-dim);}',
      '.toc-elapsed{font-size:10px;color:var(--text-secondary);font-variant-numeric:tabular-nums;min-width:48px;text-align:right;}',
      '.toc-kill-btn{font-size:10px;padding:2px 8px;border-radius:var(--radius-xs);cursor:pointer;font-weight:600;font-family:inherit;background:var(--red-container);color:var(--red);border:1px solid var(--red);transition:all var(--motion-quick);flex-shrink:0;}',
      '.toc-kill-btn:hover{background:var(--red);color:#fff;}',
      '.toc-kill-btn:disabled{opacity:0.4;cursor:not-allowed;}',
      '.toc-body{flex:1;overflow-y:auto;padding:8px 12px;font-size:12px;line-height:1.5;min-height:60px;white-space:pre-wrap;word-break:break-all;color:var(--text-primary);}',
      '.toc-body::-webkit-scrollbar{width:6px;}',
      '.toc-body::-webkit-scrollbar-track{background:transparent;}',
      '.toc-body::-webkit-scrollbar-thumb{background:var(--surface-container-highest);border-radius:3px;}',
      '.toc-footer{display:flex;align-items:center;gap:8px;padding:4px 12px;border-top:1px solid var(--border-color);background:var(--surface-container-high);flex-shrink:0;}',
      '.toc-exit-code{font-size:10px;font-weight:700;padding:2px 8px;border-radius:var(--radius-xs);}',
      '.toc-exit-success{background:var(--green-container);color:var(--green);}',
      '.toc-exit-failure{background:var(--red-container);color:var(--red);}',
      '.toc-status{font-size:10px;color:var(--text-dim);flex:1;}',
      '.toc-scroll-anchor{font-size:9px;padding:2px 6px;border-radius:var(--radius-xs);cursor:pointer;background:var(--surface-container-highest);color:var(--text-secondary);border:none;transition:all var(--motion-quick);flex-shrink:0;}',
      '.toc-scroll-anchor:hover{background:var(--accent-container);color:var(--accent);}',
      /* ANSI color classes */
      '.ansi-black{color:#555555;}',
      '.ansi-red{color:#f87171;}',
      '.ansi-green{color:#4ade80;}',
      '.ansi-yellow{color:#fbbf24;}',
      '.ansi-blue{color:#60a5fa;}',
      '.ansi-magenta{color:#c084fc;}',
      '.ansi-cyan{color:#22d3ee;}',
      '.ansi-white{color:#e2e8f0;}',
      '.ansi-bright-black{color:#6b7280;}',
      '.ansi-bright-red{color:#fca5a5;}',
      '.ansi-bright-green{color:#86efac;}',
      '.ansi-bright-yellow{color:#fde68a;}',
      '.ansi-bright-blue{color:#93c5fd;}',
      '.ansi-bright-magenta{color:#d8b4fe;}',
      '.ansi-bright-cyan{color:#67e8f9;}',
      '.ansi-bright-white{color:#ffffff;}',
      '.ansi-bold{font-weight:700;}',
      '.ansi-dim{opacity:0.6;}',
      '.ansi-italic{font-style:italic;}',
      '.ansi-underline{text-decoration:underline;}',
      '.ansi-bg-black{background:#555555;}',
      '.ansi-bg-red{background:rgba(248,113,113,0.3);}',
      '.ansi-bg-green{background:rgba(74,222,128,0.3);}',
      '.ansi-bg-yellow{background:rgba(251,191,36,0.3);}',
      '.ansi-bg-blue{background:rgba(96,165,250,0.3);}',
      '.ansi-bg-magenta{background:rgba(192,132,252,0.3);}',
      '.ansi-bg-cyan{background:rgba(34,211,238,0.3);}',
      '.ansi-bg-white{background:rgba(226,232,240,0.3);}',
      '.toc-empty{text-align:center;padding:24px 12px;color:var(--text-dim);font-size:11px;font-family:inherit;}',
    ].join('\n');
    document.head.appendChild(styleEl);
  }

  // ─── ANSI Parser ─────────────────────────────────────────────────

  var ANSI_REGEX = /\x1b\[([0-9;]*)m/g;

  var FG_CLASSES = {
    30: 'ansi-black', 31: 'ansi-red', 32: 'ansi-green', 33: 'ansi-yellow',
    34: 'ansi-blue', 35: 'ansi-magenta', 36: 'ansi-cyan', 37: 'ansi-white',
    90: 'ansi-bright-black', 91: 'ansi-bright-red', 92: 'ansi-bright-green',
    93: 'ansi-bright-yellow', 94: 'ansi-bright-blue', 95: 'ansi-bright-magenta',
    96: 'ansi-bright-cyan', 97: 'ansi-bright-white'
  };

  var BG_CLASSES = {
    40: 'ansi-bg-black', 41: 'ansi-bg-red', 42: 'ansi-bg-green', 43: 'ansi-bg-yellow',
    44: 'ansi-bg-blue', 45: 'ansi-bg-magenta', 46: 'ansi-bg-cyan', 47: 'ansi-bg-white'
  };

  function parseAnsi(text) {
    var parts = [];
    var lastIndex = 0;
    var currentClasses = [];
    var match;

    ANSI_REGEX.lastIndex = 0;
    while ((match = ANSI_REGEX.exec(text)) !== null) {
      // Push text before this escape
      if (match.index > lastIndex) {
        parts.push({ text: text.substring(lastIndex, match.index), classes: currentClasses.slice() });
      }
      lastIndex = match.index + match[0].length;

      // Parse codes
      var codes = match[1] ? match[1].split(';').map(function (c) { return parseInt(c, 10); }) : [0];
      for (var i = 0; i < codes.length; i++) {
        var code = codes[i];
        if (code === 0) {
          currentClasses = [];
        } else if (code === 1) {
          currentClasses.push('ansi-bold');
        } else if (code === 2) {
          currentClasses.push('ansi-dim');
        } else if (code === 3) {
          currentClasses.push('ansi-italic');
        } else if (code === 4) {
          currentClasses.push('ansi-underline');
        } else if (FG_CLASSES[code]) {
          // Remove any existing fg class
          currentClasses = currentClasses.filter(function (c) { return c.indexOf('ansi-bg-') === 0 || ['ansi-bold', 'ansi-dim', 'ansi-italic', 'ansi-underline'].indexOf(c) >= 0; });
          currentClasses.push(FG_CLASSES[code]);
        } else if (BG_CLASSES[code]) {
          // Remove any existing bg class
          currentClasses = currentClasses.filter(function (c) { return c.indexOf('ansi-bg-') !== 0; });
          currentClasses.push(BG_CLASSES[code]);
        }
      }
    }

    // Push remaining text
    if (lastIndex < text.length) {
      parts.push({ text: text.substring(lastIndex), classes: currentClasses.slice() });
    }

    return parts;
  }

  function renderAnsiToHtml(text) {
    var parts = parseAnsi(text);
    var html = '';
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var escaped = escHtml(part.text);
      if (part.classes.length > 0) {
        html += '<span class="' + part.classes.join(' ') + '">' + escaped + '</span>';
      } else {
        html += escaped;
      }
    }
    return html;
  }

  // ─── Utility ─────────────────────────────────────────────────────

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function formatElapsed(ms) {
    var seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + 's';
    var minutes = Math.floor(seconds / 60);
    var secs = seconds % 60;
    if (minutes < 60) return minutes + 'm ' + secs + 's';
    var hours = Math.floor(minutes / 60);
    var mins = minutes % 60;
    return hours + 'h ' + mins + 'm';
  }

  // ─── TerminalOutputComponent Constructor ─────────────────────────

  function TerminalOutputComponent(container, options) {
    this.container = container;
    this.options = options || {};
    this.onKill = this.options.onKill || null;
    this.showElapsed = this.options.showElapsed !== false;
    this.maxLines = this.options.maxLines || 5000;

    this.command = '';
    this.running = false;
    this.exitCode = null;
    this.startTime = null;
    this.elapsedTimer = null;
    this.lineCount = 0;
    this.autoScroll = true;

    // DOM references
    this.wrapperEl = null;
    this.headerEl = null;
    this.commandEl = null;
    this.elapsedEl = null;
    this.killBtn = null;
    this.bodyEl = null;
    this.footerEl = null;

    this.render();
  }

  TerminalOutputComponent.prototype.render = function () {
    this.container.innerHTML = '';

    var wrapper = document.createElement('div');
    wrapper.className = 'toc-container';
    wrapper.setAttribute('role', 'log');
    wrapper.setAttribute('aria-label', 'Terminal output');

    // Header
    var header = document.createElement('div');
    header.className = 'toc-header';

    var cmdSpan = document.createElement('span');
    cmdSpan.className = 'toc-command';
    cmdSpan.textContent = this.command || 'No command';
    header.appendChild(cmdSpan);
    this.commandEl = cmdSpan;

    if (this.showElapsed) {
      var elapsedSpan = document.createElement('span');
      elapsedSpan.className = 'toc-elapsed';
      elapsedSpan.textContent = '0s';
      header.appendChild(elapsedSpan);
      this.elapsedEl = elapsedSpan;
    }

    var killBtn = document.createElement('button');
    killBtn.type = 'button';
    killBtn.className = 'toc-kill-btn';
    killBtn.textContent = 'Kill';
    killBtn.setAttribute('aria-label', 'Kill running command');
    killBtn.disabled = !this.running;
    killBtn.style.display = this.running ? '' : 'none';
    var self = this;
    killBtn.addEventListener('click', function () {
      self.handleKill();
    });
    header.appendChild(killBtn);
    this.killBtn = killBtn;

    wrapper.appendChild(header);
    this.headerEl = header;

    // Body (output area)
    var body = document.createElement('div');
    body.className = 'toc-body';
    body.setAttribute('aria-live', 'polite');

    // Auto-scroll detection
    body.addEventListener('scroll', function () {
      var atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
      self.autoScroll = atBottom;
    });

    wrapper.appendChild(body);
    this.bodyEl = body;

    // Footer (shown after completion)
    var footer = document.createElement('div');
    footer.className = 'toc-footer';
    footer.style.display = 'none';
    wrapper.appendChild(footer);
    this.footerEl = footer;

    this.container.appendChild(wrapper);
    this.wrapperEl = wrapper;
  };

  /**
   * Start a new command execution display.
   */
  TerminalOutputComponent.prototype.start = function (command) {
    this.command = command || '';
    this.running = true;
    this.exitCode = null;
    this.startTime = Date.now();
    this.lineCount = 0;
    this.autoScroll = true;

    // Update DOM
    if (this.commandEl) this.commandEl.textContent = this.command;
    if (this.killBtn) {
      this.killBtn.disabled = false;
      this.killBtn.style.display = '';
    }
    if (this.bodyEl) this.bodyEl.innerHTML = '';
    if (this.footerEl) this.footerEl.style.display = 'none';
    if (this.elapsedEl) this.elapsedEl.textContent = '0s';

    // Start elapsed timer
    var self = this;
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = setInterval(function () {
      if (self.startTime && self.elapsedEl) {
        self.elapsedEl.textContent = formatElapsed(Date.now() - self.startTime);
      }
    }, 1000);
  };

  /**
   * Append streamed output text (supports ANSI escape codes).
   */
  TerminalOutputComponent.prototype.appendOutput = function (text) {
    if (!this.bodyEl || !text) return;

    // Split into lines and render with ANSI support
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // For empty lines between splits (except last empty from trailing \n)
      if (i === lines.length - 1 && line === '') continue;

      this.lineCount++;

      // Enforce maxLines by removing oldest lines
      if (this.lineCount > this.maxLines) {
        var firstChild = this.bodyEl.firstChild;
        if (firstChild) this.bodyEl.removeChild(firstChild);
      }

      var lineEl = document.createElement('div');
      lineEl.innerHTML = renderAnsiToHtml(line);
      this.bodyEl.appendChild(lineEl);
    }

    // Auto-scroll to bottom during streaming (Req 8.5)
    if (this.autoScroll) {
      this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
    }
  };

  /**
   * Mark the command as finished with an exit code.
   * Exit code 0 = green (success), non-zero = red (failure). (Req 8.4)
   */
  TerminalOutputComponent.prototype.finish = function (exitCode) {
    this.running = false;
    this.exitCode = exitCode;

    // Stop timer
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }

    // Update elapsed one final time
    if (this.startTime && this.elapsedEl) {
      this.elapsedEl.textContent = formatElapsed(Date.now() - this.startTime);
    }

    // Hide kill button
    if (this.killBtn) {
      this.killBtn.disabled = true;
      this.killBtn.style.display = 'none';
    }

    // Show footer with exit code
    if (this.footerEl) {
      this.footerEl.innerHTML = '';
      this.footerEl.style.display = '';

      var codeEl = document.createElement('span');
      codeEl.className = 'toc-exit-code ' + (exitCode === 0 ? 'toc-exit-success' : 'toc-exit-failure');
      codeEl.textContent = 'Exit: ' + exitCode;
      this.footerEl.appendChild(codeEl);

      var statusEl = document.createElement('span');
      statusEl.className = 'toc-status';
      statusEl.textContent = exitCode === 0 ? 'Command completed successfully' : 'Command failed';
      this.footerEl.appendChild(statusEl);

      // Scroll-to-bottom button
      var scrollBtn = document.createElement('button');
      scrollBtn.type = 'button';
      scrollBtn.className = 'toc-scroll-anchor';
      scrollBtn.textContent = '↓ Bottom';
      scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
      var self = this;
      scrollBtn.addEventListener('click', function () {
        if (self.bodyEl) {
          self.bodyEl.scrollTop = self.bodyEl.scrollHeight;
          self.autoScroll = true;
        }
      });
      this.footerEl.appendChild(scrollBtn);
    }
  };

  /**
   * Handle kill button click.
   */
  TerminalOutputComponent.prototype.handleKill = function () {
    if (!this.running) return;

    // Visually indicate killed state
    this.appendOutput('\n\x1b[31m[Process killed by user]\x1b[0m\n');
    this.finish(-1);

    // Call external handler
    if (this.onKill) {
      this.onKill();
    }

    // Attempt IPC kill if electronAPI available
    var api = window.electronAPI;
    if (api && typeof api.invoke === 'function') {
      api.invoke('terminal:kill', { command: this.command }).catch(function () {
        // Best-effort kill
      });
    }

    if (window.showThemedToast) {
      window.showThemedToast('Process killed', 'info');
    }
  };

  /**
   * Clear all output.
   */
  TerminalOutputComponent.prototype.clear = function () {
    if (this.bodyEl) this.bodyEl.innerHTML = '';
    this.lineCount = 0;
  };

  /**
   * Destroy the component and clean up.
   */
  TerminalOutputComponent.prototype.destroy = function () {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    this.container.innerHTML = '';
    this.onKill = null;
    this.wrapperEl = null;
    this.headerEl = null;
    this.commandEl = null;
    this.elapsedEl = null;
    this.killBtn = null;
    this.bodyEl = null;
    this.footerEl = null;
  };

  // ─── Convenience: wk.terminal ────────────────────────────────────
  // Quick-create for workspace panels: wk.terminal(container, command, options)

  function wkTerminal(container, command, options) {
    var term = new TerminalOutputComponent(container, options || {});
    if (command) {
      term.start(command);
    }
    return term;
  }

  // ─── Expose to Global Scope ──────────────────────────────────────

  if (typeof window !== 'undefined') {
    window.TerminalOutputComponent = TerminalOutputComponent;

    // Attach to wk namespace (workspace-ui-kit.js loads before this script)
    if (window.wk) {
      window.wk.terminal = wkTerminal;
    }
  }

})();
