/**
 * LargeOutputHandler — Paginate or expand large output in chat responses.
 *
 * Large outputs are summarized in chat with expandable or separately
 * paginated detail rather than freezing the timeline.
 *
 * Requirements: 17.6
 */

// ─── Types ──────────────────────────────────────────────────────

/**
 * Configuration for large output handling.
 */
export interface LargeOutputConfig {
  /** Maximum lines to show before collapsing. Default: 50 */
  readonly maxVisibleLines: number;
  /** Maximum characters before collapsing. Default: 5000 */
  readonly maxVisibleChars: number;
  /** Number of lines per page in paginated mode. Default: 100 */
  readonly pageSize: number;
  /** Whether to show a summary when collapsed. Default: true */
  readonly showSummary: boolean;
}

/**
 * Output display mode.
 */
export type OutputDisplayMode = 'collapsed' | 'expanded' | 'paginated';

/**
 * A chunk of output for display.
 */
export interface OutputChunk {
  readonly id: string;
  readonly content: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly isFirstChunk: boolean;
  readonly isLastChunk: boolean;
}

/**
 * The current state of a large output block.
 */
export interface LargeOutputState {
  readonly outputId: string;
  readonly totalLines: number;
  readonly totalChars: number;
  readonly isLarge: boolean;
  readonly displayMode: OutputDisplayMode;
  readonly currentPage: number;
  readonly totalPages: number;
  readonly summary: string;
  readonly visibleContent: string;
  readonly truncated: boolean;
}

/**
 * Remote resource gating state.
 */
