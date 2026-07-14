/**
 * MarketplacePanel — Renderer panel for the MCP Marketplace.
 *
 * Displays the MCP catalog with search, category filters, and relevance-sorted
 * recommendations. Provides one-click install with status feedback.
 *
 * Wires IPC channels: marketplace:catalog, marketplace:search,
 * marketplace:detect, marketplace:install, marketplace:uninstall,
 * marketplace:health, marketplace:sync, marketplace:installations
 *
 * Gated behind `mcp_marketplace` feature flag.
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as worktree-panel.ts.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.6
 */

// ─── Helpers ───────────────────────────────────────────────────────
function marketplaceEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function marketplaceEapi() {
  return window.electronAPI;
}

// ─── Category colors ──────────────────────────────────────────────
var MARKETPLACE_CATEGORY_COLORS = {
  core: '#60a5fa',
  filesystem: '#34d399',
  database: '#fbbf24',
  browser: '#a78bfa',
  vcs: '#f87171',
  devops: '#fb923c',
  communication: '#2dd4bf',
  productivity: '#818cf8',
  automation: '#e879f9',
  frontend: '#38bdf8',
  backend: '#4ade80',
  containers: '#fb7185',
};

// ─── MarketplacePanel class ───────────────────────────────────────
function MarketplacePanel(container) {
  this.container = container;
  this.catalog = [];
  this.categories = [];
  this.recommendations = [];
  this.installations = [];
  this.searchQuery = '';
  this.selectedCategory = '';
  this.activeTab = 'catalog'; // 'catalog' | 'recommendations' | 'installed'
  this.isLoading = false;
}

MarketplacePanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';

  // Header
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';

  var title = document.createElement('h4');
  title.style.cssText = 'margin:0;font-size:13px;color:var(--text-secondary);';
  title.textContent = 'MCP Marketplace';
  header.appendChild(title);

  var headerActions = document.createElement('div');
  headerActions.style.cssText = 'display:flex;gap:6px;';

  var syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.textContent = 'Sync Catalog';
  syncBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  syncBtn.addEventListener('click', function () { self.syncCatalog(); });
  headerActions.appendChild(syncBtn);

  header.appendChild(headerActions);
  this.container.appendChild(header);

  // Tab bar
  var tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:2px;margin-bottom:12px;border-bottom:1px solid var(--border-color);padding-bottom:8px;';

  var tabs = [
    { id: 'catalog', label: 'Browse' },
    { id: 'recommendations', label: 'Recommended' },
    { id: 'installed', label: 'Installed' },
  ];

  for (var i = 0; i < tabs.length; i++) {
    (function (tab) {
      var tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.textContent = tab.label;
      var isActive = self.activeTab === tab.id;
      tabBtn.style.cssText = 'font-size:11px;padding:5px 12px;border:none;border-radius:4px;cursor:pointer;' +
        (isActive ? 'background:var(--accent-color);color:#fff;' : 'background:transparent;color:var(--text-secondary);');
      tabBtn.addEventListener('click', function () {
        self.activeTab = tab.id;
        self.render();
        if (tab.id === 'recommendations') self.loadRecommendations();
        if (tab.id === 'installed') self.loadInstallations();
        if (tab.id === 'catalog') self.loadCatalog();
      });
      tabBar.appendChild(tabBtn);
    })(tabs[i]);
  }
  this.container.appendChild(tabBar);

  // Search bar (for catalog tab)
  if (this.activeTab === 'catalog') {
    var searchRow = document.createElement('div');
    searchRow.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';

    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search MCP servers...';
    searchInput.value = this.searchQuery;
    searchInput.style.cssText = 'flex:1;font-size:11px;padding:6px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);border-radius:6px;outline:none;';
    searchInput.addEventListener('input', function (e) {
      self.searchQuery = e.target.value;
      self.performSearch();
    });
    searchRow.appendChild(searchInput);

    // Category filter
    var catSelect = document.createElement('select');
    catSelect.style.cssText = 'font-size:11px;padding:6px 8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);border-radius:6px;';
    var allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All Categories';
    catSelect.appendChild(allOpt);

    for (var ci = 0; ci < this.categories.length; ci++) {
      var opt = document.createElement('option');
      opt.value = this.categories[ci];
      opt.textContent = this.categories[ci];
      if (this.selectedCategory === this.categories[ci]) opt.selected = true;
      catSelect.appendChild(opt);
    }
    catSelect.addEventListener('change', function (e) {
      self.selectedCategory = e.target.value;
      self.performSearch();
    });
    searchRow.appendChild(catSelect);

    this.container.appendChild(searchRow);
  }

  // Content area
  this.contentRoot = document.createElement('div');
  this.contentRoot.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-height:400px;overflow-y:auto;';

  if (this.isLoading) {
    this.contentRoot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;">Loading...</div>';
  } else {
    this.renderContent();
  }

  this.container.appendChild(this.contentRoot);

  // Initial load
  if (this.catalog.length === 0) {
    this.loadCatalog();
  }
};

