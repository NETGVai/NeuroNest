/**
 * QuickActionManager — Manages quick action toolbar items for one-click pipeline execution.
 *
 * Quick actions are pre-configured shortcuts that invoke specific pipelines with
 * predefined parameters. They provide a configurable toolbar of one-click buttons
 * for common development tasks.
 *
 * Persists quick actions to `.neuronest/pipelines/quick-actions.json`.
 * Includes 5 bundled defaults created on first load.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { uuidv7 } from 'uuidv7';
import * as fs from 'fs';
import * as path from 'path';
import type { QuickAction, PipelineExecution } from '../shared/feature-integration-types';
import { FeatureError } from '../shared/feature-integration-errors';
import type { PipelineEngine } from './pipeline-engine';

// ─── Types ──────────────────────────────────────────────────────

/** Options for creating the QuickActionManager. */
export interface QuickActionManagerOptions {
  /** Root project directory for resolving `.neuronest/pipelines/quick-actions.json`. */
  projectDir: string;
  /** Reference to the PipelineEngine for executing pipelines. */
  pipelineEngine: PipelineEngine;
}

// ─── Bundled Default Quick Actions ──────────────────────────────

/**
 * Returns the 5 bundled default quick actions.
 * These get created on first load if quick-actions.json doesn't exist.
 */
function createBundledDefaults(): QuickAction[] {
  return [
    {
      id: uuidv7(),
      label: 'Scaffold Component',
      icon: 'component',
      pipelineId: 'scaffold-component',
      prefilledParams: {
        type: 'react',
        includeTests: true,
        includeStorybook: false,
      },
      position: 0,
    },
    {
      id: uuidv7(),
      label: 'Run Tests',
      icon: 'test',
      pipelineId: 'run-tests',
      prefilledParams: {
        coverage: true,
        watch: false,
      },
      position: 1,
    },
    {
      id: uuidv7(),
      label: 'Lint & Fix',
      icon: 'lint',
      pipelineId: 'lint-and-fix',
      prefilledParams: {
        autoFix: true,
        staged: false,
      },
      position: 2,
    },
    {
      id: uuidv7(),
      label: 'Generate API Endpoint',
      icon: 'api',
      pipelineId: 'generate-api-endpoint',
      prefilledParams: {
        method: 'GET',
        authentication: true,
      },
      position: 3,
    },
    {
      id: uuidv7(),
      label: 'Add Dependency',
      icon: 'package',
      pipelineId: 'add-dependency',
      prefilledParams: {
        dev: false,
        exact: true,
      },
      position: 4,
    },
  ];
}

// ─── QuickActionManager ─────────────────────────────────────────

export class QuickActionManager {
  private readonly projectDir: string;
  private readonly pipelineEngine: PipelineEngine;
  private readonly filePath: string;

  /** In-memory cache of quick actions. Loaded from disk on first access. */
  private actions: QuickAction[] | null = null;

  constructor(options: QuickActionManagerOptions) {
    this.projectDir = options.projectDir;
    this.pipelineEngine = options.pipelineEngine;
    this.filePath = path.join(
      this.projectDir,
      '.neuronest',
      'pipelines',
      'quick-actions.json',
    );
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * List all quick actions, sorted by position.
   *
   * On first call, loads from disk. If no file exists, creates bundled defaults.
   */
  list(): QuickAction[] {
    this.ensureLoaded();
    return [...this.actions!].sort((a, b) => a.position - b.position);
  }

  /**
   * Create a new quick action.
   *
   * Assigns a unique ID, appends to the list, and persists to disk.
   *
   * @param action - Quick action data without the ID.
   * @returns The created QuickAction with assigned ID.
   */
  create(action: Omit<QuickAction, 'id'>): QuickAction {
    this.ensureLoaded();

    const newAction: QuickAction = {
      ...action,
      id: uuidv7(),
    };

    this.actions!.push(newAction);
    this.persist();

    return newAction;
  }

  /**
   * Execute a quick action by ID.
   *
   * Looks up the action, then calls PipelineEngine.execute with the
   * action's pipelineId and prefilledParams.
   *
   * @param actionId - ID of the quick action to execute.
   * @returns The PipelineExecution result.
   */
  async execute(actionId: string): Promise<PipelineExecution> {
    this.ensureLoaded();

    const action = this.actions!.find((a) => a.id === actionId);
    if (!action) {
      throw new FeatureError({
        message: `Quick action not found: ${actionId}`,
        category: 'pipeline',
        code: 'QUICK_ACTION_NOT_FOUND',
        details: { actionId },
      });
    }

    return this.pipelineEngine.execute(action.pipelineId, action.prefilledParams);
  }

  /**
   * Reorder quick actions by specifying the new order of action IDs.
   *
   * Sets position values based on array index. IDs not present in the
   * provided array are appended at the end in their original order.
   *
   * @param actionIds - Ordered array of action IDs defining the new positions.
   */
  reorder(actionIds: string[]): void {
    this.ensureLoaded();

    const idToAction = new Map(this.actions!.map((a) => [a.id, a]));

    // Assign positions based on the provided order
    let position = 0;
    for (const id of actionIds) {
      const action = idToAction.get(id);
      if (action) {
        action.position = position++;
      }
    }

    // Any actions not in the provided list get appended at the end
    for (const action of this.actions!) {
      if (!actionIds.includes(action.id)) {
        action.position = position++;
      }
    }

    this.persist();
  }

  /**
   * Delete a quick action by ID.
   *
   * @param actionId - ID of the quick action to delete.
   */
  delete(actionId: string): void {
    this.ensureLoaded();

    const index = this.actions!.findIndex((a) => a.id === actionId);
    if (index === -1) {
      throw new FeatureError({
        message: `Quick action not found: ${actionId}`,
        category: 'pipeline',
        code: 'QUICK_ACTION_NOT_FOUND',
        details: { actionId },
      });
    }

    this.actions!.splice(index, 1);
    this.persist();
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Ensure quick actions are loaded into memory.
   * On first access:
   * - If the file exists on disk, load it.
   * - If the file doesn't exist, create bundled defaults and persist.
   */
  private ensureLoaded(): void {
    if (this.actions !== null) return;

    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      this.actions = JSON.parse(content) as QuickAction[];
    } catch {
      // File doesn't exist or is malformed — create bundled defaults
      this.actions = createBundledDefaults();
      this.persist();
    }
  }

  /**
   * Persist the current quick actions array to disk as JSON.
   */
  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.actions, null, 2), 'utf-8');
  }
}
