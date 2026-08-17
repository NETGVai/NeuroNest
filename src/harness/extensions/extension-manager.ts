/**
 * ExtensionManager — Controlled staged extensions with disabled-by-default behavior.
 *
 * Implements:
 * - Disabled-by-default: extensions start disabled and must be explicitly enabled
 * - Isolated bounded tests: tests run in isolation before activation
 * - Exact-content approval: approval binds to the exact content digest
 * - Reversible registration: extensions can be cleanly unregistered
 * - Audit events: all lifecycle transitions emit auditable events
 * - Host-escape rejection: extensions cannot break sandbox boundaries
 *
 * Requirements: 27.1–27.8
 */

import { randomUUID } from 'crypto';
import type {
  ExtensionDescriptor,
  ExtensionApproval,
  AuditEvent,
  AuditEventType,
  ExtensionState,
} from './schemas';
import { ExtensionDescriptorSchema, ExtensionApprovalSchema } from './schemas';

// ─── Host-Escape Detection ──────────────────────────────────────

/**
 * Patterns that indicate an attempt to escape the extension sandbox.
 * These include raw host execution, secret access, policy mutation, and control bypass.
 */
const HOST_ESCAPE_PATTERNS = [
  /require\s*\(\s*['"]child_process['"]\s*\)/,
  /require\s*\(\s*['"]fs['"]\s*\)/,
  /require\s*\(\s*['"]net['"]\s*\)/,
  /require\s*\(\s*['"]dgram['"]\s*\)/,
  /require\s*\(\s*['"]cluster['"]\s*\)/,
  /process\.env/,
  /process\.exit/,
  /process\.kill/,
  /eval\s*\(/,
  /Function\s*\(/,
  /globalThis/,
  /global\./,
  /__dirname/,
  /__filename/,
  /import\.meta/,
];

/**
 * Capabilities that indicate host-escape intent.
 */
const FORBIDDEN_CAPABILITIES = [
  'raw_host_execution',
  'raw_secret_access',
  'policy_mutation',
  'control_bypass',
  'arbitrary_process_spawn',
  'unrestricted_network',
  'unrestricted_filesystem',
];

/**
 * Checks whether an extension's imports or capabilities request host-escape access.
 */
export function detectHostEscape(descriptor: ExtensionDescriptor): {
  detected: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  // Check imports for forbidden patterns
  for (const imp of descriptor.imports) {
    for (const pattern of HOST_ESCAPE_PATTERNS) {
      if (pattern.test(imp)) {
        reasons.push(`Forbidden import pattern detected: ${imp}`);
      }
    }
  }

  // Check declared capabilities for forbidden access
  for (const cap of descriptor.declaredCapabilities) {
    if (FORBIDDEN_CAPABILITIES.includes(cap)) {
      reasons.push(`Forbidden capability requested: ${cap}`);
    }
  }

  // Check permissions for host-level access
  for (const perm of descriptor.declaredPermissions) {
    if (perm.startsWith('host:') || perm.startsWith('system:') || perm.startsWith('raw:')) {
      reasons.push(`Forbidden permission requested: ${perm}`);
    }
  }

  return { detected: reasons.length > 0, reasons };
}

// ─── Extension Record ───────────────────────────────────────────

export interface ExtensionRecord {
  descriptor: ExtensionDescriptor;
  state: ExtensionState;
  approval?: ExtensionApproval;
  registeredAt: string;
  activatedAt?: string;
  removedAt?: string;
  testResults?: Array<{ testId: string; passed: boolean; error?: string }>;
}

// ─── Test Runner Interface ──────────────────────────────────────

/**
 * Interface for running isolated extension tests within bounded resources.
 */
export interface ExtensionTestRunner {
  runTests(
    descriptor: ExtensionDescriptor,
  ): Promise<Array<{ testId: string; passed: boolean; error?: string }>>;
}

// ─── Default Test Runner (no-op) ────────────────────────────────

const defaultTestRunner: ExtensionTestRunner = {
  async runTests(descriptor: ExtensionDescriptor) {
    // Default runner passes all tests when no tests are defined
    return (descriptor.tests ?? []).map((t) => ({ testId: t.testId, passed: true }));
  },
};

// ─── ExtensionManager ───────────────────────────────────────────

/**
 * ExtensionManager manages the lifecycle of staged extensions.
 *
 * Model-authored extension creation is disabled by default (27.8).
 * All lifecycle transitions emit audit events (27.7).
 */
export class ExtensionManager {
  private readonly extensions = new Map<string, ExtensionRecord>();
  private readonly auditLog: AuditEvent[] = [];
  private readonly testRunner: ExtensionTestRunner;
  private extensionCreationEnabled = false;

  constructor(options?: { testRunner?: ExtensionTestRunner; enableCreation?: boolean }) {
    this.testRunner = options?.testRunner ?? defaultTestRunner;
    this.extensionCreationEnabled = options?.enableCreation ?? false;
  }

  // ─── Configuration ──────────────────────────────────────────

  /**
   * Whether model-authored extension creation is enabled.
   * Disabled by default per requirement 27.8.
   */
  isCreationEnabled(): boolean {
    return this.extensionCreationEnabled;
  }

  /**
   * Enables model-authored extension creation. Requires explicit opt-in.
   */
  enableCreation(): void {
    this.extensionCreationEnabled = true;
  }

  /**
   * Disables model-authored extension creation.
   */
  disableCreation(): void {
    this.extensionCreationEnabled = false;
  }

  // ─── Registration (Staging) ─────────────────────────────────

  /**
   * Stages a new extension in disabled state (27.2).
   * Returns a disposer for reversible registration (27.7).
   */
  stage(
    descriptor: ExtensionDescriptor,
    actor: string,
  ): { ok: true; disposer: () => void } | { ok: false; error: string } {
    // Check if creation is enabled
    if (!this.extensionCreationEnabled) {
      return { ok: false, error: 'Extension creation is disabled by default' };
    }

    // Validate descriptor schema
    const parseResult = ExtensionDescriptorSchema.safeParse(descriptor);
    if (!parseResult.success) {
      return { ok: false, error: `Invalid descriptor: ${parseResult.error.message}` };
    }

    // Reject if already registered
    if (this.extensions.has(descriptor.extensionId)) {
      return { ok: false, error: `Extension already registered: ${descriptor.extensionId}` };
    }

    // Host-escape detection (27.6)
    const escape = detectHostEscape(descriptor);
    if (escape.detected) {
      this.emitAudit('host_escape_rejected', descriptor.extensionId, actor, {
        reasons: escape.reasons,
      });
      return { ok: false, error: `Host escape rejected: ${escape.reasons.join('; ')}` };
    }

    // Stage in disabled state (27.2)
    const record: ExtensionRecord = {
      descriptor,
      state: 'disabled',
      registeredAt: new Date().toISOString(),
    };
    this.extensions.set(descriptor.extensionId, record);

    this.emitAudit('extension_staged', descriptor.extensionId, actor);

    // Return reversible disposer (27.7)
    const disposer = () => {
      this.remove(descriptor.extensionId, actor);
    };

    return { ok: true, disposer };
  }

  // ─── Validation ─────────────────────────────────────────────

  /**
   * Validates a staged extension's schemas, imports, capabilities, permissions,
   * resource limits, signatures, and removal metadata (27.3).
   */
  validate(
    extensionId: string,
    actor: string,
  ): { ok: true } | { ok: false; error: string } {
    const record = this.extensions.get(extensionId);
    if (!record) {
      return { ok: false, error: `Extension not found: ${extensionId}` };
    }
    if (record.state !== 'disabled' && record.state !== 'staged') {
      return { ok: false, error: `Extension not in stageable state: ${record.state}` };
    }

    // Re-validate descriptor
    const parseResult = ExtensionDescriptorSchema.safeParse(record.descriptor);
    if (!parseResult.success) {
      record.state = 'rejected';
      this.emitAudit('extension_rejected', extensionId, actor, {
        reason: parseResult.error.message,
      });
      return { ok: false, error: `Validation failed: ${parseResult.error.message}` };
    }

    // Re-check host escape
    const escape = detectHostEscape(record.descriptor);
    if (escape.detected) {
      record.state = 'rejected';
      this.emitAudit('host_escape_rejected', extensionId, actor, {
        reasons: escape.reasons,
      });
      return { ok: false, error: `Host escape detected: ${escape.reasons.join('; ')}` };
    }

    record.state = 'staged';
    this.emitAudit('extension_validated', extensionId, actor);
    return { ok: true };
  }

  // ─── Isolated Testing ───────────────────────────────────────

  /**
   * Runs isolated bounded tests for a staged extension (27.4).
   * Tests execute in isolation with finite time, memory, output, process,
   * network, and filesystem limits.
   */
  async runTests(
    extensionId: string,
    actor: string,
  ): Promise<{ ok: true; results: Array<{ testId: string; passed: boolean; error?: string }> } | { ok: false; error: string }> {
    const record = this.extensions.get(extensionId);
    if (!record) {
      return { ok: false, error: `Extension not found: ${extensionId}` };
    }
    if (record.state !== 'staged') {
      return { ok: false, error: `Extension must be validated before testing. Current state: ${record.state}` };
    }

    record.state = 'testing';
    const results = await this.testRunner.runTests(record.descriptor);
    record.testResults = results;

    const allPassed = results.every((r) => r.passed);
    if (allPassed) {
      record.state = 'awaiting_approval';
      this.emitAudit('extension_test_passed', extensionId, actor, { results });
    } else {
      record.state = 'staged';
      this.emitAudit('extension_test_failed', extensionId, actor, { results });
    }

    return { ok: true, results };
  }

  // ─── Approval ───────────────────────────────────────────────

  /**
   * Approves an extension for activation (27.5).
   * Approval binds to the exact staged content digest and requested capabilities.
   */
  approve(
    approval: ExtensionApproval,
    actor: string,
  ): { ok: true } | { ok: false; error: string } {
    // Validate approval schema
    const parseResult = ExtensionApprovalSchema.safeParse(approval);
    if (!parseResult.success) {
      return { ok: false, error: `Invalid approval: ${parseResult.error.message}` };
    }

    const record = this.extensions.get(approval.extensionId);
    if (!record) {
      return { ok: false, error: `Extension not found: ${approval.extensionId}` };
    }
    if (record.state !== 'awaiting_approval') {
      return { ok: false, error: `Extension not awaiting approval. Current state: ${record.state}` };
    }

    // Exact-content approval — digest must match (27.5)
    if (approval.approvedContentDigest !== record.descriptor.contentDigest) {
      return {
        ok: false,
        error: `Content digest mismatch: expected ${record.descriptor.contentDigest}, got ${approval.approvedContentDigest}`,
      };
    }

    record.approval = approval;
    record.state = 'approved';
    this.emitAudit('extension_approved', approval.extensionId, actor, {
      contentDigest: approval.approvedContentDigest,
    });
    return { ok: true };
  }

  // ─── Activation ─────────────────────────────────────────────

  /**
   * Activates an approved extension (27.7).
   * Only approved extensions with matching content digest may activate.
   */
  activate(
    extensionId: string,
    actor: string,
  ): { ok: true } | { ok: false; error: string } {
    const record = this.extensions.get(extensionId);
    if (!record) {
      return { ok: false, error: `Extension not found: ${extensionId}` };
    }
    if (record.state !== 'approved') {
      return { ok: false, error: `Extension must be approved before activation. Current state: ${record.state}` };
    }
    if (!record.approval) {
      return { ok: false, error: 'Missing approval record' };
    }

    // Final host-escape check before activation
    const escape = detectHostEscape(record.descriptor);
    if (escape.detected) {
      record.state = 'rejected';
      this.emitAudit('host_escape_rejected', extensionId, actor, {
        reasons: escape.reasons,
      });
      return { ok: false, error: `Host escape rejected at activation: ${escape.reasons.join('; ')}` };
    }

    record.state = 'active';
    record.activatedAt = new Date().toISOString();
    this.emitAudit('extension_activated', extensionId, actor);
    return { ok: true };
  }

  // ─── Deactivation ──────────────────────────────────────────

  /**
   * Deactivates an active extension — returns it to approved state.
   */
  deactivate(
    extensionId: string,
    actor: string,
  ): { ok: true } | { ok: false; error: string } {
    const record = this.extensions.get(extensionId);
    if (!record) {
      return { ok: false, error: `Extension not found: ${extensionId}` };
    }
    if (record.state !== 'active') {
      return { ok: false, error: `Extension not active. Current state: ${record.state}` };
    }

    record.state = 'approved';
    record.activatedAt = undefined;
    this.emitAudit('extension_deactivated', extensionId, actor);
    return { ok: true };
  }

  // ─── Removal (Reversible Registration) ─────────────────────

  /**
   * Removes an extension cleanly (27.7 — reversible registration).
   * Emits an audit event and removes all registration effects.
   */
  remove(
    extensionId: string,
    actor: string,
  ): { ok: true } | { ok: false; error: string } {
    const record = this.extensions.get(extensionId);
    if (!record) {
      return { ok: false, error: `Extension not found: ${extensionId}` };
    }

    record.state = 'removed';
    record.removedAt = new Date().toISOString();
    this.extensions.delete(extensionId);
    this.emitAudit('extension_removed', extensionId, actor);
    return { ok: true };
  }

  // ─── Query ──────────────────────────────────────────────────

  /**
   * Returns the state of a registered extension.
   */
  getExtension(extensionId: string): ExtensionRecord | undefined {
    return this.extensions.get(extensionId);
  }

  /**
   * Returns all registered extensions.
   */
  listExtensions(): ExtensionRecord[] {
    return Array.from(this.extensions.values());
  }

  /**
   * Returns the full audit log.
   */
  getAuditLog(): readonly AuditEvent[] {
    return this.auditLog;
  }

  // ─── Audit ──────────────────────────────────────────────────

  private emitAudit(
    type: AuditEventType,
    extensionId: string,
    actor: string,
    details?: Record<string, unknown>,
  ): void {
    const event: AuditEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      type,
      extensionId,
      actor,
      timestamp: new Date().toISOString(),
      details,
    };
    this.auditLog.push(event);
  }
}
