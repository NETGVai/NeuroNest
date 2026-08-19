// @ts-nocheck
/**
 * Advanced-only Inspector lifecycle factory.
 *
 * This module owns the previously-static `<aside id="inspector">` markup that
 * used to live in `src/renderer/index.html`. The DOM, drag handle, resize/
 * collapse listeners, keyboard focus targets, and Inspector-only startup
 * subscriptions must exist only when the resolved launch mode is `advanced`.
 *
 * Classic mode MUST NOT construct the Inspector element, the drag handle, or
 * a reserved grid track for the panel, and MUST NOT issue startup requests
 * (for example the eager `get-departments` fetch) that exist solely to
 * populate a hidden Inspector.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3
 *
 * Plain-JS style — no ES import/export syntax so the file survives the
 * `scripts/copy-renderer.mjs` parse-check that ships `index.ts` and its
 * companions as raw browser scripts. Cross-file consumers use the
 * `window.InspectorFactory` global; unit tests use the `module.exports`
 * fallback below.
 */

// ── Constants ────────────────────────────────────────────────────────────

var INSPECTOR_ELEMENT_ID = 'inspector';
var INSPECTOR_DRAG_HANDLE_ID = 'drag-inspector';

/**
 * Ordered list of every element the Inspector owns exclusively. Used by tests
 * and static checks to prove Classic mode does not leak any of these ids into
 * the DOM. Kept in sync with `INSPECTOR_STATIC_INNER_MARKUP` below.
 */
var INSPECTOR_OWNED_ELEMENT_IDS = [
  'dept-list',
  'inspector-headroom-section',
  'headroom-status-pill',
  'headroom-toggle',
  'headroom-toggle-knob',
  'headroom-saved',
  'headroom-ratio',
  'headroom-runs',
  'headroom-foot',
  'headroom-foot-msg',
  'headroom-proxy-url',
  'headroom-reset',
  'treemap-file-count',
  'treemap-expand-btn',
  'sidebar-treemap',
  'clear-agents-btn',
  'active-agents',
  'inspector-schemas-section',
  'inspector-schema-create',
  'inspector-schema-help',
  'inspector-schema-active',
  'inspector-schema-list',
  'inspector-quality-gate-html',
  'inspector-gate-info',
  'inspector-gate-run-html',
  'inspector-gate-status-html',
  'inspector-gate-history-html',
  'inspector-readiness-section',
  'inspector-readiness-info',
  'inspector-readiness-run',
  'inspector-readiness-result',
  'inspector-testgap-section',
  'inspector-testgap-info',
  'inspector-testgap-run',
  'inspector-testgap-result',
  'inspector-adversary-section',
  'inspector-adversary-status',
  'inspector-alerts-section',
  'inspector-alerts-list',
  'inspector-memory-section',
  'inspector-memory-status',
  'inspector-memory-stats',
  'inspector-memory-recent',
  'inspector-memory-search-btn',
  'inspector-memory-clear-btn',
  'stat-status',
  'stat-messages',
  'stat-tokens',
  'stat-cost',
  'inspector-connection',
  'inspector-branch',
  'prod-auth-status',
  'inspector-tools-section',
  'inspector-tools',
];

/**
 * The exact HTML that used to sit inside `<aside id="inspector">` in
 * `src/renderer/index.html`. Extracted verbatim so Advanced-mode DOM,
 * accessibility semantics, and every id/class the rest of the renderer
 * targets are preserved (Requirements 3.1, 3.2, 3.3, 3.5). Every visual
 * detail — inline styles, animation IDs, tooltip metadata, and legacy
 * inline `onclick="openTreemapPopup..."` binding — is retained so the
 * Inspector renders identically to before this refactor.
 */
