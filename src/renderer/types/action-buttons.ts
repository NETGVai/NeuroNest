/**
 * Shared type definitions for the inline action buttons feature.
 *
 * This module defines all interfaces and types used across the prompt detection,
 * button rendering, lifecycle management, and spec orchestration subsystems.
 */

// ---------------------------------------------------------------------------
// Prompt Detection Types
// ---------------------------------------------------------------------------

/** Pattern types recognized by the detector. */
export type PromptType =
  | 'explicit-keyword'
  | 'binary-approval'
  | 'destructive-confirmation'
  | 'multi-choice';

/** Result of prompt detection analysis. */
export interface DetectionResult {
  /** Type of prompt detected. */
  type: PromptType;
  /** The extracted response text to send on confirm (e.g., "confirm"). */
  responseText: string | null;
  /** Label for the primary action button. */
  confirmLabel: string;
  /** Label for the cancel/secondary button. */
  cancelLabel: string;
  /** For multi-choice: array of option labels. */
  options?: string[];
  /** Whether this is a destructive/irreversible operation. */
  isDestructive: boolean;
  /** Character offset of the detected prompt within the full text. */
  promptOffset: number;
}

// ---------------------------------------------------------------------------
// Button Rendering Types
// ---------------------------------------------------------------------------

/** State of a rendered button group. */
export type ButtonGroupState =
  | 'active'
  | 'resolved-confirm'
  | 'resolved-cancel'
  | 'disabled';

/** Callback invoked when a button is clicked. */
export type ActionCallback = (
  responseText: string,
  action: 'confirm' | 'cancel' | 'option'
) => void;

/** Tracks a rendered button group for lifecycle management. */
export interface ButtonGroupInstance {
  /** Unique ID for this button group. */
  id: string;
  /** The container DOM element. */
  containerEl: HTMLElement;
  /** The message element this group belongs to. */
  messageEl: HTMLElement;
  /** Current state. */
  state: ButtonGroupState;
  /** The detection result that produced this group. */
  detection: DetectionResult;
  /** Callback invoked when a button is clicked. */
  onAction: ActionCallback;
}

// ---------------------------------------------------------------------------
// Message Metadata Types
// ---------------------------------------------------------------------------

/** Stored alongside a message in the session for re-rendering. */
export interface MessageActionMeta {
  /** The detection result (if any) for this message. */
  detection: DetectionResult | null;
  /** How the prompt was resolved (null if still pending on session save). */
  resolution: {
    action: 'confirm' | 'cancel' | 'option';
    responseText: string;
    resolvedAt: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Spec Orchestrator Types
// ---------------------------------------------------------------------------

/** Phases of the spec-driven development workflow. */
export type SpecPhase =
  | 'idle'
  | 'interviewing'
  | 'spec-review'
  | 'plan-review'
  | 'task-review'
  | 'executing';

/** State of the spec-driven development workflow. */
export interface SpecModeState {
  /** Whether spec mode is currently active. */
  active: boolean;
  /** Current phase. */
  phase: SpecPhase;
  /** ID of the current interview/workflow. */
  workflowId: string | null;
  /** Generated spec document content. */
  specDocument: string | null;
  /** Generated implementation plan content. */
  implementationPlan: string | null;
  /** Generated task list content. */
  taskList: string | null;
}

// ---------------------------------------------------------------------------
// IPC Message Types
// ---------------------------------------------------------------------------

/** Renderer → Main: Spec mode activation. */
export interface SpecModeActivateMessage {
  type: 'spec:activate';
  payload: { userMessage: string; sessionId: string };
}

/** Main → Renderer: Interview question(s). */
export interface SpecQuestionMessage {
  type: 'spec:question';
  payload: {
    workflowId: string;
    questions: Array<{ text: string; options?: string[]; index: number }>;
  };
}

/** Main → Renderer: Document generated. */
export interface SpecDocumentMessage {
  type: 'spec:document';
  payload: {
    workflowId: string;
    phase: 'spec' | 'plan' | 'tasks';
    content: string;
  };
}

/** Renderer → Main: Document approval/rejection. */
export interface SpecApprovalMessage {
  type: 'spec:approve' | 'spec:request-changes';
  payload: {
    workflowId: string;
    phase: 'spec' | 'plan' | 'tasks';
    feedback?: string;
  };
}

// ---------------------------------------------------------------------------
// Service Interfaces
// ---------------------------------------------------------------------------

/** Interface for the prompt detection service. */
export interface IPromptDetector {
  /**
   * Analyze finalized response text for confirmation prompts.
   * Returns null if no prompt is detected.
   */
  detect(text: string): DetectionResult | null;

  /**
   * Extract the response text keyword from a prompt pattern.
   * e.g., "type 'confirm' to proceed" → "confirm"
   */
  extractResponseText(text: string): string | null;
}

/** Interface for the action button rendering service. */
export interface IActionButtonRenderer {
  /**
   * Render a button group into a message element based on detection result.
   * Returns the ButtonGroupInstance for lifecycle management.
   */
  render(
    messageEl: HTMLElement,
    detection: DetectionResult,
    onAction: ActionCallback
  ): ButtonGroupInstance;

  /**
   * Render a multi-choice button group with N option buttons.
   */
  renderMultiChoice(
    messageEl: HTMLElement,
    options: string[],
    onAction: ActionCallback
  ): ButtonGroupInstance;

  /**
   * Disable a button group (e.g., when superseded by a new message or manual input).
   */
  disable(instance: ButtonGroupInstance): void;

  /**
   * Mark a button group as resolved with the selected action.
   */
  resolve(
    instance: ButtonGroupInstance,
    selectedAction: 'confirm' | 'cancel',
    selectedIndex?: number
  ): void;

  /**
   * Remove a button group from the DOM entirely (e.g., session termination).
   */
  remove(instance: ButtonGroupInstance): void;

  /**
   * Get all active (non-disabled, non-resolved) button group instances.
   */
  getActiveInstances(): ButtonGroupInstance[];
}

/** Interface for the button group lifecycle manager. */
export interface IButtonGroupManager {
  /** Register a new active button group. */
  register(instance: ButtonGroupInstance): void;

  /** Disable all active button groups (e.g., new agent message arrived). */
  disableAll(): void;

  /** Remove all button groups (session termination). */
  removeAll(): void;

  /** Disable button groups for a specific message element. */
  disableForMessage(messageEl: HTMLElement): void;

  /** Handle manual user input — disables all active groups. */
  onManualInput(): void;

  /** Get the count of active button groups. */
  activeCount(): number;
}

/** Interface for the spec-driven development workflow orchestrator. */
export interface ISpecOrchestrator {
  /** Activate spec mode for a build request. */
  activate(userMessage: string): Promise<void>;

  /** Get current spec mode state. */
  getState(): SpecModeState;

  /** Handle user approval of a document. */
  approve(phase: 'spec-review' | 'plan-review' | 'task-review'): Promise<void>;

  /** Handle user request for changes. */
  requestChanges(
    phase: 'spec-review' | 'plan-review' | 'task-review',
    feedback: string
  ): Promise<void>;

  /** Cancel spec mode. */
  cancel(): void;

  /** Start implementation after task approval. */
  startImplementation(): Promise<void>;

  /** Save documents without starting implementation. */
  saveOnly(): Promise<void>;
}
