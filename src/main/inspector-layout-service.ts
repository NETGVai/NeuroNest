import type Database from 'better-sqlite3';

import {
  InspectorLayoutConfigPayloadSchema,
  InspectorLayoutStateSchema,
  UI_INSPECTOR_LAYOUT_CONFIG_KEY,
  type InspectorLayoutState,
  type LaunchMode,
} from '../shared/app-bootstrap-contracts.js';

/**
 * Main-process authority for the persisted Advanced Inspector layout.
 *
 * The service owns exactly one revisioned config row (`ui:inspector-layout:v1`).
 * Writes only happen when the resolved graphical mode is `advanced`; Classic
 * startup, Classic settings changes, and any renderer running without a
 * committed launch-mode selection therefore cannot overwrite the persisted
 * Advanced state (Requirements 2.8, 3.3, 3.4). Corrupt payloads recover to a
 * clamped default so a damaged row cannot block the Advanced shell.
 */

/** Bounds enforced on the persisted DIP width. */
export const INSPECTOR_LAYOUT_MIN_WIDTH_DIP = 150;
export const INSPECTOR_LAYOUT_MAX_WIDTH_DIP = 800;
/** Compatibility default matching {@link `src/renderer/app/App.ts`}. */
export const INSPECTOR_LAYOUT_DEFAULT_WIDTH_DIP = 320;

const CLASSIC_MODE: LaunchMode = 'classic';

export type InspectorLayoutRepairReason =
  | 'invalid-json'
  | 'invalid-payload'
  | 'invalid-width'
  | 'invalid-collapsed'
  | 'invalid-revision';

/** Non-sensitive diagnostic emitted after a corrupt row is repaired. */
export interface InspectorLayoutRepairDiagnostic {
  readonly kind: 'inspector-layout-repaired';
  readonly reason: InspectorLayoutRepairReason;
  readonly repairedRevision: number;
  readonly repairedWidthDip: number;
  readonly repairedCollapsed: boolean;
}

/** Reason a Classic-mode write attempt was rejected before touching config. */
export interface InspectorLayoutClassicRejectionDiagnostic {
  readonly kind: 'inspector-layout-classic-write-rejected';
  readonly attemptedWidthDip: number | null;
  readonly attemptedCollapsed: boolean | null;
}

export type InspectorLayoutDiagnostic =
  | InspectorLayoutRepairDiagnostic
  | InspectorLayoutClassicRejectionDiagnostic;

export interface InspectorLayoutServiceOptions {
  now?: () => Date;
  onDiagnostic?: (diagnostic: InspectorLayoutDiagnostic) => void;
  /**
   * Reports the resolved graphical launch mode. When this returns anything
   * other than `advanced`, {@link InspectorLayoutService.updateLayout} throws
   * and no config write is attempted. `undefined`/`null` is treated as
   * "unknown, not yet resolved" — the service refuses to write in that case
   * so a stalled first-run bootstrap cannot persist Inspector state.
   */
  getCurrentLaunchMode?: () => LaunchMode | null | undefined;
}

export class InspectorLayoutRevisionConflictError extends Error {
  constructor(
    public readonly expectedRevision: number,
    public readonly currentRevision: number,
  ) {
    super(
      `Inspector layout revision conflict: expected=${expectedRevision}, current=${currentRevision}`,
    );
    this.name = 'InspectorLayoutRevisionConflictError';
  }
}

export class InspectorLayoutClassicWriteError extends Error {
  constructor() {
    super('Inspector layout writes are only permitted in advanced mode');
    this.name = 'InspectorLayoutClassicWriteError';
  }
}

/** Renderer-facing update payload accepted by {@link InspectorLayoutService.updateLayout}. */
export interface InspectorLayoutUpdateInput {
  readonly widthDip: number;
  readonly collapsed: boolean;
  readonly expectedRevision: number;
}

interface AtomicResult<T> {
  value: T;
  diagnostic?: InspectorLayoutDiagnostic;
}

interface NormalizedRow {
  layout: InspectorLayoutState;
  diagnostic?: InspectorLayoutRepairDiagnostic;
}

