/**
 * StructuredComposerService — Supports text, command, code, and mention
 * input modalities with boundary validation, multiline modes, prompt history,
 * branching, and cancellable context-resolution progress.
 *
 * The composer validates all input at the boundary (before submission to
 * a provider), rejecting invalid commands, malformed mentions, and other
 * constraint violations. It declares supported modalities based on current
 * context (e.g., mentions available only when entity store is loaded).
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.9, 16.10
 */

import type {
  InputModality,
  ComposerInput,
  ValidationResult,
  ValidationIssue,
  ComposerContext,
  ModalityDeclaration,
  ComposerMode,
  HistoryEntry,
  ContextResolutionProgress,
} from './types';

/** Known command prefixes for validation. */
const VALID_COMMANDS = new Set([
  '/ask',
  '/plan',
  '/edit',
  '/run',
  '/help',
  '/clear',
  '/branch',
  '/stop',
]);

/** Pattern for a valid mention reference: @entity-type:identifier */
const MENTION_PATTERN = /^@[a-zA-Z][a-zA-Z0-9_-]*:[a-zA-Z0-9_./-]+$/;

/** Maximum prompt history entries retained */
const MAX_HISTORY_ENTRIES = 100;

export class StructuredComposerService {
  private currentMode: ComposerMode = 'ask';
  private readonly history: HistoryEntry[] = [];
  private historyIndex: number = -1;
  private resolutionProgress: ContextResolutionProgress = {
    resolvedCount: 0,
    totalCount: 0,
    inProgress: false,
    cancellationRequested: false,
  };

  // ─── Mode Management ──────────────────────────────────────────

  /**
   * Get the current composer mode.
   */
  getMode(): ComposerMode {
    return this.currentMode;
  }

  /**
   * Set the composer mode (ask, plan, edit, agent).
   */
  setMode(mode: ComposerMode): void {
    this.currentMode = mode;
  }

  /**
   * Get all supported modes.
   */
  getSupportedModes(): readonly ComposerMode[] {
    return Object.freeze(['ask', 'plan', 'edit', 'agent'] as const);
  }

  // ─── Prompt History ───────────────────────────────────────────

  /**
   * Add a prompt to history. Returns the created history entry.
   */
  addToHistory(content: string, mode?: ComposerMode, parentId?: string): HistoryEntry {
    const entry: HistoryEntry = {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      mode: mode ?? this.currentMode,
      timestamp: Date.now(),
      parentId,
    };

    this.history.push(entry);

    // Evict oldest entries beyond limit
    while (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history.shift();
    }

    // Reset navigation index
    this.historyIndex = -1;

    return entry;
  }

  /**
   * Navigate to previous history entry. Returns null if at start.
   */
  navigateHistoryBack(): HistoryEntry | null {
    if (this.history.length === 0) return null;

    if (this.historyIndex === -1) {
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return null;
    }

    return this.history[this.historyIndex] ?? null;
  }

  /**
   * Navigate to next history entry. Returns null if at end.
   */
  navigateHistoryForward(): HistoryEntry | null {
    if (this.historyIndex === -1 || this.historyIndex >= this.history.length - 1) {
      this.historyIndex = -1;
      return null;
    }

    this.historyIndex++;
    return this.history[this.historyIndex] ?? null;
  }

  /**
   * Get the full history list.
   */
  getHistory(): readonly HistoryEntry[] {
    return [...this.history];
  }

  /**
   * Get history size.
   */
  getHistorySize(): number {
    return this.history.length;
  }

  /**
   * Create a branch from a prior history entry. Returns the new branch entry.
   */
  branchFromEntry(parentId: string, newContent: string): HistoryEntry | null {
    const parent = this.history.find(e => e.id === parentId);
    if (!parent) return null;

    return this.addToHistory(newContent, parent.mode, parentId);
  }

  // ─── Context Resolution Progress ─────────────────────────────

  /**
   * Start context resolution tracking.
   */
  startResolution(totalCount: number): void {
    this.resolutionProgress = {
      resolvedCount: 0,
      totalCount,
      inProgress: true,
      cancellationRequested: false,
    };
  }

  /**
   * Update progress of context resolution.
   */
  updateResolutionProgress(resolvedCount: number, currentItemLabel?: string): void {
    this.resolutionProgress.resolvedCount = resolvedCount;
    this.resolutionProgress.currentItemLabel = currentItemLabel;
  }

  /**
   * Request cancellation of in-progress context resolution.
   */
  cancelResolution(): boolean {
    if (!this.resolutionProgress.inProgress) return false;
    this.resolutionProgress.cancellationRequested = true;
    return true;
  }