export interface RemoteResourceGate {
  readonly uri: string;
  readonly allowed: boolean;
  readonly reason?: string | undefined;
  readonly contentType?: string | undefined;
  readonly estimatedSize?: number | undefined;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_CONFIG: LargeOutputConfig = {
  maxVisibleLines: 50,
  maxVisibleChars: 5000,
  pageSize: 100,
  showSummary: true,
};

// ─── Service ────────────────────────────────────────────────────

function generateOutputId(): string {
  return `output-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class LargeOutputHandler {
  private readonly config: LargeOutputConfig;
  private readonly outputs: Map<string, { content: string; state: LargeOutputState }> = new Map();
  private readonly gatedResources: Map<string, RemoteResourceGate> = new Map();

  constructor(config?: Partial<LargeOutputConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process output content and determine if it needs large-output handling.
   * Returns the state with appropriate display mode.
   */
  process(content: string, outputId?: string): LargeOutputState {
    const id = outputId ?? generateOutputId();
    const lines = content.split('\n');
    const totalLines = lines.length;
    const totalChars = content.length;

    const isLarge = totalLines > this.config.maxVisibleLines || totalChars > this.config.maxVisibleChars;
    const totalPages = isLarge ? Math.ceil(totalLines / this.config.pageSize) : 1;

    let visibleContent: string;
    let truncated: boolean;
    let displayMode: OutputDisplayMode;

    if (!isLarge) {
      visibleContent = content;
      truncated = false;
      displayMode = 'expanded';
    } else {
      // Start collapsed with first N lines visible
      const visibleLines = lines.slice(0, this.config.maxVisibleLines);
      visibleContent = visibleLines.join('\n');
      truncated = true;
      displayMode = 'collapsed';
    }

    const summary = this.generateSummary(content, totalLines, totalChars);

    const state: LargeOutputState = {
      outputId: id,
      totalLines,
      totalChars,
      isLarge,
      displayMode,
      currentPage: 1,
      totalPages,
      summary,
      visibleContent,
      truncated,
    };

    this.outputs.set(id, { content, state });
    return state;
  }

  /**
   * Expand a collapsed output to full content.
   */
  expand(outputId: string): LargeOutputState | null {
    const entry = this.outputs.get(outputId);
    if (!entry) return null;

    const updated: LargeOutputState = {
      ...entry.state,
      displayMode: 'expanded',
      visibleContent: entry.content,
      truncated: false,
    };
    this.outputs.set(outputId, { content: entry.content, state: updated });
    return updated;
  }

  /**
   * Collapse an expanded output back to summary view.
   */
  collapse(outputId: string): LargeOutputState | null {
    const entry = this.outputs.get(outputId);
    if (!entry) return null;

    if (!entry.state.isLarge) {
      return entry.state; // Not large, cannot collapse
    }

    const lines = entry.content.split('\n');
    const visibleLines = lines.slice(0, this.config.maxVisibleLines);

    const updated: LargeOutputState = {
      ...entry.state,
      displayMode: 'collapsed',
      visibleContent: visibleLines.join('\n'),
      truncated: true,
      currentPage: 1,
    };
    this.outputs.set(outputId, { content: entry.content, state: updated });
    return updated;
  }

  /**
   * Switch to paginated mode.
   */
  paginate(outputId: string): LargeOutputState | null {
    const entry = this.outputs.get(outputId);
    if (!entry) return null;

    return this.goToPage(outputId, 1);
  }

  /**
   * Navigate to a specific page.
   */
  goToPage(outputId: string, page: number): LargeOutputState | null {
    const entry = this.outputs.get(outputId);
    if (!entry) return null;

    const lines = entry.content.split('\n');
    const totalPages = Math.ceil(lines.length / this.config.pageSize);
    const clampedPage = Math.max(1, Math.min(page, totalPages));
    const startLine = (clampedPage - 1) * this.config.pageSize;
    const endLine = Math.min(startLine + this.config.pageSize, lines.length);
    const pageLines = lines.slice(startLine, endLine);

    const updated: LargeOutputState = {
      ...entry.state,
      displayMode: 'paginated',
      currentPage: clampedPage,
      totalPages,
      visibleContent: pageLines.join('\n'),
      truncated: endLine < lines.length,
    };
    this.outputs.set(outputId, { content: entry.content, state: updated });
    return updated;
  }

  /**
   * Get a specific chunk (page) of an output.
   */
  getChunk(outputId: string, page: number): OutputChunk | null {
    const entry = this.outputs.get(outputId);
    if (!entry) return null;

    const lines = entry.content.split('\n');
    const totalPages = Math.ceil(lines.length / this.config.pageSize);
    const clampedPage = Math.max(1, Math.min(page, totalPages));
    const startLine = (clampedPage - 1) * this.config.pageSize;
    const endLine = Math.min(startLine + this.config.pageSize, lines.length);
    const pageLines = lines.slice(startLine, endLine);

    return {
      id: `${outputId}-chunk-${clampedPage}`,
      content: pageLines.join('\n'),
      lineStart: startLine + 1,
      lineEnd: endLine,
      isFirstChunk: clampedPage === 1,
      isLastChunk: clampedPage === totalPages,
    };
  }

  /**
   * Get the current state of an output.
   */
  getState(outputId: string): LargeOutputState | undefined {
    return this.outputs.get(outputId)?.state;
  }

  /**
   * Gate a remote resource — check if it should be loaded.
   */
  gateRemoteResource(uri: string, options?: { contentType?: string; estimatedSize?: number }): RemoteResourceGate {
    const gate: RemoteResourceGate = {
      uri,
      allowed: false,
      reason: 'Remote resources require explicit consent before loading.',
      ...(options?.contentType !== undefined ? { contentType: options.contentType } : {}),
      ...(options?.estimatedSize !== undefined ? { estimatedSize: options.estimatedSize } : {}),
    };
    this.gatedResources.set(uri, gate);
    return gate;
  }

  /**
   * Allow a gated remote resource to load.
   */
  allowRemoteResource(uri: string): RemoteResourceGate | null {
    const existing = this.gatedResources.get(uri);
    if (!existing) return null;

    const updated: RemoteResourceGate = {
      uri: existing.uri,
      allowed: true,
      ...(existing.contentType !== undefined ? { contentType: existing.contentType } : {}),
      ...(existing.estimatedSize !== undefined ? { estimatedSize: existing.estimatedSize } : {}),
    };
    this.gatedResources.set(uri, updated);
    return updated;
  }

  /**
   * Block a gated remote resource.
   */
  blockRemoteResource(uri: string, reason?: string): RemoteResourceGate | null {
    const existing = this.gatedResources.get(uri);
    if (!existing) return null;

    const updated: RemoteResourceGate = {
      uri: existing.uri,
      allowed: false,
      reason: reason ?? 'Resource blocked by security policy.',
      ...(existing.contentType !== undefined ? { contentType: existing.contentType } : {}),
      ...(existing.estimatedSize !== undefined ? { estimatedSize: existing.estimatedSize } : {}),
    };
    this.gatedResources.set(uri, updated);
    return updated;
  }

  /**
   * Check if a remote resource is allowed.
   */
  isResourceAllowed(uri: string): boolean {
    const gate = this.gatedResources.get(uri);
    return gate?.allowed === true;
  }

  /**
   * Get all gated resources.
   */
  getGatedResources(): readonly RemoteResourceGate[] {
    return [...this.gatedResources.values()];
  }

  /**
   * Clear all stored output data.
   */
  clear(): void {
    this.outputs.clear();
    this.gatedResources.clear();
  }

  // ─── Private ──────────────────────────────────────────────────

  private generateSummary(content: string, totalLines: number, totalChars: number): string {
    if (!this.config.showSummary) return '';

    const parts: string[] = [];
    parts.push(`${totalLines} lines`);
    if (totalChars > 10000) {
      parts.push(`${Math.round(totalChars / 1000)}K characters`);
    } else {
      parts.push(`${totalChars} characters`);
    }

    // Count code blocks
    const codeBlockMatches = content.match(/```/g);
    if (codeBlockMatches && codeBlockMatches.length >= 2) {
      const codeBlocks = Math.floor(codeBlockMatches.length / 2);
      parts.push(`${codeBlocks} code block${codeBlocks > 1 ? 's' : ''}`);
    }

    return parts.join(', ');
  }
}
