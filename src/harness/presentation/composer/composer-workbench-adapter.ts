/**
 * ComposerWorkbenchAdapter
 *
 * Bridges the per-session DraftTransactionStore with the existing production
 * composer UI. Adapts the legacy send/steer/queue/spec behavior to use typed
 * state while preserving exact production IPC channels (`chat-message`,
 * `abort-pipeline`, `msgmode:*`) until typed equivalents pass parity.
 *
 * Responsibilities:
 * - Expose visible typed controls with disabled discoverable reasons
 * - Show selected mode text/state (send, steer, queue, spec)
 * - Configure busy primary action and keyboard alternate (Cmd/Ctrl+Enter)
 * - Manage attachment/context chip visibility and status
 * - Surface voice/TTS availability
 * - Preserve provider/model and project behavior
 * - Route submissions through existing IPC during migration
 *
 * Requirements: 1.5–1.6, 15.2–15.7, 21.11, 22.10
 */

import type { DraftTransactionStore, DraftRevision } from './draft-transaction-store';

// ─── Message Modes ──────────────────────────────────────────────

/**
 * Legacy message modes mapped to their typed equivalents.
 * These correspond to the `data-mode` attribute on mode toggle buttons
 * and the `currentMessageMode` variable in src/renderer/index.ts.
 */
export type MessageMode = 'send' | 'steer' | 'queue' | 'spec';

/**
 * Describes the UI state of a single mode button.
 */
export interface ModeControlState {
  mode: MessageMode;
  label: string;
  active: boolean;
  disabled: boolean;
  disabledReason?: string | undefined;
  ariaLabel: string;
  placeholder: string;
}

// ─── Capability State ───────────────────────────────────────────

/**
 * Whether a capability is available, unavailable, or hidden.
 * When 'disabled', the control is visible with a discoverable reason.
 * When 'hidden', the control is not rendered at all.
 */
export type CapabilityVisibility = 'enabled' | 'disabled' | 'hidden';

/**
 * Describes one typed composer control state.
 */
export interface CapabilityControlState {
  id: string;
  visibility: CapabilityVisibility;
  disabledReason?: string | undefined;
  label: string;
  ariaLabel: string;
}

// ─── Voice/TTS State ────────────────────────────────────────────

export type VoiceAvailability = 'available' | 'unavailable' | 'loading' | 'recording' | 'transcribing';

export interface VoiceControlState {
  availability: VoiceAvailability;
  disabledReason?: string | undefined;
  /** Whether the voice models are downloaded and ready */
  modelsReady: boolean;
}

// ─── Primary Action ─────────────────────────────────────────────

/**
 * The primary composer button action based on current state.
 */
export type PrimaryActionKind = 'send' | 'stop' | 'brain_active';

export interface PrimaryActionState {
  kind: PrimaryActionKind;
  label: string;
  ariaLabel: string;
  disabled: boolean;
  disabledReason?: string | undefined;
}

// ─── Keyboard Alternate ─────────────────────────────────────────

export interface KeyboardAlternateAction {
  /** Mode to send with on Cmd/Ctrl+Enter */
  targetMode: MessageMode;
  label: string;
  description: string;
}

// ─── Route/Model Summary ────────────────────────────────────────

export interface RouteModelSummary {
  provider?: string | undefined;
  model?: string | undefined;
  displayText: string;
  available: boolean;
  disabledReason?: string | undefined;
}

// ─── Workbench State ────────────────────────────────────────────

/**
 * Complete computed state for the composer workbench UI.
 * This state is derived from the DraftTransactionStore, authority,
 * and settings without holding independent durable data.
 */
export interface ComposerWorkbenchState {
  /** Current active mode */
  activeMode: MessageMode;
  /** All mode control states */
  modeControls: ModeControlState[];
  /** Primary action button */
  primaryAction: PrimaryActionState;
  /** Keyboard alternate action (Cmd/Ctrl+Enter) */
  keyboardAlternate: KeyboardAlternateAction;
  /** Whether the system is currently processing */
  isBusy: boolean;
  /** Route/model summary */
  routeModel: RouteModelSummary;
  /** Voice input control */
  voice: VoiceControlState;
  /** Attachment capability */
  attachments: CapabilityControlState;
  /** Context chips capability */
  contextItems: CapabilityControlState;
  /** Project ID */
  activeProjectId: string | undefined;
  /** Whether the composer is in a collaboration takeover state */
  isTakeoverActive: boolean;
  /** Current text from the store */
  text: string;
  /** Current draft revision */
  revision: number;
}

// ─── Configuration ──────────────────────────────────────────────

