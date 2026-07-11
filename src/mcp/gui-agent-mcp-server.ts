/**
 * GUI Agent MCP Server — External Browser MCP registration for multi-page
 * verification scenarios the embedded preview cannot cover.
 *
 * Registers the GUI Agent's MCP server via MCPServerManager using the standard
 * MCPServerConfig schema. Routes multi-page/OAuth/multi-tab scenarios through
 * the External_Browser_MCP path with all browser actions validated through
 * the Action Security Analyzer.
 *
 * Requirements: 24.1, 24.2, 24.3, 24.4
 */

import type { MCPServerConfig, MCPToolResult } from './types/mcp-types.js';
import type { MCPServerManager, FirewallEngineLike } from './mcp-server-manager.js';
import { EnsembleSecurityAnalyzer, classifyAction } from '../security/action-analyzer.js';
import type { SecurityGate } from '../security/security-gate.js';
import { PERF_FLAGS } from '../main/performance/feature-flags.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Scenario types that require the External Browser MCP path.
 * These cannot be verified by the embedded in-page preview alone.
 */
export type ExternalBrowserScenario =
  | 'multi-page-navigation'
  | 'oauth-redirect'
  | 'multi-tab-interaction';

/**
 * A browser action to be validated before execution.
 */
export interface BrowserAction {
  /** Human-readable description of the action */
  description: string;
  /** The URL or target of the action */
  target: string;
  /** Type of browser operation */
  type: 'navigate' | 'click' | 'input' | 'wait' | 'evaluate' | 'tab-switch';
  /** Optional action payload (form data, script content, etc.) */
  payload?: string;
}

/**
 * Result of validating a browser action through the Action Security Analyzer.
 */
export interface BrowserActionValidationResult {
  /** Whether the action is allowed to proceed */
  allowed: boolean;
  /** Risk level assigned by the security analyzer */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Reason for blocking (if not allowed) */
  reason?: string;
}

// ─── Constants ──────────────────────────────────────────────────

/** Server ID for the External Browser MCP registration. */
export const EXTERNAL_BROWSER_MCP_SERVER_ID = 'external-browser-mcp';

/** Server name displayed in the MCP settings panel. */
export const EXTERNAL_BROWSER_MCP_SERVER_NAME = 'External Browser (GUI Agent)';

/**
 * The MCPServerConfig for the External Browser MCP server.
 * Uses stdio transport with authType: 'none' consistent with other
 * local MCP server registrations (Requirement 24.4).
 */
export const EXTERNAL_BROWSER_MCP_CONFIG: MCPServerConfig = {
  id: EXTERNAL_BROWSER_MCP_SERVER_ID,
  name: EXTERNAL_BROWSER_MCP_SERVER_NAME,
  url: 'stdio://gui-agent-mcp-server',
  authType: 'none',
};

// ─── Scenario Detection ─────────────────────────────────────────

/**
 * Determine whether a GUI acceptance criterion requires the External Browser
 * MCP path based on the criterion description (Requirement 24.2).
 *
 * Returns the detected scenario type, or null if the criterion can be
 * handled by the embedded in-page preview.
 */
export function detectExternalBrowserScenario(
  criterionDescription: string,
): ExternalBrowserScenario | null {
  const lower = criterionDescription.toLowerCase();

  // Multi-page navigation: involves navigating between distinct pages/routes
  if (
    /multi[- ]?page/i.test(lower) ||
    /navigate\s+(to|between)\s+(multiple|different)\s+page/i.test(lower) ||
    /cross[- ]?page/i.test(lower)
  ) {
    return 'multi-page-navigation';
  }

  // OAuth redirect flows: involves OAuth, SSO, or redirect-based auth
  if (
    /oauth/i.test(lower) ||
    /redirect.*auth/i.test(lower) ||
    /auth.*redirect/i.test(lower) ||
    /sso\s+(flow|redirect|login)/i.test(lower) ||
    /login\s+redirect/i.test(lower)
  ) {
    return 'oauth-redirect';
  }

  // Multi-tab interactions: involves switching between browser tabs
  if (
    /multi[- ]?tab/i.test(lower) ||
    /new\s+tab/i.test(lower) ||
    /tab\s+(switch|open|close)/i.test(lower) ||
    /popup\s+window/i.test(lower)
  ) {
    return 'multi-tab-interaction';
  }

  return null;
}

