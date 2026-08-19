import { OpaqueResponseIdSchema } from '../../../harness/contracts/response-support';

export const MINIMAL_ERROR_STATUS = 'render_failed' as const;
export const MINIMAL_ERROR_FALLBACK_CORRELATION_ID = 'renderer-boundary' as const;

const NO_ACTIONS: readonly never[] = Object.freeze([]);

export interface MinimalErrorSurfaceRequest {
  readonly correlationId?: unknown;
}

export interface MinimalErrorSurfaceHandle {
  readonly element: HTMLElement;
  readonly actions: readonly never[];
  update(request: MinimalErrorSurfaceRequest): void;
  dispose(): void;
}

/**
 * Restrict renderer-owned correlation values to the opaque identifier contract.
 * Invalid or sensitive values are replaced rather than escaped for display.
 */
export function normalizeRendererCorrelationId(value: unknown): string {
  const parsed = OpaqueResponseIdSchema.safeParse(value);
  return parsed.success ? parsed.data : MINIMAL_ERROR_FALLBACK_CORRELATION_ID;
}

/**
 * Last-resort inert renderer. Its accessible and visible content is deliberately
 * limited to the fixed failure state and an opaque correlation identity.
 */
export class MinimalErrorSurface {
  private readonly ownerDocument: Document;

  constructor(ownerDocument: Document = document) {
    this.ownerDocument = ownerDocument;
  }

  render(request: MinimalErrorSurfaceRequest): MinimalErrorSurfaceHandle {
    const root = this.ownerDocument.createElement('section');
    root.className = 'nn-structured-response-minimal-error';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-atomic', 'true');

    const status = this.ownerDocument.createElement('span');
    status.className = 'nn-structured-response-minimal-error__status';
    status.textContent = MINIMAL_ERROR_STATUS;

    const correlation = this.ownerDocument.createElement('span');
    correlation.className = 'nn-structured-response-minimal-error__correlation';
    correlation.textContent = normalizeRendererCorrelationId(request.correlationId);

    root.append(status, correlation);

    let disposed = false;
    return Object.freeze({
      element: root,
      actions: NO_ACTIONS,
      update: (next: MinimalErrorSurfaceRequest): void => {
        if (disposed) return;
        correlation.textContent = normalizeRendererCorrelationId(next.correlationId);
      },
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        root.remove();
      },
    });
  }
}
