/**
 * Closed Response Surface Registry V1.
 *
 * A validated response block kind is the only primary dispatch key. Optional
 * RenderIntent data may refine a selected surface only after the versioned
 * compatibility matrix accepts it. This registry has no runtime registration
 * API: adding a V1 block kind requires updating the exhaustive adapter map.
 *
 * Requirements: 2.2-2.5, 2.8, 22.1
 */

import type { RenderIntentV1 } from '../../harness/contracts/render-intent';
import {
  ResponseBlockV1Schema,
  type ResponseBlockKind,
  type ResponseBlockV1,
} from '../../harness/contracts/response-composition';
import {
  evaluateResponseBlockCompatibility,
  type ResponseCompatibilityFailureReason,
} from '../../harness/presentation/response-compatibility';

export type ResponseSurfaceContext = Readonly<Record<string, unknown>>;

/** Opaque renderer-owned handle. Concrete surfaces may add DOM or state fields. */
export type SurfaceHandle = object;

export interface ResponseSurfaceRenderOptions {
  readonly refinement?: RenderIntentV1;
}

export interface ResponseSurfaceAdapter<K extends ResponseBlockKind> {
  readonly kind: K;
  render(
    block: Extract<ResponseBlockV1, { kind: K }>,
    context: ResponseSurfaceContext,
    options: ResponseSurfaceRenderOptions,
  ): SurfaceHandle;
  update(
    handle: SurfaceHandle,
    previous: Extract<ResponseBlockV1, { kind: K }>,
    next: Extract<ResponseBlockV1, { kind: K }>,
    context: ResponseSurfaceContext,
    options: ResponseSurfaceRenderOptions,
  ): void;
  dispose(handle: SurfaceHandle): void;
}

/**
 * Compile-time exhaustive V1 map. `satisfies ResponseSurfaceAdapterMapV1`
 * rejects missing, extra, and discriminator-mismatched surface adapters.
 */
export type ResponseSurfaceAdapterMapV1 = {
  readonly [K in ResponseBlockKind]: ResponseSurfaceAdapter<K>;
};

type MissingV1SurfaceKinds = Exclude<ResponseBlockKind, keyof ResponseSurfaceAdapterMapV1>;
type UnexpectedV1SurfaceKinds = Exclude<keyof ResponseSurfaceAdapterMapV1, ResponseBlockKind>;
type AssertNever<T extends never> = T;

/** Public type assertions consumed by compile-time tests. */
export type ResponseSurfaceRegistryMissingKindsAssertion = AssertNever<MissingV1SurfaceKinds>;
export type ResponseSurfaceRegistryUnexpectedKindsAssertion = AssertNever<UnexpectedV1SurfaceKinds>;

export type ResponseSurfaceFailureReason =
  | ResponseCompatibilityFailureReason
  | 'parse_failure'
  | 'surface_kind_mismatch'
  | 'render_failure'
  | 'update_failure';

export interface SafeGenericSurfaceInputV1 {
  readonly rawBlock: unknown;
  readonly correlationId: string;
  readonly reason: ResponseSurfaceFailureReason;
}

export interface MinimalErrorSurfaceInputV1 {
  readonly status: 'render_failed';
  readonly correlationId: string;
}

export interface InertSurfaceAdapter<I> {
  render(input: I, context: ResponseSurfaceContext): SurfaceHandle;
  update(handle: SurfaceHandle, previous: I, next: I, context: ResponseSurfaceContext): void;
  dispose(handle: SurfaceHandle): void;
}

export interface ResponseSurfaceInertBoundariesV1 {
  readonly safeGeneric: InertSurfaceAdapter<SafeGenericSurfaceInputV1>;
  readonly minimalError: InertSurfaceAdapter<MinimalErrorSurfaceInputV1>;
}

