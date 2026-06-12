/**
 * Terminal panel type definitions.
 * Defines typed boundaries for the terminal emulator module.
 */

/** Unique identifier for a terminal session. */
export type TerminalSessionId = string;

/** Terminal process status. */
export type TerminalStatus = 'starting' | 'running' | 'exited' | 'error';

/** Represents a single terminal session. */
export interface TerminalSession {
  id: TerminalSessionId;
  /** Display label in the tab/selector (e.g., "bash", "zsh"). */
  label: string;
  /** Shell command or executable path. */
  shell: string;
  /** Working directory for the session. */
  cwd: string;
  /** Current session status. */
  status: TerminalStatus;
  /** Exit code when status is 'exited'. */
  exitCode?: number;
  /** Error message when status is 'error'. */
  error?: string;
}

/** Configuration for terminal rendering. */
export interface TerminalConfig {
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  cursorBlink: boolean;
  cursorStyle: 'block' | 'underline' | 'bar';
  scrollback: number;
  theme: TerminalTheme;
}

/** Terminal color theme. */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

/** Default terminal configuration. */
export const DEFAULT_TERMINAL_CONFIG: TerminalConfig = {
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  lineHeight: 1.4,
  cursorBlink: true,
  cursorStyle: 'block',
  scrollback: 5000,
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#ffffff',
    selectionBackground: '#264f78',
  },
};

/** Request to create a new terminal session. */
export interface CreateTerminalRequest {
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** Response from creating a terminal session. */
export interface CreateTerminalResponse {
  success: boolean;
  session?: TerminalSession;
  error?: string;
}

/** Request to write data to a terminal session. */
export interface TerminalWriteRequest {
  sessionId: TerminalSessionId;
  data: string;
}

/** Request to resize a terminal session. */
export interface TerminalResizeRequest {
  sessionId: TerminalSessionId;
  cols: number;
  rows: number;
}

/** Events emitted by the terminal service. */
export type TerminalServiceEvent =
  | { type: 'data'; sessionId: TerminalSessionId; data: string }
  | { type: 'exit'; sessionId: TerminalSessionId; exitCode: number }
  | { type: 'error'; sessionId: TerminalSessionId; error: string };

/** Listener for terminal service events. */
export type TerminalServiceListener = (event: TerminalServiceEvent) => void;
