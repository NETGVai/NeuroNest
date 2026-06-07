/**
 * Live Activity Map — Real-time visualization of agent file activity.
 * Agents shown as icons inside the map cells they're working on.
 */

window._liveMapState = {
  files: {},
  agents: {},
  connections: [],
  isActive: false,
  lastFile: null,
};

var _agentColorIdx = 0;
var _lastThemeForAgents = '';

// Theme-specific color palettes for the live map
var THEME_PALETTES = {
  dark:     { bg: '#1a1819', cells: ['#484647','#767475','#a3a3a3','#d1d1d1'], lines: '#007AFF', text: '#d1d1d1' },
  light:    { bg: '#ffffff', cells: ['#dddddd','#cbcbcb','#a6a6a6','#818181'], lines: '#18181b', text: '#333333' },
  sepia:    { bg: '#eadbcb', cells: ['#cda882','#d4b595','#dcc1a7','#e3ceb9'], lines: '#9a6b3a', text: '#5a3e28' },
  midnight: { bg: '#06080f', cells: ['#141a2e','#1c2440','#253055','#2e3d6a'], lines: '#7c6cf0', text: '#8a9cc8' },
  terminal: { bg: '#0a0a0a', cells: ['#0d1f0d','#1a3a1a','#2a5a2a','#3a7a3a'], lines: '#00ff41', text: '#00ff41' },
  zen:      { bg: '#dad2ba', cells: ['#c3d3b2','#a1b88d','#445942','#b32230'], lines: '#8b7355', text: '#445942' },
};

function getCurrentThemePalette() {
  var theme = 'dark';
  try {
    // Theme classes are applied to document.body (e.g. 'theme-light', 'theme-midnight')
    var classes = (document.body.className || '') + ' ' + (document.documentElement.className || '');
    if (classes.indexOf('theme-light') !== -1 || classes.indexOf('light') !== -1) theme = 'light';
    else if (classes.indexOf('theme-sepia') !== -1 || classes.indexOf('sepia') !== -1) theme = 'sepia';
    else if (classes.indexOf('theme-midnight') !== -1 || classes.indexOf('midnight') !== -1) theme = 'midnight';
    else if (classes.indexOf('theme-terminal') !== -1 || classes.indexOf('terminal') !== -1) theme = 'terminal';
    else if (classes.indexOf('theme-zen') !== -1 || classes.indexOf('zen') !== -1) theme = 'zen';
    else {
      // Check data-theme attribute as fallback
      var dt = document.documentElement.getAttribute('data-theme') || document.body.getAttribute('data-theme') || '';
      if (dt) theme = dt;
    }
    // Also check localStorage as last resort
    if (theme === 'dark') {
      var stored = localStorage.getItem('neuronest-theme');
      if (stored && stored !== 'dark') theme = stored;
    }
  } catch(e) {}
  return THEME_PALETTES[theme] || THEME_PALETTES.dark;
}

function getAccentColor() {
  var p = getCurrentThemePalette();
  return p.lines;
}

function getCellColor(intensity) {
  var p = getCurrentThemePalette();
  var idx = Math.min(Math.floor(intensity * p.cells.length), p.cells.length - 1);
  return p.cells[idx];
}

function getMapBg() {
  return getCurrentThemePalette().bg;
}

function getMapTextColor() {
  return getCurrentThemePalette().text;
}

function getAgentColor(agentName) {
  if (!agentName) return getAccentColor();
  var state = window._liveMapState;

  // Detect theme change and reassign all agent colors
  var currentTheme = '';
  try { currentTheme = document.documentElement.className + (document.documentElement.getAttribute('data-theme') || ''); } catch(e) {}
  if (_lastThemeForAgents && _lastThemeForAgents !== currentTheme) {
    var p = getCurrentThemePalette();
    var colors = [p.lines, p.cells[3] || p.lines, p.cells[2] || p.lines, p.cells[1] || p.lines, p.cells[0] || p.lines];
    var idx = 0;
    for (var k in state.agents) {
      state.agents[k].color = colors[idx % colors.length];
      idx++;
    }
  }
  _lastThemeForAgents = currentTheme;

  if (!state.agents[agentName]) {
    var p = getCurrentThemePalette();
    var colors = [p.lines, p.cells[3] || p.lines, p.cells[2] || p.lines, p.cells[1] || p.lines, p.cells[0] || p.lines];
    state.agents[agentName] = { files: [], color: colors[_agentColorIdx % colors.length], lastActive: Date.now(), icon: getAgentIcon(agentName) };
    _agentColorIdx++;
  }
  return state.agents[agentName].color;
}

