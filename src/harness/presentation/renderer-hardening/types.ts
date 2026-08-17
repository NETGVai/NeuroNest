/**
 * Types for Renderer Hardening
 *
 * Defines contracts for content sanitization, preview isolation,
 * script/event-handler prohibition, authorization port routing,
 * and canary-safe labeling for renderer adapters.
 *
 * Requirements: 9.9, 21.6, 24.2–24.8, 29.2, 37.9–37.11, 41.3, 41.11, 45.10
 */

// ─── Action Kinds ───────────────────────────────────────────────

/**
 * Actions that renderer adapters must route through authorization ports.
 */
export type AuthorizedActionKind =
  | 'file_open'
  | 'file_download'
  | 'web_fetch'
  | 'web_navigate'
  | 'attachment_retrieve'
  | 'attachment_download'
  | 'spill_retrieve';

/**
 * Authorization decision from the owning authority.
 */
export type AuthorizationDecision =
  | { authorized: true; reason?: string }
  | { authorized: false; code: AuthorizationDenialCode; reason: string };

export type AuthorizationDenialCode =
  | 'SCOPE_VIOLATION'
  | 'POLICY_DENIED'
  | 'RESOURCE_UNAVAILABLE'
  | 'EXPIRED'
  | 'UNAUTHORIZED_LOCATOR';

// ─── Authorization Request ──────────────────────────────────────

/**
 * A request to authorize a renderer action through the owning authority.
 */
export interface AuthorizationRequest {
  /** The kind of action being requested. */
  action: AuthorizedActionKind;
  /** The target resource identifier (sanitized before dispatch). */
  target: string;
  /** Scope descriptor for the request. */
  scopeId: string;
  /** Session identity. */
  sessionId: string;
  /** Correlation identity from the source event. */
  correlationId: string;
}

/**
 * Result of an authorization check.
 */
export interface AuthorizationResult {
  decision: AuthorizationDecision;
  /** The action that was checked. */
  action: AuthorizedActionKind;
  /** Redacted target safe for diagnostics (no private paths or secrets). */
  redactedTarget: string;
  /** Timestamp of the decision. */
  timestamp: number;
}

// ─── Content Isolation ──────────────────────────────────────────

/**
 * Isolation level for rendering untrusted previews.
 */
export type IsolationLevel =
  | 'none'
  | 'sandbox_iframe'
  | 'blob_isolation'
  | 'text_only';

/**
 * Result of determining isolation requirements for content.
 */
export interface IsolationAssessment {
  /** Required isolation level. */
  level: IsolationLevel;
  /** Why this level was selected. */
  reason: string;
  /** Sandbox attribute flags (for iframe isolation). */
  sandboxFlags?: string[];
  /** Content Security Policy directives to apply. */
  cspDirectives?: string[];
}

// ─── Sanitization Severity ──────────────────────────────────────

export type SanitizationSeverity = 'info' | 'warning' | 'critical';

/**
 * A sanitization finding with details about what was removed/replaced.
 */
export interface SanitizationFinding {
  severity: SanitizationSeverity;
  category: string;
  /** Redacted description (no secrets, private paths, or locators). */
  description: string;
  /** Approximate character offset of the finding. */
  offset?: number;
}

// ─── Hardened Output ────────────────────────────────────────────

/**
 * Output from the renderer hardening pipeline.
 * Contains sanitized content plus diagnostics and authorization state.
 */
export interface HardenedOutput {
  /** Sanitized content safe for rendering. */
  content: string;
  /** Whether content was modified during hardening. */
  modified: boolean;
  /** Isolation assessment for this content. */
  isolation: IsolationAssessment;
  /** Findings from the hardening pass. */
  findings: SanitizationFinding[];
  /** Canary-safe label suitable for display (no secrets/paths/locators). */
  safeLabel: string;
  /** Canary-safe diagnostics suitable for export. */
  safeDiagnostics: Record<string, string>;
}

// ─── Canary Labels ──────────────────────────────────────────────

/**
 * A label that has been verified to not contain canary patterns
 * (secrets, private paths, private locators).
 */
export interface CanarySafeLabel {
  /** The verified safe label text. */
  text: string;
  /** Whether the original label was modified to be canary-safe. */
  wasRedacted: boolean;
  /** Categories of content that were redacted. */
  redactedCategories: string[];
}

// ─── Authorization Port Interface ───────────────────────────────

/**
 * Port through which renderer adapters route file, web, attachment,
 * and spill actions for authorization by the owning authority.
 *
 * Implementations must:
 * - Never bypass authority boundaries
 * - Return canary-safe labels in denial reasons
 * - Not expose private paths or locators in results
 */
export interface RendererAuthorizationPort {
  /**
   * Check whether an action is authorized.
   * Returns a structured decision without exposing internal state.
   */
  authorize(request: AuthorizationRequest): Promise<AuthorizationResult>;

  /**
   * Check port health.
   */
  isHealthy(): boolean;
}
