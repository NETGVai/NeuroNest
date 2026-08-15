/**
 * Editor Chat Enhancement Feature Gates
 *
 * Independently controllable gates for the editor-chat-enhancement staged rollout.
 * Each gate controls one domain of functionality and can be enabled/disabled
 * without affecting others.
 *
 * Requirements: 28.1, 28.2, 28.3, 28.4, 28.6, 28.7, 28.8
 */

// ─── Gate Identifiers ───────────────────────────────────────────

/**
 * The six independently controllable gates for the editor-chat-enhancement rollout.
 */
export type EditorChatGateId =
  | 'model_management'
  | 'change_sets'
  | 'visual_taskbar'
  | 'dispatch_integration'
  | 'chat_timeline'
  | 'lsp_enhancements';

export const EDITOR_CHAT_GATE_IDS: readonly EditorChatGateId[] = [
  'model_management',
  'change_sets',
  'visual_taskbar',
  'dispatch_integration',
  'chat_timeline',
  'lsp_enhancements',
] as const;

// ─── Gate Metadata ──────────────────────────────────────────────

export interface EditorChatGateMetadata {
  id: EditorChatGateId;
  description: string;
  /** Which requirement areas this gate covers */
  requirementAreas: string[];
  /** Other gates that should be active before this one for full behavior */
  softDependencies: EditorChatGateId[];
}

export const EDITOR_CHAT_GATE_METADATA: Record<EditorChatGateId, EditorChatGateMetadata> = {
  model_management: {
    id: 'model_management',
    description: 'Canonical Monaco model ownership, lifecycle, and EditorModelStore authority',
    requirementAreas: ['R1', 'R2'],
    softDependencies: [],
  },
  change_sets: {
    id: 'change_sets',
    description: 'Versioned multi-file Change_Sets, atomic transactions, and review queue',
    requirementAreas: ['R5', 'R6', 'R7', 'R8', 'R9'],
    softDependencies: ['model_management'],
  },
  visual_taskbar: {
    id: 'visual_taskbar',
    description: 'Visual Specification Taskbar, planning graph, and traceability views',
    requirementAreas: ['R10', 'R11', 'R12'],
    softDependencies: [],
  },
  dispatch_integration: {
    id: 'dispatch_integration',
    description: 'Task-to-agent dispatch, run coordination, and delivery loops',
    requirementAreas: ['R13', 'R14', 'R30'],
    softDependencies: ['visual_taskbar', 'change_sets'],
  },
  chat_timeline: {
    id: 'chat_timeline',
    description: 'Unified chat timeline, structured context, tools, and streaming',
    requirementAreas: ['R15', 'R16', 'R17', 'R18'],
    softDependencies: [],
  },
  lsp_enhancements: {
    id: 'lsp_enhancements',
    description: 'Enhanced LSP synchronization, capability-driven registration, and completion',
    requirementAreas: ['R3', 'R4'],
    softDependencies: ['model_management'],
  },
};

// ─── Gate State ─────────────────────────────────────────────────

export type GateState = 'enabled' | 'disabled' | 'rollback_blocked';

export interface EditorChatGateState {
  id: EditorChatGateId;
  state: GateState;
  enabledAt: string | null;
  disabledAt: string | null;
  /** If rollback_blocked, the reason safe reversion was impossible */
  blockReason: string | null;
  /** Schema version at the time this gate was enabled */
  schemaVersion: number | null;
}

// ─── Gate Configuration ─────────────────────────────────────────

export interface EditorChatGateConfig {
  /** All gates default to disabled */
  gates: Record<EditorChatGateId, boolean>;
}

export const DEFAULT_EDITOR_CHAT_GATE_CONFIG: EditorChatGateConfig = {
  gates: {
    model_management: false,
    change_sets: false,
    visual_taskbar: false,
    dispatch_integration: false,
    chat_timeline: false,
    lsp_enhancements: false,
  },
};
