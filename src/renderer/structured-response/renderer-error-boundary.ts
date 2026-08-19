import type { RedactedDiagnosticV1 } from '../../harness/contracts/response-support';
import {
  MinimalErrorSurface,
  type MinimalErrorSurfaceHandle,
  normalizeRendererCorrelationId,
} from './surfaces/minimal-error-surface';

export type RendererFailurePhase =
  | 'parser'
  | 'primary-render'
  | 'primary-update'
  | 'primary-dispose'
  | 'fallback-render'
  | 'fallback-dispose'
  | 'lazy-work-cleanup'
  | 'boundary-dispose';

export type RendererParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

export interface RendererDiagnosticSink {
  record(diagnostic: RedactedDiagnosticV1): void;
}

export interface RendererLazyWork {
  cancel(reason: 'renderer_failure'): void;
}

export interface RendererDisposable {
  dispose(): void;
}

/** Resources registered while rendering are always released if that render fails. */
export interface RendererContainmentScope {
  trackLazyWork(work: RendererLazyWork): () => void;
  trackDisposable(resource: RendererDisposable): () => void;
  trackCleanup(cleanup: () => void): () => void;
}

export interface ContainableSurfaceHandle<T> {
  readonly element: HTMLElement;
  update?(next: T, scope: RendererContainmentScope): void;
  dispose?(): void;
}

export interface PrimarySurfaceAdapter<T> {
  render(value: T, scope: RendererContainmentScope): ContainableSurfaceHandle<T>;
}

export interface FallbackSurfaceAdapter<TRaw> {
  render(
    raw: TRaw,
    context: { readonly correlationId: string },
    scope: RendererContainmentScope,
  ): ContainableSurfaceHandle<TRaw>;
}

export interface RendererErrorBoundaryOptions<TRaw, TParsed> {
  parse(raw: TRaw): RendererParseResult<TParsed>;
  readonly primary: PrimarySurfaceAdapter<TParsed>;
  readonly fallback: FallbackSurfaceAdapter<TRaw>;
  readonly diagnostics?: RendererDiagnosticSink;
  readonly minimalErrorSurface?: MinimalErrorSurface;
}

export interface ContainedRendererHandle<TRaw> {
  readonly element: HTMLElement;
  readonly mode: 'primary' | 'fallback' | 'minimal-error';
  update(raw: TRaw): void;
  retry(): void;
  dispose(): void;
}

type ActiveSurface<TRaw, TParsed> =
  | {
      readonly mode: 'primary';
      readonly handle: ContainableSurfaceHandle<TParsed>;
      readonly scope: ContainmentScope;
    }
  | {
      readonly mode: 'fallback';
      readonly handle: ContainableSurfaceHandle<TRaw>;
      readonly scope: ContainmentScope;
    }
  | {
      readonly mode: 'minimal-error';
      readonly handle: MinimalErrorSurfaceHandle;
    };

interface Placement {
  readonly parent: Node | null;
  readonly nextSibling: Node | null;
}

class ContainmentScope implements RendererContainmentScope {
  private cleanups: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly onCleanupFailure: () => void) {}

  trackLazyWork(work: RendererLazyWork): () => void {
    return this.trackCleanup(() => work.cancel('renderer_failure'));
  }

  trackDisposable(resource: RendererDisposable): () => void {
    return this.trackCleanup(() => resource.dispose());
  }

  trackCleanup(cleanup: () => void): () => void {
    if (this.disposed) {
      this.runCleanup(cleanup);
      return () => undefined;
    }

    this.cleanups.push(cleanup);
    let registered = true;
    return (): void => {
      if (!registered) return;
      registered = false;
      const index = this.cleanups.indexOf(cleanup);
      if (index >= 0) this.cleanups.splice(index, 1);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cleanups = this.cleanups.splice(0).reverse();
    for (const cleanup of cleanups) this.runCleanup(cleanup);
  }

  private runCleanup(cleanup: () => void): void {
    try {
      cleanup();
    } catch {
      this.onCleanupFailure();
    }
  }
}

/**
 * Final response-renderer containment boundary.
 *
 * It never forwards caught values to fallback renderers, diagnostics, DOM, or
 * accessibility output. Canonical input is retained unchanged for fallback and
 * retry, while renderer-owned handles and lazy work are torn down on failure.
 */
export class RendererErrorBoundary<TRaw, TParsed> {
  private readonly correlationId: string;
  private readonly minimalErrorSurface: MinimalErrorSurface;

  constructor(
    private readonly options: RendererErrorBoundaryOptions<TRaw, TParsed>,
    correlationId: unknown,
  ) {
    this.correlationId = normalizeRendererCorrelationId(correlationId);
    this.minimalErrorSurface = options.minimalErrorSurface ?? new MinimalErrorSurface();
  }

