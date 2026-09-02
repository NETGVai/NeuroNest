/**
 * ChokidarWatcherBackend — the production {@link WatcherBackend} adapter for the
 * IndexCoordinator (FUT-PKG-07-EXPERIENCE/T-004).
 *
 * This is the ONLY place the coordinator's raw filesystem watch is realized in
 * production. It wraps a single chokidar watcher for one workspace root and
 * translates chokidar's native events (`add`/`change`/`unlink`/`addDir`/
 * `unlinkDir`) into the coordinator's {@link RawFileEvent} vocabulary. It owns
 * no ordering, no exclusion, and no projection — those belong to the
 * coordinator (NN-INDEX-001/002, NN-INV-008). Keeping this adapter thin is what
 * lets tests inject a fake backend and exercise the coordinator without real OS
 * events.
 *
 * Requirements: NN-INDEX-001, NN-INV-008. Design anchors: D-05, D-08.
 */

import chokidar, { type FSWatcher } from 'chokidar';

import type {
  RawEventListener,
  RawFileEvent,
  WatcherBackend,
} from './index-coordinator.js';

export interface ChokidarWatcherBackendOptions {
  /** Use polling instead of native events (slow FS/network mounts). */
  readonly usePolling?: boolean;
  /** Await write-finish for atomic-save editors. */
  readonly awaitWriteFinish?: boolean;
}

/**
 * A single-root chokidar adapter. One instance owns exactly one `FSWatcher`;
 * the coordinator holds exactly one backend, so there is one watch per root.
 */
export class ChokidarWatcherBackend implements WatcherBackend {
  private watcher: FSWatcher | null = null;
  private readonly usePolling: boolean;
  private readonly awaitWriteFinish: boolean;

  constructor(options: ChokidarWatcherBackendOptions = {}) {
    this.usePolling = options.usePolling ?? false;
    this.awaitWriteFinish = options.awaitWriteFinish ?? false;
  }

  start(rootPath: string, listener: RawEventListener): void {
    if (this.watcher) return; // one watch per backend (NN-INV-008)
    const watcher = chokidar.watch(rootPath, {
      persistent: true,
      usePolling: this.usePolling,
      ignoreInitial: true,
      awaitWriteFinish: this.awaitWriteFinish,
    });

    const emit = (event: RawFileEvent) => listener(event);

    watcher.on('add', (p: string) => emit({ absolutePath: p, kind: 'add', isDirectory: false }));
    watcher.on('change', (p: string) => emit({ absolutePath: p, kind: 'change', isDirectory: false }));
    watcher.on('unlink', (p: string) => emit({ absolutePath: p, kind: 'unlink', isDirectory: false }));
    watcher.on('addDir', (p: string) => emit({ absolutePath: p, kind: 'add', isDirectory: true }));
    watcher.on('unlinkDir', (p: string) => emit({ absolutePath: p, kind: 'unlink', isDirectory: true }));

    this.watcher = watcher;
  }

  stop(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
  }
}
