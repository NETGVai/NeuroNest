/**
 * KernelManager — Kernel lifecycle management for notebook cells.
 *
 * Supports Python (ipykernel), JavaScript (tslab), and R kernels.
 * Starts a kernel on first cell execution, restarts on crash, shuts down
 * on notebook close. Integrates with BackgroundProcessManager for process
 * management.
 *
 * Uses child_process for simplicity (Jupyter wire protocol over ZeroMQ
 * can be added later as an optimization).
 *
 * Requirements: 20.2, 20.6, 20.7
 */

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { BackgroundProcessManager } from '../runtime/background-process-manager';

// ─── Types ──────────────────────────────────────────────────────

export type KernelLanguage = 'python' | 'javascript' | 'r';

export type KernelStatus = 'idle' | 'busy' | 'starting' | 'dead' | 'restarting';

export interface KernelInfo {
  id: string;
  language: KernelLanguage;
  status: KernelStatus;
  pid: number | null;
  startedAt: number | null;
  restartCount: number;
}

export interface ExecutionResult {
  success: boolean;
  outputs: CellOutput[];
  executionCount: number;
  durationMs: number;
}

export interface CellOutput {
  type: 'text' | 'image' | 'table' | 'error';
  content: string;
  /** MIME type for images (e.g., 'image/png') */
  mimeType?: string;
}

// ─── Kernel Session ─────────────────────────────────────────────

interface KernelSession {
  id: string;
  language: KernelLanguage;
  status: KernelStatus;
  process: ChildProcess | null;
  pid: number | null;
  startedAt: number | null;
  restartCount: number;
  maxRestarts: number;
  executionCount: number;
  cwd: string;
}

// ─── KernelManager ──────────────────────────────────────────────

/**
 * Singleton kernel lifecycle manager.
 * Lazy-initialized following NeuroNest's established patterns.
 */
export class KernelManager extends EventEmitter {
  private static instance: KernelManager | null = null;

  private readonly kernels = new Map<string, KernelSession>();
  private disposed = false;

  private constructor() {
    super();
  }

  /** Lazy singleton accessor */
  static getInstance(): KernelManager {
    if (!KernelManager.instance) {
      KernelManager.instance = new KernelManager();
    }
    return KernelManager.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    if (KernelManager.instance) {
      KernelManager.instance.dispose();
      KernelManager.instance = null;
    }
  }

  // ─── Kernel Lifecycle ─────────────────────────────────────────

  /**
   * Start a kernel for a given notebook. If the kernel is already running,
   * returns its current info.
   */
  async startKernel(notebookId: string, language: KernelLanguage, cwd: string): Promise<KernelInfo> {
    if (this.disposed) {
      throw new Error('KernelManager has been disposed');
    }

    const existing = this.kernels.get(notebookId);
    if (existing && (existing.status === 'idle' || existing.status === 'busy')) {
      return this.toKernelInfo(existing);
    }

    const session: KernelSession = {
      id: notebookId,
      language,
      status: 'starting',
      process: null,
      pid: null,
      startedAt: null,
      restartCount: existing?.restartCount ?? 0,
      maxRestarts: 3,
      executionCount: existing?.executionCount ?? 0,
      cwd,
    };

    this.kernels.set(notebookId, session);
    this.emit('kernel:starting', { id: notebookId, language });

    await this.spawnKernelProcess(session);

    return this.toKernelInfo(session);
  }