MarketplacePanel.prototype.renderContent = function () {
  if (!this.contentRoot) return;
  this.contentRoot.innerHTML = '';

  var items = [];
  if (this.activeTab === 'catalog') {
    items = this.catalog;
  } else if (this.activeTab === 'recommendations') {
    items = this.recommendations;
  } else if (this.activeTab === 'installed') {
    items = this.installations;
  }

  if (items.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;';
    empty.textContent = this.activeTab === 'installed' ? 'No MCP servers installed yet.' :
      this.activeTab === 'recommendations' ? 'No recommendations available.' :
      'No results found.';
    this.contentRoot.appendChild(empty);
    return;
  }

  var self = this;
  for (var i = 0; i < items.length; i++) {
    (function (item) {
      var card = self.renderCard(item);
      self.contentRoot.appendChild(card);
    })(items[i]);
  }
};

MarketplacePanel.prototype.renderCard = function (item) {
  var self = this;
  var entry = item.entry || item;
  var isInstalled = self.isServerInstalled(entry.id);

  var card = document.createElement('div');
  card.style.cssText = 'padding:10px 12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-card,var(--bg-input));';

  // Top row: name + badges
  var topRow = document.createElement('div');
  topRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;';

  var nameEl = document.createElement('span');
  nameEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
  nameEl.textContent = entry.name;
  topRow.appendChild(nameEl);

  var badges = document.createElement('div');
  badges.style.cssText = 'display:flex;gap:4px;align-items:center;';

  if (entry.verified) {
    var verifiedBadge = document.createElement('span');
    verifiedBadge.style.cssText = 'font-size:9px;padding:2px 5px;border-radius:3px;background:#059669;color:#fff;';
    verifiedBadge.textContent = 'Verified';
    badges.appendChild(verifiedBadge);
  }

  var transportBadge = document.createElement('span');
  transportBadge.style.cssText = 'font-size:9px;padding:2px 5px;border-radius:3px;background:var(--border-color);color:var(--text-secondary);';
  transportBadge.textContent = entry.transport;
  badges.appendChild(transportBadge);

  topRow.appendChild(badges);
  card.appendChild(topRow);

  // Description
  var desc = document.createElement('div');
  desc.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-bottom:6px;';
  desc.textContent = entry.description;
  card.appendChild(desc);

  // Categories
  if (entry.categories && entry.categories.length > 0) {
    var catRow = document.createElement('div');
    catRow.style.cssText = 'display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap;';
    for (var ci = 0; ci < entry.categories.length; ci++) {
      var catBadge = document.createElement('span');
      var color = MARKETPLACE_CATEGORY_COLORS[entry.categories[ci]] || '#6b7280';
      catBadge.style.cssText = 'font-size:9px;padding:1px 5px;border-radius:3px;border:1px solid ' + color + ';color:' + color + ';';
      catBadge.textContent = entry.categories[ci];
      catRow.appendChild(catBadge);
    }
    card.appendChild(catRow);
  }

  // Relevance score (for recommendations tab)
  if (item.relevanceScore !== undefined) {
    var scoreEl = document.createElement('div');
    scoreEl.style.cssText = 'font-size:10px;color:var(--text-dim);margin-bottom:6px;';
    scoreEl.textContent = 'Relevance: ' + Math.round(item.relevanceScore * 100) + '%';
    if (item.reasons && item.reasons.length > 0) {
      scoreEl.textContent += ' — ' + item.reasons[0];
    }
    card.appendChild(scoreEl);
  }

  // Bottom row: rating + action button
  var bottomRow = document.createElement('div');
  bottomRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';

  var metaEl = document.createElement('span');
  metaEl.style.cssText = 'font-size:10px;color:var(--text-dim);';
  metaEl.textContent = '\u2605 ' + (entry.rating || 0).toFixed(1) + '  \u2022  ' + (entry.downloads || 0).toLocaleString() + ' installs';
  bottomRow.appendChild(metaEl);

  var actionBtn = document.createElement('button');
  actionBtn.type = 'button';
  if (isInstalled) {
    actionBtn.textContent = 'Installed';
    actionBtn.style.cssText = 'font-size:10px;padding:4px 10px;border:1px solid #059669;background:transparent;color:#059669;border-radius:5px;cursor:default;';
    actionBtn.disabled = true;
  } else {
    actionBtn.textContent = 'Install';
    actionBtn.style.cssText = 'font-size:10px;padding:4px 10px;border:none;background:var(--accent-color);color:#fff;border-radius:5px;cursor:pointer;';
    actionBtn.addEventListener('click', function () {
      self.installServer(entry.id, actionBtn);
    });
  }
  bottomRow.appendChild(actionBtn);

  card.appendChild(bottomRow);
  return card;
};

