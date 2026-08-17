/**
 * Protocol Adapter — Edge translator between external protocols (Agent_Client_Protocol)
 * and NeuroNest's canonical internal event and tool contracts.
 *
 * Adapters sit at the boundary — external protocol formats never penetrate into the
 * canonical domain layer. Every operation entering through an adapter is routed through:
 * 1. Schema validation
 * 2. Scope_Descriptor resolution
 * 3. Security policy (Security_Authority)
 * 4. Approval checks (Collaboration_Service)
 * 5. Audit recording
 * 6. Tool controls (Tool_Registry)
 *
 * The adapter rejects representations that lose required safety fields, correlation
 * identifiers, or scope information.
 *
 * Each adapter has an identity and version for pinning and replay.
 *
 * Requirements: 25.2–25.6
 */

import { randomUUID } from 'node:crypto';
import {
  ExternalProtocolMessageSchema,
  REQUIRED_SAFETY_FIELDS,
  AdapterAuditRecordSchema,
  type AdapterIdentity,
  type ExternalProtocolMessage,
  type CanonicalOperation,
  type AdapterOperationResult,
  type PipelineStageResult,
  type ProtocolAdapterConfig,
  type LosslessExtension,
  type AdapterAuditRecord,
  type RequiredSafetyField,
} from './protocol-adapter-types.js';
import type { ScopeDescriptorV1 } from '../contracts/scope.js';
import type { ActorRef } from '../contracts/actor.js';

// ─── Pipeline Dependencies (injected) ──────────────────────────

/**
 * Schema validation service — validates the translated canonical operation
 * against the expected schema for its operation type.
 */
export interface SchemaValidator {
  validate(operation: CanonicalOperation): { valid: boolean; errors?: string[] };
}

/**
 * Scope resolution service — resolves scope descriptor from the operation context.
 */
export interface ScopeResolver {
  resolve(
    actor: ActorRef,
    operationType: string,
    payload: Record<string, unknown>,
  ): { resolved: true; scope: ScopeDescriptorV1 } | { resolved: false; reason: string };
}

/**
 * Security policy enforcement — evaluates whether the operation is allowed
 * under current security policy.
 */
export interface SecurityPolicy {
  evaluate(
    operation: CanonicalOperation,
  ): { allowed: true } | { allowed: false; reason: string };
}

/**
 * Approval check service — verifies that required approvals exist for the operation.
 */
export interface ApprovalChecker {
  check(
    operation: CanonicalOperation,
  ): { approved: true } | { approved: false; reason: string };
}

/**
 * Audit recorder — records all operations passing through the adapter boundary.
 */
export interface AuditRecorder {
  record(auditRecord: AdapterAuditRecord): void;
}

/**
 * Tool control service — validates tool-related operations through Tool_Registry.
 */
export interface ToolControl {
  validate(
    operation: CanonicalOperation,
  ): { valid: true } | { valid: false; reason: string };
}

/**
 * Protocol translator — translates external protocol messages into canonical operations.
 * Each protocol (Agent_Client_Protocol) provides its own translator.
 */
export interface ProtocolTranslator {
  /**
   * Translate an external message into a canonical operation.
   * Returns null for fields that cannot be represented; the adapter will then
   * check for lossless extensions or reject the operation.
   */
  translate(
    message: ExternalProtocolMessage,
    adapterIdentity: AdapterIdentity,
  ): TranslationResult;
}

export type TranslationResult =
  | { ok: true; operation: CanonicalOperation }
  | { ok: false; missingFields: RequiredSafetyField[]; reason: string };

// ─── Protocol Adapter ───────────────────────────────────────────

export class ProtocolAdapter {
  private readonly config: ProtocolAdapterConfig;
  private readonly translator: ProtocolTranslator;
  private readonly schemaValidator: SchemaValidator;
  private readonly scopeResolver: ScopeResolver;
  private readonly securityPolicy: SecurityPolicy;
  private readonly approvalChecker: ApprovalChecker;
  private readonly auditRecorder: AuditRecorder;
  private readonly toolControl: ToolControl;
  private readonly losslessExtensionMap: Map<string, LosslessExtension>;

  constructor(
    config: ProtocolAdapterConfig,
    dependencies: {
      translator: ProtocolTranslator;
      schemaValidator: SchemaValidator;
      scopeResolver: ScopeResolver;
      securityPolicy: SecurityPolicy;
      approvalChecker: ApprovalChecker;
      auditRecorder: AuditRecorder;
      toolControl: ToolControl;
    },
  ) {
    this.config = config;
    this.translator = dependencies.translator;
    this.schemaValidator = dependencies.schemaValidator;
    this.scopeResolver = dependencies.scopeResolver;
    this.securityPolicy = dependencies.securityPolicy;
    this.approvalChecker = dependencies.approvalChecker;
    this.auditRecorder = dependencies.auditRecorder;
    this.toolControl = dependencies.toolControl;

    // Index lossless extensions by the fields they provide
    this.losslessExtensionMap = new Map();
    for (const ext of config.losslessExtensions) {
      for (const field of ext.providedFields) {
        this.losslessExtensionMap.set(field, ext);
      }
    }
  }