interface ConfigRow {
  value: string;
}

export class InspectorLayoutService {
  private readonly now: () => Date;
  private readonly onDiagnostic:
    | ((diagnostic: InspectorLayoutDiagnostic) => void)
    | undefined;
  private readonly getCurrentLaunchMode:
    | (() => LaunchMode | null | undefined)
    | undefined;

  constructor(
    private readonly db: Database.Database,
    options: InspectorLayoutServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.onDiagnostic = options.onDiagnostic;
    this.getCurrentLaunchMode = options.getCurrentLaunchMode;
  }

  /**
   * Read the current Advanced Inspector layout, repairing a corrupt row into
   * a clamped default while emitting a non-secret diagnostic. Safe to call in
   * either launch mode: this method never writes when the row is already
   * valid, so Classic startup can inspect defaults without side effects.
   */
  getLayout(): InspectorLayoutState {
    return this.atomic(() => {
      const normalized = this.normalizeInTransaction();
      return { value: normalized.layout, diagnostic: normalized.diagnostic };
    });
  }

  /**
   * Persist a new width/collapse pair. Rejects any attempt while the resolved
   * mode is Classic (or before a mode is resolved) so Classic can never
   * overwrite Advanced Inspector state. Uses optimistic concurrency against
   * the last observed revision.
   */
  updateLayout(input: InspectorLayoutUpdateInput): InspectorLayoutState {
    const attemptedWidth = Number.isFinite(input.widthDip)
      ? input.widthDip
      : null;
    const attemptedCollapsed =
      typeof input.collapsed === 'boolean' ? input.collapsed : null;

    if (!this.isAdvancedModeResolved()) {
      const diagnostic: InspectorLayoutClassicRejectionDiagnostic = {
        kind: 'inspector-layout-classic-write-rejected',
        attemptedWidthDip: attemptedWidth,
        attemptedCollapsed,
      };
      this.emit(diagnostic);
      throw new InspectorLayoutClassicWriteError();
    }

    if (
      !Number.isFinite(input.widthDip)
      || typeof input.collapsed !== 'boolean'
      || !Number.isInteger(input.expectedRevision)
      || input.expectedRevision < 1
    ) {
      throw new TypeError('Invalid Inspector layout update payload');
    }

    return this.atomic(() => {
      const normalized = this.normalizeInTransaction();
      const current = normalized.layout;

      if (current.revision !== input.expectedRevision) {
        throw new InspectorLayoutRevisionConflictError(
          input.expectedRevision,
          current.revision,
        );
      }

      const updated = InspectorLayoutStateSchema.parse({
        widthDip: clampWidth(input.widthDip),
        collapsed: input.collapsed,
        revision: current.revision + 1,
      });
      this.writeConfig(updated);

      return { value: updated, diagnostic: normalized.diagnostic };
    });
  }

  private atomic<T>(work: () => AtomicResult<T>): T {
    const result = this.db.transaction(work).immediate();
    if (result.diagnostic) this.emit(result.diagnostic);
    return result.value;
  }

  private emit(diagnostic: InspectorLayoutDiagnostic): void {
    if (!this.onDiagnostic) return;
    try {
      this.onDiagnostic(diagnostic);
    } catch {
      // Diagnostics must never make a successful read/write fail.
    }
  }

