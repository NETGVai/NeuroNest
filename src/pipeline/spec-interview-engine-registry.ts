/**
 * Spec Interview Engine Registry — Singleton access for IPC handlers.
 *
 * Mirrors the intent-gate-registry pattern: the SpecInterviewEngine is
 * constructed during application initialization and registered here so
 * IPC handlers can access it without circular imports.
 *
 * Requirements: 9.3
 */

import type { ISpecInterviewEngine } from './spec-interview-engine.js';

// ─── Singleton State ────────────────────────────────────────────────────────

let specInterviewEngineInstance: ISpecInterviewEngine | null = null;

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Register the SpecInterviewEngine instance for global access.
 * Should be called once during application initialization.
 */
export function registerSpecInterviewEngine(engine: ISpecInterviewEngine): void {
  specInterviewEngineInstance = engine;
}

// ─── Access ─────────────────────────────────────────────────────────────────

/**
 * Get the registered SpecInterviewEngine instance.
 * Returns null if not yet registered (callers should handle gracefully).
 */
export function getSpecInterviewEngineInstance(): ISpecInterviewEngine | null {
  return specInterviewEngineInstance;
}

// ─── Testing Utilities ──────────────────────────────────────────────────────

/**
 * Reset the registry (for testing purposes only).
 */
export function resetSpecInterviewEngineRegistry(): void {
  specInterviewEngineInstance = null;
}
