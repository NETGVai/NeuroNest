/**
 * Trajectory Detail Port — On-demand detail loading, cancellation routing,
 * bounded log retrieval, and result-injection tracking.
 *
 * Responsibilities:
 * - Load bounded durable detail records on demand (when user opens detail)
 * - Retrieve bounded log ranges within configured positive line/byte limits
 * - Route cancellation commands through owning authority
 * - Expose result-injection status (pending/injected/rejected/omitted/superseded)
 * - Preserve last verified state on failure; never infer completion
 * - Respect Semantic_Anchor during state updates
 *
 * Requirements: 42.3–42.7, 42.10, 42.11, 42.13, 42.14
 */

import type {
  TrajectoryDetailV1,
  TrajectoryQuery,
  CancellationCommand,
  LogRangeQuery,
  BoundedLogRange,
  TrajectoryProjectionV1,
  UnavailableReason,
} from './trajectory-schemas';
import { isTerminalState } from './trajectory-schemas';
import { TrajectoryProjector, type RawTrajectoryRecord } from './trajectory-projector';

// ─── Data Source Port ───────────────────────────────────────────

/**
 * Port for loading trajectory data from durable projection sources.
 * Implementations connect to Projection_Service / Session_Log records.
 */
export interface TrajectoryDataSource {
  /** Load all raw trajectory records for a session. */
  getRecords(sessionId: string): Promise<RawTrajectoryRecord[]>;

  /** Load full detail for a specific entity. */
  getDetail(entityId: string): Promise<TrajectoryDetailV1 | null>;

  /** Retrieve bounded log range for an entity. */
  getLogRange(query: LogRangeQuery): Promise<BoundedLogRange | null>;
}

// ─── Authority Port ─────────────────────────────────────────────

/**
 * Port for routing cancellation commands to the owning authority.
 * Implementations route to Orchestration_Engine or Job_Service.
 */
export interface TrajectoryAuthorityPort {
  /** Submit a cancellation command to the owning authority. */
  cancelEntity(command: CancellationCommand): Promise<CancellationResult>;
}

// ─── Cancellation Result ────────────────────────────────────────

/**
 * Result of a cancellation command submission.
 */
export interface CancellationResult {
  /** Whether the command was accepted. */
  accepted: boolean;
  /** Command identity for tracking. */
  commandId: string;
  /** Reason if not accepted. */
  rejectionReason?: string;
}

// ─── Port Configuration ─────────────────────────────────────────

export interface TrajectoryDetailPortConfig {
  /** Maximum log lines for bounded retrieval. Default: 200. */
  maxLogLines: number;
  /** Maximum log bytes for bounded retrieval. Default: 65536. */
  maxLogBytes: number;
  /** Maximum summaries in projection. Default: 100. */
  maxSummaries: number;
}

const DEFAULT_CONFIG: TrajectoryDetailPortConfig = {
  maxLogLines: 200,
  maxLogBytes: 65536,
  maxSummaries: 100,
};

// ─── Trajectory Detail Port Implementation ──────────────────────

/**
 * Coordinates trajectory projection, detail loading, log retrieval,
 * and cancellation routing.
 *
 * Requirements:
 * - 42.3: Detail shows dependencies, budgets, attempts, ownership, lineage, injection state
 * - 42.4: Bounded logs within configured positive line and byte limits
 * - 42.5: Cancellation routed through owning authority when actor is authorized
 * - 42.6: Unavailable cancellation displays terminal state or authority reason
 * - 42.7: Result injection status displayed
 * - 42.10: State derived exclusively from durable records via Projection_Service
 * - 42.11: Incomplete/incompatible records show last verified revision
 * - 42.13: Cancellation nonterminal until terminal projection arrives
 * - 42.14: Failures preserve last verified state
 */
export class TrajectoryDetailPortImpl {
  private readonly config: TrajectoryDetailPortConfig;
  private readonly dataSource: TrajectoryDataSource;
  private readonly authorityPort: TrajectoryAuthorityPort;
  private readonly projector: TrajectoryProjector;

  /** Last verified projection, preserved on failure (Req 42.14). */
  private lastVerifiedProjection: TrajectoryProjectionV1 | null = null;
  /** Last verified detail, preserved on failure (Req 42.14). */
  private lastVerifiedDetail: TrajectoryDetailV1 | null = null;

  constructor(
    dataSource: TrajectoryDataSource,
    authorityPort: TrajectoryAuthorityPort,
    config: Partial<TrajectoryDetailPortConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dataSource = dataSource;
    this.authorityPort = authorityPort;
    this.projector = new TrajectoryProjector({ maxSummaries: this.config.maxSummaries });
  }