var INSPECTOR_STATIC_INNER_MARKUP = [
  '<div class="inspector-section">',
  '  <h3>Departments</h3>',
  '  <ul id="dept-list">',
  '    <li><span class="icon">⏳</span> Loading...</li>',
  '  </ul>',
  '</div>',
  '<div class="inspector-section" id="inspector-headroom-section" style="margin:6px 8px;padding:0;border-bottom:none;background:transparent;">',
  '  <div class="hr-card" style="position:relative;border-radius:12px;padding:12px 14px;overflow:hidden;background:linear-gradient(135deg,rgba(99,102,241,0.10),rgba(34,197,94,0.10),rgba(99,102,241,0.10));border:1px solid rgba(99,102,241,0.28);box-shadow:0 4px 14px rgba(99,102,241,0.18),inset 0 1px 0 rgba(255,255,255,0.05);">',
  '    <div class="hr-card-glow" aria-hidden="true" style="position:absolute;inset:-1px;border-radius:12px;padding:1px;background:linear-gradient(135deg,#6366f1 0%,#22c55e 50%,#6366f1 100%);background-size:200% 200%;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:0.55;animation:hrCardFlow 6s ease-in-out infinite;pointer-events:none;"></div>',
  '    <div style="position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">',
  '      <div style="display:flex;align-items:center;gap:8px;min-width:0;">',
  '        <div style="width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(99,102,241,0.25),rgba(34,197,94,0.20));border:1px solid rgba(99,102,241,0.35);box-shadow:0 0 12px rgba(99,102,241,0.35);font-size:14px;flex-shrink:0;">🪶</div>',
  '        <div style="min-width:0;">',
  '          <div style="display:flex;align-items:center;gap:6px;">',
  '            <h3 style="margin:0;font-size:10px;font-weight:800;color:var(--text-primary);text-transform:uppercase;letter-spacing:1.2px;">Compression</h3>',
  '            <span id="headroom-status-pill" title="Compression status" style="font-size:8px;font-weight:700;padding:1px 6px;border-radius:10px;background:rgba(148,163,184,0.20);color:var(--text-dim);border:1px solid rgba(148,163,184,0.30);text-transform:uppercase;letter-spacing:0.6px;">Off</span>',
  '          </div>',
  '          <div style="font-size:9px;color:var(--text-dim);margin-top:1px;letter-spacing:0.3px;">Prompt compression · saves tokens</div>',
  '        </div>',
  '      </div>',
  '      <button id="headroom-toggle" role="switch" aria-checked="false" aria-label="Toggle Headroom prompt compression" data-tippy-content="Compress outgoing prompts via local Headroom proxy. Requires `headroom proxy --port 8787`." data-tippy-placement="left" style="position:relative;width:36px;height:20px;border-radius:11px;border:none;cursor:pointer;background:rgba(148,163,184,0.25);transition:background 0.18s ease;flex-shrink:0;padding:0;">',
  '        <span id="headroom-toggle-knob" style="position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left 0.18s ease,background 0.18s ease;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></span>',
  '      </button>',
  '    </div>',
  '    <div style="position:relative;display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">',
  '      <div style="background:rgba(15,23,42,0.45);border:1px solid rgba(99,102,241,0.18);border-radius:6px;padding:6px 8px;">',
  '        <div style="font-size:9px;font-weight:700;color:rgba(226,232,240,0.85);text-transform:uppercase;letter-spacing:0.5px;">Saved</div>',
  '        <div id="headroom-saved" style="font-size:14px;font-weight:800;color:#a6e3a1;font-variant-numeric:tabular-nums;line-height:1.2;">0</div>',
  '        <div style="font-size:9px;color:rgba(203,213,225,0.75);">tokens · session</div>',
  '      </div>',
  '      <div style="background:rgba(15,23,42,0.45);border:1px solid rgba(99,102,241,0.18);border-radius:6px;padding:6px 8px;">',
  '        <div style="font-size:9px;font-weight:700;color:rgba(226,232,240,0.85);text-transform:uppercase;letter-spacing:0.5px;">Ratio</div>',
  '        <div id="headroom-ratio" style="font-size:14px;font-weight:800;color:#89b4fa;font-variant-numeric:tabular-nums;line-height:1.2;">—</div>',
  '        <div style="font-size:9px;color:rgba(203,213,225,0.75);"><span id="headroom-runs">0</span> compressions</div>',
  '      </div>',
  '    </div>',
  '    <div id="headroom-foot" style="position:relative;font-size:9px;color:var(--text-dim);display:flex;align-items:center;justify-content:space-between;gap:6px;">',
  '      <span id="headroom-foot-msg" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Tap to enable · proxy at <code style="font-size:9px;color:var(--text-dim);background:rgba(15,23,42,0.4);padding:1px 4px;border-radius:3px;" id="headroom-proxy-url">localhost:8787</code></span>',
  '      <button id="headroom-reset" style="background:transparent;border:1px solid rgba(148,163,184,0.25);color:var(--text-dim);font-size:9px;padding:1px 6px;border-radius:4px;cursor:pointer;flex-shrink:0;" data-tippy-content="Reset session counters" data-tippy-placement="left">↻</button>',
  '    </div>',
  '  </div>',
  '</div>',
  '<div class="inspector-section" style="padding:8px 8px 6px;">',
  '  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">',
  '    <div style="display:flex;align-items:center;gap:5px;">',
  '      <div style="width:6px;height:6px;border-radius:50%;background:#a6e3a1;box-shadow:0 0 4px #a6e3a1;"></div>',
  '      <h3 style="margin:0;font-size:9px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;">Live Map</h3>',
  '    </div>',
  '    <div style="display:flex;align-items:center;gap:6px;">',
  '      <span id="treemap-file-count" style="font-size:8px;color:var(--text-dim);background:rgba(99,102,241,0.1);padding:1px 5px;border-radius:3px;">0 files</span>',
  '      <button id="treemap-expand-btn" data-tippy-content="Click to view live activity map in fullscreen mode" data-tippy-placement="left" style="background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2);cursor:pointer;font-size:12px;padding:2px 5px;border-radius:4px;line-height:1;color:var(--text-dim);transition:all 0.12s;">🔎</button>',
  '    </div>',
  '  </div>',
  '  <div id="sidebar-treemap" style="background:linear-gradient(135deg,#08080f,#0c0c1a);border-radius:8px;height:110px;overflow:hidden;border:1px solid rgba(99,102,241,0.15);box-shadow:inset 0 1px 3px rgba(0,0,0,0.3);cursor:pointer;" onclick="if(typeof openTreemapPopup===\'function\')openTreemapPopup()"></div>',
  '</div>',
  '<div class="inspector-section">',
  '  <h3 style="display:flex;justify-content:space-between;align-items:center;">Active Agents <span id="clear-agents-btn" style="cursor:pointer;font-size:11px;color:var(--text-dim);padding:2px 6px;border-radius:4px;border:1px solid var(--border-color);display:none;" title="Clear agent list">✕ Clear</span></h3>',
  '  <div id="active-agents" style="font-size:12px;color:var(--text-dim);font-style:italic;">Idle</div>',
  '</div>',
  '<!-- Response Schemas (project-specific activation) -->',
  '<div id="inspector-schemas-section" class="inspector-section" style="display:none;background:linear-gradient(135deg,rgba(250,179,135,0.04),rgba(249,226,175,0.04));border-radius:10px;margin:4px 8px;padding:12px 14px;border:1px solid rgba(250,179,135,0.15);box-shadow:0 2px 8px rgba(0,0,0,0.15);">',
  '  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">',
  '    <div style="display:flex;align-items:center;gap:6px;">',
  '      <div style="width:24px;height:24px;border-radius:6px;background:linear-gradient(135deg,#fab387,#f9e2af);display:flex;align-items:center;justify-content:center;font-size:12px;">📐</div>',
  '      <span style="font-size:11px;font-weight:700;color:var(--text-primary);">Response Schema</span>',
  '    </div>',
  '    <div style="display:flex;gap:4px;">',
  '      <button id="inspector-schema-create" style="padding:3px 8px;font-size:10px;font-weight:600;border-radius:5px;border:none;background:linear-gradient(135deg,#fab387,#f9e2af);color:#1e1e2e;cursor:pointer;">+ New</button>',
  '      <button id="inspector-schema-help" style="width:22px;height:22px;border-radius:50%;border:none;background:var(--bg-input);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:11px;color:var(--text-dim);" title="What are schemas?">?</button>',
  '    </div>',
  '  </div>',
  '  <div id="inspector-schema-active" style="font-size:10px;color:var(--text-dim);margin-bottom:6px;padding:4px 8px;background:var(--bg-input);border-radius:4px;border:1px solid var(--border-color);">No schema active</div>',
  '  <div id="inspector-schema-list" style="display:flex;flex-direction:column;gap:3px;max-height:120px;overflow-y:auto;"></div>',
  '</div>',
  '<div id="inspector-quality-gate-html" class="inspector-section" style="display:none;background:linear-gradient(135deg,rgba(46,204,113,0.06),rgba(39,174,96,0.06));border-radius:10px;margin:4px 8px;padding:10px 12px;border:1px solid rgba(46,204,113,0.2);">',
  '  <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">',
  '    <span style="font-size:14px;">🚦</span>',
  '    <span style="font-size:11px;font-weight:700;color:var(--text-primary);">Quality Gate</span>',
  '    <span id="inspector-gate-info" style="font-size:12px;cursor:pointer;opacity:0.6;margin-left:auto;" title="What is this?">ℹ️</span>',
  '  </div>',
  '  <div style="display:flex;gap:6px;margin-bottom:6px;">',
  '    <button id="inspector-gate-run-html" style="flex:1;padding:7px 0;font-size:10px;font-weight:600;border-radius:6px;border:none;background:linear-gradient(135deg,var(--accent),#6366f1);color:#fff;cursor:pointer;transition:all 0.15s;box-shadow:0 2px 6px rgba(99,102,241,0.25);display:flex;align-items:center;justify-content:center;gap:4px;">🔍 Run Scan</button>',
  '  </div>',
  '  <div id="inspector-gate-status-html" style="font-size:10px;color:var(--text-dim);"></div>',
  '  <div id="inspector-gate-history-html" style="margin-top:4px;"></div>',
  '</div>',
  '<!-- AI Readiness Score -->',
  '<div id="inspector-readiness-section" class="inspector-section" style="display:none;background:linear-gradient(135deg,rgba(99,102,241,0.06),rgba(137,180,250,0.06));border-radius:10px;margin:4px 8px;padding:10px 12px;border:1px solid rgba(99,102,241,0.15);">',
  '  <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">',
  '    <span style="font-size:13px;">📊</span>',
  '    <span style="font-size:11px;font-weight:700;color:var(--text-primary);">AI Readiness</span>',
  '    <span id="inspector-readiness-info" style="font-size:12px;cursor:pointer;opacity:0.6;margin-left:auto;" title="What is this?">ℹ️</span>',
  '  </div>',
  '  <button id="inspector-readiness-run" style="width:100%;padding:6px 0;font-size:10px;font-weight:600;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;">📊 Scan Readiness</button>',
  '  <div id="inspector-readiness-result" style="font-size:10px;color:var(--text-dim);margin-top:6px;"></div>',
  '</div>',
  '<!-- Test Gap Analysis -->',
  '<div id="inspector-testgap-section" class="inspector-section" style="display:none;background:linear-gradient(135deg,rgba(243,139,168,0.06),rgba(235,111,146,0.06));border-radius:10px;margin:4px 8px;padding:10px 12px;border:1px solid rgba(243,139,168,0.15);">',
  '  <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">',
  '    <span style="font-size:13px;">🧪</span>',
  '    <span style="font-size:11px;font-weight:700;color:var(--text-primary);">Test Gaps</span>',
  '    <span id="inspector-testgap-info" style="font-size:12px;cursor:pointer;opacity:0.6;margin-left:auto;" title="What is this?">ℹ️</span>',
  '  </div>',
  '  <button id="inspector-testgap-run" style="width:100%;padding:6px 0;font-size:10px;font-weight:600;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;">🧪 Find Gaps</button>',
  '  <div id="inspector-testgap-result" style="font-size:10px;color:var(--text-dim);margin-top:6px;"></div>',
  '</div>',
  '<!-- Adversary Reviewer -->',
  '<div id="inspector-adversary-section" class="inspector-section" style="display:none;background:linear-gradient(135deg,rgba(250,179,135,0.06),rgba(249,226,175,0.06));border-radius:10px;margin:4px 8px;padding:10px 12px;border:1px solid rgba(250,179,135,0.15);">',
  '  <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">',
  '    <span style="font-size:13px;">🛡️</span>',
  '    <span style="font-size:11px;font-weight:700;color:var(--text-primary);">Adversary Monitor</span>',
  '  </div>',
  '  <div id="inspector-adversary-status" style="font-size:10px;color:var(--green,#a6e3a1);">● Watching — 0 threats detected</div>',
  '</div>',
  '<!-- Smart Alerts -->',
  '<div id="inspector-alerts-section" class="inspector-section" style="display:none;background:linear-gradient(135deg,rgba(249,226,175,0.06),rgba(245,194,131,0.06));border-radius:10px;margin:4px 8px;padding:10px 12px;border:1px solid rgba(249,226,175,0.15);">',
  '  <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">',
  '    <span style="font-size:13px;">⚡</span>',
  '    <span style="font-size:11px;font-weight:700;color:var(--text-primary);">Smart Alerts</span>',
  '  </div>',
  '  <div id="inspector-alerts-list" style="font-size:10px;color:var(--text-dim);">No active alerts</div>',
  '</div>',
  '<!-- Persistent Memory -->',
  '<div id="inspector-memory-section" class="inspector-section" style="display:none;background:linear-gradient(135deg,rgba(180,190,254,0.06),rgba(137,180,250,0.06));border-radius:10px;margin:4px 8px;padding:10px 12px;border:1px solid rgba(180,190,254,0.2);">',
  '  <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">',
  '    <span style="font-size:13px;">🧠</span>',
  '    <span style="font-size:11px;font-weight:700;color:var(--text-primary);">Memory</span>',
  '    <span id="inspector-memory-status" style="font-size:8px;margin-left:auto;padding:2px 6px;border-radius:8px;background:var(--border-color);color:var(--text-dim);">offline</span>',
  '  </div>',
  '  <div id="inspector-memory-stats" style="font-size:9px;color:var(--text-dim);margin-bottom:6px;"></div>',
  '  <div id="inspector-memory-recent" style="font-size:9px;color:var(--text-dim);margin-bottom:6px;max-height:80px;overflow-y:auto;"></div>',
  '  <div style="display:flex;gap:4px;">',
  '    <button id="inspector-memory-search-btn" style="flex:1;padding:5px 0;font-size:9px;font-weight:600;border-radius:5px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);cursor:pointer;">🔍 Search</button>',
  '    <button id="inspector-memory-clear-btn" style="flex:1;padding:5px 0;font-size:9px;font-weight:600;border-radius:5px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);cursor:pointer;">🗑️ Clear</button>',
  '  </div>',
  '</div>',
  '<div class="inspector-section" style="background:linear-gradient(135deg, rgba(99,102,241,0.05), rgba(139,92,246,0.05));border-radius:8px;margin:4px 8px;border:1px solid rgba(99,102,241,0.15);">',
  '  <h3><span style="font-size:12px;">📊</span> Session</h3>',
  '  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">',
  '    <div style="background:var(--bg-input);border-radius:6px;padding:6px 8px;text-align:center;"><div style="font-size:13px;font-weight:700;color:var(--text-primary);" id="stat-status">Ready</div><div style="font-size:8px;color:var(--text-dim);text-transform:uppercase;">Status</div></div>',
  '    <div style="background:var(--bg-input);border-radius:6px;padding:6px 8px;text-align:center;"><div style="font-size:13px;font-weight:700;color:var(--text-primary);" id="stat-messages">0</div><div style="font-size:8px;color:var(--text-dim);text-transform:uppercase;">Messages</div></div>',
  '    <div style="background:var(--bg-input);border-radius:6px;padding:6px 8px;text-align:center;"><div style="font-size:13px;font-weight:700;color:var(--text-primary);" id="stat-tokens">0</div><div style="font-size:8px;color:var(--text-dim);text-transform:uppercase;">Tokens</div></div>',
  '    <div style="background:var(--bg-input);border-radius:6px;padding:6px 8px;text-align:center;"><div style="font-size:13px;font-weight:700;color:var(--green,#a6e3a1);" id="stat-cost">$0.00</div><div style="font-size:8px;color:var(--text-dim);text-transform:uppercase;">Cost</div></div>',
  '  </div>',
  '  <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px;color:var(--text-dim);"><span id="inspector-connection">● Connected</span><span id="inspector-branch">no branch</span></div>',
  '</div>',
  '<div class="inspector-section" style="background:linear-gradient(135deg, rgba(34,197,94,0.05), rgba(16,185,129,0.05));border-radius:8px;margin:4px 8px;border:1px solid rgba(34,197,94,0.12);">',
  '  <h3><span style="font-size:12px;">🔐</span> Profile</h3>',
  '  <div id="prod-auth-status" style="font-size:11px;color:var(--text-dim);">Loading...</div>',
  '</div>',
  '<div class="inspector-section" id="inspector-tools-section">',
  '  <h3>Tools</h3>',
  '  <div id="inspector-tools" style="display:flex;flex-direction:column;gap:4px;"></div>',
  '</div>',
].join('\n');