export type ResponseSurfaceSelectionV1 =
  | {
      readonly mode: 'primary';
      readonly surfaceKind: ResponseBlockKind;
      readonly refinementKind?: RenderIntentV1['kind'];
    }
  | {
      readonly mode: 'safe_generic';
      readonly surfaceKind: 'safe_generic';
      readonly failureReason: ResponseSurfaceFailureReason;
    }
  | {
      readonly mode: 'minimal_error';
      readonly surfaceKind: 'minimal_error';
      readonly failureReason: 'safe_generic_render_failure' | 'minimal_error_render_failure';
    };

export interface RegistrySurfaceHandle {
  readonly current: SurfaceHandle;
  readonly selection: ResponseSurfaceSelectionV1;
  readonly disposed: boolean;
}

type ErasedResponseSurfaceAdapter = {
  readonly kind: ResponseBlockKind;
  render(block: ResponseBlockV1, context: ResponseSurfaceContext, options: ResponseSurfaceRenderOptions): SurfaceHandle;
  update(
    handle: SurfaceHandle,
    previous: ResponseBlockV1,
    next: ResponseBlockV1,
    context: ResponseSurfaceContext,
    options: ResponseSurfaceRenderOptions,
  ): void;
  dispose(handle: SurfaceHandle): void;
};

type InternalSurfaceState =
  | {
      readonly mode: 'primary';
      readonly handle: SurfaceHandle;
      readonly adapter: ErasedResponseSurfaceAdapter;
      readonly block: ResponseBlockV1;
      readonly options: ResponseSurfaceRenderOptions;
      readonly selection: Extract<ResponseSurfaceSelectionV1, { mode: 'primary' }>;
    }
  | {
      readonly mode: 'safe_generic';
      readonly handle: SurfaceHandle;
      readonly adapter: InertSurfaceAdapter<SafeGenericSurfaceInputV1>;
      readonly input: SafeGenericSurfaceInputV1;
      readonly selection: Extract<ResponseSurfaceSelectionV1, { mode: 'safe_generic' }>;
    }
  | {
      readonly mode: 'minimal_error';
      readonly handle: SurfaceHandle;
      readonly adapter: InertSurfaceAdapter<MinimalErrorSurfaceInputV1> | null;
      readonly input: MinimalErrorSurfaceInputV1;
      readonly selection: Extract<ResponseSurfaceSelectionV1, { mode: 'minimal_error' }>;
    };

class ManagedRegistrySurfaceHandle implements RegistrySurfaceHandle {
  private state: InternalSurfaceState;
  private isDisposed = false;

  constructor(state: InternalSurfaceState) {
    this.state = state;
  }

  get current(): SurfaceHandle {
    return this.state.handle;
  }

  get selection(): ResponseSurfaceSelectionV1 {
    return this.state.selection;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  get internalState(): InternalSurfaceState {
    return this.state;
  }

  replace(state: InternalSurfaceState): void {
    this.state = state;
  }

  markDisposed(): boolean {
    if (this.isDisposed) {
      return false;
    }
    this.isDisposed = true;
    return true;
  }
}

type SelectionPlan =
  | {
      readonly mode: 'primary';
      readonly block: ResponseBlockV1;
      readonly options: ResponseSurfaceRenderOptions;
      readonly selection: Extract<ResponseSurfaceSelectionV1, { mode: 'primary' }>;
    }
  | {
      readonly mode: 'safe_generic';
      readonly input: SafeGenericSurfaceInputV1;
      readonly selection: Extract<ResponseSurfaceSelectionV1, { mode: 'safe_generic' }>;
    };

function isSurfaceHandle(value: unknown): value is SurfaceHandle {
  return typeof value === 'object' && value !== null;
}

function readCorrelationId(rawBlock: unknown): string {
  try {
    if (typeof rawBlock !== 'object' || rawBlock === null || Array.isArray(rawBlock)) {
      return 'response-block';
    }
    const stableKey = (rawBlock as Record<string, unknown>)['stableKey'];
    return typeof stableKey === 'string' && stableKey.length > 0 ? stableKey.slice(0, 512) : 'response-block';
  } catch {
    return 'response-block';
  }
}

function safeGenericPlan(
  rawBlock: unknown,
  reason: ResponseSurfaceFailureReason,
): Extract<SelectionPlan, { mode: 'safe_generic' }> {
  const input: SafeGenericSurfaceInputV1 = Object.freeze({
    rawBlock,
    correlationId: readCorrelationId(rawBlock),
    reason,
  });
  return {
    mode: 'safe_generic',
    input,
    selection: Object.freeze({
      mode: 'safe_generic',
      surfaceKind: 'safe_generic',
      failureReason: reason,
    }),
  };
}

/**
 * Immutable, closed registry for all ResponseBlockV1 surfaces.
 *
 * Surface adapter construction is an application bootstrap concern. The
 * registry intentionally exposes no register/unregister/replace API.
 */
export class ResponseSurfaceRegistry {
  private readonly adapters: Readonly<ResponseSurfaceAdapterMapV1>;
  private readonly inert: ResponseSurfaceInertBoundariesV1;
  private readonly ownedHandles = new WeakSet<RegistrySurfaceHandle>();

