/**
 * Request Reconstruction and Exact-Retry Preflight
 *
 * Rebuilds provider-neutral prompts, ordered tools, route/adapter versions,
 * and attachments from durable records. Verifies fingerprints, availability,
 * compatibility, policy, and budgets before exact dispatch.
 *
 * The reconstruction process:
 * 1. Load durable records for the target Completion_Anchor from Session_Log
 * 2. Rebuild ordered prompt sections, tool schemas, route decision, and attachments
 * 3. Recompute Prompt_Fingerprint and verify against the recorded value
 * 4. Run preflight checks: route availability, adapter compatibility, tool schemas,
 *    attachment resolvability, policy compliance, budget eligibility, capacity fit
 * 5. Return a structured result: dispatch allowed or block reasons
 *
 * Requirements: 34.1–34.2, 44.4–44.6, 44.8, 44.12, 44.14
 */

import type {
  ReconstructedRequestV1,
  ReconstructionInputV1,
  ExactRetryPreflightResultV1,
  PreflightCheckResultV1,
  RetryBlockReasonV1,
  PreflightCheckKind,
  PromptSectionV1,
  OrderedToolSchemaV1,
  RouteDecisionV1,
  AttachmentReferenceV1,
} from './request-reconstruction-schemas.js';

// ─── Dependency Ports ───────────────────────────────────────────

/**
 * Port for reading durable prompt/completion records from Session_Log.
 */
export interface DurableRecordReader {
  /**
   * Load the prompt sections persisted for the given anchor.
   */
  loadPromptSections(anchorId: string, sessionId: string, branchId: string): Promise<PromptSectionV1[] | null>;

  /**
   * Load the ordered tool schemas persisted for the given anchor.
   */
  loadToolSchemas(anchorId: string, sessionId: string, branchId: string): Promise<OrderedToolSchemaV1[] | null>;

  /**
   * Load the route decision persisted for the given anchor.
   */
  loadRouteDecision(anchorId: string, sessionId: string, branchId: string): Promise<RouteDecisionV1 | null>;

  /**
   * Load attachment references persisted for the given anchor.
   */
  loadAttachmentReferences(anchorId: string, sessionId: string, branchId: string): Promise<AttachmentReferenceV1[] | null>;

  /**
   * Load the recorded prompt fingerprint for the given anchor.
   */
  loadPromptFingerprint(anchorId: string, sessionId: string, branchId: string): Promise<string | null>;

  /**
   * Load the assembly version used for the given anchor.
   */
  loadAssemblyVersion(anchorId: string, sessionId: string, branchId: string): Promise<string | null>;

  /**
   * Load the source sequence in the Session_Log for the original request.
   */
  loadSourceSequence(anchorId: string, sessionId: string, branchId: string): Promise<number | null>;
}

/**
 * Port for computing prompt fingerprints. Must match the Prompt_Assembler's
 * deterministic fingerprint computation.
 */
export interface FingerprintComputer {
  /**
   * Compute a Prompt_Fingerprint from normalized inputs.
   * Must be deterministic: same inputs always produce the same hash.
   */
  compute(params: {
    sections: PromptSectionV1[];
    tools: OrderedToolSchemaV1[];
    routeId: string;
    adapterVersion: string;
    assemblyVersion: string;
  }): string;
}

/**
 * Port for verifying current route/adapter availability.
 */
export interface RouteAvailabilityChecker {
  /**
   * Check if the route is still available and healthy.
   */
  isRouteAvailable(routeId: string): Promise<boolean>;

  /**
   * Check if the specific adapter version is still compatible.
   */
  isAdapterVersionCompatible(adapterId: string, adapterVersion: string): Promise<boolean>;
}

/**
 * Port for verifying tool schema compatibility.
 */
export interface ToolCompatibilityChecker {
  /**
   * Verify that a tool still exists and its schema hash matches.
   * Returns the current schema hash if the tool exists, or null if removed.
   */
  getCurrentSchemaHash(toolName: string, toolVersion: string): Promise<string | null>;
}

/**
 * Port for verifying attachment resolvability.
 */
export interface AttachmentResolver {
  /**
   * Check if an attachment reference is still resolvable (not expired, not deleted).
   */
  isResolvable(attachmentId: string, contentHash: string): Promise<boolean>;
}

/**
 * Port for verifying security/approval policy compliance.
 */
export interface PolicyChecker {
  /**
   * Check if the operation is still allowed under current policy.
   */
  isAllowed(params: {
    sessionId: string;
    routeId: string;
    toolNames: string[];
    attachmentIds: string[];
  }): Promise<{ allowed: boolean; reason?: string }>;
}

