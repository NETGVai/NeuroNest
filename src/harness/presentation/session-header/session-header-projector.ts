/**
 * SessionHeaderProjector — Projects raw authority data into attributed header fields.
 *
 * Every projected field carries value, status (verified/inherited/estimated/stale/unavailable),
 * source authority, source revision, and actor. Layout priority determines visibility
 * in narrow vs wide breakpoints.
 *
 * The projector does not hold durable state — it is a pure transformation from
 * raw authority records into the SessionHeaderProjectionV1 envelope.
 *
 * Requirements: 43.1-43.2, 43.6-43.10, 43.11, 43.14, 43.17
 */

import type {
  AttributedFieldV1,
  ConnectionStatus,
  HeaderFieldKind,
  HeaderFieldStatus,
  HeaderLayoutMode,
  LayoutAttributedField,
  LayoutPriority,
  PendingHeaderChange,
  SessionHeaderProjectionV1,
  SourceAuthority,
} from './session-header-schemas';
import { NARROW_LAYOUT_PRIMARY_FIELDS } from './session-header-schemas';

// ─── Raw Header Record ──────────────────────────────────────────

/**
 * A raw record from an owning authority providing a header field value.
 * Projection_Service supplies these from the latest compatible events.
 */
export interface RawHeaderFieldRecord {
  /** Which field this record supplies. */
  readonly kind: HeaderFieldKind;
  /** Display label. */
  readonly label: string;
  /** Current string value. */
  readonly value: string;
  /** Numeric value (when applicable). */
  readonly numericValue?: number;
  /** Unit for numeric values. */
  readonly unit?: string;
  /** Authority identity that owns this field. */
  readonly authorityId: string;
  /** Authority display name. */
  readonly authorityName: string;
  /** Source revision at which this value was produced. */
  readonly sourceRevision: number;
  /** Source timestamp. */
  readonly sourceTimestamp?: string;
  /** Actor that last changed this field. */
  readonly actor?: string;
  /** Whether the value is verified by the authority. */
  readonly verified: boolean;
  /** Whether the value is inherited from a parent scope. */
  readonly inherited: boolean;
  /** Whether the value is estimated. */
  readonly estimated: boolean;
  /** Whether the value is stale (last verified revision differs from latest). */
  readonly stale: boolean;
  /** Whether the field supports change controls. */
  readonly changeable: boolean;
  /** Authority to route changes through (when changeable). */
  readonly changeAuthority?: string;
  /** Last verified revision when not currently verified. */
  readonly lastVerifiedRevision?: number;
  /** Last verified timestamp when not currently verified. */
  readonly lastVerifiedAt?: string;
}

/**
 * Raw connection status record from Provider_Registry/Diagnostics_Service.
 */
export interface RawConnectionRecord {
  readonly status: ConnectionStatus;
  readonly authorityId: string;
  readonly authorityName: string;
  readonly sourceRevision: number;
  readonly sourceTimestamp?: string;
}

/**
 * Configuration for the projector.
 */
export interface SessionHeaderProjectorConfig {
  /**
   * Available width breakpoint for narrow layout (in device-independent pixels).
   * Below this value, layout is narrow.
   * Requirements: 43.7
   */
  readonly narrowBreakpoint: number;
  /**
   * Available width breakpoint for wide layout.
   * At or above this value, layout is wide.
   * Requirements: 43.8
   */
  readonly wideBreakpoint: number;
  /**
   * Override for primary field kinds in narrow layout.
   * Defaults to NARROW_LAYOUT_PRIMARY_FIELDS.
   */
  readonly narrowPrimaryFields?: ReadonlySet<HeaderFieldKind>;
}

const DEFAULT_CONFIG: SessionHeaderProjectorConfig = {
  narrowBreakpoint: 600,
  wideBreakpoint: 600,
};

// ─── SessionHeaderProjector ─────────────────────────────────────

export class SessionHeaderProjector {
  private readonly config: SessionHeaderProjectorConfig;
  private readonly narrowPrimaryFields: ReadonlySet<HeaderFieldKind>;

  constructor(config: Partial<SessionHeaderProjectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.narrowPrimaryFields =
      this.config.narrowPrimaryFields ?? NARROW_LAYOUT_PRIMARY_FIELDS;
  }

