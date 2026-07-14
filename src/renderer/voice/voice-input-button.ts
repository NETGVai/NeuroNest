/**
 * VoiceInputButton — Microphone button component for the chat input area.
 *
 * Provides a toggle button that starts/stops voice recording.
 * Displays different visual states: idle, recording, transcribing.
 *
 * Uses Vanilla JS + DOM manipulation per project renderer patterns.
 *
 * Requirements: 18.3, 18.4
 */

// ─── Types ──────────────────────────────────────────────────────

/** Visual state of the voice input button */
export type VoiceButtonState = 'idle' | 'recording' | 'transcribing' | 'disabled';

/** Callback when the button is clicked */
export type VoiceButtonClickCallback = () => void;

/** Configuration for the voice input button */
export interface VoiceInputButtonConfig {
  /** Size of the button in pixels (default: 32) */
  size: number;
  /** Tooltip text when idle (default: 'Start voice input') */
  tooltipIdle: string;
  /** Tooltip text when recording (default: 'Stop recording') */
  tooltipRecording: string;
  /** Tooltip text when transcribing (default: 'Transcribing...') */
  tooltipTranscribing: string;
}

// ─── Constants ──────────────────────────────────────────────────

export const DEFAULT_VOICE_BUTTON_CONFIG: VoiceInputButtonConfig = {
  size: 32,
  tooltipIdle: 'Start voice input',
  tooltipRecording: 'Stop recording',
  tooltipTranscribing: 'Transcribing...',
};

/** SVG icon for microphone (idle state) */
export const MIC_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`;

/** SVG icon for stop (recording state) */
export const STOP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

/** SVG icon for loading/transcribing state */
export const LOADING_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="voice-btn-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

/** CSS styles for the voice input button */
export const VOICE_BUTTON_STYLES = `
.voice-input-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #9ca3af);
  cursor: pointer;
  transition: all 0.15s ease;
  padding: 4px;
}

.voice-input-btn:hover {
  background: var(--bg-hover, #374151);
  color: var(--text-primary, #f3f4f6);
}

.voice-input-btn:focus-visible {
  outline: 2px solid var(--focus-ring, #3b82f6);
  outline-offset: 2px;
}

.voice-input-btn[data-state="recording"] {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
  animation: voice-btn-pulse 1.5s ease-in-out infinite;
}

.voice-input-btn[data-state="transcribing"] {
  color: var(--text-secondary, #9ca3af);
  cursor: wait;
}

.voice-input-btn[data-state="disabled"] {
  color: var(--text-disabled, #6b7280);
  cursor: not-allowed;
  opacity: 0.5;
}

@keyframes voice-btn-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.3); }
  50% { box-shadow: 0 0 0 4px rgba(239, 68, 68, 0); }
}

.voice-btn-spin {
  animation: voice-btn-spin-anim 1s linear infinite;
}

@keyframes voice-btn-spin-anim {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
`;

// ─── VoiceInputButton Class ─────────────────────────────────────

/**
 * Microphone button for the chat input area.
 *
 * Displays a microphone icon that toggles voice recording when clicked.
 * Changes appearance based on state (idle/recording/transcribing).
 *
 * Usage:
 *   const button = new VoiceInputButton();
 *   chatInputArea.appendChild(button.getElement());
 *   button.onClick(() => { toggleRecording(); });
 *   button.setState('recording');
 */
export class VoiceInputButton {
  private config: VoiceInputButtonConfig;
  private button: HTMLButtonElement;
  private state: VoiceButtonState = 'idle';
  private clickCallback: VoiceButtonClickCallback | null = null;
  private stylesInjected = false;

  constructor(config?: Partial<VoiceInputButtonConfig>) {
    this.config = { ...DEFAULT_VOICE_BUTTON_CONFIG, ...config };

    this.button = document.createElement('button');
    this.button.className = 'voice-input-btn';
    this.button.setAttribute('data-state', 'idle');
    this.button.setAttribute('type', 'button');
    this.button.setAttribute('aria-label', this.config.tooltipIdle);
    this.button.setAttribute('title', this.config.tooltipIdle);
    this.button.style.width = `${this.config.size}px`;
    this.button.style.height = `${this.config.size}px`;
    this.button.innerHTML = MIC_ICON_SVG;

    this.button.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.state === 'disabled' || this.state === 'transcribing') return;
      this.clickCallback?.();
    });

    this.injectStyles();
  }

  /**
   * Get the button DOM element.
   */
  getElement(): HTMLButtonElement {
    return this.button;
  }

  /**
   * Get the current button state.
   */
  getState(): VoiceButtonState {
    return this.state;
  }

  /**
   * Set the button visual state.
   *
   * @param state - New state to display
   */
  setState(state: VoiceButtonState): void {
    this.state = state;
    this.button.setAttribute('data-state', state);

    switch (state) {
      case 'idle':
        this.button.innerHTML = MIC_ICON_SVG;
        this.button.setAttribute('aria-label', this.config.tooltipIdle);
        this.button.setAttribute('title', this.config.tooltipIdle);
        this.button.disabled = false;
        break;
      case 'recording':
        this.button.innerHTML = STOP_ICON_SVG;
        this.button.setAttribute('aria-label', this.config.tooltipRecording);
        this.button.setAttribute('title', this.config.tooltipRecording);
        this.button.disabled = false;
        break;
      case 'transcribing':
        this.button.innerHTML = LOADING_ICON_SVG;
        this.button.setAttribute('aria-label', this.config.tooltipTranscribing);
        this.button.setAttribute('title', this.config.tooltipTranscribing);
        this.button.disabled = true;
        break;
      case 'disabled':
        this.button.innerHTML = MIC_ICON_SVG;
        this.button.setAttribute('aria-label', 'Voice input unavailable');
        this.button.setAttribute('title', 'Voice input unavailable');
        this.button.disabled = true;
        break;
    }
  }

  /**
   * Register a click callback.
   *
   * @param callback - Called when the button is clicked (and not disabled)
   */
  onClick(callback: VoiceButtonClickCallback): void {
    this.clickCallback = callback;
  }

  /**
   * Dispose the button — remove from DOM and clean up.
   */
  dispose(): void {
    this.button.remove();
    this.clickCallback = null;
  }

  // ─── Internal Methods ─────────────────────────────────────────

  /** Inject CSS styles into the document head (once) */
  private injectStyles(): void {
    if (this.stylesInjected) return;
    if (typeof document === 'undefined') return;

    const existingStyle = document.getElementById('voice-input-btn-styles');
    if (existingStyle) {
      this.stylesInjected = true;
      return;
    }

    const style = document.createElement('style');
    style.id = 'voice-input-btn-styles';
    style.textContent = VOICE_BUTTON_STYLES;
    document.head.appendChild(style);
    this.stylesInjected = true;
  }
}
