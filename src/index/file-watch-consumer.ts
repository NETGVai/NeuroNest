/**
 * FileWatchConsumer — a bounded read adapter that lets the legacy per-file
 * watch surface (`src/context/file-watcher.ts`, consumed by the GCF) run as a
 * *consumer* of the single {@link IndexCoordinator} instead of starting its own
 * chokidar watcher (FUT-PKG-07-EXPERIENCE/T-004).
 *
 * NN-INDEX-001 / NN-INV-008 forbid independent competing watchers: one
 * coordinator owns the watch for a root and everything else subscribes. This
 * adapter presents the same "watch a file path, get a `FileChangeEvent`"
 * contract the GCF's `FileWatcher` exposes, but sources those events from the
 * coordinator's ordered, exclusion-filtered change stream. Because it only
 * *reads* the coordinator's projection/stream it can never swap the tree store
 * (NN-INDEX-012) — which is exactly the rollback shape the task requires
 * ("rollback returns a bounded read adapter, never an independent watcher").
 *
 * The existing `FileWatcher` keeps working unchanged for callers that have not
 * migrated; this adapter is the migration path that routes those callers
 * through the coordinator without a behavior regression at the callback level.
 *
 * Requirements: NN-INDEX-001/012, NN-INV-008, NN-WORKSPACE-009. Design: D-05,
 * D-20 (bounded read projection for compatibility).
 */

import * as nodePath from 'node:path';

import type { FileChangeEvent } from '../context/types.js';
import type { FileChangeRecord, IndexCoordinator } from './index-coordinator.js';

/** Map an ordered coordinator record to the legacy `FileChangeEvent` shape. */
export function toFileChangeEvent(rootPath: string, record: FileChangeRecord): FileChangeEvent {
  const absolute = nodePath.join(nodePath.resolve(rootPath), record.relativePath.split('/').join(nodePath.sep));
  return {
    filePath: absolute,
    // The legacy surface only distinguishes change vs delete; create/modify/
    // permission all present as a 'change' to a watched file.
    type: record.type === 'delete' ? 'delete' : 'change',
    timestamp: record.occurredAt,
  };
}

/**
 * A read-only adapter that fans a coordinator's change stream out to per-file
 * callbacks, matching the legacy `FileWatcher.watch(filePath, cb)` contract. It
 * holds no watcher of its own; it subscribes to the coordinator and filters by
 * the exact watched absolute path.
 */
export class FileWatchConsumer {
  private readonly rootPath: string;
  private readonly callbacks = new Map<string, (event: FileChangeEvent) => void>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly coordinator: IndexCoordinator, rootPath: string) {
    this.rootPath = nodePath.resolve(rootPath);
    this.unsubscribe = coordinator.subscribe((record) => this.onRecord(record));
  }

  /**
   * Register interest in an absolute file path. The callback fires when the
   * coordinator emits a change for exactly that path (after exclusion).
   */
  watch(filePath: string, callback: (event: FileChangeEvent) => void): void {
    if (this.disposed) return;
    this.callbacks.set(nodePath.resolve(filePath), callback);
  }

  /** Stop delivering events for a specific path. */
  unwatch(filePath: string): void {
    this.callbacks.delete(nodePath.resolve(filePath));
  }

  /** Stop all delivery and unsubscribe from the coordinator. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.callbacks.clear();
    this.unsubscribe();
  }

  /** Number of paths currently being observed (parity with `watchCount`). */
  get watchCount(): number {
    return this.callbacks.size;
  }

  private onRecord(record: FileChangeRecord): void {
    if (this.disposed || this.callbacks.size === 0) return;
    const event = toFileChangeEvent(this.rootPath, record);
    const cb = this.callbacks.get(nodePath.resolve(event.filePath));
    if (cb) cb(event);
  }
}