// ── Predicates ───────────────────────────────────────────────────────────

/**
 * Returns true when the resolved graphical launch mode owns the Inspector
 * lifecycle. Only the exact string `'advanced'` mounts the panel; any other
 * value — including a missing or corrupt payload that has already been
 * repaired upstream — must not create Inspector DOM. This keeps the
 * mount/no-mount decision closed and mechanical.
 */
function shouldMountInspector(mode) {
  return mode === 'advanced';
}

// ── Factories ────────────────────────────────────────────────────────────

/**
 * Creates a fresh `<aside id="inspector">` element populated with the same
 * markup that used to live in `index.html`. The caller is responsible for
 * inserting the element into the DOM. Never called in Classic mode.
 */
function createInspectorElement(doc) {
  var d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) throw new Error('inspector-factory: no document available');
  var aside = d.createElement('aside');
  aside.id = INSPECTOR_ELEMENT_ID;
  aside.innerHTML = INSPECTOR_STATIC_INNER_MARKUP;
  return aside;
}

/**
 * Creates a fresh vertical drag handle bound to the Inspector. The caller is
 * responsible for attaching the mousedown/dblclick listeners; the factory
 * only owns construction so Classic mode never leaks the id or the visible
 * cursor affordance.
 */
function createInspectorDragHandle(doc) {
  var d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) throw new Error('inspector-factory: no document available');
  var handle = d.createElement('div');
  handle.className = 'drag-handle drag-handle-vertical';
  handle.id = INSPECTOR_DRAG_HANDLE_ID;
  return handle;
}