/**
 * Port for verifying budget eligibility.
 */
export interface BudgetChecker {
  /**
   * Check if there is sufficient budget remaining for the retry.
   */
  hasSufficientBudget(params: {
    sessionId: string;
    routeId: string;
    estimatedTokens: number;
  }): Promise<{ eligible: boolean; reason?: string }>;
}

// ─── Reconstruction Service ─────────────────────────────────────

export interface RequestReconstructionDeps {
  durableRecordReader: DurableRecordReader;
  fingerprintComputer: FingerprintComputer;
  routeAvailabilityChecker: RouteAvailabilityChecker;
  toolCompatibilityChecker: ToolCompatibilityChecker;
  attachmentResolver: AttachmentResolver;
  policyChecker: PolicyChecker;
  budgetChecker: BudgetChecker;
}

/**
 * Reconstructs a request from durable records and returns either a
 * ReconstructedRequestV1 or a reconstruction failure reason.
 */
export type ReconstructionResult =
  | { ok: true; request: ReconstructedRequestV1 }
  | { ok: false; reason: string; code: 'RECORDS_NOT_FOUND' | 'INCOMPLETE_RECORDS' | 'FINGERPRINT_MISMATCH' };

/**
 * Request Reconstruction Service.
 *
 * Rebuilds the exact provider-neutral prompt from durable Session_Log records
 * and runs all preflight checks to determine if an exact retry can be dispatched.
 */
export class RequestReconstructionService {
  private readonly deps: RequestReconstructionDeps;

  constructor(deps: RequestReconstructionDeps) {
    this.deps = deps;
  }