  /**
   * Projects raw records into a full SessionHeaderProjectionV1 envelope.
   *
   * @param sessionId - The session identity.
   * @param fieldRecords - Raw field records from owning authorities.
   * @param connectionRecord - Connection status record.
   * @param pendingChanges - Active pending header changes.
   * @param availableWidth - Current available width in DIP for layout.
   * @param projectionRevision - Current projection revision.
   * @param sourceSequence - Current source sequence.
   */
  project(
    sessionId: string,
    fieldRecords: readonly RawHeaderFieldRecord[],
    connectionRecord: RawConnectionRecord,
    pendingChanges: readonly PendingHeaderChange[],
    availableWidth: number,
    projectionRevision: number,
    sourceSequence: number,
  ): SessionHeaderProjectionV1 {
    const layoutMode = this.resolveLayoutMode(availableWidth);
    const fields = this.projectFields(fieldRecords, layoutMode);

    return {
      sessionId,
      fields,
      connectionStatus: connectionRecord.status,
      connectionAuthority: {
        authorityId: connectionRecord.authorityId,
        authorityName: connectionRecord.authorityName,
        sourceRevision: connectionRecord.sourceRevision,
        sourceTimestamp: connectionRecord.sourceTimestamp,
      },
      pendingChanges: [...pendingChanges],
      layoutMode,
      projectionRevision,
      sourceSequence,
      schemaVersion: 1,
    };
  }

  /**
   * Resolves the layout mode from available width.
   * Requirements: 43.7, 43.8
   */
  resolveLayoutMode(availableWidth: number): HeaderLayoutMode {
    return availableWidth < this.config.narrowBreakpoint ? 'narrow' : 'wide';
  }

  /**
   * Returns the fields that should be in the primary row given the layout mode.
   * Narrow layouts show only primary-priority fields in the primary row;
   * remaining fields go to accessible disclosure.
   * Wide layouts expose all configured primary fields without horizontal scrolling.
   *
   * Requirements: 43.7, 43.8, 43.9
   */
  getPrimaryFields(fields: readonly LayoutAttributedField[]): readonly LayoutAttributedField[] {
    return fields.filter((f) => f.priority === 'primary');
  }

  /**
   * Returns the fields that should be in the disclosure section.
   * Requirements: 43.7, 43.9
   */
  getDisclosureFields(fields: readonly LayoutAttributedField[]): readonly LayoutAttributedField[] {
    return fields.filter((f) => f.priority === 'secondary');
  }

  /**
   * Returns a field with a pending change overlay applied.
   * The pending value is shown as "pending" while the committed value is retained.
   * Requirements: 43.13, 43.14
   */
  overlayPendingChange(
    field: AttributedFieldV1,
    pending: PendingHeaderChange,
  ): { displayed: AttributedFieldV1; committed: AttributedFieldV1 } {
    if (pending.status === 'confirmed' && pending.confirmingRevision != null) {
      // Confirmed — the projected value IS the new committed value
      return { displayed: field, committed: field };
    }

    // Pending/rejected/timeout/stale — show requested as pending, retain prior committed
    const displayed: AttributedFieldV1 = {
      ...field,
      value: pending.command.selectedValue,
      numericValue: pending.command.numericSelectedValue,
      status: pending.status === 'pending' ? 'estimated' : field.status,
    };

    const committed: AttributedFieldV1 = {
      ...field,
      value: pending.committedValue,
    };

    return { displayed, committed };
  }

  // ─── Private ────────────────────────────────────────────────────

  private projectFields(
    records: readonly RawHeaderFieldRecord[],
    layoutMode: HeaderLayoutMode,
  ): LayoutAttributedField[] {
    return records.map((record) => {
      const field = this.projectSingleField(record);
      const priority = this.resolveFieldPriority(record.kind, layoutMode);
      return { field, priority };
    });
  }

  private projectSingleField(record: RawHeaderFieldRecord): AttributedFieldV1 {
    const status = this.resolveFieldStatus(record);
    const sourceAuthority: SourceAuthority = {
      authorityId: record.authorityId,
      authorityName: record.authorityName,
      sourceRevision: record.sourceRevision,
      sourceTimestamp: record.sourceTimestamp,
    };

    return {
      kind: record.kind,
      label: record.label,
      value: record.value,
      numericValue: record.numericValue,
      unit: record.unit,
      status,
      sourceAuthority,
      actor: record.actor,
      lastVerifiedRevision: record.lastVerifiedRevision,
      lastVerifiedAt: record.lastVerifiedAt,
      changeable: record.changeable,
      changeAuthority: record.changeAuthority,
    };
  }

  private resolveFieldStatus(record: RawHeaderFieldRecord): HeaderFieldStatus {
    // Priority: unavailable > stale > estimated > inherited > verified
    if (!record.value && !record.numericValue) {
      return 'unavailable';
    }
    if (record.stale) {
      return 'stale';
    }
    if (record.estimated) {
      return 'estimated';
    }
    if (record.inherited) {
      return 'inherited';
    }
    if (record.verified) {
      return 'verified';
    }
    // Default: if no flag matches, treat as unavailable
    return 'unavailable';
  }

  private resolveFieldPriority(
    kind: HeaderFieldKind,
    layoutMode: HeaderLayoutMode,
  ): LayoutPriority {
    if (layoutMode === 'wide') {
      // In wide mode, all fields are primary (no disclosure needed)
      return 'primary';
    }
    // In narrow mode, only specific fields are primary
    return this.narrowPrimaryFields.has(kind) ? 'primary' : 'secondary';
  }
}