function getAgentIcon(name) {
  if (window.agentEmojiCache && window.agentEmojiCache[name]) return window.agentEmojiCache[name];
  var m = { 'Security':'🛡️','Performance':'⚡','Frontend':'🎨','Backend':'⚙️','DevOps':'🚀','QA':'🧪','Data':'📊','Design':'🎨','Research':'🔬','Mobile':'📱','AI':'🤖','Infrastructure':'🏗️','Blockchain':'⛓️','Writer':'📝','Product':'📋','NeuroNest':'🧠','Orchestrator':'🎯','Planner':'📐','Architect':'🏛️','Tester':'🧪','Memory':'🧬','Prompt':'✍️','Agent':'🤖' };
  for (var k in m) { if (name.indexOf(k) !== -1) return m[k]; }
  return '🤖';
}

function markFileActivity(filePath, type, agentName) {
  if (!filePath) return;
  if (!agentName || agentName === 'NeuroNest') agentName = '';
  var state = window._liveMapState;
  if (!state.files[filePath]) {
    state.files[filePath] = { reads: 0, writes: 0, lastAccess: Date.now(), size: 1, agents: [] };
  }
  var f = state.files[filePath];
  f.lastAccess = Date.now();
  if (type === 'write') f.writes++; else f.reads++;
  f.size = f.reads + f.writes * 3;
  if (f.agents.indexOf(agentName) === -1) f.agents.push(agentName);

  if (!agentName) { state.isActive = true; renderSidebarLiveMap(); return; }
  getAgentColor(agentName); // ensure agent is registered
  var ag = state.agents[agentName];
  ag.lastActive = Date.now();
  if (ag.files.indexOf(filePath) === -1) ag.files.push(filePath);

  if (state.lastFile && state.lastFile !== filePath) {
    state.connections.push({ from: state.lastFile, to: filePath, agent: agentName, time: Date.now() });
    if (state.connections.length > 50) state.connections.shift();
  }
  state.lastFile = filePath;
  state.isActive = true;
  renderSidebarLiveMap();
}

