/**
 * DiffWorkerCoordinator — Routes diff computation requests to a worker thread
 * when above configurable size thresholds, or computes inline when below.
 *
 * Ensures the renderer's contribution stays bounded to one animation frame (16ms)
 * by offloading expensive diff work to a dedicated worker. Supports progressive
 * rendering through bounded slices and cancellation of in-flight work.
 *
 * Requirements: 7.3, 7.4, 7.5, 7.6, 7.7
 */

import { CanonicalDiffComputer } from './canonical-diff-computer';
import type { DiffInput, CanonicalDiffResult, FileDiff } from './canonical-diff-computer';

/**
 * Configuration thresholds for routing diff computation.
 */
export interface DiffWorkerThresholds {
  /** Maximum total line count for inline computation (default: 1000) */
  readonly maxInlineLines: number;
  /** Maximum total byte size for inline computation (default: 50_000) */
  readonly maxInlineBytes: number;
  /** Maximum number of files to process per progressive slice (default: 10) */
  readonly maxFilesPerSlice: number;
  /** Maximum lines per progressive slice for renderer consumption (default: 2000) */
  readonly maxLinesPerSlice: number;
}

/**
 * Latency diagnostic record for a single diff computation.
 */
export interface DiffLatencyDiagnostic {
  /** Unique request identifier */
  readonly requestId: string;
  /** Whether computation was done inline or via worker */
  readonly route: 'inline' | 'worker';
  /** Total computation time in milliseconds */
  readonly durationMs: number;
  /** Number of files in the diff input */
  readonly fileCount: number;
  /** Total line count across all files */
  readonly totalLines: number;
  /** Total byte size across all files */
  readonly totalBytes: number;
  /** Whether renderer budget (16ms) was exceeded */
  readonly exceededRendererBudget: boolean;
  /** Timestamp of the computation */
  readonly timestamp: number;
  /** Whether the computation was cancelled */
  readonly cancelled?: boolean;
  /** Number of progressive slices emitted */
  readonly slicesEmitted?: number;
}

/**
 * Interface for a worker thread that computes diffs.
 * In production this wraps a Node.js Worker or Web Worker.
 */
export interface DiffWorker {
  /** Send a diff computation request to the worker and await result */
  computeDiff(inputs: readonly DiffInput[]): Promise<CanonicalDiffResult>;
  /** Whether the worker is available */
  isAvailable(): boolean;
  /** Terminate the worker */
  terminate(): void;
}

/**
 * A cancellation token that can be used to abort an in-flight diff computation.
 */
export interface CancellationToken {
  /** Whether cancellation has been requested */
  readonly isCancelled: boolean;
  /** Request cancellation */
  cancel(): void;
  /** Register a callback for when cancellation is requested */
  onCancelled(callback: () => void): void;
}

/**
 * A progressive diff slice — a bounded portion of the full diff result
 * suitable for rendering within one animation frame.
 */
export interface ProgressiveDiffSlice {
  /** Index of this slice in the overall sequence */
  readonly sliceIndex: number;
  /** File diffs included in this slice */
  readonly fileDiffs: readonly FileDiff[];
  /** Whether this is the final slice */
  readonly isFinal: boolean;
  /** Total files processed so far (cumulative) */
  readonly processedFiles: number;
  /** Total files in the full computation */
  readonly totalFiles: number;
  /** Computation time for this slice in milliseconds */
  readonly sliceComputeTimeMs: number;
}

/**
 * Callback for receiving progressive diff slices.
 */
export type ProgressiveSliceCallback = (slice: ProgressiveDiffSlice) => void;

/** Default thresholds for inline vs worker routing */
export const DEFAULT_THRESHOLDS: DiffWorkerThresholds = {
  maxInlineLines: 1000,
  maxInlineBytes: 50_000,
  maxFilesPerSlice: 10,
  maxLinesPerSlice: 2000,
};

/** Animation frame budget in milliseconds */
const RENDERER_FRAME_BUDGET_MS = 16;

/** Counter for unique request IDs */
let requestCounter = 0;

/**
 * Creates a cancellation token that can be used to abort diff computations.
 */
