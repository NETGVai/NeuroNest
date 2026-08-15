/**
 * LegacyCutoverGate — Feature gate that disables direct-execution paths.
 *
 * When the gate is active, all tool invocations MUST pass through the manifest-validated
 * pipeline. Legacy direct-execution paths are disabled.
 *
 * When the gate is inactive, legacy paths still work (backward compatibility during migration).
 *
 * Requirements: 36.1, 36.7, 37.9, 37.10
 */

import type { ToolManifest, ToolInvocationRequest, ToolInvocationResult, PolicyStack } from './types.js';
import { ToolManifestService } from './tool-manifest-service.js';

// ─── Gate State ─────────────────────────────────────────────────

export type CutoverGateState = 'active' | 'inactive';

// ─── Execution Handler ──────────────────────────────────────────

export type ToolExecutionHandler = (
  toolName: string,
  input: unknown,
  context: Record<string, unknown>,
) => Promise<ToolInvocationResult>;

// ─── LegacyCutoverGate ──────────────────────────────────────────

export class LegacyCutoverGate {
  private state: CutoverGateState;
  private manifestService: ToolManifestService;
  private legacyHandler: ToolExecutionHandler | null = null;
  private manifestHandler: ToolExecutionHandler | null = null;

  constructor(
    manifestService: ToolManifestService,
    initialState: CutoverGateState = 'inactive',
  ) {
    this.manifestService = manifestService;
    this.state = initialState;
  }

  /**
   * Get the current gate state.
   */
  getState(): CutoverGateState {
    return this.state;
  }

  /**
   * Activate the gate — disables legacy direct-execution paths.
   * All invocations must pass through manifest-validated pipeline.
   */
  activate(): void {
    this.state = 'active';
  }

  /**
   * Deactivate the gate — re-enables legacy direct-execution paths.
   * For backward compatibility during migration.
   */
  deactivate(): void {
    this.state = 'inactive';
  }

  /**
   * Register the legacy execution handler (direct execution path).
   */
  setLegacyHandler(handler: ToolExecutionHandler): void {
    this.legacyHandler = handler;
  }

  /**
   * Register the manifest-validated execution handler.
   */
  setManifestHandler(handler: ToolExecutionHandler): void {
    this.manifestHandler = handler;
  }

  /**
   * Execute a tool through the gate.
   *
   * When active: only manifest-validated pipeline is used, legacy paths are blocked.
   * When inactive: legacy paths work, manifest pipeline also works.
   */
  async execute(
    request: ToolInvocationRequest,
    policyStack: PolicyStack,
    options?: { preferLegacy?: boolean },
  ): Promise<ToolInvocationResult> {
    const useManifestPath = this.state === 'active' || !options?.preferLegacy;

    if (this.state === 'active') {
      // Gate is active: MUST use manifest-validated pipeline
      return this.executeViaManifest(request, policyStack);
    }

    // Gate is inactive: both paths available
    if (options?.preferLegacy && this.legacyHandler) {
      return this.executeViaLegacy(request);
    }

    // Default to manifest path if available, fallback to legacy
    if (this.manifestHandler) {
      return this.executeViaManifest(request, policyStack);
    }

    if (this.legacyHandler) {
      return this.executeViaLegacy(request);
    }

    return {
      success: false,
      error: 'No execution handler available',
    };
  }

  /**
   * Check if direct (legacy) execution is currently available.
   */
  isLegacyExecutionAvailable(): boolean {
    return this.state === 'inactive' && this.legacyHandler !== null;
  }

  /**
   * Check if manifest-validated execution is available for a tool.
   */
  isManifestExecutionAvailable(toolName: string): boolean {
    return this.manifestService.getLatest(toolName) !== undefined;
  }

  // ─── Private Execution Paths ──────────────────────────────────

  private async executeViaManifest(
    request: ToolInvocationRequest,
    policyStack: PolicyStack,
  ): Promise<ToolInvocationResult> {
    // Validate through manifest service first
    const validationResult = this.manifestService.validateInvocation(request, policyStack);
    if (!validationResult.success) {
      return validationResult;
    }

    if (!this.manifestHandler) {
      return {
        success: false,
        error: 'Manifest execution handler not configured',
      };
    }

    return this.manifestHandler(request.toolName, request.input, request.context);
  }

  private async executeViaLegacy(
    request: ToolInvocationRequest,
  ): Promise<ToolInvocationResult> {
    if (!this.legacyHandler) {
      return {
        success: false,
        error: 'Legacy execution handler not configured',
      };
    }

    return this.legacyHandler(request.toolName, request.input, request.context);
  }
}
