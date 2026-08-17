/**
 * Tool Presentation Port — Facade for tool tree projection, inspection, and spill retrieval.
 *
 * Implements the ToolPresentationPort interface from the design:
 * - getCallTree: Project verified call lineage into a structured tree
 * - inspect: Bounded redacted inspection with authority-routed actions
 * - retrieveSpill: Authorized range retrieval from Tool_Spill_Service
 *
 * Requirements: 37.1–37.17
 */

import { ToolTreeProjector, type RawToolCallRecord } from './tool-tree-projector';
import { ToolInspector, type ToolCallDataSource, type AuthorityActionPort } from './tool-inspector';
import type {
  ToolTreeProjectionV1,
  ToolTreeQuery,
  ToolInspectionV1,
  ToolInspectionQuery,
  AuthorizedRangeQuery,
  BoundedRangeV1,
} from './tool-tree-schemas';

// ─── Spill Service Port ─────────────────────────────────────────

/**
 * Port for authorized spill range retrieval.
 * The presentation port delegates to this for oversized output retrieval.
 *
 * Requirements: 37.8
 */
export interface SpillServicePort {
  /**
   * Retrieve a bounded range from a spilled tool result.
   * Returns the retrieved content with availability labels.
   */
  retrieveRange(query: AuthorizedRangeQuery, signal: AbortSignal): Promise<BoundedRangeV1>;
}

// ─── Call Record Provider ───────────────────────────────────────

/**
 * Provider for raw tool call records to feed into the projector.
 */
export interface ToolCallRecordProvider {
  /**
   * Get all tool call records for a session/turn.
   */
  getCallRecords(sessionId: string, turnId?: string): Promise<RawToolCallRecord[]>;
}

// ─── Tool Presentation Port ─────────────────────────────────────

export interface ToolPresentationPortConfig {
  /** Maximum tree depth for projection. */
  maxDepth?: number;
  /** Default maximum bytes for argument preview in inspector. */
  defaultMaxArgumentBytes?: number;
  /** Default maximum lines for argument preview. */
  defaultMaxArgumentLines?: number;
  /** Default maximum bytes for output preview. */
  defaultMaxOutputBytes?: number;
  /** Default maximum lines for output preview. */
  defaultMaxOutputLines?: number;
}

/**
 * Concrete implementation of the ToolPresentationPort interface.
 *
 * Coordinates the ToolTreeProjector (for tree projection),
 * ToolInspector (for bounded inspection), and SpillServicePort
 * (for authorized range retrieval).
 */
export class ToolPresentationPortImpl {
  private readonly projector: ToolTreeProjector;
  private readonly inspector: ToolInspector;
  private readonly spillService: SpillServicePort;
  private readonly recordProvider: ToolCallRecordProvider;
  private projectionRevision: number = 0;

  constructor(
    recordProvider: ToolCallRecordProvider,
    dataSource: ToolCallDataSource,
    authorityPort: AuthorityActionPort,
    spillService: SpillServicePort,
    config: ToolPresentationPortConfig = {},
  ) {
    this.recordProvider = recordProvider;
    this.spillService = spillService;

    this.projector = new ToolTreeProjector({
      maxDepth: config.maxDepth ?? 10,
    });

    this.inspector = new ToolInspector(dataSource, authorityPort, {
      ...(config.defaultMaxArgumentBytes !== undefined && { defaultMaxArgumentBytes: config.defaultMaxArgumentBytes }),
      ...(config.defaultMaxArgumentLines !== undefined && { defaultMaxArgumentLines: config.defaultMaxArgumentLines }),
      ...(config.defaultMaxOutputBytes !== undefined && { defaultMaxOutputBytes: config.defaultMaxOutputBytes }),
      ...(config.defaultMaxOutputLines !== undefined && { defaultMaxOutputLines: config.defaultMaxOutputLines }),
    });
  }

  /**
   * Project the call tree for a session/turn query.
   *
   * Each immutable call identity appears exactly once in model order.
   * Verified lineage is rendered as a tree; malformed edges are flattened
   * to a safe model-ordered fallback.
   *
   * Requirements: 37.1, 37.2, 37.14, 37.15
   */
  async getCallTree(query: ToolTreeQuery): Promise<ToolTreeProjectionV1> {
    const records = await this.recordProvider.getCallRecords(
      query.sessionId,
      query.turnId,
    );

    this.projectionRevision++;

    return this.projector.project(records, query, this.projectionRevision);
  }

  /**
   * Inspect a specific tool call. Returns bounded redacted data with
   * authorized actions routed through owning authorities.
   *
   * Requirements: 37.3, 37.4, 37.7–37.13, 37.16, 37.17
   */
  async inspect(query: ToolInspectionQuery): Promise<ToolInspectionV1 | null> {
    return this.inspector.inspect(query);
  }

  /**
   * Retrieve a bounded range from spilled tool output.
   * Labels retrieved and unavailable ranges.
   *
   * Requirements: 37.8
   */
  async retrieveSpill(
    query: AuthorizedRangeQuery,
    signal: AbortSignal,
  ): Promise<BoundedRangeV1> {
    return this.spillService.retrieveRange(query, signal);
  }
}