export interface ComposerWorkbenchAdapterConfig {
  store: DraftTransactionStore;
  /** Current project ID — mutable external state during migration */
  getProjectId: () => string | undefined;
  /** Whether the pipeline is currently processing */
  getIsBusy: () => boolean;
  /** Whether collaboration takeover is active */
  getIsTakeoverActive: () => boolean;
  /** Current provider/model info */
  getRouteModel: () => { provider?: string; model?: string } | undefined;
  /** Whether voice/TTS models are ready */
  getVoiceAvailability: () => VoiceAvailability;
  /** Whether voice models are downloaded */
  getVoiceModelsReady: () => boolean;
  /** Whether providers are configured */
  getHasProviders: () => boolean;
  /** Settings-derived discoverable capabilities */
  settings?: ComposerCapabilitySettings | undefined;
}

export interface ComposerCapabilitySettings {
  /** Whether voice input is discoverable even when unavailable */
  voiceDiscoverable: boolean;
  /** Whether attachments are discoverable when project not selected */
  attachmentsDiscoverable: boolean;
  /** Whether context items are discoverable */
  contextItemsDiscoverable: boolean;
}

const DEFAULT_CAPABILITY_SETTINGS: ComposerCapabilitySettings = {
  voiceDiscoverable: true,
  attachmentsDiscoverable: true,
  contextItemsDiscoverable: true,
};

// ─── Mode Metadata ──────────────────────────────────────────────

const MODE_LABELS: Record<MessageMode, string> = {
  send: 'Send',
  steer: 'Steer',
  queue: 'Queue',
  spec: 'Spec',
};

const MODE_PLACEHOLDERS: Record<MessageMode, string> = {
  send: 'Type a message or /command...',
  steer: '\u2935 Steer: redirect the agent to this task...',
  queue: '\ud83d\udccb Queue: message will be sent after current task...',
  spec: '\ud83d\udcdd Spec: describe the build; I\'ll interview you to refine it...',
};

const MODE_ARIA_LABELS: Record<MessageMode, string> = {
  send: 'Send mode: messages are sent immediately',
  steer: 'Steer mode: interrupt and redirect the agent',
  queue: 'Queue mode: message queued for later processing',
  spec: 'Spec mode: describe a build for specification interview',
};

/**
 * Given the current mode, return the next mode for the keyboard alternate.
 * Matches the Cmd/Ctrl+Enter behavior in src/renderer/index.ts.
 */
function getAlternateMode(current: MessageMode): MessageMode {
  switch (current) {
    case 'send': return 'steer';
    case 'steer': return 'queue';
    case 'queue': return 'spec';
    case 'spec': return 'send';
  }
}

// ─── Adapter ────────────────────────────────────────────────────

/**
 * ComposerWorkbenchAdapter adapts the DraftTransactionStore to the
 * existing production composer UI. It computes derived presentation
 * state without holding independent durable data.
 *
 * All IPC submission still routes through the production channels
 * (`chat-message`, `abort-pipeline`, `msgmode:*`) until typed
 * equivalents pass parity gates.
 */
export class ComposerWorkbenchAdapter {
  private readonly store: DraftTransactionStore;
  private readonly config: ComposerWorkbenchAdapterConfig;
  private readonly settings: ComposerCapabilitySettings;

  /** Currently active message mode */
  private activeMode: MessageMode = 'send';

  constructor(config: ComposerWorkbenchAdapterConfig) {
    this.store = config.store;
    this.config = config;
    this.settings = config.settings ?? DEFAULT_CAPABILITY_SETTINGS;
  }

  // ─── Mode Management ────────────────────────────────────────

  getActiveMode(): MessageMode {
    return this.activeMode;
  }

  setActiveMode(mode: MessageMode): void {
    this.activeMode = mode;
    // Sync to the DraftTransactionStore mode mapping
    const storeMode = this.mapMessageModeToStoreMode(mode);
    this.store.applyChange({ mode: storeMode });
  }

  /**
   * Map legacy message mode to DraftTransactionStore ComposerMode.
   * The store uses 'chat'|'command'|'edit'|'agent'|'plan', while
   * the UI has send/steer/queue/spec. During migration both coexist.
   */
  private mapMessageModeToStoreMode(_mode: MessageMode): 'chat' | 'command' | 'edit' | 'agent' | 'plan' {
    // All legacy modes currently map to 'chat' in the store.
    // The distinction is maintained by the adapter's activeMode field
    // and the IPC submission path rather than the store's mode field.
    return 'chat';
  }

  // ─── State Derivation ───────────────────────────────────────