  mount(raw: TRaw): ContainedRendererHandle<TRaw> {
    let currentRaw = raw;
    let active = this.createSurface(raw);
    let disposed = false;

    const replaceActive = (next: ActiveSurface<TRaw, TParsed>): void => {
      const previousElement = active.handle.element;
      const placement = this.capturePlacement(previousElement);
      this.disposeActive(active, active.mode === 'fallback' ? 'fallback-dispose' : 'primary-dispose');
      active = next;
      this.restorePlacement(placement, active.handle.element);
    };

    const update = (nextRaw: TRaw): void => {
      if (disposed) return;
      currentRaw = nextRaw;

      if (active.mode === 'primary') {
        let parsed: RendererParseResult<TParsed>;
        try {
          parsed = this.options.parse(nextRaw);
        } catch {
          this.recordFailure('parser');
          replaceActive(this.createFallback(nextRaw));
          return;
        }

        if (parsed.ok && active.handle.update) {
          const previousElement = active.handle.element;
          try {
            active.handle.update(parsed.value, active.scope);
            this.replaceElementIfChanged(previousElement, active.handle.element);
            return;
          } catch {
            this.recordFailure('primary-update');
            replaceActive(this.createFallback(nextRaw));
            return;
          }
        }
      }

      replaceActive(this.createSurface(nextRaw));
    };

    const controller: ContainedRendererHandle<TRaw> = {
      get element(): HTMLElement {
        return active.handle.element;
      },
      get mode(): 'primary' | 'fallback' | 'minimal-error' {
        return active.mode;
      },
      update,
      retry: (): void => update(currentRaw),
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        this.disposeActive(active, 'boundary-dispose');
      },
    };

    return Object.freeze(controller);
  }

  private createSurface(raw: TRaw): ActiveSurface<TRaw, TParsed> {
    let parsed: RendererParseResult<TParsed>;
    try {
      parsed = this.options.parse(raw);
    } catch {
      this.recordFailure('parser');
      return this.createFallback(raw);
    }

    if (!parsed.ok) return this.createFallback(raw);

    const scope = this.createScope();
    try {
      const handle = this.options.primary.render(parsed.value, scope);
      this.assertElement(handle.element);
      return { mode: 'primary', handle, scope };
    } catch {
      this.recordFailure('primary-render');
      scope.dispose();
      return this.createFallback(raw);
    }
  }

  private createFallback(raw: TRaw): ActiveSurface<TRaw, TParsed> {
    const scope = this.createScope();
    try {
      const handle = this.options.fallback.render(
        raw,
        { correlationId: this.correlationId },
        scope,
      );
      this.assertElement(handle.element);
      return { mode: 'fallback', handle, scope };
    } catch {
      this.recordFailure('fallback-render');
      scope.dispose();
      return {
        mode: 'minimal-error',
        handle: this.minimalErrorSurface.render({ correlationId: this.correlationId }),
      };
    }
  }

  private createScope(): ContainmentScope {
    return new ContainmentScope(() => this.recordFailure('lazy-work-cleanup'));
  }

  private disposeActive(
    active: ActiveSurface<TRaw, TParsed>,
    phase: 'primary-dispose' | 'fallback-dispose' | 'boundary-dispose',
  ): void {
    if (active.mode === 'minimal-error') {
      try {
        active.handle.dispose();
      } catch {
        this.recordFailure(phase);
      }
      return;
    }

    try {
      active.handle.dispose?.();
    } catch {
      this.recordFailure(phase);
    } finally {
      active.scope.dispose();
      try {
        active.handle.element.remove();
      } catch {
        this.recordFailure(phase);
      }
    }
  }

  private recordFailure(phase: RendererFailurePhase): void {
    const sink = this.options.diagnostics;
    if (!sink) return;

    const diagnostic: RedactedDiagnosticV1 = {
      schemaVersion: 1,
      diagnosticId: `renderer-failure-${phase}`,
      correlationId: this.correlationId,
      reasonCode: 'RENDERER_FAILURE',
      scope: 'renderer',
      severity: 'error',
      entityKind: 'renderer',
      occurrences: 1,
    };

    try {
      sink.record(diagnostic);
    } catch {
      // Diagnostics must never become another renderer failure channel.
    }
  }

  private assertElement(element: HTMLElement): void {
    if (!element || element.nodeType !== 1) throw new TypeError('invalid surface element');
  }

  private capturePlacement(element: HTMLElement): Placement {
    return { parent: element.parentNode, nextSibling: element.nextSibling };
  }

  private restorePlacement(placement: Placement, element: HTMLElement): void {
    if (!placement.parent) return;
    if (placement.nextSibling?.parentNode === placement.parent) {
      placement.parent.insertBefore(element, placement.nextSibling);
    } else {
      placement.parent.appendChild(element);
    }
  }

  private replaceElementIfChanged(previous: HTMLElement, next: HTMLElement): void {
    if (previous === next || !previous.parentNode) return;
    previous.parentNode.replaceChild(next, previous);
  }
}