// ── Mount ────────────────────────────────────────────────────────────────

/**
 * Conditionally mounts the Inspector aside and its drag handle inside the
 * `#app` grid container. Returns a descriptor recording which nodes (if any)
 * were created; in Classic mode both are `null` so the caller can skip every
 * Inspector-related registration without any conditional DOM introspection.
 *
 * The `#app` element's `data-launch-mode` attribute is set to the resolved
 * mode so mode-aware CSS (in `index.html`) can pick the correct grid track
 * template without depending on JS to add or remove columns imperatively.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 3.1
 */
function mountInspector(appEl, mode, options) {
  var opts = options || {};
  var d = opts.document || (typeof document !== 'undefined' ? document : null);
  if (!appEl) return { mode: mode, mounted: false, inspector: null, dragHandle: null };

  // Publish the resolved mode so CSS can drop the 4th grid track in Classic.
  try { appEl.setAttribute('data-launch-mode', mode); } catch (e) { /* SVG or unusual root */ }
  try {
    if (d && d.body) d.body.setAttribute('data-launch-mode', mode);
    if (d && d.documentElement) d.documentElement.setAttribute('data-launch-mode', mode);
  } catch (e) { /* jsdom edge cases */ }

  if (!shouldMountInspector(mode)) {
    return { mode: mode, mounted: false, inspector: null, dragHandle: null };
  }

  var inspector = createInspectorElement(d);
  var dragHandle = createInspectorDragHandle(d);

  // Preserve the original DOM order: <aside id="inspector"> came before the
  // drag handles and #bottom-panel. Append at the end of #app is safe because
  // grid-column assignments (not source order) determine layout.
  appEl.appendChild(inspector);

  // Insert the inspector drag handle after the sidebar drag handle, matching
  // the previous static ordering. If the sidebar handle is missing, fall back
  // to appending after the inspector to keep DOM traversal predictable.
  var sidebarHandle = d ? d.getElementById('drag-sidebar') : null;
  if (sidebarHandle && sidebarHandle.parentNode === appEl) {
    if (sidebarHandle.nextSibling) {
      appEl.insertBefore(dragHandle, sidebarHandle.nextSibling);
    } else {
      appEl.appendChild(dragHandle);
    }
  } else {
    appEl.appendChild(dragHandle);
  }

  return { mode: mode, mounted: true, inspector: inspector, dragHandle: dragHandle };
}