  /**
   * Compute the full workbench state for rendering.
   * This is the primary entry point for the UI to get presentation data.
   */
  getState(): ComposerWorkbenchState {
    const isBusy = this.config.getIsBusy();
    const isTakeoverActive = this.config.getIsTakeoverActive();
    const projectId = this.config.getProjectId();
    const hasProviders = this.config.getHasProviders();
    const revision = this.store.getCurrentRevision();

    return {
      activeMode: this.activeMode,
      modeControls: this.computeModeControls(isBusy, isTakeoverActive),
      primaryAction: this.computePrimaryAction(isBusy, isTakeoverActive, projectId, hasProviders, revision),
      keyboardAlternate: this.computeKeyboardAlternate(),
      isBusy,
      routeModel: this.computeRouteModel(hasProviders),
      voice: this.computeVoiceState(),
      attachments: this.computeAttachmentCapability(projectId, isTakeoverActive),
      contextItems: this.computeContextItemCapability(projectId, isTakeoverActive),
      activeProjectId: projectId,
      isTakeoverActive,
      text: revision.text,
      revision: revision.revision,
    };
  }

  // ─── Mode Controls ──────────────────────────────────────────

  private computeModeControls(_isBusy: boolean, isTakeoverActive: boolean): ModeControlState[] {
    const modes: MessageMode[] = ['send', 'steer', 'queue', 'spec'];

    return modes.map(mode => {
      const isActive = mode === this.activeMode;
      let disabled = false;
      let disabledReason: string | undefined;

      if (isTakeoverActive) {
        disabled = true;
        disabledReason = 'Decision takeover active — respond to the pending question first';
      }

      return {
        mode,
        label: MODE_LABELS[mode],
        active: isActive,
        disabled,
        disabledReason,
        ariaLabel: MODE_ARIA_LABELS[mode],
        placeholder: MODE_PLACEHOLDERS[mode],
      };
    });
  }

  // ─── Primary Action ─────────────────────────────────────────

  private computePrimaryAction(
    isBusy: boolean,
    isTakeoverActive: boolean,
    projectId: string | undefined,
    hasProviders: boolean,
    revision: DraftRevision,
  ): PrimaryActionState {
    // During busy state, primary action is stop/brain-active
    if (isBusy && (this.activeMode === 'send' || this.activeMode === 'spec')) {
      return {
        kind: 'brain_active',
        label: 'Processing...',
        ariaLabel: 'Agent is processing. Click to stop.',
        disabled: false,
      };
    }

    // Base send state
    let disabled = false;
    let disabledReason: string | undefined;

    if (isTakeoverActive) {
      disabled = true;
      disabledReason = 'Decision takeover active';
    } else if (!hasProviders) {
      disabled = true;
      disabledReason = 'No AI provider configured';
    } else if (!projectId && !revision.text.trim()) {
      disabled = true;
      disabledReason = 'No project selected and no message entered';
    } else if (!revision.text.trim()) {
      disabled = true;
      disabledReason = 'Enter a message to send';
    }

    return {
      kind: 'send',
      label: MODE_LABELS[this.activeMode],
      ariaLabel: `${MODE_LABELS[this.activeMode]} message`,
      disabled,
      disabledReason,
    };
  }

  // ─── Keyboard Alternate ─────────────────────────────────────

  private computeKeyboardAlternate(): KeyboardAlternateAction {
    const targetMode = getAlternateMode(this.activeMode);
    return {
      targetMode,
      label: `${MODE_LABELS[targetMode]} (${process.platform === 'darwin' ? '\u2318' : 'Ctrl'}+Enter)`,
      description: `Send with ${MODE_LABELS[targetMode].toLowerCase()} mode`,
    };
  }

  // ─── Route/Model ────────────────────────────────────────────

  private computeRouteModel(hasProviders: boolean): RouteModelSummary {
    const info = this.config.getRouteModel();

    if (!hasProviders) {
      return {
        displayText: 'No provider',
        available: false,
        disabledReason: 'No AI provider configured. Go to Settings to add one.',
      };
    }

    if (!info) {
      return {
        displayText: 'Default route',
        available: true,
      };
    }

    return {
      provider: info.provider,
      model: info.model,
      displayText: info.model
        ? `${info.provider ?? 'Provider'} / ${info.model}`
        : (info.provider ?? 'Default route'),
      available: true,
    };
  }

  // ─── Voice ──────────────────────────────────────────────────

  private computeVoiceState(): VoiceControlState {
    const availability = this.config.getVoiceAvailability();
    const modelsReady = this.config.getVoiceModelsReady();
    let disabledReason: string | undefined;

    if (availability === 'unavailable') {
      disabledReason = modelsReady
        ? 'Voice input is temporarily unavailable'
        : 'Voice models not downloaded. Go to Settings to download them.';
    }

    return {
      availability,
      disabledReason,
      modelsReady,
    };
  }

