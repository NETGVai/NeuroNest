/**
 * Renderer voice input module — barrel export.
 *
 * Provides the complete renderer-side voice input integration:
 * - VoiceIpcClient: IPC communication with main process
 * - WaveformVisualizer: Real-time audio level visualization
 * - VoiceInputButton: Microphone button UI component
 * - VoiceInputController: Full workflow orchestrator with hotkey support
 *
 * Requirements: 18.3, 18.4
 */

export {
  VoiceIpcClient,
  getVoiceIpcClient,
  resetVoiceIpcClient,
  type VoiceCaptureMode,
  type VoiceStatus,
  type StartCapturePayload,
  type StartCaptureResponse,
  type StopCaptureResponse,
  type TranscribeResponse,
  type VoiceStatusInfo,
  type AudioLevelUpdate,
} from './voice-ipc-client';

export {
  WaveformVisualizer,
  DEFAULT_WAVEFORM_CONFIG,
  WAVEFORM_STYLES,
  type WaveformVisualizerConfig,
  type StopCallback,
} from './waveform-visualizer';

export {
  VoiceInputButton,
  DEFAULT_VOICE_BUTTON_CONFIG,
  VOICE_BUTTON_STYLES,
  MIC_ICON_SVG,
  STOP_ICON_SVG,
  LOADING_ICON_SVG,
  type VoiceButtonState,
  type VoiceButtonClickCallback,
  type VoiceInputButtonConfig,
} from './voice-input-button';

export {
  VoiceInputController,
  getVoiceInputController,
  resetVoiceInputController,
  DEFAULT_HOTKEY,
  DEFAULT_CONTROLLER_CONFIG,
  type VoiceInputControllerConfig,
  type VoiceInputControllerEvents,
  type HotkeyBinding,
} from './voice-input-controller';