  /**
   * Get the adapter identity for pinning and replay.
   */
  get identity(): AdapterIdentity {
    return this.config.identity;
  }

  /**
   * Check whether this adapter is enabled.
   */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Process an external protocol message through the full pipeline.
   *
   * Pipeline order:
   * 1. Validate external message schema
   * 2. Translate to canonical operation
   * 3. Check required safety fields (reject or apply lossless extensions)
   * 4. Validate canonical schema
   * 5. Resolve scope
   * 6. Evaluate security policy
   * 7. Check approvals
   * 8. Record audit
   * 9. Validate tool controls
   *
   * Protocol-specific representations are confined to this adapter boundary.
   */
  async processMessage(message: unknown): Promise<AdapterOperationResult> {
    if (!this.config.enabled) {
      return {
        status: 'rejected',
        stage: 'adapter_disabled',
        reason: `Adapter '${this.config.identity.adapterName}' is not enabled`,
        pipelineResults: [],
      };
    }

    const pipelineResults: PipelineStageResult[] = [];

    // ─── Step 1: Validate external message schema ─────────────
    const parseStart = Date.now();
    const messageResult = ExternalProtocolMessageSchema.safeParse(message);
    if (!messageResult.success) {
      const result: PipelineStageResult = {
        outcome: 'rejected',
        stage: 'schema_validation',
        reason: `Invalid external message: ${messageResult.error.message}`,
        durationMs: Date.now() - parseStart,
      };
      pipelineResults.push(result);
      return {
        status: 'rejected',
        stage: 'schema_validation',
        reason: result.reason,
        pipelineResults,
      };
    }
    pipelineResults.push({
      outcome: 'passed',
      stage: 'external_message_validation',
      durationMs: Date.now() - parseStart,
    });

    const externalMessage = messageResult.data;

    // ─── Step 2: Translate to canonical operation ─────────────
    const translateStart = Date.now();
    const translationResult = this.translator.translate(
      externalMessage,
      this.config.identity,
    );

    if (!translationResult.ok) {
      // Check if we have lossless extensions for the missing fields
      const unresolvableFields = translationResult.missingFields.filter(
        f => !this.losslessExtensionMap.has(f),
      );

      if (unresolvableFields.length > 0) {
        // Cannot represent required safety fields — reject per Requirement 25.5
        const extensionNames = translationResult.missingFields
          .map(f => this.losslessExtensionMap.get(f)?.extensionName)
          .filter(Boolean);

        pipelineResults.push({
          outcome: 'rejected',
          stage: 'schema_validation',
          reason: `External protocol cannot represent required safety/correlation fields: ${unresolvableFields.join(', ')}`,
          durationMs: Date.now() - translateStart,
        });

        return {
          status: 'lossless_extension_required',
          missingFields: unresolvableFields,
          documentedExtension: extensionNames.length > 0
            ? extensionNames.join(', ')
            : undefined,
        };
      }
    }

    if (!translationResult.ok) {
      pipelineResults.push({
        outcome: 'rejected',
        stage: 'schema_validation',
        reason: translationResult.reason,
        durationMs: Date.now() - translateStart,
      });
      return {
        status: 'rejected',
        stage: 'schema_validation',
        reason: translationResult.reason,
        pipelineResults,
      };
    }

    pipelineResults.push({
      outcome: 'passed',
      stage: 'translation',
      durationMs: Date.now() - translateStart,
    });

    const operation = translationResult.operation;

    // ─── Step 3: Verify required safety fields are present ────
    const safetyStart = Date.now();
    const missingSafetyFields = this.checkRequiredSafetyFields(operation);
    if (missingSafetyFields.length > 0) {
      pipelineResults.push({
        outcome: 'rejected',
        stage: 'schema_validation',
        reason: `Missing required safety/correlation fields: ${missingSafetyFields.join(', ')}`,
        durationMs: Date.now() - safetyStart,
      });
      return {
        status: 'rejected',
        operationId: operation.operationId,
        correlationId: operation.correlationId,
        stage: 'schema_validation',
        reason: `Missing required safety/correlation fields: ${missingSafetyFields.join(', ')}`,
        pipelineResults,
      };
    }
    pipelineResults.push({
      outcome: 'passed',
      stage: 'safety_field_check',
      durationMs: Date.now() - safetyStart,
    });

    // ─── Step 4: Canonical schema validation ──────────────────
    const schemaResult = this.runPipelineStage(
      'schema_validation',
      () => this.schemaValidator.validate(operation),
      (r) => r.valid ? null : (r.errors?.join('; ') ?? 'Schema validation failed'),
    );
    pipelineResults.push(schemaResult);
    if (schemaResult.outcome === 'rejected') {
      this.recordAudit(operation, 'schema_validation', 'rejected', schemaResult.reason);
      return {
        status: 'rejected',
        operationId: operation.operationId,
        correlationId: operation.correlationId,
        stage: 'schema_validation',
        reason: schemaResult.reason,
        pipelineResults,
      };
    }

    // ─── Step 5: Scope resolution ─────────────────────────────
    const scopeResult = this.runPipelineStage(
      'scope_resolution',
      () => this.scopeResolver.resolve(
        operation.actor,
        operation.operationType,
        operation.canonicalPayload,
      ),
      (r) => r.resolved ? null : r.reason,
    );
    pipelineResults.push(scopeResult);
    if (scopeResult.outcome === 'rejected') {
      this.recordAudit(operation, 'scope_resolution', 'rejected', scopeResult.reason);
      return {
        status: 'rejected',
        operationId: operation.operationId,
        correlationId: operation.correlationId,
        stage: 'scope_resolution',
        reason: scopeResult.reason,
        pipelineResults,
      };
    }

    // ─── Step 6: Security policy ──────────────────────────────
    const securityResult = this.runPipelineStage(
      'security_policy',
      () => this.securityPolicy.evaluate(operation),
      (r) => r.allowed ? null : r.reason,
    );
    pipelineResults.push(securityResult);
    if (securityResult.outcome === 'rejected') {
      this.recordAudit(operation, 'security_policy', 'rejected', securityResult.reason);
      return {
        status: 'rejected',
        operationId: operation.operationId,
        correlationId: operation.correlationId,
        stage: 'security_policy',
        reason: securityResult.reason,
        pipelineResults,
      };
    }

    // ─── Step 7: Approval check ──────────────────────────────
    const approvalResult = this.runPipelineStage(
      'approval_check',
      () => this.approvalChecker.check(operation),
      (r) => r.approved ? null : r.reason,
    );
    pipelineResults.push(approvalResult);
    if (approvalResult.outcome === 'rejected') {
      this.recordAudit(operation, 'approval_check', 'rejected', approvalResult.reason);
      return {
        status: 'rejected',
        operationId: operation.operationId,
        correlationId: operation.correlationId,
        stage: 'approval_check',
        reason: approvalResult.reason,
        pipelineResults,
      };
    }

    // ─── Step 8: Audit recording ──────────────────────────────
    this.recordAudit(operation, 'audit_recording', 'passed');
    pipelineResults.push({
      outcome: 'passed',
      stage: 'audit_recording',
      durationMs: 0,
    });

    // ─── Step 9: Tool control ─────────────────────────────────
    const toolResult = this.runPipelineStage(
      'tool_control',
      () => this.toolControl.validate(operation),
      (r) => r.valid ? null : r.reason,
    );
    pipelineResults.push(toolResult);
    if (toolResult.outcome === 'rejected') {
      this.recordAudit(operation, 'tool_control', 'rejected', toolResult.reason);
      return {
        status: 'rejected',
        operationId: operation.operationId,
        correlationId: operation.correlationId,
        stage: 'tool_control',
        reason: toolResult.reason,
        pipelineResults,
      };
    }

    // ─── All stages passed ────────────────────────────────────
    return {
      status: 'dispatched',
      operationId: operation.operationId,
      correlationId: operation.correlationId,
      pipelineResults,
    };
  }