export function createCancellationToken(): CancellationToken {
  let cancelled = false;
  const callbacks: Array<() => void> = [];

  return {
    get isCancelled() {
      return cancelled;
    },
    cancel() {
      if (!cancelled) {
        cancelled = true;
        for (const cb of callbacks) {
          cb();
        }
        callbacks.length = 0;
      }
    },
    onCancelled(callback: () => void) {
      if (cancelled) {
        callback();
      } else {
        callbacks.push(callback);
      }
    },
  };
}

/**
 * DiffWorkerCoordinator manages routing of diff computation between
 * inline (synchronous) and worker (async) paths based on size thresholds.
 * Supports progressive rendering via bounded slices and cancellation.
 */
export class DiffWorkerCoordinator {
  private readonly computer: CanonicalDiffComputer;
  private readonly thresholds: DiffWorkerThresholds;
  private readonly worker: DiffWorker | null;
  private readonly diagnostics: DiffLatencyDiagnostic[] = [];
  private readonly maxDiagnosticHistory: number;
  private readonly activeRequests: Map<string, CancellationToken> = new Map();

  constructor(options?: {
    thresholds?: Partial<DiffWorkerThresholds>;
    worker?: DiffWorker | null;
    maxDiagnosticHistory?: number;
  }) {
    this.computer = new CanonicalDiffComputer();
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...options?.thresholds,
    };
    this.worker = options?.worker ?? null;
    this.maxDiagnosticHistory = options?.maxDiagnosticHistory ?? 100;
  }

  /**
   * Compute a diff, routing to worker or inline based on input size.
   * Supports optional cancellation token.
   */
  async computeDiff(
    inputs: readonly DiffInput[],
    cancellation?: CancellationToken
  ): Promise<CanonicalDiffResult> {
    const { totalLines, totalBytes } = this.measureInputSize(inputs);
    const shouldUseWorker = this.shouldRouteToWorker(totalLines, totalBytes);
    const requestId = `diff-${++requestCounter}-${Date.now()}`;

    if (cancellation) {
      this.activeRequests.set(requestId, cancellation);
    }

    try {
      if (cancellation?.isCancelled) {
        return this.buildCancelledResult(requestId, inputs.length, totalLines, totalBytes);
      }

      const startTime = performance.now();
      let result: CanonicalDiffResult;

      if (shouldUseWorker && this.worker?.isAvailable()) {
        result = await this.worker.computeDiff(inputs);
      } else {
        result = this.computer.compute(inputs);
      }

      if (cancellation?.isCancelled) {
        return this.buildCancelledResult(requestId, inputs.length, totalLines, totalBytes);
      }

      const durationMs = performance.now() - startTime;
      const route: 'inline' | 'worker' =
        shouldUseWorker && this.worker?.isAvailable() ? 'worker' : 'inline';

      const diagnostic: DiffLatencyDiagnostic = {
        requestId,
        route,
        durationMs,
        fileCount: inputs.length,
        totalLines,
        totalBytes,
        exceededRendererBudget: route === 'inline' && durationMs > RENDERER_FRAME_BUDGET_MS,
        timestamp: Date.now(),
        cancelled: false,
      };

      this.recordDiagnostic(diagnostic);
      return result;
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  /**
   * Compute diffs progressively, emitting bounded slices suitable for
   * renderer consumption without blocking for more than one animation frame.
   *
   * Each slice contains at most `maxFilesPerSlice` files and respects
   * `maxLinesPerSlice` for total line count in the slice.
   *
   * The slices are emitted in deterministic order (sorted by URI).
   */
  async computeProgressively(
    inputs: readonly DiffInput[],
    onSlice: ProgressiveSliceCallback,
    cancellation?: CancellationToken
  ): Promise<CanonicalDiffResult> {
    const { totalLines, totalBytes } = this.measureInputSize(inputs);
    const requestId = `diff-progressive-${++requestCounter}-${Date.now()}`;

    if (cancellation) {
      this.activeRequests.set(requestId, cancellation);
    }

    try {
      if (cancellation?.isCancelled) {
        return this.buildCancelledResult(requestId, inputs.length, totalLines, totalBytes);
      }

      const startTime = performance.now();
      const allFileDiffs: FileDiff[] = [];
      let sliceIndex = 0;
      let processedFiles = 0;

      // Sort inputs by URI for deterministic chunk order
      const sorted = [...inputs].sort((a, b) => a.targetUri.localeCompare(b.targetUri));
      const totalFileCount = sorted.length;

      // Process in bounded slices
      const slices = this.partitionIntoSlices(sorted);

      for (const slice of slices) {
        if (cancellation?.isCancelled) {
          return this.buildCancelledResult(requestId, inputs.length, totalLines, totalBytes, sliceIndex);
        }

        const sliceStart = performance.now();
        let sliceResult: CanonicalDiffResult;

        if (this.worker?.isAvailable()) {
          sliceResult = await this.worker.computeDiff(slice);
        } else {
          sliceResult = this.computer.compute(slice);
        }

        if (cancellation?.isCancelled) {
          return this.buildCancelledResult(requestId, inputs.length, totalLines, totalBytes, sliceIndex);
        }

        const sliceComputeTimeMs = performance.now() - sliceStart;
        processedFiles += slice.length;
        allFileDiffs.push(...sliceResult.fileDiffs);

        const isFinal = processedFiles >= totalFileCount;

        onSlice({
          sliceIndex,
          fileDiffs: sliceResult.fileDiffs,
          isFinal,
          processedFiles,
          totalFiles: totalFileCount,
          sliceComputeTimeMs,
        });

        sliceIndex++;

        // Yield to the event loop between slices for renderer responsiveness
        if (!isFinal) {
          await yieldToEventLoop();
        }
      }

      const durationMs = performance.now() - startTime;

      // Compute final fingerprint from all diffs
      const fingerprintSource = allFileDiffs
        .map((fd) => `${fd.targetUri}:${fd.baseHash}:${fd.proposedHash}`)
        .join('|');
      const fingerprint = simpleHash(fingerprintSource);

      const result: CanonicalDiffResult = {
        fileDiffs: Object.freeze(allFileDiffs),
        success: true,
        computeTimeMs: durationMs,
        fingerprint,
      };

      const diagnostic: DiffLatencyDiagnostic = {
        requestId,
        route: this.worker?.isAvailable() ? 'worker' : 'inline',
        durationMs,
        fileCount: inputs.length,
        totalLines,
        totalBytes,
        exceededRendererBudget: false,
        timestamp: Date.now(),
        cancelled: false,
        slicesEmitted: sliceIndex,
      };

      this.recordDiagnostic(diagnostic);
      return result;
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  /**
   * Cancel all active diff computation requests.
   */
  cancelAll(): number {
    let cancelled = 0;
    for (const [, token] of this.activeRequests) {
      token.cancel();
      cancelled++;
    }
    this.activeRequests.clear();
    return cancelled;
  }

  /**
   * Get the number of currently active (in-flight) diff requests.
   */
  getActiveRequestCount(): number {
    return this.activeRequests.size;
  }

  /**
   * Synchronous inline diff computation (used when below threshold).
   * This should only be called when the caller knows the input is small.
   */
  computeInline(inputs: readonly DiffInput[]): CanonicalDiffResult {
    const { totalLines, totalBytes } = this.measureInputSize(inputs);
    const requestId = `diff-inline-${++requestCounter}-${Date.now()}`;

    const startTime = performance.now();
    const result = this.computer.compute(inputs);
    const durationMs = performance.now() - startTime;

    const diagnostic: DiffLatencyDiagnostic = {
      requestId,
      route: 'inline',
      durationMs,
      fileCount: inputs.length,
      totalLines,
      totalBytes,
      exceededRendererBudget: durationMs > RENDERER_FRAME_BUDGET_MS,
      timestamp: Date.now(),
    };

    this.recordDiagnostic(diagnostic);

    return result;
  }

  /**
   * Determine whether the input should be routed to a worker.
   */
  shouldRouteToWorker(totalLines: number, totalBytes: number): boolean {
    return totalLines > this.thresholds.maxInlineLines ||
      totalBytes > this.thresholds.maxInlineBytes;
  }

  /**
   * Measure the total size of diff inputs.
   */
  measureInputSize(inputs: readonly DiffInput[]): { totalLines: number; totalBytes: number } {
    let totalLines = 0;
    let totalBytes = 0;

    for (const input of inputs) {
      if (input.baseBlob !== null) {
        totalBytes += input.baseBlob.length;
        totalLines += countLines(input.baseBlob);
      }
      if (input.proposedBlob !== null) {
        totalBytes += input.proposedBlob.length;
        totalLines += countLines(input.proposedBlob);
      }
    }

    return { totalLines, totalBytes };
  }

  /**
   * Get the current thresholds.
   */
  getThresholds(): DiffWorkerThresholds {
    return { ...this.thresholds };
  }

  /**
   * Get latency diagnostics history.
   */
  getDiagnostics(): readonly DiffLatencyDiagnostic[] {
    return [...this.diagnostics];
  }

  /**
   * Get the most recent diagnostic entry.
   */
  getLastDiagnostic(): DiffLatencyDiagnostic | undefined {
    return this.diagnostics[this.diagnostics.length - 1];
  }

  /**
   * Clear diagnostics history.
   */
  clearDiagnostics(): void {
    this.diagnostics.length = 0;
  }

  /**
   * Check if a worker is configured and available.
   */
  hasWorker(): boolean {
    return this.worker !== null && this.worker.isAvailable();
  }

  /**
   * Terminate the worker if present.
   */
  dispose(): void {
    this.cancelAll();
    this.worker?.terminate();
  }

  /**
   * Partition sorted inputs into bounded slices respecting file count and line limits.
   */
  private partitionIntoSlices(sortedInputs: readonly DiffInput[]): DiffInput[][] {
    const slices: DiffInput[][] = [];
    let currentSlice: DiffInput[] = [];
    let currentSliceLines = 0;

    for (const input of sortedInputs) {
      const inputLines = this.countInputLines(input);

      // Start a new slice if adding this input would exceed bounds
      if (
        currentSlice.length > 0 &&
        (currentSlice.length >= this.thresholds.maxFilesPerSlice ||
          currentSliceLines + inputLines > this.thresholds.maxLinesPerSlice)
      ) {
        slices.push(currentSlice);
        currentSlice = [];
        currentSliceLines = 0;
      }

      currentSlice.push(input);
      currentSliceLines += inputLines;
    }

    if (currentSlice.length > 0) {
      slices.push(currentSlice);
    }

    return slices;
  }

  /**
   * Count lines in a single diff input.
   */
  private countInputLines(input: DiffInput): number {
    let lines = 0;
    if (input.baseBlob !== null) lines += countLines(input.baseBlob);
    if (input.proposedBlob !== null) lines += countLines(input.proposedBlob);
    return lines;
  }

  /**
   * Build a result object for a cancelled computation.
   */
  private buildCancelledResult(
    requestId: string,
    fileCount: number,
    totalLines: number,
    totalBytes: number,
    slicesEmitted?: number
  ): CanonicalDiffResult {
    const diagnostic: DiffLatencyDiagnostic = {
      requestId,
      route: 'inline',
      durationMs: 0,
      fileCount,
      totalLines,
      totalBytes,
      exceededRendererBudget: false,
      timestamp: Date.now(),
      cancelled: true,
      slicesEmitted,
    };
    this.recordDiagnostic(diagnostic);

    return {
      fileDiffs: Object.freeze([]),
      success: false,
      computeTimeMs: 0,
      fingerprint: '',
    };
  }

  /**
   * Record a diagnostic entry, maintaining the history bound.
   */
  private recordDiagnostic(diagnostic: DiffLatencyDiagnostic): void {
    this.diagnostics.push(diagnostic);
    if (this.diagnostics.length > this.maxDiagnosticHistory) {
      this.diagnostics.shift();
    }
  }
}

/**
 * Count the number of lines in a string.
 */
function countLines(content: string): number {
  if (content === '') return 1;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') count++;
  }
  return count;
}

/**
 * Simple hash function for fingerprinting (same as CanonicalDiffComputer).
 */
function simpleHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Yield to the event loop to allow the renderer to process updates.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