  private normalizeInTransaction(): NormalizedRow {
    const row = this.readConfig();
    if (!row) {
      const layout = this.createDefaultLayout(1);
      this.writeConfig(layout);
      return { layout };
    }

    const parsed = this.parseJson(row.value);
    const validated = parsed.ok
      ? InspectorLayoutConfigPayloadSchema.safeParse(parsed.value)
      : undefined;

    if (validated?.success) {
      const layout = validated.data;
      const clampedWidth = clampWidth(layout.widthDip);
      if (clampedWidth === layout.widthDip) {
        return { layout };
      }

      // Value is structurally valid but outside supported bounds. Repair the
      // width in place without bumping revision, so a stale renderer holding
      // the same revision can still commit its next legitimate change.
      const repaired = InspectorLayoutStateSchema.parse({
        widthDip: clampedWidth,
        collapsed: layout.collapsed,
        revision: layout.revision,
      });
      this.writeConfig(repaired);
      const diagnostic: InspectorLayoutRepairDiagnostic = {
        kind: 'inspector-layout-repaired',
        reason: 'invalid-width',
        repairedRevision: repaired.revision,
        repairedWidthDip: repaired.widthDip,
        repairedCollapsed: repaired.collapsed,
      };
      return { layout: repaired, diagnostic };
    }

    // Fully corrupt payload — install a clamped default whose revision is
    // strictly greater than any parseable revision so a concurrent renderer
    // holding the old revision cannot successfully commit a stale update.
    const repaired = this.createDefaultLayout(
      this.nextRevision(parsed.ok ? parsed.value : undefined),
    );
    this.writeConfig(repaired);
    const diagnostic: InspectorLayoutRepairDiagnostic = {
      kind: 'inspector-layout-repaired',
      reason: this.repairReason(parsed),
      repairedRevision: repaired.revision,
      repairedWidthDip: repaired.widthDip,
      repairedCollapsed: repaired.collapsed,
    };
    return { layout: repaired, diagnostic };
  }

  private isAdvancedModeResolved(): boolean {
    if (!this.getCurrentLaunchMode) return false;
    let mode: LaunchMode | null | undefined;
    try {
      mode = this.getCurrentLaunchMode();
    } catch {
      return false;
    }
    return mode === 'advanced' && mode !== CLASSIC_MODE;
  }

  private readConfig(): ConfigRow | undefined {
    return this.db
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(UI_INSPECTOR_LAYOUT_CONFIG_KEY) as ConfigRow | undefined;
  }

  private writeConfig(payload: InspectorLayoutState): void {
    const timestamp = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(UI_INSPECTOR_LAYOUT_CONFIG_KEY, JSON.stringify(payload), timestamp);
  }

  private createDefaultLayout(revision: number): InspectorLayoutState {
    return InspectorLayoutStateSchema.parse({
      widthDip: INSPECTOR_LAYOUT_DEFAULT_WIDTH_DIP,
      collapsed: false,
      revision,
    });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private parseJson(raw: string):
    | { ok: true; value: unknown }
    | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      return { ok: false };
    }
  }

  private nextRevision(payload: unknown): number {
    if (
      typeof payload === 'object'
      && payload !== null
      && 'revision' in payload
      && typeof (payload as { revision: unknown }).revision === 'number'
      && Number.isInteger((payload as { revision: number }).revision)
      && (payload as { revision: number }).revision > 0
      && Number.isFinite((payload as { revision: number }).revision)
    ) {
      return (payload as { revision: number }).revision + 1;
    }
    return 1;
  }

  private repairReason(
    parsed: { ok: true; value: unknown } | { ok: false },
  ): InspectorLayoutRepairReason {
    if (!parsed.ok) return 'invalid-json';
    const value = parsed.value;
    if (typeof value !== 'object' || value === null) return 'invalid-payload';
    const record = value as Record<string, unknown>;
    if (
      'widthDip' in record
      && (typeof record.widthDip !== 'number'
        || !Number.isFinite(record.widthDip)
        || record.widthDip <= 0)
    ) {
      return 'invalid-width';
    }
    if ('collapsed' in record && typeof record.collapsed !== 'boolean') {
      return 'invalid-collapsed';
    }
    if (
      'revision' in record
      && (typeof record.revision !== 'number'
        || !Number.isInteger(record.revision)
        || record.revision < 1)
    ) {
      return 'invalid-revision';
    }
    return 'invalid-payload';
  }
}

function clampWidth(widthDip: number): number {
  if (!Number.isFinite(widthDip)) return INSPECTOR_LAYOUT_DEFAULT_WIDTH_DIP;
  return Math.min(
    INSPECTOR_LAYOUT_MAX_WIDTH_DIP,
    Math.max(INSPECTOR_LAYOUT_MIN_WIDTH_DIP, widthDip),
  );
}
