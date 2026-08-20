import { FifoAsyncLock } from './fifo-async-lock.js';

export interface AbortableSwarmOwner {
  abort(): void;
}

export interface SwarmDispatchLease<T extends AbortableSwarmOwner> {
  setOwner(owner: T): void;
  clearOwner(): void;
  release(): void;
}

/** Serializes swarm dispatch and keeps active-owner cleanup request-scoped. */
export class SwarmDispatchGate<T extends AbortableSwarmOwner> {
  private readonly lock = new FifoAsyncLock();
  private active: { token: object; owner: T } | null = null;

  get activeOwner(): T | null {
    return this.active?.owner ?? null;
  }

  async acquire(): Promise<SwarmDispatchLease<T>> {
    const unlock = await this.lock.acquire();
    const token = {};
    let released = false;

    const clearOwner = () => {
      if (this.active?.token === token) this.active = null;
    };

    return {
      setOwner: owner => {
        if (released) throw new Error('Cannot publish an owner after releasing the swarm dispatch lease');
        this.active = { token, owner };
      },
      clearOwner,
      release: () => {
        if (released) return;
        released = true;
        clearOwner();
        unlock();
      },
    };
  }

  abortActive(): boolean {
    const active = this.active;
    if (!active) return false;
    try {
      active.owner.abort();
    } finally {
      if (this.active === active) this.active = null;
    }
    return true;
  }
}
