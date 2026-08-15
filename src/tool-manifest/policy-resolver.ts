/**
 * PolicyResolver — Most-restrictive policy resolution across all layers.
 *
 * When global, project, agent, Task, and run policies overlap, the most restrictive
 * combination is applied. Each layer can only restrict further, never loosen.
 *
 * Policy layers: global -> project -> agent -> task -> run
 *
 * Resolution rules:
 * - Boolean fields: if ANY layer denies, result is deny (AND logic)
 * - Numeric fields: smallest value wins (most restrictive)
 * - Risk levels: lowest risk level wins (most restrictive)
 * - Denied tools: union of all denied tools
 * - Allowed tools: intersection of all allowed-tool lists (most restrictive)
 *
 * Requirements: 36.2, 36.3, 36.5, 37.3, 37.5
 */

import type {
  ToolPolicy,
  PolicyStack,
  ResolvedPolicy,
  ToolRiskLevel,
} from './types.js';

// ─── Risk Level Ordering ────────────────────────────────────────

const RISK_LEVEL_ORDER: Record<ToolRiskLevel, number> = {
  'read-only': 0,
  'write': 1,
  'execute': 2,
  'destructive': 3,
};

const RISK_LEVELS_BY_ORDER: ToolRiskLevel[] = [
  'read-only',
  'write',
  'execute',
  'destructive',
];

// ─── Default Policy (fully permissive) ──────────────────────────

const DEFAULT_RESOLVED_POLICY: ResolvedPolicy = {
  networkAllowed: true,
  secretAccessAllowed: true,
  maxRiskLevel: 'destructive',
  maxOutputBoundsBytes: Infinity,
  destructiveAllowed: true,
  deniedTools: new Set(),
  allowedTools: null,
};

// ─── PolicyResolver ─────────────────────────────────────────────

export class PolicyResolver {
  /**
   * Resolve a stack of policies into a single most-restrictive policy.
   *
   * The layers are applied in order: global -> project -> agent -> task -> run.
   * Each successive layer can only make things MORE restrictive.
   */
  resolve(stack: PolicyStack): ResolvedPolicy {
    const layers: (ToolPolicy | undefined)[] = [
      stack.global,
      stack.project,
      stack.agent,
      stack.task,
      stack.run,
    ];

    const activeLayers = layers.filter(
      (layer): layer is ToolPolicy => layer !== undefined,
    );

    if (activeLayers.length === 0) {
      return { ...DEFAULT_RESOLVED_POLICY, deniedTools: new Set(), allowedTools: null };
    }

    let networkAllowed = true;
    let secretAccessAllowed = true;
    let maxRiskLevel: ToolRiskLevel = 'destructive';
    let maxOutputBoundsBytes = Infinity;
    let destructiveAllowed = true;
    const deniedTools = new Set<string>();
    let allowedTools: Set<string> | null = null;

    for (const layer of activeLayers) {
      // Boolean restrictions: if any layer denies, result is deny
      if (layer.networkAllowed === false) {
        networkAllowed = false;
      }
      if (layer.secretAccessAllowed === false) {
        secretAccessAllowed = false;
      }
      if (layer.destructiveAllowed === false) {
        destructiveAllowed = false;
      }

      // Risk level: take the lowest (most restrictive)
      if (layer.maxRiskLevel !== undefined) {
        const layerOrder = RISK_LEVEL_ORDER[layer.maxRiskLevel];
        const currentOrder = RISK_LEVEL_ORDER[maxRiskLevel];
        if (layerOrder < currentOrder) {
          maxRiskLevel = layer.maxRiskLevel;
        }
      }

      // Output bounds: take the smallest (most restrictive)
      if (layer.maxOutputBoundsBytes !== undefined) {
        if (layer.maxOutputBoundsBytes < maxOutputBoundsBytes) {
          maxOutputBoundsBytes = layer.maxOutputBoundsBytes;
        }
      }

      // Denied tools: union of all denied tool sets
      if (layer.deniedTools) {
        for (const tool of layer.deniedTools) {
          deniedTools.add(tool);
        }
      }

      // Allowed tools: intersection (most restrictive)
      if (layer.allowedTools !== undefined) {
        const layerAllowed = new Set(layer.allowedTools);
        if (allowedTools === null) {
          // First allowlist encountered — adopt it
          allowedTools = layerAllowed;
        } else {
          // Intersect with existing allowlist
          const intersection = new Set<string>();
          for (const tool of allowedTools) {
            if (layerAllowed.has(tool)) {
              intersection.add(tool);
            }
          }
          allowedTools = intersection;
        }
      }
    }

    return {
      networkAllowed,
      secretAccessAllowed,
      maxRiskLevel,
      maxOutputBoundsBytes,
      destructiveAllowed,
      deniedTools,
      allowedTools,
    };
  }

  /**
   * Check if a tool is allowed under the resolved policy.
   */
  isToolAllowed(toolName: string, toolRiskLevel: ToolRiskLevel, resolvedPolicy: ResolvedPolicy): { allowed: boolean; reason?: string } {
    // Check denied tools
    if (resolvedPolicy.deniedTools.has(toolName)) {
      return { allowed: false, reason: `Tool '${toolName}' is explicitly denied by policy` };
    }

    // Check allowlist (if present, tool must be in it)
    if (resolvedPolicy.allowedTools !== null && !resolvedPolicy.allowedTools.has(toolName)) {
      return { allowed: false, reason: `Tool '${toolName}' is not in the allowed tools list` };
    }

    // Check risk level
    const toolOrder = RISK_LEVEL_ORDER[toolRiskLevel];
    const maxOrder = RISK_LEVEL_ORDER[resolvedPolicy.maxRiskLevel];
    if (toolOrder > maxOrder) {
      return {
        allowed: false,
        reason: `Tool risk level '${toolRiskLevel}' exceeds maximum allowed '${resolvedPolicy.maxRiskLevel}'`,
      };
    }

    // Check destructive
    if (toolRiskLevel === 'destructive' && !resolvedPolicy.destructiveAllowed) {
      return { allowed: false, reason: 'Destructive operations are not allowed by policy' };
    }

    return { allowed: true };
  }

  /**
   * Get the numeric order of a risk level (useful for comparisons).
   */
  getRiskLevelOrder(level: ToolRiskLevel): number {
    return RISK_LEVEL_ORDER[level];
  }
}