  /**
   * Reconstruct a request from durable records.
   *
   * Loads prompt sections, tool schemas, route decision, attachments,
   * and assembly metadata from durable Session_Log records, then verifies
   * that the reconstructed inputs produce the same Prompt_Fingerprint.
   *
   * Requirements: 34.1 (exact reconstruction), 34.2 (fingerprint reproduction)
   */
  async reconstruct(input: ReconstructionInputV1): Promise<ReconstructionResult> {
    const { anchorId, sessionId, branchId } = input;
    const reader = this.deps.durableRecordReader;

    // Load all durable records in parallel
    const [
      sections,
      tools,
      routeDecision,
      attachments,
      recordedFingerprint,
      assemblyVersion,
      sourceSequence,
    ] = await Promise.all([
      reader.loadPromptSections(anchorId, sessionId, branchId),
      reader.loadToolSchemas(anchorId, sessionId, branchId),
      reader.loadRouteDecision(anchorId, sessionId, branchId),
      reader.loadAttachmentReferences(anchorId, sessionId, branchId),
      reader.loadPromptFingerprint(anchorId, sessionId, branchId),
      reader.loadAssemblyVersion(anchorId, sessionId, branchId),
      reader.loadSourceSequence(anchorId, sessionId, branchId),
    ]);

    // Verify all required records are present
    if (sections === null || routeDecision === null || recordedFingerprint === null) {
      return {
        ok: false,
        reason: 'Required durable records not found for the target anchor',
        code: 'RECORDS_NOT_FOUND',
      };
    }

    if (assemblyVersion === null || sourceSequence === null) {
      return {
        ok: false,
        reason: 'Incomplete reconstruction metadata for the target anchor',
        code: 'INCOMPLETE_RECORDS',
      };
    }

    // Ensure sections are in stable ordinal order
    const orderedSections = [...sections].sort((a, b) => a.ordinal - b.ordinal);
    const orderedTools = [...(tools ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    const resolvedAttachments = attachments ?? [];

    // Recompute fingerprint from reconstructed inputs
    const computedFingerprint = this.deps.fingerprintComputer.compute({
      sections: orderedSections,
      tools: orderedTools,
      routeId: routeDecision.routeId,
      adapterVersion: routeDecision.adapterVersion,
      assemblyVersion,
    });

    // Verify fingerprint matches the recorded value (Requirement 34.2)
    if (computedFingerprint !== recordedFingerprint) {
      return {
        ok: false,
        reason: `Reconstructed fingerprint "${computedFingerprint}" does not match recorded "${recordedFingerprint}"`,
        code: 'FINGERPRINT_MISMATCH',
      };
    }

    const request: ReconstructedRequestV1 = {
      anchorId,
      sessionId,
      branchId,
      sections: orderedSections,
      tools: orderedTools,
      routeDecision,
      attachments: resolvedAttachments,
      promptFingerprint: recordedFingerprint,
      assemblyVersion,
      sourceSequence,
      reconstructedAt: new Date().toISOString(),
    };

    return { ok: true, request };
  }

  /**
   * Run all preflight checks for an exact retry.
   *
   * Verifies: fingerprint reconstruction, route availability, adapter compatibility,
   * tool schema integrity, attachment resolvability, policy compliance, budget
   * eligibility, and capacity fit.
   *
   * If ANY check fails, the exact retry is blocked with structured reasons.
   *
   * Requirements: 44.5 (verify reconstructability, route, attachment, policy, budget),
   *              44.6 (display reason when action is unavailable),
   *              44.8 (fingerprint and provenance display),
   *              44.12 (reconstruction failure offers branch-with-current-config),
   *              44.14 (bind to matching fingerprint without substitution)
   */
  async runPreflight(input: ReconstructionInputV1): Promise<ExactRetryPreflightResultV1> {
    const checks: PreflightCheckResultV1[] = [];
    const blockReasons: RetryBlockReasonV1[] = [];

    // Step 1: Reconstruct the request (validates fingerprint)
    const reconstruction = await this.reconstruct(input);

    if (!reconstruction.ok) {
      const now = new Date().toISOString();
      checks.push(makeCheck('fingerprint', false, reconstruction.reason, now));
      blockReasons.push({
        checkKind: 'fingerprint',
        message: reconstruction.reason,
        code: 'RECONSTRUCTION_FAILED',
        details: { errorCode: reconstruction.code },
      });
      return makePreflightResult(input.anchorId, '', checks, blockReasons);
    }

    const request = reconstruction.request;
    const now = () => new Date().toISOString();

    // Step 2: Fingerprint check (passed since reconstruction succeeded)
    checks.push(makeCheck('fingerprint', true, undefined, now()));

    // Step 3: Route availability
    const routeAvailable = await this.deps.routeAvailabilityChecker.isRouteAvailable(
      request.routeDecision.routeId,
    );
    checks.push(makeCheck('route_availability', routeAvailable, routeAvailable ? undefined : 'Route is no longer available', now()));
    if (!routeAvailable) {
      blockReasons.push({
        checkKind: 'route_availability',
        message: `Route "${request.routeDecision.routeId}" is no longer available`,
        code: 'ROUTE_UNAVAILABLE',
        details: { routeId: request.routeDecision.routeId },
      });
    }

    // Step 4: Adapter compatibility
    const adapterCompatible = await this.deps.routeAvailabilityChecker.isAdapterVersionCompatible(
      request.routeDecision.adapterId,
      request.routeDecision.adapterVersion,
    );
    checks.push(makeCheck('adapter_compatibility', adapterCompatible, adapterCompatible ? undefined : 'Adapter version is no longer compatible', now()));
    if (!adapterCompatible) {
      blockReasons.push({
        checkKind: 'adapter_compatibility',
        message: `Adapter "${request.routeDecision.adapterId}" version "${request.routeDecision.adapterVersion}" is no longer compatible`,
        code: 'ADAPTER_INCOMPATIBLE',
        details: {
          adapterId: request.routeDecision.adapterId,
          adapterVersion: request.routeDecision.adapterVersion,
        },
      });
    }

    // Step 5: Tool compatibility
    for (const tool of request.tools) {
      const currentHash = await this.deps.toolCompatibilityChecker.getCurrentSchemaHash(
        tool.toolName,
        tool.toolVersion,
      );
      if (currentHash === null) {
        checks.push(makeCheck('tool_compatibility', false, `Tool "${tool.toolName}" has been removed`, now()));
        blockReasons.push({
          checkKind: 'tool_compatibility',
          message: `Tool "${tool.toolName}" v${tool.toolVersion} is no longer available`,
          code: 'TOOL_REMOVED',
          details: { toolName: tool.toolName, toolVersion: tool.toolVersion },
        });
      } else if (currentHash !== tool.schemaHash) {
        checks.push(makeCheck('tool_compatibility', false, `Tool "${tool.toolName}" schema has changed`, now()));
        blockReasons.push({
          checkKind: 'tool_compatibility',
          message: `Tool "${tool.toolName}" schema has changed since original request`,
          code: 'TOOL_SCHEMA_CHANGED',
          details: {
            toolName: tool.toolName,
            toolVersion: tool.toolVersion,
            originalHash: tool.schemaHash,
            currentHash,
          },
        });
      } else {
        checks.push(makeCheck('tool_compatibility', true, undefined, now()));
      }
    }

    // Step 6: Attachment availability
    for (const attachment of request.attachments) {
      const resolvable = await this.deps.attachmentResolver.isResolvable(
        attachment.attachmentId,
        attachment.contentHash,
      );
      if (!resolvable) {
        checks.push(makeCheck('attachment_availability', false, `Attachment "${attachment.attachmentId}" is no longer resolvable`, now()));
        blockReasons.push({
          checkKind: 'attachment_availability',
          message: `Attachment "${attachment.attachmentId}" is no longer resolvable`,
          code: 'ATTACHMENT_UNRESOLVABLE',
          details: {
            attachmentId: attachment.attachmentId,
            contentHash: attachment.contentHash,
          },
        });
      } else {
        checks.push(makeCheck('attachment_availability', true, undefined, now()));
      }
    }

    // Step 7: Policy compliance
    const policyResult = await this.deps.policyChecker.isAllowed({
      sessionId: request.sessionId,
      routeId: request.routeDecision.routeId,
      toolNames: request.tools.map(t => t.toolName),
      attachmentIds: request.attachments.map(a => a.attachmentId),
    });
    checks.push(makeCheck('policy_compliance', policyResult.allowed, policyResult.reason, now()));
    if (!policyResult.allowed) {
      blockReasons.push({
        checkKind: 'policy_compliance',
        message: policyResult.reason ?? 'Policy does not allow this operation',
        code: 'POLICY_DENIED',
        details: {},
      });
    }

    // Step 8: Budget eligibility
    const estimatedTokens = request.routeDecision.capacityTokens;
    const budgetResult = await this.deps.budgetChecker.hasSufficientBudget({
      sessionId: request.sessionId,
      routeId: request.routeDecision.routeId,
      estimatedTokens,
    });
    checks.push(makeCheck('budget_eligibility', budgetResult.eligible, budgetResult.reason, now()));
    if (!budgetResult.eligible) {
      blockReasons.push({
        checkKind: 'budget_eligibility',
        message: budgetResult.reason ?? 'Insufficient budget for retry',
        code: 'BUDGET_EXHAUSTED',
        details: { estimatedTokens },
      });
    }

    // Step 9: Capacity fit — verify the request can still fit in the route's context window
    const totalContextTokens = estimateContextTokens(request.sections, request.tools);
    const capacityPassed = totalContextTokens <= request.routeDecision.capacityTokens;
    checks.push(makeCheck('capacity_fit', capacityPassed, capacityPassed ? undefined : 'Request exceeds route context capacity', now()));
    if (!capacityPassed) {
      blockReasons.push({
        checkKind: 'capacity_fit',
        message: `Request context (${totalContextTokens} tokens) exceeds route capacity (${request.routeDecision.capacityTokens} tokens)`,
        code: 'CAPACITY_EXCEEDED',
        details: {
          estimatedContextTokens: totalContextTokens,
          routeCapacity: request.routeDecision.capacityTokens,
        },
      });
    }

    return makePreflightResult(
      request.anchorId,
      request.promptFingerprint,
      checks,
      blockReasons,
    );
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function makeCheck(
  kind: PreflightCheckKind,
  passed: boolean,
  reason: string | undefined,
  checkedAt: string,
): PreflightCheckResultV1 {
  return {
    kind,
    passed,
    ...(reason !== undefined ? { reason } : {}),
    details: {},
    checkedAt,
  };
}

function makePreflightResult(
  anchorId: string,
  promptFingerprint: string,
  checks: PreflightCheckResultV1[],
  blockReasons: RetryBlockReasonV1[],
): ExactRetryPreflightResultV1 {
  return {
    anchorId,
    promptFingerprint,
    checks,
    canDispatch: blockReasons.length === 0,
    blockReasons,
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * Estimate the total context token count from prompt sections and tools.
 * Uses a simple character-based approximation (4 chars per token).
 * The actual Prompt_Assembler would use provider-specific tokenizers.
 */
function estimateContextTokens(sections: PromptSectionV1[], tools: OrderedToolSchemaV1[]): number {
  let totalChars = 0;

  for (const section of sections) {
    totalChars += section.content.length;
    for (const value of Object.values(section.variables)) {
      totalChars += value.length;
    }
  }

  for (const tool of tools) {
    // Tool schema contributes to context in provider-specific ways
    // Use tool name + version + policy as a rough estimate
    totalChars += tool.toolName.length + tool.toolVersion.length + JSON.stringify(tool.policyMetadata).length;
  }

  // Approximate: 4 characters per token
  return Math.ceil(totalChars / 4);
}
