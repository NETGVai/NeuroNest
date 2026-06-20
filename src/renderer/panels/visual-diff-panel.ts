/**
 * VisualDiffPanel — Side-by-side image comparison with difference overlay display.
 *
 * Features:
 * - Side-by-side view for comparing two images (expected vs actual)
 * - Difference overlay highlighting regions that differ
 * - Similarity percentage and diff region list
 * - Threshold configuration for classification
 * - Diagram recognition results display with Mermaid source
 *
 * Requirements: 8.4, 22.3
 */

import type {
  VisualAnalysisResult,
  DiagramRecognitionResult,
  DetectedComponent,
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

interface CompareResult {
  similarityPercent: number;
  diffRegions: Array<{ x: number; y: number; width: number; height: number; area: number }>;
  isVisuallyDifferent: boolean;
  diffImageBase64?: string;
}

interface IPCError {
  error: true;
  code: string;
  message: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function isIPCError(result: unknown): result is IPCError {
  return !!result && typeof result === 'object' && 'error' in result;
}

// ─── VisualDiffPanel ────────────────────────────────────────────

export class VisualDiffPanel {
  private container: HTMLElement;
  private currentView: string = 'compare';
  private threshold: number = 5;
  private lastCompareResult: CompareResult | null = null;
  private lastAnalyzeResult: VisualAnalysisResult | null = null;
  private lastDiagramResult: DiagramRecognitionResult | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Render the panel with initial compare view. */
  render(): void {
    this.container.innerHTML = '';
    this.container.style.cssText =
      'display:flex;flex-direction:column;height:100%;font-family:var(--font-family,system-ui);';
    this.renderCompareView();
  }

  // ─── Compare View (Side-by-Side Diff) ───────────────────────

  private renderCompareView(): void {
    this.currentView = 'compare';
    this.container.innerHTML = '';

    const header = this.createHeader('🔍 Visual Diff', [
      { label: '📷', title: 'Analyze Screenshot', onClick: () => this.renderAnalyzeView() },
      { label: '🗺️', title: 'Diagram Recognition', onClick: () => this.renderDiagramView() },
    ]);
    this.container.appendChild(header);

    const content = document.createElement('div');
    content.style.cssText = 'flex:1;overflow-y:auto;padding:12px;';

    // Threshold configuration
    content.appendChild(this.createThresholdControl());

    // Drop zones for two images
    const dropContainer = document.createElement('div');
    dropContainer.style.cssText =
      'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;';

    const dropZoneA = this.createImageDropZone('Image A (Expected)', 'imageA');
    const dropZoneB = this.createImageDropZone('Image B (Actual)', 'imageB');

    dropContainer.appendChild(dropZoneA);
    dropContainer.appendChild(dropZoneB);
    content.appendChild(dropContainer);

    // Compare button
    const compareBtn = document.createElement('button');
    compareBtn.textContent = 'Compare Images';
    compareBtn.setAttribute('aria-label', 'Compare the two loaded images');
    compareBtn.style.cssText =
      'width:100%;margin-top:12px;padding:10px;background:var(--accent,#3b82f6);color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;';
    compareBtn.addEventListener('click', () => this.runCompare());
    content.appendChild(compareBtn);

    // Results area placeholder
    const resultsArea = document.createElement('div');
    resultsArea.id = 'vision-compare-results';
    resultsArea.style.cssText = 'margin-top:16px;';
    content.appendChild(resultsArea);

    this.container.appendChild(content);
  }

  private createThresholdControl(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-input);border-radius:6px;font-size:12px;';

    const label = document.createElement('label');
    label.textContent = 'Diff Threshold:';
    label.style.cssText = 'color:var(--text-secondary);flex-shrink:0;';
    label.htmlFor = 'vision-threshold';
    wrapper.appendChild(label);

    const input = document.createElement('input');
    input.id = 'vision-threshold';
    input.type = 'range';
    input.min = '1';
    input.max = '50';
    input.value = String(this.threshold);
    input.style.cssText = 'flex:1;';
    input.setAttribute('aria-label', 'Difference threshold percentage');
    wrapper.appendChild(input);

    const valueDisplay = document.createElement('span');
    valueDisplay.style.cssText = 'color:var(--text-primary);font-weight:600;min-width:36px;text-align:right;';
    valueDisplay.textContent = `${this.threshold}%`;
    wrapper.appendChild(valueDisplay);

    input.addEventListener('input', () => {
      this.threshold = parseInt(input.value, 10);
      valueDisplay.textContent = `${this.threshold}%`;
    });

    return wrapper;
  }

  private createImageDropZone(label: string, dataKey: string): HTMLElement {
    const zone = document.createElement('div');
    zone.dataset['imageKey'] = dataKey;
    zone.style.cssText =
      'border:2px dashed var(--border-color);border-radius:8px;padding:24px 12px;text-align:center;min-height:120px;display:flex;flex-direction:column;align-items:center;justify-content:center;transition:border-color 0.2s,background 0.2s;cursor:pointer;position:relative;';
    zone.setAttribute('role', 'button');
    zone.setAttribute('aria-label', `Drop zone for ${label}`);
    zone.tabIndex = 0;

    const labelEl = document.createElement('div');
    labelEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px;';
    labelEl.textContent = label;
    zone.appendChild(labelEl);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:var(--text-dim);';
    hint.textContent = 'Drop image or click to select';
    zone.appendChild(hint);

    // File input (hidden)
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    fileInput.setAttribute('aria-hidden', 'true');
    zone.appendChild(fileInput);

    // Click to open file dialog
    zone.addEventListener('click', () => fileInput.click());
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });

    // File selection handler
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) this.loadImageFile(file, zone, dataKey);
    });

    // Drag and drop
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.style.borderColor = 'var(--accent,#3b82f6)';
      zone.style.background = 'rgba(59,130,246,0.05)';
    });

    zone.addEventListener('dragleave', () => {
      zone.style.borderColor = 'var(--border-color)';
      zone.style.background = '';
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.style.borderColor = 'var(--border-color)';
      zone.style.background = '';
      const file = e.dataTransfer?.files[0];
      if (file && file.type.startsWith('image/')) {
        this.loadImageFile(file, zone, dataKey);
      }
    });

    return zone;
  }

  private loadImageFile(file: File, zone: HTMLElement, dataKey: string): void {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Store image data on the zone element for later retrieval
        (zone as any).__imageData = {
          src: reader.result as string,
          width: img.naturalWidth,
          height: img.naturalHeight,
        };

        // Show preview thumbnail
        zone.innerHTML = '';
        const preview = document.createElement('img');
        preview.src = reader.result as string;
        preview.style.cssText = 'max-width:100%;max-height:100px;border-radius:4px;object-fit:contain;';
        preview.alt = `Preview for ${dataKey}`;
        zone.appendChild(preview);

        const dimensions = document.createElement('div');
        dimensions.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:4px;';
        dimensions.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
        zone.appendChild(dimensions);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  // ─── Compare Execution ──────────────────────────────────────

  private async runCompare(): Promise<void> {
    const zoneA = this.container.querySelector('[data-image-key="imageA"]') as HTMLElement | null;
    const zoneB = this.container.querySelector('[data-image-key="imageB"]') as HTMLElement | null;

    const dataA = (zoneA as any)?.__imageData;
    const dataB = (zoneB as any)?.__imageData;

    if (!dataA || !dataB) {
      this.showResultsError('Please load both images before comparing.');
      return;
    }

    const resultsArea = this.container.querySelector('#vision-compare-results') as HTMLElement;
    if (resultsArea) {
      resultsArea.innerHTML =
        '<div style="text-align:center;padding:12px;color:var(--text-dim);font-size:12px;">Comparing images…</div>';
    }

    try {
      // Extract base64 data (strip data URL prefix)
      const base64A = (dataA.src as string).replace(/^data:image\/\w+;base64,/, '');
      const base64B = (dataB.src as string).replace(/^data:image\/\w+;base64,/, '');

      const result = await eapi().invoke('vision:compare', {
        imageA: base64A,
        widthA: dataA.width,
        heightA: dataA.height,
        imageB: base64B,
        widthB: dataB.width,
        heightB: dataB.height,
        threshold: this.threshold,
      });

      if (isIPCError(result)) {
        this.showResultsError(result.message);
        return;
      }

      this.lastCompareResult = result as CompareResult;
      this.renderCompareResults(dataA.src, dataB.src, result as CompareResult);
    } catch (err: unknown) {
      this.showResultsError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderCompareResults(
    srcA: string,
    srcB: string,
    result: CompareResult,
  ): void {
    const resultsArea = this.container.querySelector('#vision-compare-results') as HTMLElement;
    if (!resultsArea) return;
    resultsArea.innerHTML = '';

    // Summary bar
    const summary = document.createElement('div');
    summary.style.cssText =
      'padding:10px 12px;border-radius:6px;font-size:12px;display:flex;align-items:center;gap:12px;margin-bottom:12px;';
    summary.style.background = result.isVisuallyDifferent
      ? 'var(--red-container,rgba(248,113,113,0.12))'
      : 'var(--green-container,rgba(74,222,128,0.12))';
    summary.style.border = result.isVisuallyDifferent
      ? '1px solid var(--red,#ef4444)'
      : '1px solid var(--green,#22c55e)';

    const statusIcon = document.createElement('span');
    statusIcon.style.cssText = 'font-size:16px;';
    statusIcon.textContent = result.isVisuallyDifferent ? '⚠️' : '✅';
    summary.appendChild(statusIcon);

    const statusText = document.createElement('div');
    statusText.style.cssText = 'flex:1;';
    const statusLabel = document.createElement('div');
    statusLabel.style.cssText = 'font-weight:600;color:var(--text-primary);';
    statusLabel.textContent = result.isVisuallyDifferent ? 'Visually Different' : 'Visually Similar';
    statusText.appendChild(statusLabel);

    const statusMeta = document.createElement('div');
    statusMeta.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:2px;';
    statusMeta.textContent = `Similarity: ${formatPercent(result.similarityPercent)} · ${result.diffRegions.length} diff region(s) · Threshold: ${this.threshold}%`;
    statusText.appendChild(statusMeta);
    summary.appendChild(statusText);
    resultsArea.appendChild(summary);

    // Side-by-side view with overlay
    const sideBySide = document.createElement('div');
    sideBySide.style.cssText =
      'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;';

    sideBySide.appendChild(this.createImagePanel('Expected (A)', srcA, result.diffRegions));
    sideBySide.appendChild(this.createImagePanel('Actual (B)', srcB, result.diffRegions));
    resultsArea.appendChild(sideBySide);

    // Diff overlay image (if available)
    if (result.diffImageBase64) {
      const overlaySection = document.createElement('div');
      overlaySection.style.cssText = 'margin-bottom:12px;';

      const overlayLabel = document.createElement('div');
      overlayLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;';
      overlayLabel.textContent = 'Difference Overlay';
      overlaySection.appendChild(overlayLabel);

      const overlayImg = document.createElement('img');
      overlayImg.src = `data:image/png;base64,${result.diffImageBase64}`;
      overlayImg.alt = 'Difference overlay showing highlighted diff regions';
      overlayImg.style.cssText =
        'width:100%;border-radius:6px;border:1px solid var(--border-color);';
      overlaySection.appendChild(overlayImg);
      resultsArea.appendChild(overlaySection);
    }

    // Diff regions table
    if (result.diffRegions.length > 0) {
      resultsArea.appendChild(this.createDiffRegionsTable(result.diffRegions));
    }
  }

  private createImagePanel(
    label: string,
    src: string,
    diffRegions: CompareResult['diffRegions'],
  ): HTMLElement {
    const panel = document.createElement('div');
    panel.style.cssText = 'position:relative;overflow:hidden;border-radius:6px;border:1px solid var(--border-color);';

    const labelEl = document.createElement('div');
    labelEl.style.cssText =
      'position:absolute;top:4px;left:4px;background:rgba(0,0,0,0.7);color:white;font-size:10px;padding:2px 6px;border-radius:3px;z-index:1;';
    labelEl.textContent = label;
    panel.appendChild(labelEl);

    // Image container with diff region overlay
    const imgContainer = document.createElement('div');
    imgContainer.style.cssText = 'position:relative;';

    const img = document.createElement('img');
    img.src = src;
    img.alt = label;
    img.style.cssText = 'width:100%;display:block;';
    imgContainer.appendChild(img);

    // Overlay diff region boxes
    for (const region of diffRegions) {
      const overlay = document.createElement('div');
      overlay.style.cssText =
        `position:absolute;border:2px solid rgba(239,68,68,0.8);background:rgba(239,68,68,0.15);pointer-events:none;` +
        `left:${region.x}px;top:${region.y}px;width:${region.width}px;height:${region.height}px;`;
      overlay.setAttribute('aria-hidden', 'true');
      imgContainer.appendChild(overlay);
    }

    panel.appendChild(imgContainer);
    return panel;
  }

  private createDiffRegionsTable(
    regions: CompareResult['diffRegions'],
  ): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'overflow-x:auto;';

    const label = document.createElement('div');
    label.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;';
    label.textContent = `Diff Regions (${regions.length})`;
    wrapper.appendChild(label);

    const table = document.createElement('table');
    table.style.cssText =
      'border-collapse:collapse;width:100%;font-size:11px;background:var(--bg-input);border-radius:6px;overflow:hidden;';
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', 'Diff regions');

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of ['#', 'X', 'Y', 'Width', 'Height', 'Area']) {
      const th = document.createElement('th');
      th.style.cssText =
        'padding:6px 8px;text-align:left;border-bottom:1px solid var(--border-color);font-weight:600;color:var(--text-primary);background:var(--bg-hover);';
      th.textContent = col;
      th.setAttribute('scope', 'col');
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let i = 0; i < Math.min(regions.length, 20); i++) {
      const r = regions[i]!;
      const tr = document.createElement('tr');
      for (const val of [i + 1, r.x, r.y, r.width, r.height, r.area]) {
        const td = document.createElement('td');
        td.style.cssText =
          'padding:4px 8px;border-bottom:1px solid var(--border-color);color:var(--text-secondary);';
        td.textContent = String(val);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);

    if (regions.length > 20) {
      const more = document.createElement('div');
      more.style.cssText = 'font-size:10px;color:var(--text-dim);padding:6px;text-align:center;';
      more.textContent = `Showing 20 of ${regions.length} regions`;
      wrapper.appendChild(more);
    }

    return wrapper;
  }

  // ─── Analyze View ─────────────────────────────────────────────

  private renderAnalyzeView(): void {
    this.currentView = 'analyze';
    this.container.innerHTML = '';

    const header = this.createHeader('📷 Screenshot Analysis', [
      { label: '←', title: 'Back to Compare', onClick: () => this.renderCompareView() },
    ]);
    this.container.appendChild(header);

    const content = document.createElement('div');
    content.style.cssText = 'flex:1;overflow-y:auto;padding:12px;';

    const dropZone = this.createImageDropZone('Screenshot to Analyze', 'analyzeImage');
    content.appendChild(dropZone);

    const analyzeBtn = document.createElement('button');
    analyzeBtn.textContent = 'Analyze Screenshot';
    analyzeBtn.setAttribute('aria-label', 'Analyze the loaded screenshot for UI components');
    analyzeBtn.style.cssText =
      'width:100%;margin-top:12px;padding:10px;background:var(--accent,#3b82f6);color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;';
    analyzeBtn.addEventListener('click', () => this.runAnalyze());
    content.appendChild(analyzeBtn);

    const resultsArea = document.createElement('div');
    resultsArea.id = 'vision-analyze-results';
    resultsArea.style.cssText = 'margin-top:16px;';
    content.appendChild(resultsArea);

    this.container.appendChild(content);
  }

  private async runAnalyze(): Promise<void> {
    const zone = this.container.querySelector('[data-image-key="analyzeImage"]') as HTMLElement | null;
    const data = (zone as any)?.__imageData;

    if (!data) {
      this.showResultsError('Please load an image first.');
      return;
    }

    const resultsArea = this.container.querySelector('#vision-analyze-results') as HTMLElement;
    if (resultsArea) {
      resultsArea.innerHTML =
        '<div style="text-align:center;padding:12px;color:var(--text-dim);font-size:12px;">Analyzing screenshot…</div>';
    }

    try {
      const base64 = (data.src as string).replace(/^data:image\/\w+;base64,/, '');

      const result = await eapi().invoke('vision:analyze', {
        image: base64,
        width: data.width,
        height: data.height,
      });

      if (isIPCError(result)) {
        this.showResultsError(result.message);
        return;
      }

      this.lastAnalyzeResult = result as VisualAnalysisResult;
      this.renderAnalyzeResults(data.src, result as VisualAnalysisResult);
    } catch (err: unknown) {
      this.showResultsError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderAnalyzeResults(src: string, result: VisualAnalysisResult): void {
    const resultsArea = this.container.querySelector('#vision-analyze-results') as HTMLElement;
    if (!resultsArea) return;
    resultsArea.innerHTML = '';

    // Summary
    const summary = document.createElement('div');
    summary.style.cssText =
      'padding:8px 12px;background:var(--bg-input);border-radius:6px;font-size:12px;color:var(--text-secondary);margin-bottom:12px;';
    summary.textContent = `Detected ${result.components.length} components in ${result.processingTimeMs}ms (${result.imageSize.width}×${result.imageSize.height})`;
    resultsArea.appendChild(summary);

    // Image with bounding box overlay
    const imgContainer = document.createElement('div');
    imgContainer.style.cssText =
      'position:relative;border-radius:6px;overflow:hidden;border:1px solid var(--border-color);margin-bottom:12px;';

    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Analyzed screenshot with detected components';
    img.style.cssText = 'width:100%;display:block;';
    imgContainer.appendChild(img);

    // Draw bounding boxes
    for (const comp of result.components) {
      const box = document.createElement('div');
      box.style.cssText =
        `position:absolute;border:2px solid rgba(59,130,246,0.8);background:rgba(59,130,246,0.1);pointer-events:none;` +
        `left:${comp.boundingBox.x}px;top:${comp.boundingBox.y}px;width:${comp.boundingBox.width}px;height:${comp.boundingBox.height}px;`;

      const boxLabel = document.createElement('span');
      boxLabel.style.cssText =
        'position:absolute;top:-16px;left:0;font-size:9px;background:rgba(59,130,246,0.9);color:white;padding:1px 4px;border-radius:2px;white-space:nowrap;';
      boxLabel.textContent = `${comp.type} (${(comp.confidence * 100).toFixed(0)}%)`;
      box.appendChild(boxLabel);
      box.setAttribute('aria-hidden', 'true');
      imgContainer.appendChild(box);
    }

    resultsArea.appendChild(imgContainer);

    // Components list
    if (result.components.length > 0) {
      resultsArea.appendChild(this.createComponentsList(result.components));
    }
  }

  private createComponentsList(components: DetectedComponent[]): HTMLElement {
    const wrapper = document.createElement('div');

    const label = document.createElement('div');
    label.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;';
    label.textContent = `Detected Components (${components.length})`;
    wrapper.appendChild(label);

    for (const comp of components) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-input);margin-bottom:4px;font-size:11px;';

      const typeEl = document.createElement('span');
      typeEl.style.cssText = 'font-weight:600;color:var(--text-primary);min-width:80px;';
      typeEl.textContent = comp.type;
      row.appendChild(typeEl);

      const confEl = document.createElement('span');
      confEl.style.cssText = 'color:var(--accent,#3b82f6);min-width:40px;';
      confEl.textContent = `${(comp.confidence * 100).toFixed(0)}%`;
      row.appendChild(confEl);

      const posEl = document.createElement('span');
      posEl.style.cssText = 'color:var(--text-dim);font-size:10px;';
      posEl.textContent = `(${comp.boundingBox.x}, ${comp.boundingBox.y}) ${comp.boundingBox.width}×${comp.boundingBox.height}`;
      row.appendChild(posEl);

      if (comp.label) {
        const labelEl = document.createElement('span');
        labelEl.style.cssText = 'color:var(--text-secondary);font-style:italic;';
        labelEl.textContent = comp.label;
        row.appendChild(labelEl);
      }

      wrapper.appendChild(row);
    }

    return wrapper;
  }

  // ─── Diagram View ─────────────────────────────────────────────

  private renderDiagramView(): void {
    this.currentView = 'diagram';
    this.container.innerHTML = '';

    const header = this.createHeader('🗺️ Diagram Recognition', [
      { label: '←', title: 'Back to Compare', onClick: () => this.renderCompareView() },
    ]);
    this.container.appendChild(header);

    const content = document.createElement('div');
    content.style.cssText = 'flex:1;overflow-y:auto;padding:12px;';

    const dropZone = this.createImageDropZone('Architecture Diagram', 'diagramImage');
    content.appendChild(dropZone);

    const recognizeBtn = document.createElement('button');
    recognizeBtn.textContent = 'Recognize Diagram';
    recognizeBtn.setAttribute('aria-label', 'Recognize architecture diagram and extract graph structure');
    recognizeBtn.style.cssText =
      'width:100%;margin-top:12px;padding:10px;background:var(--accent,#3b82f6);color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;';
    recognizeBtn.addEventListener('click', () => this.runDiagramRecognition());
    content.appendChild(recognizeBtn);

    const resultsArea = document.createElement('div');
    resultsArea.id = 'vision-diagram-results';
    resultsArea.style.cssText = 'margin-top:16px;';
    content.appendChild(resultsArea);

    this.container.appendChild(content);
  }

  private async runDiagramRecognition(): Promise<void> {
    const zone = this.container.querySelector('[data-image-key="diagramImage"]') as HTMLElement | null;
    const data = (zone as any)?.__imageData;

    if (!data) {
      this.showResultsError('Please load an image first.');
      return;
    }

    const resultsArea = this.container.querySelector('#vision-diagram-results') as HTMLElement;
    if (resultsArea) {
      resultsArea.innerHTML =
        '<div style="text-align:center;padding:12px;color:var(--text-dim);font-size:12px;">Recognizing diagram…</div>';
    }

    try {
      const base64 = (data.src as string).replace(/^data:image\/\w+;base64,/, '');

      const result = await eapi().invoke('vision:diagram', {
        image: base64,
        width: data.width,
        height: data.height,
      });

      if (isIPCError(result)) {
        this.showResultsError(result.message);
        return;
      }

      this.lastDiagramResult = result as DiagramRecognitionResult;
      this.renderDiagramResults(result as DiagramRecognitionResult);
    } catch (err: unknown) {
      this.showResultsError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderDiagramResults(result: DiagramRecognitionResult): void {
    const resultsArea = this.container.querySelector('#vision-diagram-results') as HTMLElement;
    if (!resultsArea) return;
    resultsArea.innerHTML = '';

    // Confidence summary
    const summary = document.createElement('div');
    summary.style.cssText =
      'padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:12px;';
    const confPercent = (result.confidence * 100).toFixed(1);
    const isLowConfidence = result.confidence < 0.6;
    summary.style.background = isLowConfidence
      ? 'var(--red-container,rgba(248,113,113,0.12))'
      : 'var(--green-container,rgba(74,222,128,0.12))';
    summary.style.border = isLowConfidence
      ? '1px solid var(--red,#ef4444)'
      : '1px solid var(--green,#22c55e)';

    summary.innerHTML = `
      <div style="font-weight:600;color:var(--text-primary);">
        ${isLowConfidence ? '⚠️ Low Confidence' : '✅ Diagram Recognized'}
      </div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">
        Confidence: ${confPercent}% · ${result.nodes.length} nodes · ${result.edges.length} edges
      </div>
    `;
    resultsArea.appendChild(summary);

    // Nodes list
    if (result.nodes.length > 0) {
      const nodesSection = document.createElement('div');
      nodesSection.style.cssText = 'margin-bottom:12px;';

      const nodesLabel = document.createElement('div');
      nodesLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;';
      nodesLabel.textContent = `Nodes (${result.nodes.length})`;
      nodesSection.appendChild(nodesLabel);

      for (const node of result.nodes) {
        const row = document.createElement('div');
        row.style.cssText =
          'display:flex;align-items:center;gap:8px;padding:4px 10px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-input);margin-bottom:3px;font-size:11px;';
        row.innerHTML = `
          <span style="font-weight:600;color:var(--text-primary);">${this.escHtml(node.label)}</span>
          <span style="color:var(--text-dim);font-size:10px;">(${node.bounds.x}, ${node.bounds.y}) ${node.bounds.width}×${node.bounds.height}</span>
        `;
        nodesSection.appendChild(row);
      }
      resultsArea.appendChild(nodesSection);
    }

    // Edges list
    if (result.edges.length > 0) {
      const edgesSection = document.createElement('div');
      edgesSection.style.cssText = 'margin-bottom:12px;';

      const edgesLabel = document.createElement('div');
      edgesLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;';
      edgesLabel.textContent = `Edges (${result.edges.length})`;
      edgesSection.appendChild(edgesLabel);

      for (const edge of result.edges) {
        const row = document.createElement('div');
        row.style.cssText =
          'padding:4px 10px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-input);margin-bottom:3px;font-size:11px;color:var(--text-secondary);';
        row.textContent = `${edge.from} → ${edge.to}${edge.label ? ` [${edge.label}]` : ''}`;
        edgesSection.appendChild(row);
      }
      resultsArea.appendChild(edgesSection);
    }

    // Mermaid source (Requirement 22.3)
    if (result.mermaidSource) {
      const mermaidSection = document.createElement('div');
      mermaidSection.style.cssText = 'margin-bottom:12px;';

      const mermaidLabel = document.createElement('div');
      mermaidLabel.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;';

      const labelText = document.createElement('span');
      labelText.textContent = 'Mermaid Source';
      mermaidLabel.appendChild(labelText);

      const copyBtn = document.createElement('button');
      copyBtn.textContent = '📋 Copy';
      copyBtn.setAttribute('aria-label', 'Copy Mermaid source to clipboard');
      copyBtn.style.cssText =
        'font-size:10px;padding:2px 6px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:3px;cursor:pointer;';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(result.mermaidSource!).catch(() => {});
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
      });
      mermaidLabel.appendChild(copyBtn);
      mermaidSection.appendChild(mermaidLabel);

      const pre = document.createElement('pre');
      pre.style.cssText =
        'background:var(--bg-code,#1e1e1e);color:var(--text-code,#d4d4d4);padding:12px;border-radius:6px;font-size:11px;font-family:var(--font-mono,"Fira Code",monospace);overflow-x:auto;white-space:pre-wrap;word-break:break-word;line-height:1.5;max-height:300px;overflow-y:auto;';
      pre.textContent = result.mermaidSource;
      mermaidSection.appendChild(pre);

      resultsArea.appendChild(mermaidSection);
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
    titleEl.style.cssText =
      'font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
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

  private showResultsError(message: string): void {
    // Try to find any results area on the page
    const resultsArea =
      this.container.querySelector('#vision-compare-results') ??
      this.container.querySelector('#vision-analyze-results') ??
      this.container.querySelector('#vision-diagram-results');

    if (resultsArea) {
      resultsArea.innerHTML = '';
      const errorEl = document.createElement('div');
      errorEl.style.cssText =
        'padding:12px;background:var(--red-container,rgba(248,113,113,0.12));border:1px solid var(--red,#ef4444);border-radius:8px;font-size:12px;color:var(--red,#ef4444);';
      errorEl.textContent = `Error: ${message}`;
      resultsArea.appendChild(errorEl);
    }
  }

  private escHtml(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /** Clean up resources. */
  destroy(): void {
    this.container.innerHTML = '';
  }
}

// ─── Convenience export ─────────────────────────────────────────

/**
 * Render the visual diff panel into the given container element.
 * Returns the panel instance for lifecycle management.
 */
export function renderVisualDiffPanel(container: HTMLElement): VisualDiffPanel {
  const panel = new VisualDiffPanel(container);
  panel.render();
  return panel;
}
