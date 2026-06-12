/**
 * Editor service — IPC wrappers for file operations.
 * Provides a typed interface for opening, saving, and watching files
 * via the main process IPC bridge.
 */

import type {
  EditorServiceEvent,
  EditorServiceListener,
  LanguageId,
  OpenFileRequest,
  OpenFileResponse,
  SaveFileRequest,
  SaveFileResponse,
} from './types';

/** File extension to language mapping. */
const EXTENSION_LANGUAGE_MAP: Record<string, LanguageId> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.py': 'python',
};

/**
 * Detects the language mode from a file path based on extension.
 */
export function detectLanguage(filePath: string): LanguageId {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? 'plaintext';
}

/**
 * Extracts the file name from a full file path.
 */
export function getFileName(filePath: string): string {
  const separatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return separatorIndex >= 0 ? filePath.slice(separatorIndex + 1) : filePath;
}

/**
 * EditorService manages file I/O via IPC.
 * It communicates with the main process for reading, writing, and watching files.
 */
export class EditorService {
  private listeners: Set<EditorServiceListener> = new Set();
  private fileWatcherCleanups: Map<string, () => void> = new Map();

  /**
   * Opens a file by reading its content from the main process.
   */
  async openFile(request: OpenFileRequest): Promise<OpenFileResponse> {
    try {
      const result = await this.ipcInvoke<OpenFileResponse>('editor:open-file', request);

      if (result.success && result.content !== undefined) {
        const language = result.language ?? detectLanguage(request.filePath);
        this.emit({
          type: 'file-opened',
          filePath: request.filePath,
          content: result.content,
          language,
        });
        this.watchFile(request.filePath);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error reading file';
      return {
        success: false,
        filePath: request.filePath,
        error: errorMessage,
      };
    }
  }

  /**
   * Saves file content to disk via the main process.
   */
  async saveFile(request: SaveFileRequest): Promise<SaveFileResponse> {
    try {
      const result = await this.ipcInvoke<SaveFileResponse>('editor:save-file', request);

      if (result.success) {
        this.emit({ type: 'file-saved', filePath: request.filePath });
      } else {
        this.emit({
          type: 'file-save-error',
          filePath: request.filePath,
          error: result.error ?? 'Save failed',
        });
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error saving file';
      this.emit({
        type: 'file-save-error',
        filePath: request.filePath,
        error: errorMessage,
      });
      return {
        success: false,
        filePath: request.filePath,
        error: errorMessage,
      };
    }
  }

  /**
   * Registers a listener for editor service events.
   */
  on(listener: EditorServiceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Sets up a file watcher for external change detection.
   */
  private watchFile(filePath: string): void {
    // Avoid duplicate watchers for the same file
    if (this.fileWatcherCleanups.has(filePath)) return;

    const cleanup = this.ipcOn(`editor:file-changed:${filePath}`, (_event: unknown) => {
      this.emit({ type: 'file-changed-externally', filePath });
    });

    const deleteCleanup = this.ipcOn(`editor:file-deleted:${filePath}`, (_event: unknown) => {
      this.emit({ type: 'file-deleted-externally', filePath });
    });

    this.fileWatcherCleanups.set(filePath, () => {
      cleanup();
      deleteCleanup();
    });
  }

  /**
   * Stops watching a file for external changes.
   */
  unwatchFile(filePath: string): void {
    const cleanup = this.fileWatcherCleanups.get(filePath);
    if (cleanup) {
      cleanup();
      this.fileWatcherCleanups.delete(filePath);
    }
  }

  /**
   * Cleans up all file watchers and listeners.
   */
  dispose(): void {
    const watcherCleanups = Array.from(this.fileWatcherCleanups.values());
    for (const cleanup of watcherCleanups) {
      cleanup();
    }
    this.fileWatcherCleanups.clear();
    this.listeners.clear();
  }

  private emit(event: EditorServiceEvent): void {
    const listeners = Array.from(this.listeners);
    for (const listener of listeners) {
      listener(event);
    }
  }

  /**
   * IPC invoke wrapper — calls the main process and awaits a response.
   * Uses the preload bridge if available, otherwise falls back gracefully.
   */
  private async ipcInvoke<T>(channel: string, data?: unknown): Promise<T> {
    const bridge = (window as unknown as Record<string, unknown>).electronAPI as
      | { invoke: (channel: string, data?: unknown) => Promise<T> }
      | undefined;

    if (bridge?.invoke) {
      return bridge.invoke(channel, data);
    }

    // Fallback for environments without the preload bridge (e.g., testing)
    throw new Error(`IPC bridge unavailable for channel: ${channel}`);
  }

  /**
   * IPC event listener wrapper — subscribes to events from the main process.
   * Returns a cleanup function to unsubscribe.
   */
  private ipcOn(channel: string, handler: (event: unknown) => void): () => void {
    const bridge = (window as unknown as Record<string, unknown>).electronAPI as
      | { on: (channel: string, handler: (event: unknown) => void) => () => void }
      | undefined;

    if (bridge?.on) {
      return bridge.on(channel, handler);
    }

    // Fallback — no-op cleanup
    return () => {};
  }
}