  // ─── Internal Helpers ───────────────────────────────────────

  /**
   * Check that all required safety fields are present and non-empty.
   * Returns a list of missing field names.
   */
  private checkRequiredSafetyFields(operation: CanonicalOperation): string[] {
    const missing: string[] = [];
    for (const field of REQUIRED_SAFETY_FIELDS) {
      const value = operation[field as keyof CanonicalOperation];
      if (value === undefined || value === null || value === '') {
        missing.push(field);
      }
      // For objects (actor, scope), check they are non-empty
      if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) {
        missing.push(field);
      }
    }
    return missing;
  }

  /**
   * Run a pipeline stage, timing it and converting to a PipelineStageResult.
   */
  private runPipelineStage<T>(
    stage: string,
    execute: () => T,
    getFailureReason: (result: T) => string | null,
  ): PipelineStageResult {
    const start = Date.now();
    const result = execute();
    const durationMs = Date.now() - start;
    const reason = getFailureReason(result);

    if (reason !== null) {
      return { outcome: 'rejected', stage, reason, durationMs };
    }
    return { outcome: 'passed', stage, durationMs };
  }

  /**
   * Record an audit entry for this adapter operation.
   */
  private recordAudit(
    operation: CanonicalOperation,
    stage: string,
    outcome: 'passed' | 'rejected' | 'error',
    reason?: string,
  ): void {
    const auditRecord: AdapterAuditRecord = {
      auditId: randomUUID(),
      adapterId: this.config.identity.adapterId,
      operationId: operation.operationId,
      correlationId: operation.correlationId,
      actor: operation.actor,
      scope: operation.scope,
      operationType: operation.operationType,
      stage,
      outcome,
      reason,
      timestamp: new Date().toISOString(),
    };

    // Validate audit record before recording
    const parsed = AdapterAuditRecordSchema.safeParse(auditRecord);
    if (parsed.success) {
      this.auditRecorder.record(parsed.data);
    }
  }
}
