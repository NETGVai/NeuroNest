/**
 * Hook Engine v2 — Command and HTTP lifecycle hooks with blocking semantics.
 *
 * Supports:
 *   - Command and HTTP hook types
 *   - Event-driven triggers (SessionStart, PreToolUse, PostToolUse, etc.)
 *   - Regex matchers for filtering
 *   - Configurable timeouts (default 2000ms, max 10000ms)
 *   - Enabled/disabled state per hook
 *   - Verdict configuration for blocking events (deny/decline)
 *   - File-based loading from project (.neuronest/hooks/*.json) and user (~/.neuronest/hooks/*.json)
 *   - Project hooks take precedence on name collision
 *
 * Requirements: 17.1, 17.4
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── Types ──────────────────────────────────────────────────────

export type HookEvent =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'TurnStart'
  | 'TurnDone'
  | 'TurnError'
  | 'AgentStop'
  | 'LoopPassStart'
  | 'LoopPassDone';

export type HookType = 'command' | 'http';

export type HookVerdict = 'deny' | 'decline';

export interface HookDefinition {
  /** Unique name identifying this hook */
  name: string;
  /** Hook execution type: shell command or HTTP request */
  type: HookType;
  /** Events that trigger this hook */
  events: HookEvent[];
  /** Regex pattern to match against tool invocation or event context */
  matcher?: string;
  /** Timeout in milliseconds. Default 2000, max 10000 */
  timeout: number;
  /** Whether this hook is active */
  enabled: boolean;
  /** Verdict for blocking events (PreToolUse, LoopPassStart) */
  verdict?: HookVerdict;
  /** Shell command (for type 'command') */
  command?: string;
  /** HTTP URL (for type 'http') */
  url?: string;
  /** HTTP method (for type 'http'), defaults to POST */
  method?: string;
}

export interface HookValidationError {
  field: string;
  message: string;
}

export interface HookLoadResult {
  hooks: HookDefinition[];
  errors: { file: string; error: string }[];
}

// ─── Constants ──────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 2000;
export const MAX_TIMEOUT_MS = 10000;
export const MIN_TIMEOUT_MS = 100;

export const VALID_EVENTS: readonly HookEvent[] = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'TurnStart',
  'TurnDone',
  'TurnError',
  'AgentStop',
  'LoopPassStart',
  'LoopPassDone',
] as const;

export const VALID_HOOK_TYPES: readonly HookType[] = ['command', 'http'] as const;
export const VALID_VERDICTS: readonly HookVerdict[] = ['deny', 'decline'] as const;

const PROJECT_HOOKS_DIR = '.neuronest/hooks';
const USER_HOOKS_DIR = path.join(os.homedir(), '.neuronest', 'hooks');

// ─── Validation ─────────────────────────────────────────────────

/**
 * Validate a hook definition and return any errors found.
 * Returns an empty array if the definition is valid.
 */