/**
 * Convenience predicate for the rest of `index.ts`. Reads the mode from the
 * `data-launch-mode` attribute the mount function published so callers do
 * not need to thread the value through half of the initialization pipeline.
 * Defaults to `advanced` when the attribute is absent so a legacy install
 * that has not been touched by the bootstrap resolution still renders the
 * Inspector — matching Requirement 1.4's compatibility fallback.
 */
function isAdvancedLaunchMode(doc) {
  var d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return true;
  var root =
    (d.getElementById && d.getElementById('app')) ||
    (d.body ? d.body : null) ||
    d.documentElement;
  if (!root || !root.getAttribute) return true;
  var attr = root.getAttribute('data-launch-mode');
  if (attr === 'classic') return false;
  if (attr === 'advanced') return true;
  return true;
}

// ── Unmount ──────────────────────────────────────────────────────────────

/**
 * Removes the Inspector aside and its drag handle from the DOM. Sets the
 * data-launch-mode attribute to 'classic'. No-op if Inspector is not mounted.
 */
function unmountInspector(appEl, options) {
  var opts = options || {};
  var d = opts.document || (typeof document !== 'undefined' ? document : null);
  if (!appEl) return;

  var inspector = d ? d.getElementById(INSPECTOR_ELEMENT_ID) : null;
  var dragHandle = d ? d.getElementById(INSPECTOR_DRAG_HANDLE_ID) : null;

  if (inspector && inspector.parentNode) inspector.parentNode.removeChild(inspector);
  if (dragHandle && dragHandle.parentNode) dragHandle.parentNode.removeChild(dragHandle);

  try { appEl.setAttribute('data-launch-mode', 'classic'); } catch (e) { /* noop */ }
  try {
    if (d && d.body) d.body.setAttribute('data-launch-mode', 'classic');
    if (d && d.documentElement) d.documentElement.setAttribute('data-launch-mode', 'classic');
  } catch (e) { /* noop */ }
}