  /**
   * Get the trajectory projection (summaries + optional expanded detail).
   *
   * Requirements: 42.1–42.3, 42.8–42.14
   */
  async getProjection(query: TrajectoryQuery): Promise<TrajectoryProjectionV1> {
    try {
      // Load records from durable source (Req 42.10)
      const records = await this.dataSource.getRecords(query.sessionId);

      // Project summaries using the projector
      const projection = this.projector.project(
        records,
        query.sessionId,
        this.nextRevision(),
      );

      // If detail is requested, load it
      if (query.expandEntityId) {
        const detail = await this.loadDetail(query);
        if (detail) {
          projection.expandedDetail = detail;
        }
      }

      // Store as last verified projection (Req 42.14)
      this.lastVerifiedProjection = projection;
      return projection;

    } catch (_error) {
      // On failure, preserve last verified state without inferring completion (Req 42.14)
      if (this.lastVerifiedProjection) {
        return this.lastVerifiedProjection;
      }
      // No prior state — return empty with unavailable indication
      return {
        sessionId: query.sessionId,
        summaries: [],
        projectionRevision: 0,
        sourceSequenceStart: 0,
        sourceSequenceEnd: 0,
        schemaVersion: 1,
      };
    }
  }

  /**
   * Load bounded detail for a specific entity.
   *
   * Requirements: 42.3, 42.4, 42.7, 42.10, 42.11
   */
  async loadDetail(query: TrajectoryQuery): Promise<TrajectoryDetailV1 | null> {
    if (!query.expandEntityId) return null;

    try {
      const detail = await this.dataSource.getDetail(query.expandEntityId);
      if (!detail) {
        // Entity not found — preserve last verified detail (Req 42.14)
        return this.lastVerifiedDetail?.entityId === query.expandEntityId
          ? this.lastVerifiedDetail
          : null;
      }

      // Load bounded logs if available (Req 42.4)
      if (!detail.logs) {
        const logRange = await this.dataSource.getLogRange({
          entityId: query.expandEntityId,
          startLine: query.logStartLine ?? 0,
          maxLines: query.maxLogLines ?? this.config.maxLogLines,
          maxBytes: query.maxLogBytes ?? this.config.maxLogBytes,
        });
        if (logRange) {
          detail.logs = logRange;
        }
      }

      // Store as last verified detail (Req 42.14)
      this.lastVerifiedDetail = detail;
      return detail;

    } catch (_error) {
      // Failure — preserve last verified detail (Req 42.14)
      if (this.lastVerifiedDetail?.entityId === query.expandEntityId) {
        return this.lastVerifiedDetail;
      }
      return null;
    }
  }

  /**
   * Retrieve bounded log range within configured limits.
   *
   * Requirements: 42.4
   * - Display no more than configured positive line and byte limits
   * - Expose authorized range retrieval for retained logs
   */
  async getLogRange(query: LogRangeQuery): Promise<BoundedLogRange | null> {
    // Enforce configured bounds (Req 42.4)
    const boundedQuery: LogRangeQuery = {
      ...query,
      maxLines: Math.min(query.maxLines, this.config.maxLogLines),
      maxBytes: Math.min(query.maxBytes, this.config.maxLogBytes),
    };

    try {
      return await this.dataSource.getLogRange(boundedQuery);
    } catch (_error) {
      // Failure — return null; caller preserves last verified state (Req 42.14)
      return null;
    }
  }

  /**
   * Request cancellation of an active trajectory entity.
   *
   * Requirements: 42.5, 42.13
   * - Route through owning Orchestration_Engine or Job_Service authority
   * - Entity remains nonterminal until authority provides terminal projection
   */
  async requestCancellation(command: CancellationCommand): Promise<CancellationResult> {
    // Validate: cannot cancel an already-terminal entity
    const currentProjection = this.lastVerifiedProjection;
    if (currentProjection) {
      const summary = currentProjection.summaries.find((s) => s.entityId === command.entityId);
      if (summary && isTerminalState(summary.state)) {
        return {
          accepted: false,
          commandId: command.commandId,
          rejectionReason: `Entity is already in terminal state: ${summary.state}`,
        };
      }
    }

    try {
      // Route to owning authority (Req 42.5)
      return await this.authorityPort.cancelEntity(command);
    } catch (_error) {
      // Failure — preserve last verified state (Req 42.14)
      return {
        accepted: false,
        commandId: command.commandId,
        rejectionReason: 'Cancellation request failed; last verified state preserved',
      };
    }
  }

  /**
   * Build an unavailable reason for failed operations.
   * Used internally to produce structured unavailable reasons (Req 42.11, 42.14).
   */
  buildUnavailableReason(
    kind: UnavailableReason['kind'],
    message: string,
    lastVerifiedRevision?: number,
    lastVerifiedAt?: string,
  ): UnavailableReason {
    return {
      kind,
      message,
      lastVerifiedRevision,
      lastVerifiedAt,
    };
  }

  /**
   * Get the last verified projection (preserved across failures).
   * Requirement 42.14
   */
  getLastVerifiedProjection(): TrajectoryProjectionV1 | null {
    return this.lastVerifiedProjection;
  }

  /**
   * Get the last verified detail (preserved across failures).
   * Requirement 42.14
   */
  getLastVerifiedDetail(): TrajectoryDetailV1 | null {
    return this.lastVerifiedDetail;
  }

  // ─── Internal Helpers ─────────────────────────────────────────

  private revisionCounter = 0;

  private nextRevision(): number {
    return ++this.revisionCounter;
  }
}
