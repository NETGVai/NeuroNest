/**
 * Editor panel type definitions.
 * Defines typed boundaries for the Monaco editor module's internal and external contracts.
 */

/** Unique identifier for an editor tab (typically a file path). */
export type TabId = string;

/** Supported language modes for syntax highlighting. */
export type LanguageId =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'html'
  | 'css'
  | 'markdown'
  | 'python'
  | 'plaintext';

/** Represents the state of a single open file in the editor. */
export interface FileState {
  /** Absolute file path on disk. */
  filePath: string;
  /** Current content in the editor buffer. */
  content: string;
  /** Content as last saved to disk. */
  savedContent: string;
  /** Detected or assigned language mode. */
  language: LanguageId;
  /** Whether the buffer has unsaved modifications. */
  isDirty: boolean;
  /** Cursor line position (1-based). */
  cursorLine: number;
  /** Cursor column position (1-based). */
  cursorColumn: number;
  /** Scroll position top in pixels. */
  scrollTop: number;
}

/** Represents a tab in the editor tab bar. */
export interface EditorTab {
  /** Unique identifier (typically file path). */
  id: TabId;
  /** Display label (file name). */
  label: string;
  /** Full file path for tooltip. */
  filePath: string;
  /** Whether the file has unsaved changes. */
  isDirty: boolean;
  /** Whether this tab is currently active/focused. */
  isActive: boolean;
}

/** Configuration for the Monaco editor instance. */
export interface EditorConfig {
  /** Font size in pixels. */
  fontSize: number;
  /** Tab size in spaces. */
  tabSize: number;
  /** Whether to use spaces instead of tabs. */
  insertSpaces: boolean;
  /** Whether word wrap is enabled. */
  wordWrap: 'on' | 'off' | 'wordWrapColumn';
  /** Word wrap column (when wordWrap is 'wordWrapColumn'). */
  wordWrapColumn: number;
  /** Whether minimap is visible. */
  minimap: boolean;
  /** Whether line numbers are displayed. */
  lineNumbers: 'on' | 'off' | 'relative';
  /** Theme identifier ('vs-dark' or 'vs'). */
  theme: 'vs-dark' | 'vs';
}

/** Default editor configuration. */
export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  fontSize: 14,
  tabSize: 2,
  insertSpaces: true,
  wordWrap: 'off',
  wordWrapColumn: 80,
  minimap: true,
  lineNumbers: 'on',
  theme: 'vs-dark',
};

/** Payload for opening a file in the editor via IPC. */
export interface OpenFileRequest {
  filePath: string;
}

/** Response after reading a file's content. */
export interface OpenFileResponse {
  success: boolean;
  filePath: string;
  content?: string;
  language?: LanguageId;
  error?: string;
}

/** Payload for saving a file via IPC. */
export interface SaveFileRequest {
  filePath: string;
  content: string;
}

/** Response after saving a file. */
export interface SaveFileResponse {
  success: boolean;
  filePath: string;
  error?: string;
}

/** Events emitted by the editor service layer. */
export type EditorServiceEvent =
  | { type: 'file-opened'; filePath: string; content: string; language: LanguageId }
  | { type: 'file-saved'; filePath: string }
  | { type: 'file-save-error'; filePath: string; error: string }
  | { type: 'file-changed-externally'; filePath: string }
  | { type: 'file-deleted-externally'; filePath: string };

/** Listener callback for editor service events. */
export type EditorServiceListener = (event: EditorServiceEvent) => void;

/** Cursor position within the editor. */
export interface CursorPosition {
  line: number;
  column: number;
}

/** Selection range within the editor. */
export interface SelectionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** Editor viewport information. */
export interface ViewportInfo {
  startLine: number;
  endLine: number;
  scrollTop: number;
}

/** Events emitted by the editor core. */
export type EditorCoreEvent =
  | { type: 'content-changed'; filePath: string; content: string }
  | { type: 'cursor-changed'; position: CursorPosition }
  | { type: 'selection-changed'; selection: SelectionRange | null }
  | { type: 'focus'; }
  | { type: 'blur'; };

/** Listener callback for editor core events. */
export type EditorCoreListener = (event: EditorCoreEvent) => void;