  // ─── Attachment Capability ──────────────────────────────────

  private computeAttachmentCapability(
    projectId: string | undefined,
    isTakeoverActive: boolean,
  ): CapabilityControlState {
    if (isTakeoverActive) {
      return {
        id: 'attachments',
        visibility: 'disabled',
        disabledReason: 'Attachments unavailable during decision takeover',
        label: 'Attach files',
        ariaLabel: 'Attach files (unavailable during decision takeover)',
      };
    }

    if (!projectId && this.settings.attachmentsDiscoverable) {
      return {
        id: 'attachments',
        visibility: 'disabled',
        disabledReason: 'Select a project to attach files',
        label: 'Attach files',
        ariaLabel: 'Attach files (select a project first)',
      };
    }

    if (!projectId && !this.settings.attachmentsDiscoverable) {
      return {
        id: 'attachments',
        visibility: 'hidden',
        label: 'Attach files',
        ariaLabel: 'Attach files',
      };
    }

    return {
      id: 'attachments',
      visibility: 'enabled',
      label: 'Attach files',
      ariaLabel: 'Attach files',
    };
  }

  // ─── Context Items Capability ───────────────────────────────

  private computeContextItemCapability(
    projectId: string | undefined,
    isTakeoverActive: boolean,
  ): CapabilityControlState {
    if (isTakeoverActive) {
      return {
        id: 'context-items',
        visibility: 'disabled',
        disabledReason: 'Context unavailable during decision takeover',
        label: 'Add context',
        ariaLabel: 'Add context (unavailable during decision takeover)',
      };
    }

    if (!projectId && this.settings.contextItemsDiscoverable) {
      return {
        id: 'context-items',
        visibility: 'disabled',
        disabledReason: 'Select a project to add context',
        label: 'Add context',
        ariaLabel: 'Add context (select a project first)',
      };
    }

    if (!projectId && !this.settings.contextItemsDiscoverable) {
      return {
        id: 'context-items',
        visibility: 'hidden',
        label: 'Add context',
        ariaLabel: 'Add context',
      };
    }

    return {
      id: 'context-items',
      visibility: 'enabled',
      label: 'Add context',
      ariaLabel: 'Add context',
    };
  }

  // ─── Submission Handling ────────────────────────────────────

  /**
   * Build the IPC payload for submission through legacy channels.
   * This preserves the exact `chat-message` behavior during migration.
   */
  buildSubmissionPayload(): LegacySubmissionPayload | null {
    const revision = this.store.getCurrentRevision();
    const text = revision.text.trim();
    if (!text) return null;

    const projectId = this.config.getProjectId();
    const mode = this.activeMode;
    const images = revision.attachmentDrafts
      .filter(a => a.state === 'ready' || a.state === 'committed')
      .map(a => ({
        fileName: a.filename,
        mimeType: a.mediaType,
        sizeBytes: a.byteSize,
        draftAttachmentId: a.draftAttachmentId,
      }));

    return {
      projectId: projectId ?? null,
      message: text,
      mode,
      images,
      spec: mode === 'spec',
      steer: mode === 'steer',
    };
  }

  /**
   * Determine the IPC channel and method for the current mode.
   */
  getSubmissionRoute(): SubmissionRoute {
    const mode = this.activeMode;
    const isBusy = this.config.getIsBusy();

    if (mode === 'queue') {
      return { channel: 'msgmode:enqueue', method: 'invoke' };
    }

    if (mode === 'steer' && isBusy) {
      return { channel: 'abort-then-send', method: 'send', abortFirst: true };
    }

    return { channel: 'chat-message', method: 'send' };
  }

  /**
   * Determine what Cmd/Ctrl+Enter should do based on current mode.
   * Returns the alternate mode payload (one-time mode override).
   */
  getKeyboardAlternatePayload(): LegacySubmissionPayload | null {
    const originalMode = this.activeMode;
    const alternateMode = getAlternateMode(originalMode);

    // Temporarily override mode for payload construction
    const savedMode = this.activeMode;
    this.activeMode = alternateMode;
    const payload = this.buildSubmissionPayload();
    this.activeMode = savedMode;

    return payload;
  }
}

// ─── Supporting Types ───────────────────────────────────────────

export interface LegacySubmissionPayload {
  projectId: string | null;
  message: string;
  mode: MessageMode;
  images: Array<{
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    draftAttachmentId: string;
  }>;
  spec: boolean;
  steer: boolean;
}

export interface SubmissionRoute {
  channel: string;
  method: 'send' | 'invoke';
  abortFirst?: boolean;
}