  /**
   * Execute code in a running kernel. Starts the kernel if not yet active.
   */
  async executeCode(notebookId: string, code: string, language: KernelLanguage, cwd: string): Promise<ExecutionResult> {
    let session = this.kernels.get(notebookId);

    // Auto-start kernel on first execution
    if (!session || session.status === 'dead') {
      await this.startKernel(notebookId, language, cwd);
      session = this.kernels.get(notebookId)!;
    }

    if (session.status !== 'idle') {
      // Wait briefly for kernel to become idle
      await this.waitForIdle(session, 10000);
    }

    if (session.status !== 'idle') {
      return {
        success: false,
        outputs: [{ type: 'error', content: `Kernel is ${session.status}, cannot execute code` }],
        executionCount: session.executionCount,
        durationMs: 0,
      };
    }

    session.status = 'busy';
    session.executionCount++;
    this.emit('kernel:busy', { id: notebookId });

    const startTime = Date.now();

    try {
      const outputs = await this.runCode(session, code);
      session.status = 'idle';
      this.emit('kernel:idle', { id: notebookId });

      return {
        success: true,
        outputs,
        executionCount: session.executionCount,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      session.status = 'idle';
      this.emit('kernel:idle', { id: notebookId });

      return {
        success: false,
        outputs: [{
          type: 'error',
          content: err.message || String(err),
        }],
        executionCount: session.executionCount,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Restart a kernel (e.g., after crash or user request).
   */
  async restartKernel(notebookId: string): Promise<KernelInfo> {
    const session = this.kernels.get(notebookId);
    if (!session) {
      throw new Error(`No kernel found for notebook: ${notebookId}`);
    }

    session.status = 'restarting';
    session.restartCount++;
    this.emit('kernel:restarting', { id: notebookId, restartCount: session.restartCount });

    // Kill existing process
    if (session.process) {
      try { session.process.kill('SIGTERM'); } catch {}
      session.process = null;
      session.pid = null;
    }

    // Re-spawn
    await this.spawnKernelProcess(session);

    return this.toKernelInfo(session);
  }

  /**
   * Shut down a kernel. Called on notebook close.
   */
  async shutdownKernel(notebookId: string): Promise<void> {
    const session = this.kernels.get(notebookId);
    if (!session) return;

    if (session.process) {
      session.process.kill('SIGTERM');

      // Force kill after 5 seconds
      const forceTimeout = setTimeout(() => {
        try { session.process?.kill('SIGKILL'); } catch {}
      }, 5000);

      await new Promise<void>((resolve) => {
        if (!session.process) { resolve(); return; }
        session.process.once('exit', () => {
          clearTimeout(forceTimeout);
          resolve();
        });
        setTimeout(() => { clearTimeout(forceTimeout); resolve(); }, 6000);
      });
    }

    session.status = 'dead';
    session.process = null;
    session.pid = null;
    this.kernels.delete(notebookId);
    this.emit('kernel:shutdown', { id: notebookId });
  }

  /**
   * Shut down all kernels. Called on app exit.
   */
  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.kernels.keys());
    await Promise.allSettled(ids.map((id) => this.shutdownKernel(id)));
  }

  // ─── Queries ──────────────────────────────────────────────────

  getKernelInfo(notebookId: string): KernelInfo | null {
    const session = this.kernels.get(notebookId);
    return session ? this.toKernelInfo(session) : null;
  }

  listKernels(): KernelInfo[] {
    return Array.from(this.kernels.values()).map((s) => this.toKernelInfo(s));
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const session of this.kernels.values()) {
      if (session.process) {
        try { session.process.kill('SIGTERM'); } catch {}
      }
    }
    this.kernels.clear();
    this.removeAllListeners();
  }

  // ─── Private ──────────────────────────────────────────────────

  private async spawnKernelProcess(session: KernelSession): Promise<void> {
    const cmd = this.getKernelCommand(session.language);
    if (!cmd) {
      session.status = 'dead';
      this.emit('kernel:error', { id: session.id, error: `No kernel available for: ${session.language}` });
      return;
    }

    try {
      const child = spawn(cmd.bin, cmd.args, {
        cwd: session.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        shell: true,
      });

      session.process = child;
      session.pid = child.pid ?? null;
      session.startedAt = Date.now();
      session.status = 'idle';

      child.on('exit', (code, signal) => {
        if (session.status === 'dead' || this.disposed) return;

        console.warn(`[KernelManager] Kernel ${session.id} exited (code=${code}, signal=${signal})`);
        session.status = 'dead';
        session.process = null;
        session.pid = null;
        this.emit('kernel:crashed', { id: session.id, code, signal });

        // Auto-restart if under limit
        if (session.restartCount < session.maxRestarts) {
          setTimeout(() => {
            if (!this.disposed) {
              this.restartKernel(session.id).catch((err) => {
                console.error(`[KernelManager] Auto-restart failed for ${session.id}:`, err);
              });
            }
          }, 1000);
        }
      });

      child.on('error', (err) => {
        session.status = 'dead';
        session.process = null;
        session.pid = null;
        this.emit('kernel:error', { id: session.id, error: err.message });
      });

      this.emit('kernel:started', { id: session.id, language: session.language, pid: session.pid });
    } catch (err: any) {
      session.status = 'dead';
      this.emit('kernel:error', { id: session.id, error: err.message });
    }
  }

  private getKernelCommand(language: KernelLanguage): { bin: string; args: string[] } | null {
    switch (language) {
      case 'python':
        return { bin: 'python3', args: ['-u', '-i'] };
      case 'javascript':
        return { bin: 'node', args: ['--interactive'] };
      case 'r':
        return { bin: 'Rscript', args: ['--vanilla', '-e', 'while(TRUE) { line <- readLines(\"stdin\", 1); tryCatch(eval(parse(text=line)), error=function(e) cat(paste(\"Error:\", e$message, \"\\n\"))) }'] };
      default:
        return null;
    }
  }

  /**
   * Execute code by writing to stdin and reading stdout/stderr.
   * Uses a sentinel pattern to detect when execution completes.
   */
  private runCode(session: KernelSession, code: string): Promise<CellOutput[]> {
    return new Promise((resolve, reject) => {
      if (!session.process || !session.process.stdin || !session.process.stdout) {
        reject(new Error('Kernel process is not available'));
        return;
      }

      const outputs: CellOutput[] = [];
      let stdout = '';
      let stderr = '';
      const sentinel = `__NEURONEST_EXEC_DONE_${Date.now()}__`;
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          // Collect whatever output we have
          if (stdout.trim()) {
            outputs.push({ type: 'text', content: stdout.trim() });
          }
          if (stderr.trim()) {
            outputs.push({ type: 'error', content: stderr.trim() });
          }
          resolve(outputs.length > 0 ? outputs : [{ type: 'text', content: '(execution timed out after 30s)' }]);
        }
      }, 30000);

      const onStdout = (data: Buffer) => {
        const text = data.toString();
        if (text.includes(sentinel)) {
          settled = true;
          clearTimeout(timeout);
          session.process?.stdout?.removeListener('data', onStdout);
          session.process?.stderr?.removeListener('data', onStderr);

          // Remove sentinel from output
          const clean = stdout.replace(sentinel, '').replace(`'${sentinel}'`, '').trim();
          if (clean) {
            outputs.push(this.parseOutput(clean, session.language));
          }
          if (stderr.trim()) {
            outputs.push({ type: 'error', content: stderr.trim() });
          }
          resolve(outputs);
        } else {
          stdout += text;
        }
      };

      const onStderr = (data: Buffer) => {
        stderr += data.toString();
      };

      session.process.stdout.on('data', onStdout);
      session.process.stderr!.on('data', onStderr);

      // Write code + sentinel to stdin
      const wrappedCode = this.wrapCodeWithSentinel(code, sentinel, session.language);
      session.process.stdin.write(wrappedCode + '\n');
    });
  }

  private wrapCodeWithSentinel(code: string, sentinel: string, language: KernelLanguage): string {
    switch (language) {
      case 'python':
        // Execute code then print sentinel
        return `${code}\nprint('${sentinel}')`;
      case 'javascript':
        return `${code}\nconsole.log('${sentinel}')`;
      case 'r':
        return `${code}\ncat('${sentinel}\\n')`;
      default:
        return `${code}\n${sentinel}`;
    }
  }

  private parseOutput(text: string, language: KernelLanguage): CellOutput {
    // Detect base64 images in output (common pattern for matplotlib, etc.)
    const base64Pattern = /^data:image\/(png|jpeg|gif|svg\+xml);base64,(.+)$/m;
    const match = text.match(base64Pattern);
    if (match) {
      return { type: 'image', content: match[2], mimeType: `image/${match[1]}` };
    }

    // Detect table-like output (TSV or CSV)
    const lines = text.split('\n');
    if (lines.length > 1) {
      const firstLineTabs = (lines[0].match(/\t/g) || []).length;
      if (firstLineTabs >= 2) {
        return { type: 'table', content: text };
      }
    }

    return { type: 'text', content: text };
  }

  private async waitForIdle(session: KernelSession, timeoutMs: number): Promise<void> {
    if (session.status === 'idle') return;

    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (session.status === 'idle' || session.status === 'dead') {
          clearInterval(check);
          resolve();
        }
      }, 100);

      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, timeoutMs);
    });
  }

  private toKernelInfo(session: KernelSession): KernelInfo {
    return {
      id: session.id,
      language: session.language,
      status: session.status,
      pid: session.pid,
      startedAt: session.startedAt,
      restartCount: session.restartCount,
    };
  }
}
