/**
 * Centralized type definitions for common IPC argument shapes.
 *
 * Many IPC handlers in src/main/ipc.ts accept loosely-typed `arg: any` parameters.
 * This file provides typed alternatives so handlers can opt in to compile-time safety.
 *
 * Convention: name types after the IPC channel they belong to.
 * Example: `voice:set-config` → `VoiceSetConfigArgs`
 */

// ── Voice TTS ──────────────────────────────────────────────────

export interface VoiceGetConfigResult {
  enabled: boolean;
  modelsReady: boolean;
  largeModelsDownloaded: boolean;
  voices: string[];
  voiceStyle: string;
  speed: number;
  provider?: string;
}

export interface VoiceSetConfigArgs {
  enabled?: boolean;
  voiceStyle?: string;
  speed?: number;
}

export interface VoiceSynthesizeArgs {
  text: string;
  voiceStyle?: string;
  speed?: number;
  lang?: string;
}

export interface VoiceSynthesizeResult {
  success: boolean;
  audio?: string;       // base64-encoded WAV
  sampleRate?: number;
  text?: string;        // for Web Speech fallback
  useWebSpeech?: boolean;
  error?: string;
}

export interface VoiceDownloadProgress {
  phase: 'preparing' | 'downloading' | 'complete' | 'error';
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
  currentFile: string;
  message: string;
}

// ── Project / File operations ──────────────────────────────────

export interface ProjectIdArg {
  projectId: string;
}

export interface ReadProjectFileArgs {
  projectId: string;
  filePath: string;
  openInExplorer?: boolean;
  getAbsolutePath?: boolean;
}

export interface SaveProjectFileArgs {
  projectId: string;
  filePath: string;
  content: string;
}

export interface ProjectFileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: ProjectFileEntry[];
}

// ── Chat / Messages ────────────────────────────────────────────

export interface ChatMessageArgs {
  message: string;
  projectId?: string;
  /** When true, message is sent to the LLM but not stored in chat history. */
  ephemeral?: boolean;
}

export interface AgentMeta {
  /** Display name of the agent or sender. */
  label?: string;
  /** Provider identifier (e.g., 'openai', 'anthropic', 'ollama'). */
  provider?: string;
  /** Model identifier (e.g., 'gpt-4', 'claude-3-opus'). */
  model?: string;
  /** Emoji avatar for the agent. */
  emoji?: string;
  /** Message type — 'command' for system status, default is regular content. */
  type?: 'command' | 'message' | 'thinking';
}

// ── Generic IPC result wrapper ─────────────────────────────────

export interface IpcResult<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

// ── Type guards (runtime validation helpers) ───────────────────

export function isVoiceSetConfigArgs(x: unknown): x is VoiceSetConfigArgs {
  if (!x || typeof x !== 'object') return false;
  const a = x as VoiceSetConfigArgs;
  if (a.enabled !== undefined && typeof a.enabled !== 'boolean') return false;
  if (a.voiceStyle !== undefined && typeof a.voiceStyle !== 'string') return false;
  if (a.speed !== undefined && typeof a.speed !== 'number') return false;
  return true;
}

export function isVoiceSynthesizeArgs(x: unknown): x is VoiceSynthesizeArgs {
  if (!x || typeof x !== 'object') return false;
  const a = x as VoiceSynthesizeArgs;
  return typeof a.text === 'string' && a.text.length > 0;
}

export function isProjectIdArg(x: unknown): x is ProjectIdArg {
  if (!x || typeof x !== 'object') return false;
  return typeof (x as ProjectIdArg).projectId === 'string';
}
