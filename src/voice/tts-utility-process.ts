/**
 * TTS Utility Process Manager — Main process side
 *
 * Manages an Electron utilityProcess that runs ONNX TTS inference in isolation.
 * The main event loop stays free (<16ms latency) while inference runs in its own
 * V8 isolate. Communication uses MessagePort for zero-copy audio buffer transfer.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4
 */

import { utilityProcess, MessageChannelMain, BrowserWindow } from 'electron';
import type { UtilityProcess, MessagePortMain } from 'electron';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

// ─── Types ──────────────────────────────────────────────────────

export interface TTSSynthesizeRequest {
  text: string;
  voiceStyle: string;
  speed: number;
  lang?: string;
  totalSteps?: number;
}

export interface ProcessHealth {
  alive: boolean;
  pid: number | null;
  uptime: number;
  restartCount: number;
  lastError?: string;
}

interface PendingRequest {
  resolve: (buffer: ArrayBuffer) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface TTSProcessManager {
  spawn(): UtilityProcess;
  synthesize(request: TTSSynthesizeRequest): Promise<ArrayBuffer>;
  restart(): Promise<void>;
  getHealthStatus(): ProcessHealth;
  dispose(): void;
}

// ─── Constants ──────────────────────────────────────────────────

const WORKER_MODULE_PATH = path.join(__dirname, 'tts-worker.js');
const SYNTHESIS_TIMEOUT_MS = 30_000;
const RESTART_DELAY_MS = 1_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_WINDOW_MS = 60_000;

// ─── Implementation ─────────────────────────────────────────────

export class TTSUtilityProcessManager extends EventEmitter implements TTSProcessManager {
  private process: UtilityProcess | null = null;
  private port: MessagePortMain | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private spawnTime = 0;
  private restartCount = 0;
  private restartTimestamps: number[] = [];
  private lastError: string | undefined;
  private disposed = false;