// ─── Data loading ────────────────────────────────────────────────

MarketplacePanel.prototype.loadCatalog = function () {
  var self = this;
  var eapi = marketplaceEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  self.isLoading = true;
  self.renderContent();

  Promise.resolve(eapi.invoke('marketplace:catalog')).then(function (result) {
    self.isLoading = false;
    if (result && result.success) {
      self.catalog = result.entries || [];
      self.categories = result.categories || [];
    }
    self.renderContent();
  }).catch(function () {
    self.isLoading = false;
    self.renderContent();
  });
};

MarketplacePanel.prototype.loadRecommendations = function () {
  var self = this;
  var eapi = marketplaceEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  self.isLoading = true;
  self.renderContent();

  Promise.resolve(eapi.invoke('marketplace:detect')).then(function (result) {
    self.isLoading = false;
    if (result && result.success) {
      self.recommendations = result.recommendations || [];
    }
    self.renderContent();
  }).catch(function () {
    self.isLoading = false;
    self.renderContent();
  });
};

MarketplacePanel.prototype.loadInstallations = function () {
  var self = this;
  var eapi = marketplaceEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  self.isLoading = true;
  self.renderContent();

  Promise.resolve(eapi.invoke('marketplace:installations')).then(function (result) {
    self.isLoading = false;
    if (result && result.success) {
      self.installations = (result.installations || []).map(function (inst) {
        return { entry: { id: inst.id, name: inst.name, description: '', categories: [], transport: inst.transport, rating: 0, downloads: 0, verified: false }, ...inst };
      });
    }
    self.renderContent();
  }).catch(function () {
    self.isLoading = false;
    self.renderContent();
  });
};

MarketplacePanel.prototype.performSearch = function () {
  var self = this;
  var eapi = marketplaceEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var options = {};
  if (self.searchQuery) options.query = self.searchQuery;
  if (self.selectedCategory) options.category = self.selectedCategory;

  Promise.resolve(eapi.invoke('marketplace:search', options)).then(function (result) {
    if (result && result.success) {
      self.catalog = result.results || [];
    }
    self.renderContent();
  }).catch(function () {
    // keep existing
  });
};

MarketplacePanel.prototype.syncCatalog = function () {
  var self = this;
  var eapi = marketplaceEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  Promise.resolve(eapi.invoke('marketplace:sync')).then(function () {
    self.loadCatalog();
  }).catch(function () {
    // silent
  });
};

MarketplacePanel.prototype.installServer = function (catalogId, btn) {
  var self = this;
  var eapi = marketplaceEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  btn.textContent = 'Installing...';
  btn.disabled = true;
  btn.style.cssText = 'font-size:10px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-dim);border-radius:5px;cursor:default;';

  Promise.resolve(eapi.invoke('marketplace:install', catalogId)).then(function (result) {
    if (result && result.success) {
      btn.textContent = 'Installed';
      btn.style.cssText = 'font-size:10px;padding:4px 10px;border:1px solid #059669;background:transparent;color:#059669;border-radius:5px;cursor:default;';
    } else {
      btn.textContent = 'Failed';
      btn.style.cssText = 'font-size:10px;padding:4px 10px;border:1px solid #ef4444;background:transparent;color:#ef4444;border-radius:5px;cursor:pointer;';
      btn.disabled = false;
    }
  }).catch(function () {
    btn.textContent = 'Error';
    btn.style.cssText = 'font-size:10px;padding:4px 10px;border:1px solid #ef4444;background:transparent;color:#ef4444;border-radius:5px;cursor:pointer;';
    btn.disabled = false;
  });
};

MarketplacePanel.prototype.isServerInstalled = function (id) {
  for (var i = 0; i < this.installations.length; i++) {
    if (this.installations[i].id === id || (this.installations[i].entry && this.installations[i].entry.id === id)) {
      return true;
    }
  }
  return false;
};

MarketplacePanel.prototype.destroy = function () {
  this.container.innerHTML = '';
  this.catalog = [];
  this.categories = [];
  this.recommendations = [];
  this.installations = [];
};
