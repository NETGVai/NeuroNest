/**
 * Plan Mode Session State — session-scoped state for Plan Mode.
 *
 * Plan Mode restricts mutations to a single plan file during planning sessions.
 * This module manages the active/inactive state and the associated plan file path.
 *
 * Session-scoped: one instance per session, not shared across sessions.
 *
 * Requirements: 11.1
 */

import * as path from 'path';

/**
 * Plan Mode session state.
 *
 * Tracks whether Plan Mode is active and the absolute path of the plan file
 * that is allowed to be modified while the mode is engaged.
 */
export class PlanModeState {
  private _active: boolean = false;
  private _planFilePath: string = '';

  /**
   * Activate Plan Mode for this session.
   *
   * @param planFilePath - Absolute path to the plan file that may be edited.
   * @throws Error if planFilePath is empty or not an absolute path.
   * @throws Error if Plan Mode is already active (must deactivate first).
   */
  activate(planFilePath: string): void {
    if (this._active) {
      throw new Error('Plan Mode is already active. Deactivate before re-entering.');
    }
    if (!planFilePath || planFilePath.trim() === '') {
      throw new Error('Plan file path must be a non-empty string.');
    }
    if (!path.isAbsolute(planFilePath)) {
      throw new Error(`Plan file path must be absolute. Received: ${planFilePath}`);
    }
    this._active = true;
    this._planFilePath = path.posix.normalize(planFilePath);
  }

  /**
   * Deactivate Plan Mode for this session.
   * Safe to call even when already inactive (no-op).
   */
  deactivate(): void {
    this._active = false;
    this._planFilePath = '';
  }

  /**
   * Returns true when Plan Mode is currently active.
   */
  isActive(): boolean {
    return this._active;
  }

  /**
   * Returns the absolute path of the session plan file, or empty string if inactive.
   */
  getPlanFilePath(): string {
    return this._planFilePath;
  }
}
