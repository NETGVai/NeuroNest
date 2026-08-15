/**
 * ToolManifest types — Versioned manifest contracts for built-in, plugin, and MCP tools.
 *
 * Every tool must be normalized into a ToolManifest before enablement.
 * The manifest declares identity, schema, risk, network policy, secret access,
 * output bounds, and cancellation support.
 *
 * Requirements: 36.1, 36.2, 36.3, 36.5, 36.6, 36.7, 37.1, 37.2, 37.3, 37.4, 37.5, 37.6, 37.7, 37.8, 37.9, 37.10
 */

// ─── Risk Levels ────────────────────────────────────────────────

export type ToolRiskLevel = 'read-only' | 'write' | 'execute' | 'destructive';

// ─── Network Policy ─────────────────────────────────────────────

export type NetworkPolicy = 'none' | 'local-only' | 'allowlist' | 'unrestricted';

// ─── Tool Source ────────────────────────────────────────────────

export type ToolSource = 'built-in' | 'plugin' | 'mcp';

// ─── Tool Manifest ──────────────────────────────────────────────

export interface ToolManifest {
  /** Stable tool identity */
  name: string;
  /** Semantic version */
  version: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for tool input */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for tool output (optional, for validation) */
  outputSchema?: Record<string, unknown>;
  /** Classification of tool risk */
  riskLevel: ToolRiskLevel;
  /** Network access requirements */
  networkPolicy: NetworkPolicy;
  /** List of allowed network destinations (used when networkPolicy is 'allowlist') */
  networkAllowlist?: string[];
  /** Secrets this tool declares it needs access to */
  secretAccess: string[];
  /** Maximum output size in bytes */
  outputBoundsBytes: number;
  /** Whether the tool supports cancellation */
  cancellationSupport: boolean;
  /** Origin of the tool */
  source: ToolSource;
  /** Optional timeout in milliseconds */
  timeoutMs?: number;
  /** Heartbeat interval in milliseconds (for long-running tools) */
  heartbeatIntervalMs?: number;
}

// ─── Policy Layers ──────────────────────────────────────────────

/**
 * A policy layer controls what is allowed or denied.
 * Each field is optional — if absent, the layer does not restrict that dimension.
 * `true` means allow; `false` means deny.
 */
export interface ToolPolicy {
  /** Whether network access is allowed */
  networkAllowed?: boolean;
  /** Whether secret access is allowed */
  secretAccessAllowed?: boolean;
  /** Maximum risk level allowed: tools above this are denied */
  maxRiskLevel?: ToolRiskLevel;
  /** Maximum output bounds in bytes (restrictive = smaller) */
  maxOutputBoundsBytes?: number;
  /** Whether destructive operations are allowed */
  destructiveAllowed?: boolean;
  /** Specific tool names that are denied */
  deniedTools?: string[];
  /** Specific tool names that are allowed (allowlist mode) */
  allowedTools?: string[];
}

/**
 * The five policy layers in precedence order.
 * Each layer can only restrict further, never loosen.
 */
export interface PolicyStack {
  global?: ToolPolicy;
  project?: ToolPolicy;
  agent?: ToolPolicy;
  task?: ToolPolicy;
  run?: ToolPolicy;
}

/**
 * The resolved policy after applying most-restrictive combination.
 */
export interface ResolvedPolicy {
  networkAllowed: boolean;
  secretAccessAllowed: boolean;
  maxRiskLevel: ToolRiskLevel;
  maxOutputBoundsBytes: number;
  destructiveAllowed: boolean;
  deniedTools: Set<string>;
  allowedTools: Set<string> | null; // null means no allowlist filter (all allowed)
}

// ─── Manifest Registration Result ───────────────────────────────

export interface ManifestRegistrationResult {
  success: boolean;
  errors: string[];
}

// ─── Tool Invocation Request ────────────────────────────────────

export interface ToolInvocationRequest {
  toolName: string;
  input: unknown;
  context: {
    workspaceId: string;
    agentId?: string;
    taskId?: string;
    runId?: string;
    sessionId?: string;
  };
}

// ─── Tool Invocation Result ─────────────────────────────────────

export interface ToolInvocationResult {
  success: boolean;
  output?: unknown;
  error?: string;
  denied?: boolean;
  reason?: string;
}
