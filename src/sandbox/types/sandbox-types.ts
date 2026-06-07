// ─── Sandbox_Manager Types ──────────────────────────────────────
// Type definitions for the sandboxed code execution environment.

export type SandboxBackend = 'local' | 'docker';

export interface SandboxSession {
  id: string;
  backend: SandboxBackend;
  uploadsDir: string;
  workspaceDir: string;
  outputsDir: string;
  status: 'running' | 'completed' | 'timed_out' | 'error';
  createdAt: Date;
  timeoutMs: number;
}

export interface SandboxResult {
  sessionId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  outputFiles: string[];
}