  constructor(adapters: ResponseSurfaceAdapterMapV1, inert: ResponseSurfaceInertBoundariesV1) {
    for (const [kind, adapter] of Object.entries(adapters)) {
      if (adapter.kind !== kind) {
        throw new TypeError(`Response surface adapter discriminator mismatch for ${kind}.`);
      }
    }
    this.adapters = Object.freeze({ ...adapters });
    this.inert = Object.freeze({ ...inert });
  }

  render(rawBlock: unknown, context: ResponseSurfaceContext): RegistrySurfaceHandle {
    const managed = new ManagedRegistrySurfaceHandle(this.renderPlan(this.select(rawBlock), context));
    this.ownedHandles.add(managed);
    return managed;
  }

  update(handle: RegistrySurfaceHandle, rawBlock: unknown, context: ResponseSurfaceContext): RegistrySurfaceHandle {
    const managed = this.requireOwnedHandle(handle);
    if (managed.disposed) {
      return managed;
    }

    const nextPlan = this.select(rawBlock);
    const current = managed.internalState;

    if (current.mode === 'primary' && nextPlan.mode === 'primary' && current.block.kind === nextPlan.block.kind) {
      try {
        current.adapter.update(current.handle, current.block, nextPlan.block, context, nextPlan.options);
        managed.replace({
          mode: 'primary',
          handle: current.handle,
          adapter: current.adapter,
          block: nextPlan.block,
          options: nextPlan.options,
          selection: nextPlan.selection,
        });
        return managed;
      } catch {
        this.replace(managed, this.renderPlan(safeGenericPlan(rawBlock, 'update_failure'), context));
        return managed;
      }
    }

    if (current.mode === 'safe_generic' && nextPlan.mode === 'safe_generic') {
      try {
        current.adapter.update(current.handle, current.input, nextPlan.input, context);
        managed.replace({
          mode: 'safe_generic',
          handle: current.handle,
          adapter: current.adapter,
          input: nextPlan.input,
          selection: nextPlan.selection,
        });
        return managed;
      } catch {
        this.replace(managed, this.renderMinimal(nextPlan.input.correlationId, context));
        return managed;
      }
    }

    this.replace(managed, this.renderPlan(nextPlan, context));
    return managed;
  }

  dispose(handle: RegistrySurfaceHandle): void {
    const managed = this.requireOwnedHandle(handle);
    if (!managed.markDisposed()) {
      return;
    }
    this.disposeState(managed.internalState);
  }

