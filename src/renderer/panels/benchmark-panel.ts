/**
 * BenchmarkPanel — Panel for benchmark comparison and historical trends.
 *
 * Features:
 * - Profile listing and creation
 * - Run benchmarks with multiple model configurations
 * - Comparison table view showing metrics side-by-side for each configuration
 * - Historical trend charts showing performance over time
 *
 * Requirements: 15.3
 */

import type {
  BenchmarkProfile,
  BenchmarkRun,
  BenchmarkResult,
  ModelConfiguration,
  EvaluationCriterion,
} from '../../shared/feature-integration-types.js';

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

type PanelView = 'profiles' | 'results' | 'trends' | 'create';

interface ProfileListResult {
  profiles?: BenchmarkProfile[];
  error?: true;
  message?: string;
}

interface RunResult {
  run?: BenchmarkRun;
  error?: true;
  message?: string;
}

interface TrendsResult {
  runs?: BenchmarkRun[];
  error?: true;
  message?: string;
}

// ─── Constants ──────────────────────────────────────────────────

const METRIC_LABELS: Record<string, string> = {
  tokensConsumed: 'Tokens',
  durationMs: 'Duration (ms)',
  toolCallIterations: 'Tool Calls',
  qualityScore: 'Quality (1-10)',
};

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatDate(date: string): string {
  const d = new Date(date);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

// ─── BenchmarkPanel ─────────────────────────────────────────────

export class BenchmarkPanel {
  private container: HTMLElement;
  private currentView: PanelView = 'profiles';
  private profiles: BenchmarkProfile[] = [];
  private selectedProfile: BenchmarkProfile | null = null;
  private currentRun: BenchmarkRun | null = null;
  private historicalRuns: BenchmarkRun[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Render the panel and load profiles. */
  render(): void {
    this.container.innerHTML = '';
    this.container.style.cssText =
      'display:flex;flex-direction:column;height:100%;font-family:var(--font-family,system-ui);';
    this.loadProfiles();
  }

  /** Refresh the profile list. */
  async loadProfiles(): Promise<void> {
    this.currentView = 'profiles';
    this.selectedProfile = null;
    this.currentRun = null;

    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Loading profiles…</div>';

    try {
      const result = await eapi().invoke('bench:list-profiles') as ProfileListResult;

      if (result && result.error) {
        this.showError(result.message ?? 'Failed to load profiles');
        return;
      }

      this.profiles = result.profiles ?? [];
      this.renderProfileList();
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Profile List View ────────────────────────────────────────

  private renderProfileList(): void {
    this.container.innerHTML = '';

    const header = this.createHeader('📊 Benchmarks', [
      { label: '+', title: 'Create Profile', onClick: () => this.showCreateForm() },
      { label: '↻', title: 'Refresh', onClick: () => this.loadProfiles() },
    ]);
    this.container.appendChild(header);

    if (this.profiles.length === 0) {
      this.container.appendChild(this.createEmptyState(
        'No benchmark profiles yet. Create one to start comparing model configurations.',
      ));
      return;
    }

    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'flex:1;overflow-y:auto;padding:8px;';

    for (const profile of this.profiles) {
      listContainer.appendChild(this.createProfileRow(profile));
    }

    this.container.appendChild(listContainer);
  }

  private createProfileRow(profile: BenchmarkProfile): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);margin-bottom:4px;cursor:pointer;transition:background 0.15s;';
    row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover,rgba(255,255,255,0.05))'; });
    row.addEventListener('mouseleave', () => { row.style.background = 'var(--bg-input)'; });
    row.addEventListener('click', () => this.openProfile(profile));

    // Icon
    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:16px;flex-shrink:0;';
    icon.textContent = '🏁';
    row.appendChild(icon);

    // Content
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;min-width:0;';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    title.textContent = profile.name;
    content.appendChild(title);

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
    meta.textContent = `${profile.configurations.length} configs · ${profile.evaluationCriteria.length} criteria`;
    content.appendChild(meta);

    row.appendChild(content);

    // Action buttons
    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

    const runBtn = document.createElement('button');
    runBtn.textContent = '▶';
    runBtn.title = 'Run Benchmark';
    runBtn.setAttribute('aria-label', 'Run Benchmark');
    runBtn.style.cssText =
      'font-size:12px;width:26px;height:26px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
    runBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.runBenchmark(profile);
    });
    btnGroup.appendChild(runBtn);

    const trendBtn = document.createElement('button');
    trendBtn.textContent = '📈';
    trendBtn.title = 'View Trends';
    trendBtn.setAttribute('aria-label', 'View Trends');
    trendBtn.style.cssText =
      'font-size:12px;width:26px;height:26px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
    trendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openTrends(profile);
    });
    btnGroup.appendChild(trendBtn);

    row.appendChild(btnGroup);
    return row;
  }

  // ─── Profile Detail / Run Benchmark ───────────────────────────

  private async openProfile(profile: BenchmarkProfile): Promise<void> {
    this.selectedProfile = profile;
    this.currentView = 'results';
    // Show profile detail with option to run or view past results
    this.renderProfileDetail(profile);
  }

  private renderProfileDetail(profile: BenchmarkProfile): void {
    this.container.innerHTML = '';

    const header = this.createHeader(`🏁 ${profile.name}`, [
      { label: '←', title: 'Back to profiles', onClick: () => this.loadProfiles() },
      { label: '▶', title: 'Run Benchmark', onClick: () => this.runBenchmark(profile) },
      { label: '📈', title: 'View Trends', onClick: () => this.openTrends(profile) },
    ]);
    this.container.appendChild(header);

    const detailArea = document.createElement('div');
    detailArea.style.cssText = 'flex:1;overflow-y:auto;padding:12px;';

    // Prompt section
    const promptSection = document.createElement('div');
    promptSection.style.cssText = 'margin-bottom:12px;';
    const promptLabel = document.createElement('div');
    promptLabel.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim);margin-bottom:4px;font-weight:600;';
    promptLabel.textContent = 'Prompt';
    promptSection.appendChild(promptLabel);
    const promptText = document.createElement('div');
    promptText.style.cssText = 'font-size:12px;color:var(--text-secondary);background:var(--bg-code,#1e1e1e);padding:8px;border-radius:4px;white-space:pre-wrap;max-height:100px;overflow-y:auto;';
    promptText.textContent = profile.prompt;
    promptSection.appendChild(promptText);
    detailArea.appendChild(promptSection);

    // Configurations section
    const configSection = document.createElement('div');
    configSection.style.cssText = 'margin-bottom:12px;';
    const configLabel = document.createElement('div');
    configLabel.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim);margin-bottom:4px;font-weight:600;';
    configLabel.textContent = `Configurations (${profile.configurations.length})`;
    configSection.appendChild(configLabel);

    for (const config of profile.configurations) {
      const configRow = document.createElement('div');
      configRow.style.cssText = 'font-size:11px;color:var(--text-secondary);padding:4px 8px;border-left:2px solid var(--accent,#3b82f6);margin-bottom:4px;background:var(--bg-input);border-radius:0 4px 4px 0;';
      configRow.textContent = `${config.label} — ${config.provider}/${config.model} (temp: ${config.temperature}, maxTokens: ${config.maxTokens})`;
      configSection.appendChild(configRow);
    }
    detailArea.appendChild(configSection);

    // Last run results (if available)
    if (this.currentRun) {
      detailArea.appendChild(this.renderComparisonTable(this.currentRun, profile));
    }

    this.container.appendChild(detailArea);
  }

  // ─── Run Benchmark ────────────────────────────────────────────

  private async runBenchmark(profile: BenchmarkProfile): Promise<void> {
    this.selectedProfile = profile;
    this.currentView = 'results';
    this.container.innerHTML = '';

    const header = this.createHeader(`▶ Running: ${profile.name}`, [
      { label: '←', title: 'Back to profiles', onClick: () => this.loadProfiles() },
    ]);
    this.container.appendChild(header);

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'padding:24px;text-align:center;';
    const spinner = document.createElement('div');
    spinner.style.cssText = 'font-size:24px;margin-bottom:12px;';
    spinner.textContent = '⏳';
    statusEl.appendChild(spinner);
    const statusText = document.createElement('div');
    statusText.style.cssText = 'font-size:12px;color:var(--text-dim);';
    statusText.textContent = `Running benchmark against ${profile.configurations.length} configurations…`;
    statusEl.appendChild(statusText);
    this.container.appendChild(statusEl);

    try {
      const result = await eapi().invoke('bench:run', {
        profileId: profile.id,
      }) as RunResult;

      if (result.error) {
        this.showError(result.message ?? 'Benchmark run failed');
        return;
      }

      this.currentRun = result.run ?? null;
      this.renderResults(profile);
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Results / Comparison Table View ──────────────────────────

  private renderResults(profile: BenchmarkProfile): void {
    this.container.innerHTML = '';

    const header = this.createHeader(`📊 Results: ${profile.name}`, [
      { label: '←', title: 'Back to profiles', onClick: () => this.loadProfiles() },
      { label: '📈', title: 'View Trends', onClick: () => this.openTrends(profile) },
      { label: '▶', title: 'Run Again', onClick: () => this.runBenchmark(profile) },
    ]);
    this.container.appendChild(header);

    const resultsArea = document.createElement('div');
    resultsArea.style.cssText = 'flex:1;overflow-y:auto;padding:12px;';

    if (!this.currentRun || this.currentRun.results.length === 0) {
      resultsArea.appendChild(this.createEmptyState('No results available. Run the benchmark to see comparison data.'));
      this.container.appendChild(resultsArea);
      return;
    }

    // Run metadata
    const runMeta = document.createElement('div');
    runMeta.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:12px;';
    runMeta.textContent = `Run ID: ${this.currentRun.id.slice(0, 8)}… · Started: ${formatDate(this.currentRun.startedAt)}${this.currentRun.completedAt ? ` · Completed: ${formatDate(this.currentRun.completedAt)}` : ''}`;
    resultsArea.appendChild(runMeta);

    // Comparison table
    resultsArea.appendChild(this.renderComparisonTable(this.currentRun, profile));

    this.container.appendChild(resultsArea);
  }

  /**
   * Render a comparison table showing metrics side-by-side for each configuration.
   * Requirement 15.3: Present results in a comparison table.
   */
  private renderComparisonTable(run: BenchmarkRun, profile: BenchmarkProfile): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'overflow-x:auto;';

    const table = document.createElement('table');
    table.style.cssText =
      'border-collapse:collapse;width:100%;font-size:11px;background:var(--bg-input);border-radius:6px;overflow:hidden;';
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', 'Benchmark comparison results');

    // Build configuration label lookup
    const configMap = new Map<string, ModelConfiguration>();
    for (const c of profile.configurations) {
      configMap.set(c.id, c);
    }

    // ─── Header row: Metric | Config1 | Config2 | ...
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    const metricTh = document.createElement('th');
    metricTh.style.cssText = 'padding:8px 10px;text-align:left;border-bottom:2px solid var(--border-color);font-weight:700;color:var(--text-primary);background:var(--bg-hover);';
    metricTh.textContent = 'Metric';
    headerRow.appendChild(metricTh);

    for (const result of run.results) {
      const config = configMap.get(result.configurationId);
      const th = document.createElement('th');
      th.style.cssText = 'padding:8px 10px;text-align:right;border-bottom:2px solid var(--border-color);font-weight:700;color:var(--text-primary);background:var(--bg-hover);min-width:100px;';
      th.textContent = config?.label ?? result.configurationId.slice(0, 8);
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // ─── Body rows: one per metric
    const tbody = document.createElement('tbody');
    const metrics: Array<{ key: keyof BenchmarkResult; label: string; format: (v: unknown) => string }> = [
      { key: 'tokensConsumed', label: 'Tokens Consumed', format: (v) => formatNumber(v as number) },
      { key: 'durationMs', label: 'Duration', format: (v) => formatDuration(v as number) },
      { key: 'toolCallIterations', label: 'Tool Call Iterations', format: (v) => formatNumber(v as number) },
      { key: 'qualityScore', label: 'Quality Score', format: (v) => v != null ? `${v}/10` : '—' },
    ];

    for (const metric of metrics) {
      const tr = document.createElement('tr');

      const labelTd = document.createElement('td');
      labelTd.style.cssText = 'padding:6px 10px;border-bottom:1px solid var(--border-color);font-weight:600;color:var(--text-primary);';
      labelTd.textContent = metric.label;
      tr.appendChild(labelTd);

      // Find best/worst for highlighting
      const values = run.results.map((r) => r[metric.key] as number | undefined).filter((v) => v != null) as number[];
      const minVal = Math.min(...values);
      const maxVal = Math.max(...values);

      for (const result of run.results) {
        const td = document.createElement('td');
        td.style.cssText = 'padding:6px 10px;text-align:right;border-bottom:1px solid var(--border-color);color:var(--text-secondary);';

        const val = result[metric.key];
        td.textContent = metric.format(val);

        // Highlight best value (lowest is best for tokens/duration/iterations, highest for quality)
        if (val != null && values.length > 1) {
          const numVal = val as number;
          if (metric.key === 'qualityScore') {
            if (numVal === maxVal) td.style.color = '#3fb950';
            else if (numVal === minVal) td.style.color = '#f85149';
          } else {
            if (numVal === minVal) td.style.color = '#3fb950';
            else if (numVal === maxVal) td.style.color = '#f85149';
          }
        }

        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
  }

  // ─── Historical Trends View ───────────────────────────────────

  private async openTrends(profile: BenchmarkProfile): Promise<void> {
    this.selectedProfile = profile;
    this.currentView = 'trends';
    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Loading trends…</div>';

    try {
      const result = await eapi().invoke('bench:trends', {
        profileId: profile.id,
      }) as TrendsResult;

      if (result.error) {
        this.showError(result.message ?? 'Failed to load trends');
        return;
      }

      this.historicalRuns = result.runs ?? [];
      this.renderTrends(profile);
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Render historical trend charts showing performance metrics over time.
   * Uses a simple ASCII/text-based chart rendered as styled HTML bars.
   */
  private renderTrends(profile: BenchmarkProfile): void {
    this.container.innerHTML = '';

    const header = this.createHeader(`📈 Trends: ${profile.name}`, [
      { label: '←', title: 'Back to profiles', onClick: () => this.loadProfiles() },
      { label: '▶', title: 'Run Benchmark', onClick: () => this.runBenchmark(profile) },
    ]);
    this.container.appendChild(header);

    const trendsArea = document.createElement('div');
    trendsArea.style.cssText = 'flex:1;overflow-y:auto;padding:12px;';

    if (this.historicalRuns.length === 0) {
      trendsArea.appendChild(this.createEmptyState('No historical data yet. Run a benchmark to start tracking trends.'));
      this.container.appendChild(trendsArea);
      return;
    }

    // Summary info
    const summaryEl = document.createElement('div');
    summaryEl.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:12px;';
    summaryEl.textContent = `${this.historicalRuns.length} historical run${this.historicalRuns.length !== 1 ? 's' : ''} (newest first)`;
    trendsArea.appendChild(summaryEl);

    // Render a trend chart for each key metric
    const trendMetrics: Array<{ key: keyof BenchmarkResult; label: string; unit: string }> = [
      { key: 'durationMs', label: 'Duration', unit: 'ms' },
      { key: 'tokensConsumed', label: 'Tokens', unit: '' },
      { key: 'toolCallIterations', label: 'Tool Calls', unit: '' },
    ];

    for (const metric of trendMetrics) {
      trendsArea.appendChild(this.renderTrendChart(profile, metric.key, metric.label, metric.unit));
    }

    // Run history list
    const historyLabel = document.createElement('div');
    historyLabel.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim);margin:16px 0 8px;font-weight:600;';
    historyLabel.textContent = 'Run History';
    trendsArea.appendChild(historyLabel);

    for (const run of this.historicalRuns) {
      const runRow = document.createElement('div');
      runRow.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-input);margin-bottom:4px;cursor:pointer;font-size:11px;';
      runRow.addEventListener('click', () => {
        this.currentRun = run;
        this.renderResults(profile);
      });

      const dateEl = document.createElement('span');
      dateEl.style.cssText = 'color:var(--text-secondary);';
      dateEl.textContent = formatDate(run.startedAt);
      runRow.appendChild(dateEl);

      const resultCount = document.createElement('span');
      resultCount.style.cssText = 'color:var(--text-dim);margin-left:auto;';
      resultCount.textContent = `${run.results.length} results`;
      runRow.appendChild(resultCount);

      trendsArea.appendChild(runRow);
    }

    this.container.appendChild(trendsArea);
  }

  /**
   * Render a simple bar-chart visualization for a single metric over time.
   * Groups by configuration and shows bars for each run.
   */
  private renderTrendChart(
    profile: BenchmarkProfile,
    metricKey: keyof BenchmarkResult,
    label: string,
    unit: string,
  ): HTMLElement {
    const section = document.createElement('div');
    section.style.cssText = 'margin-bottom:16px;';

    const sectionLabel = document.createElement('div');
    sectionLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:8px;';
    sectionLabel.textContent = label;
    section.appendChild(sectionLabel);

    // Collect all values for scaling
    const allValues: number[] = [];
    for (const run of this.historicalRuns) {
      for (const result of run.results) {
        const val = result[metricKey];
        if (typeof val === 'number') allValues.push(val);
      }
    }

    if (allValues.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:10px;color:var(--text-dim);padding:4px;';
      empty.textContent = 'No data';
      section.appendChild(empty);
      return section;
    }

    const maxValue = Math.max(...allValues, 1);

    // Color palette for configurations
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

    // Build config-to-color map
    const configColors = new Map<string, string>();
    for (let i = 0; i < profile.configurations.length; i++) {
      configColors.set(profile.configurations[i].id, colors[i % colors.length]);
    }

    // Render bars for the most recent runs (up to 10)
    const recentRuns = this.historicalRuns.slice(0, 10).reverse(); // oldest to newest left-to-right

    const chartContainer = document.createElement('div');
    chartContainer.style.cssText = 'display:flex;gap:4px;align-items:flex-end;height:80px;padding:4px;background:var(--bg-code,#1e1e1e);border-radius:4px;overflow-x:auto;';

    for (const run of recentRuns) {
      const runGroup = document.createElement('div');
      runGroup.style.cssText = 'display:flex;gap:1px;align-items:flex-end;height:100%;';
      runGroup.title = formatDate(run.startedAt);

      for (const result of run.results) {
        const val = result[metricKey];
        if (typeof val !== 'number') continue;

        const barHeight = Math.max(2, (val / maxValue) * 70);
        const bar = document.createElement('div');
        const color = configColors.get(result.configurationId) ?? '#6b7280';
        bar.style.cssText = `width:8px;height:${barHeight}px;background:${color};border-radius:2px 2px 0 0;transition:height 0.2s;`;
        bar.title = `${val}${unit ? ' ' + unit : ''}`;
        runGroup.appendChild(bar);
      }

      chartContainer.appendChild(runGroup);
    }

    section.appendChild(chartContainer);

    // Legend
    const legend = document.createElement('div');
    legend.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;';

    for (const config of profile.configurations) {
      const legendItem = document.createElement('div');
      legendItem.style.cssText = 'display:flex;align-items:center;gap:3px;font-size:9px;color:var(--text-dim);';

      const dot = document.createElement('div');
      const color = configColors.get(config.id) ?? '#6b7280';
      dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${color};`;
      legendItem.appendChild(dot);

      const name = document.createElement('span');
      name.textContent = config.label;
      legendItem.appendChild(name);

      legend.appendChild(legendItem);
    }

    section.appendChild(legend);
    return section;
  }

  // ─── Create Profile Form ──────────────────────────────────────

  private showCreateForm(): void {
    this.currentView = 'create';
    this.container.innerHTML = '';

    const header = this.createHeader('➕ Create Benchmark Profile', [
      { label: '←', title: 'Back to profiles', onClick: () => this.loadProfiles() },
    ]);
    this.container.appendChild(header);

    const formArea = document.createElement('div');
    formArea.style.cssText = 'flex:1;overflow-y:auto;padding:12px;';

    // Name input
    const nameGroup = this.createFormGroup('Profile Name');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'e.g., Code Generation Comparison';
    nameInput.style.cssText = this.inputStyle();
    nameInput.setAttribute('aria-label', 'Profile name');
    nameGroup.appendChild(nameInput);
    formArea.appendChild(nameGroup);

    // Prompt input
    const promptGroup = this.createFormGroup('Prompt');
    const promptInput = document.createElement('textarea');
    promptInput.placeholder = 'The prompt to run against all configurations…';
    promptInput.rows = 4;
    promptInput.style.cssText = this.inputStyle() + 'resize:vertical;min-height:60px;';
    promptInput.setAttribute('aria-label', 'Benchmark prompt');
    promptGroup.appendChild(promptInput);
    formArea.appendChild(promptGroup);

    // Configurations note
    const configNote = document.createElement('div');
    configNote.style.cssText = 'font-size:10px;color:var(--text-dim);margin:8px 0;padding:8px;background:var(--bg-input);border-radius:4px;';
    configNote.textContent = 'Configurations can be added after creation via the benchmark API. A minimum of 2 configurations are required to run a benchmark.';
    formArea.appendChild(configNote);

    // Submit button
    const submitBtn = document.createElement('button');
    submitBtn.textContent = 'Create Profile';
    submitBtn.style.cssText =
      'margin-top:12px;padding:8px 16px;background:var(--accent,#3b82f6);color:white;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;width:100%;';
    submitBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const prompt = promptInput.value.trim();

      if (!name || !prompt) {
        this.showInlineError(formArea, 'Name and prompt are required.');
        return;
      }

      await this.createProfile(name, prompt);
    });
    formArea.appendChild(submitBtn);

    this.container.appendChild(formArea);
  }

  private async createProfile(name: string, prompt: string): Promise<void> {
    try {
      // Create with minimal placeholder configs (user can add more via API)
      const result = await eapi().invoke('bench:create-profile', {
        name,
        prompt,
        configurations: [
          { id: 'config-a', label: 'Config A', provider: 'default', model: 'default', temperature: 0.7, maxTokens: 2048, topP: 1.0 },
          { id: 'config-b', label: 'Config B', provider: 'default', model: 'default', temperature: 0.3, maxTokens: 2048, topP: 1.0 },
        ],
        evaluationCriteria: [],
      }) as { profile?: BenchmarkProfile; error?: true; message?: string };

      if (result.error) {
        this.showError(result.message ?? 'Failed to create profile');
        return;
      }

      // Navigate back to profiles list
      await this.loadProfiles();
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── UI Helpers ───────────────────────────────────────────────

  private createHeader(
    title: string,
    buttons: Array<{ label: string; title: string; onClick: () => void }>,
  ): HTMLElement {
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-input);border-bottom:1px solid var(--border-color);min-height:36px;';

    const titleEl = document.createElement('span');
    titleEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    titleEl.textContent = title;
    header.appendChild(titleEl);

    if (buttons.length > 0) {
      const btnGroup = document.createElement('div');
      btnGroup.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

      for (const btn of buttons) {
        const el = document.createElement('button');
        el.textContent = btn.label;
        el.title = btn.title;
        el.setAttribute('aria-label', btn.title);
        el.style.cssText =
          'font-size:13px;width:28px;height:28px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
        el.addEventListener('click', btn.onClick);
        btnGroup.appendChild(el);
      }

      header.appendChild(btnGroup);
    }

    return header;
  }

  private createEmptyState(message: string): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText =
      'text-align:center;padding:32px 16px;color:var(--text-dim);font-size:12px;';
    el.textContent = message;
    return el;
  }

  private createFormGroup(label: string): HTMLElement {
    const group = document.createElement('div');
    group.style.cssText = 'margin-bottom:10px;';

    const labelEl = document.createElement('label');
    labelEl.style.cssText = 'display:block;font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:4px;';
    labelEl.textContent = label;
    group.appendChild(labelEl);

    return group;
  }

  private inputStyle(): string {
    return 'width:100%;padding:6px 8px;font-size:12px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-input);color:var(--text-primary);font-family:inherit;box-sizing:border-box;';
  }

  private showInlineError(parent: HTMLElement, message: string): void {
    // Remove any existing inline error
    const existing = parent.querySelector('[data-inline-error]');
    if (existing) existing.remove();

    const errorEl = document.createElement('div');
    errorEl.setAttribute('data-inline-error', 'true');
    errorEl.style.cssText =
      'margin-top:8px;padding:8px;background:var(--red-container,rgba(248,113,113,0.12));border:1px solid var(--red,#ef4444);border-radius:4px;font-size:11px;color:var(--red,#ef4444);';
    errorEl.textContent = message;
    parent.appendChild(errorEl);
  }

  private showError(message: string): void {
    this.container.innerHTML = '';

    const header = this.createHeader('📊 Benchmarks', [
      { label: '↻', title: 'Retry', onClick: () => this.loadProfiles() },
    ]);
    this.container.appendChild(header);

    const errorEl = document.createElement('div');
    errorEl.style.cssText =
      'margin:12px;padding:12px;background:var(--red-container,rgba(248,113,113,0.12));border:1px solid var(--red,#ef4444);border-radius:8px;font-size:12px;color:var(--red,#ef4444);';
    errorEl.textContent = `Error: ${message}`;
    this.container.appendChild(errorEl);
  }

  /** Clean up resources. */
  destroy(): void {
    this.container.innerHTML = '';
  }
}

// ─── Convenience export ─────────────────────────────────────────

/**
 * Render the benchmark panel into the given container element.
 * Returns the panel instance for lifecycle management.
 */
export function renderBenchmarkPanel(container: HTMLElement): BenchmarkPanel {
  const panel = new BenchmarkPanel(container);
  panel.render();
  return panel;
}