  /**
   * Spawn the utility process and establish MessagePort communication.
   */
  spawn(): UtilityProcess {
    if (this.disposed) {
      throw new Error('TTSProcessManager has been disposed');
    }

    this.cleanup();

    // Fork the utility process in its own V8 isolate
    this.process = utilityProcess.fork(WORKER_MODULE_PATH, [], {
      serviceName: 'neuronest-tts-worker',
    });

    this.spawnTime = Date.now();

    // Create a MessageChannel for zero-copy communication
    const { port1, port2 } = new MessageChannelMain();
    this.port = port1;

    // Set up message handling on our end of the port
    this.port.on('message', (event) => {
      this.handleWorkerMessage(event.data);
    });
    this.port.start();

    // Send port2 to the utility process
    this.process.postMessage({ type: 'init' }, [port2]);

    // Handle process exit (crash detection)
    this.process.on('exit', (code) => {
      const wasReady = this.ready;
      this.ready = false;
      this.readyPromise = null;

      if (code !== 0 && !this.disposed) {
        this.lastError = `TTS process exited with code ${code}`;
        this.rejectAllPending(new Error(this.lastError));
        this.notifyUserOfCrash(code);
        this.scheduleRestart();
      } else if (wasReady && !this.disposed) {
        // Clean exit but unexpected — still restart
        this.rejectAllPending(new Error('TTS process exited unexpectedly'));
        this.scheduleRestart();
      }
    });

    // Store the ready promise
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('TTS worker did not signal ready within timeout'));
      }, 10_000);

      const checkReady = () => {
        if (this.ready) {
          clearTimeout(timeout);
          resolve();
        }
      };

      // Poll-free: we'll resolve in handleWorkerMessage when 'ready' arrives
      this.once('worker-ready', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    return this.process;
  }

  /**
   * Synthesize speech from text. Returns the audio buffer (WAV PCM).
   * The buffer is transferred from the utility process via MessagePort (zero-copy).
   */
  async synthesize(request: TTSSynthesizeRequest): Promise<ArrayBuffer> {
    if (this.disposed) {
      throw new Error('TTSProcessManager has been disposed');
    }

    // Auto-spawn if not running
    if (!this.process || !this.port) {
      this.spawn();
    }

    // Wait for worker to be ready
    if (!this.ready && this.readyPromise) {
      await this.readyPromise;
    }

    if (!this.ready || !this.port) {
      throw new Error('TTS worker is not ready');
    }

    const id = this.generateRequestId();

    return new Promise<ArrayBuffer>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`TTS synthesis timed out after ${SYNTHESIS_TIMEOUT_MS}ms`));
      }, SYNTHESIS_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      // Send synthesis request via MessagePort
      this.port!.postMessage({
        type: 'synthesize',
        id,
        payload: {
          text: request.text,
          voiceStyle: request.voiceStyle,
          speed: request.speed,
          lang: request.lang || 'en',
          totalSteps: request.totalSteps || 6,
        },
      });
    });
  }

  /**
   * Restart the utility process (e.g., after model update).
   */
  async restart(): Promise<void> {
    if (this.disposed) {
      throw new Error('TTSProcessManager has been disposed');
    }

    this.cleanup();
    this.spawn();

    // Wait for the new process to be ready
    if (this.readyPromise) {
      await this.readyPromise;
    }
  }

  /**
   * Get current health status of the TTS process.
   */
  getHealthStatus(): ProcessHealth {
    return {
      alive: this.ready && this.process !== null,
      pid: this.process?.pid ?? null,
      uptime: this.spawnTime > 0 ? Date.now() - this.spawnTime : 0,
      restartCount: this.restartCount,
      lastError: this.lastError,
    };
  }

  /**
   * Dispose of the manager and kill the process.
   */
  dispose(): void {
    this.disposed = true;
    this.cleanup();
    this.removeAllListeners();
  }

  // ─── Private Methods ────────────────────────────────────────────

  private handleWorkerMessage(data: any): void {
    if (!data || typeof data !== 'object') return;

    switch (data.type) {
      case 'ready': {
        this.ready = true;
        this.emit('worker-ready');
        break;
      }

      case 'health': {
        const pending = this.pendingRequests.get(data.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(data.id);
          // Health check doesn't return audio — resolve with empty buffer
          pending.resolve(new ArrayBuffer(0));
        }
        break;
      }

      case 'audio': {
        const pending = this.pendingRequests.get(data.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(data.id);
          pending.resolve(data.buffer);
        }
        break;
      }

      case 'error': {
        const pending = this.pendingRequests.get(data.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(data.id);
          pending.reject(new Error(data.error || 'Worker error'));
        }
        this.lastError = data.error;
        break;
      }
    }
  }

  private cleanup(): void {
    this.ready = false;
    this.readyPromise = null;

    // Reject all pending requests
    this.rejectAllPending(new Error('TTS process shutting down'));

    // Close the port
    if (this.port) {
      this.port.close();
      this.port = null;
    }

    // Kill the process
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // Process may already be dead
      }
      this.process = null;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private scheduleRestart(): void {
    if (this.disposed) return;

    const now = Date.now();
    // Track restart timestamps to avoid restart storms
    this.restartTimestamps = this.restartTimestamps.filter(t => now - t < RESTART_WINDOW_MS);

    if (this.restartTimestamps.length >= MAX_RESTART_ATTEMPTS) {
      this.lastError = 'TTS process crashed too many times, not restarting';
      this.emit('restart-failed', this.lastError);
      return;
    }

    this.restartTimestamps.push(now);
    this.restartCount++;

    setTimeout(() => {
      if (!this.disposed) {
        try {
          this.spawn();
        } catch (err: any) {
          this.lastError = `Restart failed: ${err.message}`;
          this.emit('restart-failed', this.lastError);
        }
      }
    }, RESTART_DELAY_MS);
  }

  private notifyUserOfCrash(exitCode: number | null): void {
    // Notify the user via all open BrowserWindows
    const windows = BrowserWindow.getAllWindows();
    const notification = {
      type: 'tts-process-crash',
      message: `Voice synthesis process crashed (exit code: ${exitCode}). Restarting...`,
      exitCode,
      restartCount: this.restartCount + 1,
    };

    for (const win of windows) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('runtime-status-update', notification);
        } catch {
          // Window may be closing
        }
      }
    }

    this.emit('crash', { exitCode, restartCount: this.restartCount });
  }

  private generateRequestId(): string {
    return `tts-${++this.requestCounter}-${Date.now()}`;
  }
}

// ─── Singleton Factory ──────────────────────────────────────────

let instance: TTSUtilityProcessManager | null = null;

/**
 * Get or create the singleton TTS process manager.
 */
export function getTTSProcessManager(): TTSUtilityProcessManager {
  if (!instance) {
    instance = new TTSUtilityProcessManager();
  }
  return instance;
}

/**
 * Dispose the singleton TTS process manager (e.g., on app quit).
 */
export function disposeTTSProcessManager(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