/**
 * Hot-swap the launch mode at runtime without restarting. Mounts or unmounts
 * the Inspector as needed and updates all data-launch-mode attributes.
 *
 * Returns the same descriptor as mountInspector.
 */
function switchLaunchMode(appEl, newMode, options) {
  var d = (options && options.document) || (typeof document !== 'undefined' ? document : null);
  var currentMode = isAdvancedLaunchMode(d) ? 'advanced' : 'classic';

  if (newMode === currentMode) {
    return { mode: newMode, mounted: newMode === 'advanced', inspector: null, dragHandle: null };
  }

  if (newMode === 'classic') {
    unmountInspector(appEl, options);
    return { mode: 'classic', mounted: false, inspector: null, dragHandle: null };
  }

  // Switch to advanced — mount the Inspector
  return mountInspector(appEl, 'advanced', options);
}

// ── Module surface ───────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    INSPECTOR_ELEMENT_ID: INSPECTOR_ELEMENT_ID,
    INSPECTOR_DRAG_HANDLE_ID: INSPECTOR_DRAG_HANDLE_ID,
    INSPECTOR_OWNED_ELEMENT_IDS: INSPECTOR_OWNED_ELEMENT_IDS,
    INSPECTOR_STATIC_INNER_MARKUP: INSPECTOR_STATIC_INNER_MARKUP,
    shouldMountInspector: shouldMountInspector,
    createInspectorElement: createInspectorElement,
    createInspectorDragHandle: createInspectorDragHandle,
    mountInspector: mountInspector,
    unmountInspector: unmountInspector,
    switchLaunchMode: switchLaunchMode,
    isAdvancedLaunchMode: isAdvancedLaunchMode,
  };
}

if (typeof window !== 'undefined') {
  window.InspectorFactory = {
    INSPECTOR_ELEMENT_ID: INSPECTOR_ELEMENT_ID,
    INSPECTOR_DRAG_HANDLE_ID: INSPECTOR_DRAG_HANDLE_ID,
    INSPECTOR_OWNED_ELEMENT_IDS: INSPECTOR_OWNED_ELEMENT_IDS,
    INSPECTOR_STATIC_INNER_MARKUP: INSPECTOR_STATIC_INNER_MARKUP,
    shouldMountInspector: shouldMountInspector,
    createInspectorElement: createInspectorElement,
    createInspectorDragHandle: createInspectorDragHandle,
    mountInspector: mountInspector,
    unmountInspector: unmountInspector,
    switchLaunchMode: switchLaunchMode,
    isAdvancedLaunchMode: isAdvancedLaunchMode,
  };
}
