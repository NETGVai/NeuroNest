/**
 * Terminal service — IPC wrappers for shell/terminal operations.
 * Communicates with the main process to create, write to, resize,
 * and destroy terminal sessions.
 */

import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalResizeRequest,
  TerminalServiceEvent,
  TerminalServiceListener,
  TerminalSessionId,
  TerminalWriteRequest,
} from './types';

/** IPC channels used by the terminal service. */
const IPC_CHANNELS = {
  CREATE: 'terminal:create',
  WRITE: 'terminal:write',
  RESIZE: 'terminal:resize',
  DESTROY: 'terminal:destroy',
  DATA: 'terminal:data',
  EXIT: 'terminal:exit',
  ERROR: 'terminal:error',
} as const;

/**
 * Typed wrapper around the preload-exposed IPC bridge.
 * Falls back to no-op if the bridge is unavailable (e.g. in unit tests).
 */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  off: (channel: string, callback: (...args: unknown[]) => void) => void;
} {
  const bridge = (window as unknown as Record<string, unknown>)['electronAPI'] as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on?: (channel: string, callback: (...args: unknown[]) => void) => void;
    off?: (channel: string, callback: (...args: unknown[]) => void) => void;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
    on: bridge?.on ?? (() => {}),
    off: bridge?.off ?? (() => {}),
  };
}

/**
 * TerminalService manages terminal session lifecycle via IPC.
 * Handles data streaming from the main process pty back to the renderer.
 */
export class TerminalService {
  private listeners: Set<TerminalServiceListener> = new Set();
  private dataHandler: ((...args: unknown[]) => void) | null = null;
  private exitHandler: ((...args: unknown[]) => void) | null = null;
  private errorHandler: ((...args: unknown[]) => void) | null = null;
  private started = false;

  /** Start listening for terminal events from the main process. */
  start(): void {
    if (this.started) return;
    this.started = true;

    const bridge = getIpcBridge();

    this.dataHandler = (...args: unknown[]) => {
      const data = args[0] as { sessionId: string; data: string } | undefined;
      if (data?.sessionId && data.data !== undefined) {
        this.emit({ type: 'data', sessionId: data.sessionId, data: data.data });
      }
    };

    this.exitHandler = (...args: unknown[]) => {
      const data = args[0] as { sessionId: string; exitCode: number } | undefined;
      if (data?.sessionId !== undefined) {
        this.emit({ type: 'exit', sessionId: data.sessionId, exitCode: data.exitCode ?? 0 });
      }
    };

    this.errorHandler = (...args: unknown[]) => {
      const data = args[0] as { sessionId: string; error: string } | undefined;
      if (data?.sessionId) {
        this.emit({ type: 'error', sessionId: data.sessionId, error: data.error ?? 'Unknown error' });
      }
    };

    bridge.on(IPC_CHANNELS.DATA, this.dataHandler);
    bridge.on(IPC_CHANNELS.EXIT, this.exitHandler);
    bridge.on(IPC_CHANNELS.ERROR, this.errorHandler);
  }

  /** Stop listening for terminal events and clean up. */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    const bridge = getIpcBridge();

    if (this.dataHandler) {
      bridge.off(IPC_CHANNELS.DATA, this.dataHandler);
      this.dataHandler = null;
    }
    if (this.exitHandler) {
      bridge.off(IPC_CHANNELS.EXIT, this.exitHandler);
      this.exitHandler = null;
    }
    if (this.errorHandler) {
      bridge.off(IPC_CHANNELS.ERROR, this.errorHandler);
      this.errorHandler = null;
    }
  }

  /** Subscribe to terminal service events. Returns an unsubscribe function. */
  subscribe(listener: TerminalServiceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Create a new terminal session via IPC. */
  async createSession(request: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const bridge = getIpcBridge();
    try {
      const result = await bridge.invoke(IPC_CHANNELS.CREATE, request);
      return (result as CreateTerminalResponse) ?? { success: false, error: 'No response from main process' };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error creating terminal';
      return { success: false, error: errorMessage };
    }
  }

  /** Write data (keystrokes) to a terminal session. */
  async write(request: TerminalWriteRequest): Promise<void> {
    const bridge = getIpcBridge();
    await bridge.invoke(IPC_CHANNELS.WRITE, request);
  }

  /** Resize a terminal session. */
  async resize(request: TerminalResizeRequest): Promise<void> {
    const bridge = getIpcBridge();
    await bridge.invoke(IPC_CHANNELS.RESIZE, request);
  }

  /** Destroy (kill) a terminal session. */
  async destroySession(sessionId: TerminalSessionId): Promise<void> {
    const bridge = getIpcBridge();
    await bridge.invoke(IPC_CHANNELS.DESTROY, { sessionId });
  }

  /** Emit an event to all registered listeners. */
  private emit(event: TerminalServiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors to prevent cascading failures.
      }
    }
  }
}