  /**
   * Check if cancellation was requested.
   */
  isCancellationRequested(): boolean {
    return this.resolutionProgress.cancellationRequested;
  }

  /**
   * Complete context resolution (success or cancellation).
   */
  completeResolution(): void {
    this.resolutionProgress = {
      ...this.resolutionProgress,
      inProgress: false,
    };
  }

  /**
   * Get the current context resolution progress.
   */
  getResolutionProgress(): Readonly<ContextResolutionProgress> {
    return { ...this.resolutionProgress };
  }

  // ─── Modality Declarations ────────────────────────────────────

  /**
   * Declares which input modalities are currently supported based
   * on the provided context. Mentions require the entity store to
   * be loaded; commands/code/text are always available when a session
   * exists and provider is connected.
   */
  declareModalities(context: ComposerContext): readonly ModalityDeclaration[] {
    const declarations: ModalityDeclaration[] = [
      {
        modality: 'text',
        available: context.activeSessionExists,
        reason: context.activeSessionExists ? undefined : 'No active session',
      },
      {
        modality: 'command',
        available: context.activeSessionExists,
        reason: context.activeSessionExists ? undefined : 'No active session',
      },
      {
        modality: 'code',
        available: context.activeSessionExists && context.providerConnected,
        reason: !context.activeSessionExists
          ? 'No active session'
          : !context.providerConnected
            ? 'Provider not connected'
            : undefined,
      },
      {
        modality: 'mention',
        available: context.entityStoreLoaded && context.activeSessionExists,
        reason: !context.activeSessionExists
          ? 'No active session'
          : !context.entityStoreLoaded
            ? 'Entity store not loaded'
            : undefined,
      },
    ];
    return Object.freeze(declarations);
  }

  /**
   * Validates an array of composer inputs at the boundary before
   * submission. Returns a validation result with errors/warnings
   * for any invalid content.
   */
  validate(inputs: readonly ComposerInput[], context: ComposerContext): ValidationResult {
    const issues: ValidationIssue[] = [];
    const availableModalities = new Set(
      this.declareModalities(context)
        .filter((d) => d.available)
        .map((d) => d.modality),
    );

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;

      // Check if modality is available in current context
      if (!availableModalities.has(input.modality)) {
        issues.push({
          modality: input.modality,
          severity: 'error',
          message: `Modality "${input.modality}" is not available in current context`,
          index: i,
        });
        continue;
      }

      // Modality-specific validation
      switch (input.modality) {
        case 'text':
          this.validateText(input, i, issues);
          break;
        case 'command':
          this.validateCommand(input, i, issues);
          break;
        case 'code':
          this.validateCode(input, i, issues);
          break;
        case 'mention':
          this.validateMention(input, i, issues);
          break;
      }
    }

    return Object.freeze({
      valid: issues.every((issue) => issue.severity !== 'error'),
      issues: Object.freeze(issues),
    });
  }

  /**
   * Returns the set of known valid command prefixes.
   */
  getValidCommands(): ReadonlySet<string> {
    return VALID_COMMANDS;
  }

  private validateText(input: ComposerInput, index: number, issues: ValidationIssue[]): void {
    if (input.content.trim().length === 0) {
      issues.push({
        modality: 'text',
        severity: 'warning',
        message: 'Empty text input',
        index,
      });
    }
  }

  private validateCommand(input: ComposerInput, index: number, issues: ValidationIssue[]): void {
    const content = input.content.trim();

    if (!content.startsWith('/')) {
      issues.push({
        modality: 'command',
        severity: 'error',
        message: 'Commands must start with "/"',
        index,
      });
      return;
    }

    const commandName = content.split(/\s/)[0]!;
    if (!VALID_COMMANDS.has(commandName)) {
      issues.push({
        modality: 'command',
        severity: 'error',
        message: `Unknown command "${commandName}". Valid commands: ${[...VALID_COMMANDS].join(', ')}`,
        index,
      });
    }
  }

  private validateCode(input: ComposerInput, index: number, issues: ValidationIssue[]): void {
    if (input.content.length === 0) {
      issues.push({
        modality: 'code',
        severity: 'error',
        message: 'Code input cannot be empty',
        index,
      });
    }
  }

  private validateMention(input: ComposerInput, index: number, issues: ValidationIssue[]): void {
    const content = input.content.trim();

    if (!content.startsWith('@')) {
      issues.push({
        modality: 'mention',
        severity: 'error',
        message: 'Mentions must start with "@"',
        index,
      });
      return;
    }

    if (!MENTION_PATTERN.test(content)) {
      issues.push({
        modality: 'mention',
        severity: 'error',
        message: `Malformed mention "${content}". Expected format: @type:identifier`,
        index,
      });
    }
  }
}