  private select(rawBlock: unknown): SelectionPlan {
    let parsed: ReturnType<typeof ResponseBlockV1Schema.safeParse>;
    try {
      parsed = ResponseBlockV1Schema.safeParse(rawBlock);
    } catch {
      return safeGenericPlan(rawBlock, 'parse_failure');
    }
    if (!parsed.success) {
      return safeGenericPlan(rawBlock, 'parse_failure');
    }

    const block = parsed.data;
    let compatibility: ReturnType<typeof evaluateResponseBlockCompatibility>;
    try {
      compatibility = evaluateResponseBlockCompatibility(block);
    } catch {
      return safeGenericPlan(rawBlock, 'invalid_render_intent');
    }

    if (!compatibility.compatible) {
      return safeGenericPlan(rawBlock, compatibility.reason);
    }
    if (compatibility.surfaceKind !== block.kind) {
      return safeGenericPlan(rawBlock, 'surface_kind_mismatch');
    }

    const options: ResponseSurfaceRenderOptions = Object.freeze(
      compatibility.refinement === undefined ? {} : { refinement: compatibility.refinement },
    );
    return {
      mode: 'primary',
      block,
      options,
      selection: Object.freeze({
        mode: 'primary',
        surfaceKind: block.kind,
        ...(compatibility.refinement === undefined ? {} : { refinementKind: compatibility.refinement.kind }),
      }),
    };
  }

  private renderPlan(plan: SelectionPlan, context: ResponseSurfaceContext): InternalSurfaceState {
    if (plan.mode === 'safe_generic') {
      return this.renderSafeGeneric(plan, context);
    }

    const adapter = this.adapters[plan.block.kind] as unknown as ErasedResponseSurfaceAdapter;
    try {
      const handle = adapter.render(plan.block, context, plan.options);
      if (!isSurfaceHandle(handle)) {
        throw new TypeError('Response surface returned an invalid handle.');
      }
      return {
        mode: 'primary',
        handle,
        adapter,
        block: plan.block,
        options: plan.options,
        selection: plan.selection,
      };
    } catch {
      return this.renderSafeGeneric(safeGenericPlan(plan.block, 'render_failure'), context);
    }
  }

  private renderSafeGeneric(
    plan: Extract<SelectionPlan, { mode: 'safe_generic' }>,
    context: ResponseSurfaceContext,
  ): InternalSurfaceState {
    try {
      const handle = this.inert.safeGeneric.render(plan.input, context);
      if (!isSurfaceHandle(handle)) {
        throw new TypeError('Safe generic surface returned an invalid handle.');
      }
      return {
        mode: 'safe_generic',
        handle,
        adapter: this.inert.safeGeneric,
        input: plan.input,
        selection: plan.selection,
      };
    } catch {
      return this.renderMinimal(plan.input.correlationId, context);
    }
  }

  private renderMinimal(correlationId: string, context: ResponseSurfaceContext): InternalSurfaceState {
    const input: MinimalErrorSurfaceInputV1 = Object.freeze({
      status: 'render_failed',
      correlationId,
    });
    try {
      const handle = this.inert.minimalError.render(input, context);
      if (!isSurfaceHandle(handle)) {
        throw new TypeError('Minimal error surface returned an invalid handle.');
      }
      return {
        mode: 'minimal_error',
        handle,
        adapter: this.inert.minimalError,
        input,
        selection: Object.freeze({
          mode: 'minimal_error',
          surfaceKind: 'minimal_error',
          failureReason: 'safe_generic_render_failure',
        }),
      };
    } catch {
      return {
        mode: 'minimal_error',
        handle: Object.freeze({}),
        adapter: null,
        input,
        selection: Object.freeze({
          mode: 'minimal_error',
          surfaceKind: 'minimal_error',
          failureReason: 'minimal_error_render_failure',
        }),
      };
    }
  }

  private replace(managed: ManagedRegistrySurfaceHandle, next: InternalSurfaceState): void {
    const previous = managed.internalState;
    managed.replace(next);
    this.disposeState(previous);
  }

  private disposeState(state: InternalSurfaceState): void {
    try {
      state.adapter?.dispose(state.handle);
    } catch {
      // Disposal is best-effort and must never escape the renderer boundary.
    }
  }

  private requireOwnedHandle(handle: RegistrySurfaceHandle): ManagedRegistrySurfaceHandle {
    if (!(handle instanceof ManagedRegistrySurfaceHandle) || !this.ownedHandles.has(handle)) {
      throw new TypeError('Registry surface handle is not owned by this registry.');
    }
    return handle;
  }
}