function renderSidebarLiveMap() {
  var container = document.getElementById('sidebar-treemap');
  if (!container) return;
  var state = window._liveMapState;
  var fileKeys = Object.keys(state.files);
  var countEl = document.getElementById('treemap-file-count');
  if (countEl) countEl.textContent = fileKeys.length + ' files';

  if (fileKeys.length === 0 && Object.keys(state.agents).length === 0) {
    container.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:6px;"><div style="width:18px;height:18px;border:2px solid var(--accent,#89b4fa);border-top-color:transparent;border-radius:50%;animation:lm-spin 0.8s linear infinite;opacity:0.5;"></div><div style="font-size:8px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;">Awaiting activity</div></div><style>@keyframes lm-spin{to{transform:rotate(360deg)}}@keyframes lm-pulse{0%,100%{opacity:0.12}50%{opacity:0.22}}</style>';
    return;
  }

  var width = container.clientWidth || 200;
  var height = container.clientHeight || 110;
  var now = Date.now();
  var accent = getAccentColor();

  fileKeys = fileKeys.filter(function(f) { return f.indexOf('agent://') !== 0; });
  fileKeys.sort(function(a, b) { return state.files[b].size - state.files[a].size; });
  var visible = fileKeys.slice(0, 35);
  // If no real files but agents exist, show agent-only view
  if (visible.length === 0 && Object.keys(state.agents).length > 0) {
    var agHtml = '<div style="position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;">';
    var agKeys = Object.keys(state.agents);
    for (var aoi = 0; aoi < agKeys.length; aoi++) {
      var aoData = state.agents[agKeys[aoi]];
      var aoActive = (Date.now() - aoData.lastActive) < 10000;
      agHtml += '<div title="' + agKeys[aoi] + '" style="font-size:20px;' + (aoActive ? 'filter:drop-shadow(0 0 6px ' + aoData.color + ');' : 'opacity:0.4;') + '">' + aoData.icon + '</div>';
    }
    agHtml += '</div>';
    container.innerHTML = agHtml;
    return;
  }
  var totalSize = 0;
  for (var i = 0; i < visible.length; i++) totalSize += state.files[visible[i]].size;
  if (!totalSize) totalSize = 1;

  var items = visible.map(function(p) { var f = state.files[p]; return { path: p, weight: f.size, writes: f.writes, age: now - f.lastAccess, agents: f.agents }; });
  var cells = binarySplit(items, { x: 0, y: 0, w: width, h: height }, totalSize);
  var cellMap = {};
  for (var ci = 0; ci < cells.length; ci++) cellMap[cells[ci].path] = cells[ci];

  // Use a wrapper div with relative positioning for HTML agent overlays
  var html = '<div style="position:relative;width:100%;height:100%;">';
  html += '<svg width="' + width + '" height="' + height + '" style="position:absolute;top:0;left:0;width:100%;height:100%;" xmlns="http://www.w3.org/2000/svg">';
  html += '<rect width="' + width + '" height="' + height + '" fill="' + getMapBg() + '"/>';

  // Connection lines (glowing dotted with animation)
  var conns = state.connections.filter(function(c) { return now - c.time < 20000; });
  if (conns.length > 0) {
    html += '<defs><filter id="lm-glow-s"><feGaussianBlur stdDeviation="2.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
  }
  for (var ri = 0; ri < Math.min(conns.length, 10); ri++) {
    var conn = conns[conns.length - 1 - ri];
    var fc = cellMap[conn.from], tc = cellMap[conn.to];
    if (!fc || !tc) continue;
    var fx = fc.x + fc.w/2, fy = fc.y + fc.h/2, tx = tc.x + tc.w/2, ty = tc.y + tc.h/2;
    var mx = (fx + tx) / 2, my = Math.min(fy, ty) - 15;
    var age = (now - conn.time) / 20000;
    var op = (1 - age) * 0.9;
    var col = state.agents[conn.agent] ? state.agents[conn.agent].color : accent;
    html += '<path d="M' + fx + ',' + fy + ' Q' + mx + ',' + my + ' ' + tx + ',' + ty + '" fill="none" stroke="' + col + '" stroke-width="1.5" opacity="' + Math.max(0.5, op).toFixed(2) + '" stroke-linecap="round" stroke-dasharray="4,4" filter="url(#lm-glow-s)"><animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.6s" repeatCount="indefinite"/></path>';
  }

  // File cells
  for (var di = 0; di < cells.length; di++) {
    var cell = cells[di];
    var isMemory = cell.path && cell.path.indexOf('memory://') === 0;
    var isRecent = cell.age < 5000;
    var isWrite = cell.writes > 0;
    var agColor = cell.agents.length > 0 ? getAgentColor(cell.agents[cell.agents.length - 1]) : accent;
    // Memory nodes use the theme's accent color with slightly different opacity
    var color = isMemory ? accent : (isWrite ? agColor : getCellColor(cell.writes / 5));
    var op2 = isMemory ? 0.55 : (isRecent ? 0.5 : 0.25);
    if (cell.w > 1 && cell.h > 1) {
      html += '<rect x="' + cell.x + '" y="' + cell.y + '" width="' + (cell.w - 0.5) + '" height="' + (cell.h - 0.5) + '" fill="' + color + '" opacity="' + op2.toFixed(2) + '" rx="' + (isMemory ? '3' : '1.5') + '" stroke="' + (isMemory ? accent + '88' : 'rgba(255,255,255,0.08)') + '" stroke-width="' + (isMemory ? '0.8' : '0.3') + '"' + (isRecent && isWrite ? ' style="animation:lm-pulse 1.5s infinite"' : '') + '/>';
    }
  }
  html += '<style>@keyframes lm-pulse{0%,100%{opacity:0.7}50%{opacity:1}}</style>';
  html += '</svg>';

  // Agent icons as HTML overlays INSIDE the map (positioned on their most active file)
  var agentKeys = Object.keys(state.agents);
  for (var ai = 0; ai < agentKeys.length; ai++) {
    var agName = agentKeys[ai];
    var agData = state.agents[agName];
    var isActive = (now - agData.lastActive) < 10000;
    // Find the cell for this agent's most recent file
    var agCell = null;
    for (var fi = agData.files.length - 1; fi >= 0; fi--) {
      if (cellMap[agData.files[fi]]) { agCell = cellMap[agData.files[fi]]; break; }
    }
    if (!agCell || agCell.w < 10 || agCell.h < 10) continue;
    var ix = agCell.x + agCell.w/2 - 7;
    var iy = agCell.y + agCell.h/2 - 7;
    html += '<div style="position:absolute;left:' + ix + 'px;top:' + iy + 'px;display:flex;flex-direction:column;align-items:center;gap:2px;pointer-events:all;cursor:pointer;z-index:5;' + (isActive ? '' : 'opacity:0.4;') + '">' + '<div style="width:24px;height:24px;border-radius:50%;background:rgba(0,0,0,0.7);border:1.5px solid ' + agData.color + ';display:flex;align-items:center;justify-content:center;font-size:12px;' + (isActive ? 'box-shadow:0 0 8px ' + agData.color + ';' : '') + '">' + agData.icon + '</div>' + '<div style="background:rgba(0,0,0,0.75);border:1px solid ' + agData.color + '44;border-radius:4px;padding:1px 4px;font-size:7px;color:' + agData.color + ';white-space:nowrap;max-width:60px;overflow:hidden;text-overflow:ellipsis;">' + agName.slice(0,10) + '</div></div>';//g,'&quot;') + '" style="position:absolute;left:' + ix + 'px;top:' + iy + 'px;font-size:14px;pointer-events:all;cursor:pointer;z-index:5;padding:2px;' + (isActive ? 'filter:drop-shadow(0 0 4px ' + agData.color + ') drop-shadow(0 0 8px ' + agData.color + ');' : 'opacity:0.4;') + '">' + agData.icon + '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
  // Init tippy on agent icons in sidebar
  if (typeof tippy === 'function') {
    var sidebarAgentDivs = container.querySelectorAll('[data-tippy-content]');
    for (var sti = 0; sti < sidebarAgentDivs.length; sti++) {
      tippy(sidebarAgentDivs[sti], { content: sidebarAgentDivs[sti].getAttribute('data-tippy-content'), theme: 'neuronest', animation: 'shift-away', arrow: true, placement: 'top', appendTo: document.body });
    }
  }

  }

function binarySplit(items, rect, totalWeight) {
  if (!items.length) return [];
  if (items.length === 1) return [{ path: items[0].path, x: rect.x, y: rect.y, w: rect.w, h: rect.h, writes: items[0].writes, age: items[0].age, agents: items[0].agents }];
  var half = totalWeight / 2, sum = 0, si = 0;
  for (var i = 0; i < items.length; i++) { sum += items[i].weight; if (sum >= half) { si = i + 1; break; } }
  if (si === 0) si = 1; if (si >= items.length) si = items.length - 1;
  var left = items.slice(0, si), right = items.slice(si);
  var lw = sum, rw = totalWeight - sum, r = lw / totalWeight;
  var lr, rr;
  if (rect.w >= rect.h) { lr = { x: rect.x, y: rect.y, w: rect.w * r, h: rect.h }; rr = { x: rect.x + rect.w * r, y: rect.y, w: rect.w * (1-r), h: rect.h }; }
  else { lr = { x: rect.x, y: rect.y, w: rect.w, h: rect.h * r }; rr = { x: rect.x, y: rect.y + rect.h * r, w: rect.w, h: rect.h * (1-r) }; }
  return binarySplit(left, lr, lw).concat(binarySplit(right, rr, rw));
}

// ── Fullscreen Popup ──
function openTreemapPopup() {
  var existing = document.getElementById('treemap-popup-overlay');
  if (existing) { existing.remove(); return; }
  var state = window._liveMapState;
  var fileCount = Object.keys(state.files).length;
  var writeCount = 0; for (var k in state.files) writeCount += state.files[k].writes;

  var overlay = document.createElement('div');
  overlay.id = 'treemap-popup-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99998;backdrop-filter:blur(4px);';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  var popup = document.createElement('div');
  popup.style.cssText = 'position:fixed;top:6%;left:10%;width:80%;height:84%;background:var(--bg-sidebar,var(--bg-primary,#1e1e2e));border:1px solid var(--accent,#89b4fa);border-radius:16px;z-index:99999;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.6);overflow:hidden;';

  popup.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 20px;background:var(--surface-container,var(--bg-input));border-bottom:1px solid var(--border-color);flex-shrink:0;cursor:move;">' +
    '<div style="display:flex;align-items:center;gap:10px;">' +
    '<div style="width:8px;height:8px;border-radius:50%;background:var(--green,#a6e3a1);box-shadow:0 0 6px var(--green,#a6e3a1);animation:lm-pulse 2s infinite;"></div>' +
    '<span style="font-size:14px;font-weight:600;color:var(--text-primary);">Live Activity Map</span>' +
    '<span style="font-size:11px;color:var(--text-dim);background:var(--bg-input);padding:2px 8px;border-radius:4px;border:1px solid var(--border-color);">' + fileCount + ' files</span>' +
    '<span style="font-size:11px;color:var(--text-dim);background:var(--bg-input);padding:2px 8px;border-radius:4px;border:1px solid var(--border-color);">' + writeCount + ' writes</span>' +
    '</div>' +
    '<button id="tm-popup-close" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);color:#f87171;font-size:18px;font-weight:700;cursor:pointer;padding:4px 12px;border-radius:8px;">✕</button>' +
    '</div>' +
    '<div id="tm-popup-content" style="flex:1;overflow:hidden;padding:8px;position:relative;background:var(--bg-primary);"></div>' +
    '<style>@keyframes lm-pulse{0%,100%{opacity:0.7}50%{opacity:1}}</style>';

  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  document.getElementById('tm-popup-close').addEventListener('click', function() { overlay.remove(); });

  // Draggable
  var hdr = popup.firstChild, dragging = false, dx = 0, dy = 0;
  hdr.addEventListener('mousedown', function(e) { if (e.target.tagName === 'BUTTON') return; dragging = true; dx = e.clientX - popup.offsetLeft; dy = e.clientY - popup.offsetTop; });
  document.addEventListener('mousemove', function(e) { if (!dragging) return; popup.style.left = (e.clientX-dx)+'px'; popup.style.top = (e.clientY-dy)+'px'; popup.style.right='auto'; popup.style.bottom='auto'; });
  document.addEventListener('mouseup', function() { dragging = false; });

  // Render immediately and keep updating every 2s
  renderPopupLiveMap();
  var popupInterval = setInterval(function() {
    if (!document.getElementById('tm-popup-content')) { clearInterval(popupInterval); return; }
    renderPopupLiveMap();
  }, 2000);
}

function renderPopupLiveMap() {
  var container = document.getElementById('tm-popup-content');
  if (!container) return;
  var state = window._liveMapState;
  var fileKeys = Object.keys(state.files);
  var now = Date.now();
  var accent = getAccentColor();

  if (!fileKeys.length) {
    container.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;"><div style="width:36px;height:36px;border:3px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:lm-spin 0.8s linear infinite;opacity:0.5;"></div><div style="font-size:13px;color:var(--text-dim);">Waiting for agent activity...</div></div><style>@keyframes lm-spin{to{transform:rotate(360deg)}}</style>';
    return;
  }

  var width = container.clientWidth || 700;
  var height = container.clientHeight || 450;

  fileKeys = fileKeys.filter(function(f) { return f.indexOf('agent://') !== 0; });
  fileKeys.sort(function(a, b) { return state.files[b].size - state.files[a].size; });
  var visible = fileKeys.slice(0, 80);
  var totalSize = 0;
  for (var i = 0; i < visible.length; i++) totalSize += state.files[visible[i]].size;
  if (!totalSize) totalSize = 1;

  var items = visible.map(function(p) { var f = state.files[p]; return { path: p, weight: f.size, writes: f.writes, age: now - f.lastAccess, agents: f.agents }; });
  var cells = binarySplit(items, { x: 0, y: 0, w: width, h: height }, totalSize);
  var cellMap = {};
  for (var ci = 0; ci < cells.length; ci++) cellMap[cells[ci].path] = cells[ci];

  var html = '<div style="position:relative;width:100%;height:100%;">';
  html += '<svg width="' + width + '" height="' + height + '" style="position:absolute;top:0;left:0;width:100%;height:100%;" xmlns="http://www.w3.org/2000/svg">';
  html += '<rect width="' + width + '" height="' + height + '" fill="' + getMapBg() + '"/>';

  // Connections (glowing dotted with animation)
  var conns = state.connections.filter(function(c) { return now - c.time < 40000; });
  if (conns.length > 0) {
    html += '<defs><filter id="lm-glow-p"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
  }
  for (var ri = 0; ri < Math.min(conns.length, 25); ri++) {
    var conn = conns[conns.length - 1 - ri];
    var fc = cellMap[conn.from], tc = cellMap[conn.to];
    if (!fc || !tc) continue;
    var fx = fc.x+fc.w/2, fy = fc.y+fc.h/2, tx = tc.x+tc.w/2, ty = tc.y+tc.h/2;
    var mx = (fx+tx)/2, my = Math.min(fy,ty) - 20;
    var age = (now - conn.time) / 40000;
    var op = (1 - age) * 0.85;
    var col = state.agents[conn.agent] ? state.agents[conn.agent].color : accent;
    html += '<path d="M'+fx+','+fy+' Q'+mx+','+my+' '+tx+','+ty+'" fill="none" stroke="'+col+'" stroke-width="2" opacity="'+Math.max(0.5, op).toFixed(2)+'" stroke-linecap="round" stroke-dasharray="6,5" filter="url(#lm-glow-p)"><animate attributeName="stroke-dashoffset" from="11" to="0" dur="0.8s" repeatCount="indefinite"/></path>';
  }

  // Cells
  for (var di = 0; di < cells.length; di++) {
    var cell = cells[di];
    var isMemory = cell.path && cell.path.indexOf('memory://') === 0;
    var isRecent = cell.age < 8000;
    var isWrite = cell.writes > 0;
    var agColor = cell.agents.length > 0 ? getAgentColor(cell.agents[cell.agents.length-1]) : accent;
    var color = isMemory ? accent : (isWrite ? agColor : getCellColor(cell.writes / 5));
    var op2 = isMemory ? 0.5 : (isRecent ? 0.45 : 0.2);
    if (cell.w > 2 && cell.h > 2) {
      html += '<rect x="'+cell.x+'" y="'+cell.y+'" width="'+(cell.w-1)+'" height="'+(cell.h-1)+'" fill="'+color+'" opacity="'+op2.toFixed(2)+'" rx="' + (isMemory ? '4' : '2') + '" stroke="' + (isMemory ? accent + '99' : 'rgba(255,255,255,0.1)') + '" stroke-width="' + (isMemory ? '1' : '0.5') + '"' + (isRecent && isWrite ? ' style="animation:lm-pulse 1.5s infinite"' : '') + '/>';
      // File/memory label
      if (cell.w > 60 && cell.h > 18) {
        var name = isMemory ? '\u{1F9E0} ' + (cell.path.split('/').pop() || 'memory') : (cell.path.split('/').pop() || cell.path);
        var max = Math.floor(cell.w / 7);
        html += '<text x="'+(cell.x+4)+'" y="'+(cell.y+13)+'" font-size="10" fill="' + getMapTextColor() + '" stroke="' + getMapBg() + '" stroke-width="2.5" paint-order="stroke" font-family="SF Mono,Menlo,monospace">' + (name.length > max ? name.slice(0,max-1)+'\u2026' : name).replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</text>';
      }
    }
  }
  html += '<style>@keyframes lm-pulse{0%,100%{opacity:0.1}50%{opacity:0.2}}</style>';
  html += '</svg>';

  // Agent icons as HTML overlays positioned on their active cells
  var agentKeys = Object.keys(state.agents);
  for (var ai = 0; ai < agentKeys.length; ai++) {
    var agName = agentKeys[ai];
    var agData = state.agents[agName];
    var isActive = (now - agData.lastActive) < 12000;
    var agCell = null;
    for (var fi = agData.files.length - 1; fi >= 0; fi--) {
      if (cellMap[agData.files[fi]]) { agCell = cellMap[agData.files[fi]]; break; }
    }
    if (!agCell) continue;
    var ix = Math.min(agCell.x + agCell.w/2 - 10, width - 24);
    var iy = Math.min(agCell.y + agCell.h/2 - 10, height - 24);
    html += '<div style="position:absolute;left:'+ix+'px;top:'+iy+'px;display:flex;flex-direction:column;align-items:center;gap:3px;pointer-events:all;cursor:pointer;z-index:5;' + (isActive ? '' : 'opacity:0.35;') + '">' + '<div style="width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,0.75);border:2px solid ' + agData.color + ';display:flex;align-items:center;justify-content:center;font-size:18px;' + (isActive ? 'box-shadow:0 0 12px ' + agData.color + ';' : '') + '">' + agData.icon + '</div>' + '<div style="background:rgba(0,0,0,0.8);border:1px solid ' + agData.color + '55;border-radius:5px;padding:2px 6px;font-size:9px;color:' + agData.color + ';white-space:nowrap;max-width:90px;overflow:hidden;text-overflow:ellipsis;font-weight:600;">' + agName.slice(0,14) + '</div></div>';
  }

  html += '</div>';
  container.innerHTML = html;
  // Initialize tippy tooltips on agent icons
  if (typeof tippy === 'function') {
    var agentDivs = container.querySelectorAll('[data-tippy-content]');
    for (var tti = 0; tti < agentDivs.length; tti++) {
      tippy(agentDivs[tti], { content: agentDivs[tti].getAttribute('data-tippy-content'), theme: 'neuronest', animation: 'shift-away', arrow: true, placement: 'top', appendTo: document.body });
    }
  }

  }

// ── Exports ──
window.markFileModified = function(filePath, agentName) { markFileActivity(filePath, 'write', agentName); };
window.markFileRead = function(filePath, agentName) { markFileActivity(filePath, 'read', agentName); };
window.markMemoryActivity = function(memoryContent, category, agentName) {
  // Add memory nodes to the live map as special "memory://" entries
  var memPath = 'memory://' + (category || 'pattern') + '/' + (memoryContent || '').slice(0, 40).replace(/[^a-zA-Z0-9 ]/g, '');
  var state = window._liveMapState;
  if (!state.memories) state.memories = {};
  state.memories[memPath] = {
    content: (memoryContent || '').slice(0, 80),
    category: category || 'pattern',
    agent: agentName || 'auto',
    time: Date.now()
  };
  // Keep max 20 memory entries
  var memKeys = Object.keys(state.memories);
  if (memKeys.length > 20) {
    var oldest = memKeys.sort(function(a, b) { return state.memories[a].time - state.memories[b].time; });
    delete state.memories[oldest[0]];
  }
  // Also register as a file activity so it shows in the map
  markFileActivity(memPath, 'write', agentName || 'Memory');
  state.isActive = true;
  renderSidebarLiveMap();
};
window.getMemoryNodes = function() {
  return window._liveMapState.memories || {};
};
window.openTreemapPopup = openTreemapPopup;
window.renderSidebarLiveMap = renderSidebarLiveMap;
window._currentStreamAgent = null;

function wireExpandBtn() {
  var btn = document.getElementById('treemap-expand-btn');
  if (btn && !btn._wired) {
    btn._wired = true;
    btn.addEventListener('click', openTreemapPopup);
    if (typeof tippy === 'function') tippy(btn, { theme: 'neuronest', animation: 'shift-away', arrow: true, delay: [200,0] });
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireExpandBtn);
else setTimeout(wireExpandBtn, 500);
setTimeout(renderSidebarLiveMap, 1000);