// ─── Action Security Validation ─────────────────────────────────

/**
 * Validate a browser action through the Action Security Analyzer
 * before execution (Requirement 24.3).
 *
 * All browser actions must pass security validation. Actions classified
 * as HIGH risk are blocked outright.
 */
export async function validateBrowserAction(
  action: BrowserAction,
  securityGate: SecurityGate,
): Promise<BrowserActionValidationResult> {
  // Build a string representation of the action for security classification
  const actionString = buildActionString(action);

  const classification = await securityGate.classify(actionString);

  // Block high-risk actions
  if (classification.level === 'high' || classification.level === 'critical') {
    return {
      allowed: false,
      riskLevel: classification.level,
      reason: classification.reason,
    };
  }

  return {
    allowed: true,
    riskLevel: classification.level,
  };
}

/**
 * Build a string representation of a browser action suitable for
 * security analysis.
 */
function buildActionString(action: BrowserAction): string {
  const parts = [`browser:${action.type}`, action.target];
  if (action.payload) {
    parts.push(action.payload);
  }
  return parts.join(' ');
}

// ─── MCP Server Registration ────────────────────────────────────

/**
 * Register the External Browser MCP server with the MCPServerManager.
 *
 * Gated behind the `external_browser_mcp` feature flag (design doc).
 * Uses the standard MCPServerConfig schema and addServer() path
 * consistent with other MCP registrations (Requirement 24.1, 24.4).
 *
 * @param manager - The MCPServerManager instance
 * @returns true if registration succeeded, false if skipped (flag off)
 */
export function registerExternalBrowserMCPServer(
  manager: MCPServerManager,
): boolean {
  if (!PERF_FLAGS.EXTERNAL_BROWSER_MCP) {
    logger.info('[MCP] External Browser MCP registration skipped — feature flag off');
    return false;
  }

  try {
    manager.addServer(EXTERNAL_BROWSER_MCP_CONFIG);
    logger.info('[MCP] External Browser MCP server registered', {
      serverId: EXTERNAL_BROWSER_MCP_CONFIG.id,
      serverName: EXTERNAL_BROWSER_MCP_CONFIG.name,
    });
    return true;
  } catch (err) {
    logger.warn('[MCP] Failed to register External Browser MCP server:', err);
    return false;
  }
}

// ─── Routing ────────────────────────────────────────────────────

/**
 * Determine whether a set of GUI acceptance criteria should route
 * through the External Browser MCP path (Requirement 24.2).
 *
 * Returns the criteria that require external browser verification,
 * along with their detected scenario types.
 */
export function routeThroughExternalBrowserMCP(
  criteria: Array<{ id: string; description: string }>,
): Array<{ id: string; description: string; scenario: ExternalBrowserScenario }> {
  const externalCriteria: Array<{
    id: string;
    description: string;
    scenario: ExternalBrowserScenario;
  }> = [];

  for (const criterion of criteria) {
    const scenario = detectExternalBrowserScenario(criterion.description);
    if (scenario !== null) {
      externalCriteria.push({
        id: criterion.id,
        description: criterion.description,
        scenario,
      });
    }
  }

  return externalCriteria;
}

/**
 * Execute a browser action through the External Browser MCP path.
 *
 * Validates the action through Action Security Analyzer before execution
 * (Requirement 24.3). Requires the External Browser MCP server to be
 * registered and connected.
 *
 * @param action - The browser action to execute
 * @param manager - The MCPServerManager instance
 * @param securityGate - The Action Security Analyzer gate
 * @returns The tool result from the MCP server, or a rejection if validation fails
 */
export async function executeBrowserAction(
  action: BrowserAction,
  manager: MCPServerManager,
  securityGate: SecurityGate,
): Promise<MCPToolResult> {
  // Validate through Action Security Analyzer (Requirement 24.3)
  const validation = await validateBrowserAction(action, securityGate);

  if (!validation.allowed) {
    return {
      success: false,
      output: null,
      error: `Browser action blocked by Action Security Analyzer: ${validation.reason ?? 'high risk'}`,
    };
  }

  // Route through the External Browser MCP server
  const toolName = `external-browser.${action.type}`;
  const args: Record<string, unknown> = {
    target: action.target,
    description: action.description,
    ...(action.payload ? { payload: action.payload } : {}),
  };

  return manager.invokeTool(toolName, args);
}
