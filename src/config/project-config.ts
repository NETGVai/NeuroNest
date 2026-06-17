/**
 * Project Configuration Loader
 *
 * Reads `.neuronest/config.json` from the project directory and validates
 * each field against allowed ranges/types. Invalid or missing values fall
 * back to global defaults with a logged warning.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * Project-level configuration for agent behavior.
 * All fields are optional in the JSON file; defaults are applied for missing values.
 */
export interface ProjectConfig {
  /** LLM temperature (0.0 - 2.0). Default: 0.7 */
  temperature: number;
  /** Maximum tool-use loop iterations (1 - 50). Default: 25 */
  maxIterations: number;
  /** Override model string. Default: undefined (use system default) */
  model: string | undefined;
  /** Max tokens for smart context budget. Default: 32000 */
  contextBudget: number;
  /** Files count threshold for turbo routing. Default: 1 */
  turboThreshold: number;
  /** Whether to auto-commit after edits. Default: true */
  autoVersioning: boolean;
  /** Whether to require plan approval. Default: false */
  planMode: boolean;
}

/**
 * Default configuration values used when fields are missing or invalid.
 */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  temperature: 0.7,
  maxIterations: 25,
  model: undefined,
  contextBudget: 32000,
  turboThreshold: 1,
  autoVersioning: true,
  planMode: false,
};

/**
 * Load project configuration from `.neuronest/config.json`.
 *
 * - If the file does not exist, returns `DEFAULT_PROJECT_CONFIG`.
 * - If parsing fails, logs a warning and returns `DEFAULT_PROJECT_CONFIG`.
 * - For each field: validates type and range, uses default + logs warning if invalid.
 *
 * @param projectDir - The project root directory
 * @returns Fully-populated ProjectConfig with defaults filled in
 */
export function loadProjectConfig(projectDir: string): ProjectConfig {
  const configPath = path.join(projectDir, '.neuronest', 'config.json');

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(configPath, 'utf-8');
  } catch {
    // File doesn't exist or can't be read — use defaults silently
    return { ...DEFAULT_PROJECT_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    logger.warn('Invalid JSON in .neuronest/config.json, using defaults');
    return { ...DEFAULT_PROJECT_CONFIG };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn('Expected object in .neuronest/config.json, using defaults');
    return { ...DEFAULT_PROJECT_CONFIG };
  }

  const raw = parsed as Record<string, unknown>;
  const config: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG };

  // temperature: number, 0.0 - 2.0
  if ('temperature' in raw) {
    if (typeof raw.temperature === 'number' && raw.temperature >= 0 && raw.temperature <= 2) {
      config.temperature = raw.temperature;
    } else {
      logger.warn('Invalid temperature in config (expected number 0.0-2.0), using default', {
        value: raw.temperature,
      });
    }
  }

  // maxIterations: number, 1 - 50
  if ('maxIterations' in raw) {
    if (
      typeof raw.maxIterations === 'number' &&
      Number.isInteger(raw.maxIterations) &&
      raw.maxIterations >= 1 &&
      raw.maxIterations <= 50
    ) {
      config.maxIterations = raw.maxIterations;
    } else {
      logger.warn('Invalid maxIterations in config (expected integer 1-50), using default', {
        value: raw.maxIterations,
      });
    }
  }

  // model: string or undefined
  if ('model' in raw) {
    if (typeof raw.model === 'string' && raw.model.trim().length > 0) {
      config.model = raw.model.trim();
    } else if (raw.model !== null && raw.model !== undefined) {
      logger.warn('Invalid model in config (expected non-empty string), using default', {
        value: raw.model,
      });
    }
  }

  // contextBudget: number, positive integer
  if ('contextBudget' in raw) {
    if (
      typeof raw.contextBudget === 'number' &&
      Number.isInteger(raw.contextBudget) &&
      raw.contextBudget > 0
    ) {
      config.contextBudget = raw.contextBudget;
    } else {
      logger.warn('Invalid contextBudget in config (expected positive integer), using default', {
        value: raw.contextBudget,
      });
    }
  }

  // turboThreshold: number, positive integer
  if ('turboThreshold' in raw) {
    if (
      typeof raw.turboThreshold === 'number' &&
      Number.isInteger(raw.turboThreshold) &&
      raw.turboThreshold >= 1
    ) {
      config.turboThreshold = raw.turboThreshold;
    } else {
      logger.warn('Invalid turboThreshold in config (expected positive integer >= 1), using default', {
        value: raw.turboThreshold,
      });
    }
  }

  // autoVersioning: boolean
  if ('autoVersioning' in raw) {
    if (typeof raw.autoVersioning === 'boolean') {
      config.autoVersioning = raw.autoVersioning;
    } else {
      logger.warn('Invalid autoVersioning in config (expected boolean), using default', {
        value: raw.autoVersioning,
      });
    }
  }

  // planMode: boolean
  if ('planMode' in raw) {
    if (typeof raw.planMode === 'boolean') {
      config.planMode = raw.planMode;
    } else {
      logger.warn('Invalid planMode in config (expected boolean), using default', {
        value: raw.planMode,
      });
    }
  }

  return config;
}
