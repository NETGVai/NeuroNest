/**
 * Semantic Language Operations — Typed language-service operations without
 * granting a raw protocol escape channel.
 *
 * Exposes typed semantic operations (diagnostics, completions, hover, definition,
 * references, rename, code actions, formatting, signature help, document symbols)
 * through Language_Service_Authority. Does not expose raw LSP protocol access.
 *
 * Requirements: 23.7–23.8
 */

import type {
  SemanticOperationRequest,
  SemanticOperationResult,
  SemanticOperationKind,
} from './bounded-operations-schemas';
import { SemanticOperationRequestSchema } from './bounded-operations-schemas';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Language service authority port for executing typed semantic operations.
 * This is the only way to access language services — no raw protocol escape.
 */
export interface LanguageServiceAuthorityPort {
  /** Execute a typed semantic operation. */
  executeOperation(request: LanguageServiceRequest): Promise<LanguageServiceResponse>;
  /** Check if a language service is available for the given language. */
  isAvailable(language: string, workspaceId: string): Promise<boolean>;
  /** Cancel an in-progress operation. */
  cancel(requestId: string): Promise<void>;
}

export interface LanguageServiceRequest {
  requestId: string;
  kind: SemanticOperationKind;
  workspaceId: string;
  language: string;
  filePath: string;
  position?: { line: number; character: number };
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
  newName?: string;
}

export interface LanguageServiceResponse {
  status: 'completed' | 'unavailable' | 'timeout' | 'error';
  results: unknown[];
  errorMessage?: string;
}

/**
 * Security authority port for verifying language-service access.
 */
export interface LanguageOpsSecurityPort {
  /** Verify that language-service access is allowed in the execution world. */
  verifyLanguageAccess(
    executionWorldId: string,
    scope: Record<string, unknown>,
  ): Promise<boolean>;
}

export interface SemanticLanguageOpsDeps {
  languageService: LanguageServiceAuthorityPort;
  security: LanguageOpsSecurityPort;
}

// ─── Semantic Language Operations Service ───────────────────────

/**
 * SemanticLanguageOps provides typed language-service operations bound to
 * an Execution_World and Scope_Descriptor. It exposes only the typed semantic
 * operations enum and never grants raw protocol access.
 *
 * Requirement 23.7: Expose typed semantic operations without raw protocol escape.
 * Requirement 23.8: Reject cross-world access unless authorized transfer exists.
 */
export class SemanticLanguageOps {
  private readonly deps: SemanticLanguageOpsDeps;
  private readonly activeRequests: Map<string, AbortController> = new Map();

  constructor(deps: SemanticLanguageOpsDeps) {
    this.deps = deps;
  }

  /**
   * Execute a typed semantic language operation.
   * Returns a structured result — never exposes raw LSP frames.
   */
  async execute(request: SemanticOperationRequest): Promise<SemanticOperationResult> {
    // Validate request schema
    const validation = SemanticOperationRequestSchema.safeParse(request);
    if (!validation.success) {
      return {
        requestId: request.requestId,
        kind: request.kind,
        status: 'error',
        results: [],
        schemaVersion: 1,
      };
    }

    // Verify access through security authority
    const hasAccess = await this.deps.security.verifyLanguageAccess(
      request.executionWorldId,
      request.scope,
    );
    if (!hasAccess) {
      return {
        requestId: request.requestId,
        kind: request.kind,
        status: 'error',
        results: [],
        schemaVersion: 1,
      };
    }

    // Check if language service is available
    const available = await this.deps.languageService.isAvailable(
      request.language,
      request.workspaceId,
    );
    if (!available) {
      return {
        requestId: request.requestId,
        kind: request.kind,
        status: 'unavailable',
        results: [],
        schemaVersion: 1,
      };
    }

    // Validate operation-specific requirements
    const validationError = this.validateOperationRequirements(request);
    if (validationError) {
      return {
        requestId: request.requestId,
        kind: request.kind,
        status: 'error',
        results: [],
        schemaVersion: 1,
      };
    }

    // Track for cancellation
    const controller = new AbortController();
    this.activeRequests.set(request.requestId, controller);

    try {
      // Execute through the language service authority (typed, not raw)
      const response = await this.deps.languageService.executeOperation({
        requestId: request.requestId,
        kind: request.kind,
        workspaceId: request.workspaceId,
        language: request.language,
        filePath: request.filePath,
        ...(request.position !== undefined ? { position: request.position } : {}),
        ...(request.range !== undefined ? { range: request.range } : {}),
        ...(request.newName !== undefined ? { newName: request.newName } : {}),
      });

      return {
        requestId: request.requestId,
        kind: request.kind,
        status: response.status,
        results: response.results,
        schemaVersion: 1,
      };
    } finally {
      this.activeRequests.delete(request.requestId);
    }
  }

  /**
   * Cancel an in-progress language-service request.
   */
  async cancel(requestId: string): Promise<boolean> {
    const controller = this.activeRequests.get(requestId);
    if (!controller) return false;

    controller.abort();
    await this.deps.languageService.cancel(requestId);
    this.activeRequests.delete(requestId);
    return true;
  }

  /**
   * Cancel all active language-service requests (for owner teardown).
   * Returns the number of requests cancelled.
   */
  async cancelAll(): Promise<number> {
    const requestIds = [...this.activeRequests.keys()];
    for (const requestId of requestIds) {
      await this.cancel(requestId);
    }
    return requestIds.length;
  }

  /**
   * Get the number of currently active requests.
   */
  getActiveCount(): number {
    return this.activeRequests.size;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Validate operation-specific requirements (position/range needed, etc.)
   */
  private validateOperationRequirements(request: SemanticOperationRequest): string | null {
    switch (request.kind) {
      case 'completions':
      case 'hover':
      case 'definition':
      case 'references':
      case 'signature_help':
        if (!request.position) {
          return `${request.kind} requires a position`;
        }
        break;
      case 'rename':
        if (!request.position || !request.newName) {
          return 'rename requires position and newName';
        }
        break;
      case 'formatting':
        // Formatting can optionally take a range
        break;
      case 'code_actions':
        if (!request.range) {
          return 'code_actions requires a range';
        }
        break;
      case 'diagnostics':
      case 'document_symbols':
        // These only need filePath which is already validated
        break;
    }
    return null;
  }
}