export function validateHookDefinition(hook: unknown): HookValidationError[] {
  const errors: HookValidationError[] = [];

  if (!hook || typeof hook !== 'object') {
    errors.push({ field: 'root', message: 'Hook definition must be a non-null object' });
    return errors;
  }

  const h = hook as Record<string, unknown>;
  const name = h['name'];
  const type = h['type'];
  const events = h['events'];
  const matcher = h['matcher'];
  const timeout = h['timeout'];
  const enabled = h['enabled'];
  const verdict = h['verdict'];
  const command = h['command'];
  const url = h['url'];
  const method = h['method'];

  // name: required, non-empty string
  if (typeof name !== 'string' || name.trim().length === 0) {
    errors.push({ field: 'name', message: 'name is required and must be a non-empty string' });
  }

  // type: required, must be 'command' or 'http'
  if (!VALID_HOOK_TYPES.includes(type as HookType)) {
    errors.push({ field: 'type', message: `type must be one of: ${VALID_HOOK_TYPES.join(', ')}` });
  }

  // events: required, non-empty array of valid events
  if (!Array.isArray(events) || events.length === 0) {
    errors.push({ field: 'events', message: 'events must be a non-empty array' });
  } else {
    const invalidEvents = events.filter((e: unknown) => !VALID_EVENTS.includes(e as HookEvent));
    if (invalidEvents.length > 0) {
      errors.push({
        field: 'events',
        message: `Invalid events: ${invalidEvents.join(', ')}. Valid events: ${VALID_EVENTS.join(', ')}`,
      });
    }
  }

  // matcher: optional, but if present must be a valid regex string
  if (matcher !== undefined && matcher !== null) {
    if (typeof matcher !== 'string') {
      errors.push({ field: 'matcher', message: 'matcher must be a string (regex pattern)' });
    } else {
      try {
        new RegExp(matcher);
      } catch {
        errors.push({ field: 'matcher', message: `matcher is not a valid regex: ${matcher}` });
      }
    }
  }

  // timeout: optional (defaults to 2000), must be number within bounds
  if (timeout !== undefined && timeout !== null) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
      errors.push({ field: 'timeout', message: 'timeout must be a finite number' });
    } else if (timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
      errors.push({
        field: 'timeout',
        message: `timeout must be between ${MIN_TIMEOUT_MS}ms and ${MAX_TIMEOUT_MS}ms`,
      });
    }
  }

  // enabled: optional (defaults to true), must be boolean
  if (enabled !== undefined && enabled !== null && typeof enabled !== 'boolean') {
    errors.push({ field: 'enabled', message: 'enabled must be a boolean' });
  }

  // verdict: optional, must be 'deny' or 'decline' if present
  if (verdict !== undefined && verdict !== null) {
    if (!VALID_VERDICTS.includes(verdict as HookVerdict)) {
      errors.push({ field: 'verdict', message: `verdict must be one of: ${VALID_VERDICTS.join(', ')}` });
    }
  }

  // type-specific validation
  if (type === 'command') {
    if (typeof command !== 'string' || command.trim().length === 0) {
      errors.push({ field: 'command', message: 'command is required for type "command" and must be a non-empty string' });
    }
  } else if (type === 'http') {
    if (typeof url !== 'string' || url.trim().length === 0) {
      errors.push({ field: 'url', message: 'url is required for type "http" and must be a non-empty string' });
    } else {
      try {
        new URL(url as string);
      } catch {
        errors.push({ field: 'url', message: `url must be a valid URL: ${url}` });
      }
    }
    if (method !== undefined && method !== null) {
      if (typeof method !== 'string') {
        errors.push({ field: 'method', message: 'method must be a string' });
      }
    }
  }

  return errors;
}

/**
 * Normalize a raw hook object into a well-formed HookDefinition,
 * applying defaults where fields are missing.
 * Assumes the hook has already passed validation (or caller is okay with partial data).
 */
