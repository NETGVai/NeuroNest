/**
 * Extension Port Types — Canonical type definitions for authority extension ports.
 *
 * Extension ports allow new harness operations to route through existing NeuroNest
 * authorities without bypassing their ownership boundaries. Each port is typed,
 * registered against an owning authority, and protected by bypass detection.
 *
 * Requirements: 1.1–1.6, 25.4, 35.12, 39.13, 43.3
 */

// ─── Authority Kinds ────────────────────────────────────────────

/**
 * The closed set of recognized NeuroNest authorities.
 * No parallel replacement authority may be introduced for any of these domains.
 */
export type AuthorityKind =
  | 'mcp_server_manager'
  | 'provider_registry'
  | 'session_store'
  | 'plugin_registry'
  | 'orchestration_engine'
  | 'skill_catalog'
  | 'security_authority'
  | 'filesystem_authority'
  | 'process_authority'
  | 'terminal_authority'
  | 'language_service_authority'
  | 'tool_system';

/**
 * Human-readable labels for authorities used in diagnostics.
 */
export const AUTHORITY_LABELS: Readonly<Record<AuthorityKind, string>> = {
  mcp_server_manager: 'MCP_Server_Manager',
  provider_registry: 'Provider_Registry',
  session_store: 'Session_Store',
  plugin_registry: 'Plugin_Registry',
  orchestration_engine: 'Orchestration_Engine',
  skill_catalog: 'Skill_Catalog',
  security_authority: 'Security_Authority',
  filesystem_authority: 'Filesystem_Authority',
  process_authority: 'Process_Authority',
  terminal_authority: 'Terminal_Authority',
  language_service_authority: 'Language_Service_Authority',
  tool_system: 'Tool_System',
};

// ─── Extension Port Contracts ───────────────────────────────────

/**
 * Unique identifier for a registered extension port.
 */
export interface ExtensionPortId {
  /** The authority that owns and routes operations for this port */
  authority: AuthorityKind;
  /** A unique name within that authority's namespace */
  name: string;
  /** Version of the port contract */
  version: string;
}

/**
 * Metadata about an extension port registration.
 */
export interface ExtensionPortRegistration {
  id: ExtensionPortId;
  /** Timestamp of registration */
  registeredAt: number;
  /** Whether this port is currently active */
  active: boolean;
  /** Description of the port's purpose */
  description: string;
}

/**
 * The result of an extension port operation — success or authority-routed error.
 */
export type ExtensionPortResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AuthorityDenial };

/**
 * A redacted structured diagnostic returned when an authority denies an operation.
 * No internal details (stack traces, internal paths, secrets) are exposed.
 */
export interface AuthorityDenial {
  /** Which authority denied the operation */
  authority: AuthorityKind;
  /** The port that was being accessed, if resolved */
  portName?: string;
  /** Redacted denial code — safe to surface to external consumers */
  code: DenialCode;
  /** Human-readable redacted message — no internal details */
  message: string;
  /** Timestamp of the denial */
  timestamp: number;
  /** Correlation ID for internal audit (opaque to external consumers) */
  correlationId: string;
}

/**
 * Denial codes for authority bypass or invalid access attempts.
 */
export type DenialCode =
  | 'AUTHORITY_BYPASS_REJECTED'
  | 'PORT_NOT_REGISTERED'
  | 'PORT_INACTIVE'
  | 'AUTHORITY_MISMATCH'
  | 'PARALLEL_AUTHORITY_DETECTED'
  | 'OPERATION_DENIED';

// ─── Extension Port Interface ───────────────────────────────────

/**
 * Contract that every extension port adapter must implement.
 * Operations are dispatched through the owning authority — never directly.
 */
export interface ExtensionPort<TInput, TOutput> {
  /** Port identity and ownership */
  readonly id: ExtensionPortId;

  /**
   * Execute an operation through the owning authority.
   * The authority validates, routes, and observes the operation.
   */
  execute(input: TInput): Promise<ExtensionPortResult<TOutput>>;

  /**
   * Check whether this port is healthy and routable.
   */
  isHealthy(): boolean;
}

/**
 * A factory that creates extension port adapters bound to their owning authority.
 */
export interface ExtensionPortFactory<TInput, TOutput> {
  portId: ExtensionPortId;
  create(authority: unknown): ExtensionPort<TInput, TOutput>;
}