export function normalizeHookDefinition(raw: Record<string, unknown>): HookDefinition {
  const name = raw['name'];
  const type = raw['type'];
  const events = raw['events'];
  const matcher = raw['matcher'];
  const timeout = raw['timeout'];
  const enabled = raw['enabled'];
  const verdict = raw['verdict'];
  const command = raw['command'];
  const url = raw['url'];
  const method = raw['method'];

  const result: HookDefinition = {
    name: (name as string).trim(),
    type: type as HookType,
    events: events as HookEvent[],
    timeout: typeof timeout === 'number' ? Math.min(Math.max(timeout, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    enabled: typeof enabled === 'boolean' ? enabled : true,
  };

  if (matcher != null) result.matcher = matcher as string;
  if (verdict != null) result.verdict = verdict as HookVerdict;
  if (command != null) result.command = command as string;
  if (url != null) result.url = url as string;
  if (method != null) result.method = method as string;

  return result;
}

// ─── File Loading ───────────────────────────────────────────────

/**
 * Load hook definition(s) from a single JSON file.
 * A file may contain a single hook object or an array of hooks.
 * Returns validated hooks and any per-file errors.
 */
export function loadHooksFromFile(filePath: string): { hooks: HookDefinition[]; errors: string[] } {
  const errors: string[] = [];
  const hooks: HookDefinition[] = [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    errors.push(`Failed to read file: ${(err as Error).message}`);
    return { hooks, errors };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    errors.push(`Invalid JSON: ${(err as Error).message}`);
    return { hooks, errors };
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const validationErrors = validateHookDefinition(item);
    if (validationErrors.length > 0) {
      const label = Array.isArray(parsed) ? `[${i}]` : '';
      errors.push(
        `Validation error${label}: ${validationErrors.map((e) => `${e.field}: ${e.message}`).join('; ')}`,
      );
      continue;
    }
    hooks.push(normalizeHookDefinition(item as Record<string, unknown>));
  }

  return { hooks, errors };
}

/**
 * Load all hook definitions from a directory.
 * Only processes files with .json extension.
 */
export function loadHooksFromDirectory(dirPath: string): HookLoadResult {
  const result: HookLoadResult = { hooks: [], errors: [] };

  if (!fs.existsSync(dirPath)) {
    return result;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch (err) {
    result.errors.push({ file: dirPath, error: `Failed to read directory: ${(err as Error).message}` });
    return result;
  }

  const jsonFiles = entries.filter((f) => f.endsWith('.json')).sort();

  for (const file of jsonFiles) {
    const filePath = path.join(dirPath, file);

    // Only process regular files
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    const { hooks, errors } = loadHooksFromFile(filePath);
    result.hooks.push(...hooks);
    for (const error of errors) {
      result.errors.push({ file: filePath, error });
    }
  }

  return result;
}

// ─── Hook Engine v2 ─────────────────────────────────────────────

export interface HookEngineV2Options {
  /** Absolute path to the project root directory */
  projectRoot?: string;
  /** Override the user hooks directory (for testing) */
  userHooksDir?: string;
}

/**
 * Hook Engine v2 — loads, manages, and resolves hook definitions
 * from project and user directories.
 *
 * Loading priority:
 *   1. Project hooks from `<projectRoot>/.neuronest/hooks/*.json`
 *   2. User hooks from `~/.neuronest/hooks/*.json`
 *
 * On name collision, project hooks take precedence over user hooks.
 */
export class HookEngineV2 {
  private hooks: Map<string, HookDefinition> = new Map();
  private loadErrors: { file: string; error: string }[] = [];
  private readonly projectHooksDir: string | null;
  private readonly userHooksDir: string;

  constructor(options: HookEngineV2Options = {}) {
    this.projectHooksDir = options.projectRoot
      ? path.join(options.projectRoot, PROJECT_HOOKS_DIR)
      : null;
    this.userHooksDir = options.userHooksDir ?? USER_HOOKS_DIR;
  }

  /**
   * Load hooks from both project and user directories.
   * Project hooks take precedence on name collision.
   */
  load(): void {
    this.hooks.clear();
    this.loadErrors = [];

    // Load user hooks first (lower precedence)
    const userResult = loadHooksFromDirectory(this.userHooksDir);
    for (const hook of userResult.hooks) {
      this.hooks.set(hook.name, hook);
    }
    this.loadErrors.push(...userResult.errors);

    // Load project hooks second (higher precedence — overwrites user on collision)
    if (this.projectHooksDir) {
      const projectResult = loadHooksFromDirectory(this.projectHooksDir);
      for (const hook of projectResult.hooks) {
        this.hooks.set(hook.name, hook);
      }
      this.loadErrors.push(...projectResult.errors);
    }
  }

  /**
   * Get all loaded hooks as an array.
   */
  listHooks(): HookDefinition[] {
    return Array.from(this.hooks.values());
  }

  /**
   * Get a hook by name.
   */
  getHook(name: string): HookDefinition | undefined {
    return this.hooks.get(name);
  }

  /**
   * Get hooks that listen to a specific event.
   * Only returns enabled hooks.
   */
  getHooksForEvent(event: HookEvent): HookDefinition[] {
    return this.listHooks().filter((h) => h.enabled && h.events.includes(event));
  }

  /**
   * Get hooks matching a specific event and context string (via regex matcher).
   * Only returns enabled hooks whose matcher (if defined) matches the context.
   */
  getMatchingHooks(event: HookEvent, context?: string): HookDefinition[] {
    return this.getHooksForEvent(event).filter((h) => {
      if (!h.matcher) return true; // No matcher = match all
      if (!context) return !h.matcher; // No context and has matcher = no match
      try {
        const regex = new RegExp(h.matcher);
        return regex.test(context);
      } catch {
        return false;
      }
    });
  }

  /**
   * Add a hook definition. Overwrites any existing hook with the same name.
   */
  addHook(hook: HookDefinition): HookValidationError[] {
    const errors = validateHookDefinition(hook);
    if (errors.length > 0) return errors;
    this.hooks.set(hook.name, normalizeHookDefinition(hook as unknown as Record<string, unknown>));
    return [];
  }

  /**
   * Remove a hook by name.
   * Returns true if the hook existed and was removed.
   */
  removeHook(name: string): boolean {
    return this.hooks.delete(name);
  }

  /**
   * Enable a hook by name.
   * Returns true if the hook exists and was updated.
   */
  enableHook(name: string): boolean {
    const hook = this.hooks.get(name);
    if (!hook) return false;
    hook.enabled = true;
    return true;
  }

  /**
   * Disable a hook by name.
   * Returns true if the hook exists and was updated.
   */
  disableHook(name: string): boolean {
    const hook = this.hooks.get(name);
    if (!hook) return false;
    hook.enabled = false;
    return true;
  }

  /**
   * Get any loading errors that occurred during the last load().
   */
  getLoadErrors(): { file: string; error: string }[] {
    return [...this.loadErrors];
  }

  /**
   * Get the total number of loaded hooks.
   */
  get size(): number {
    return this.hooks.size;
  }
}
