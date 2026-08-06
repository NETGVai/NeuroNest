// ─── Adapter Registry ───────────────────────────────────────────
// Lazy-instantiation registry for channel adapters.
// Registration stores only the factory; construction is deferred
// until `instantiate` is called.

import type { AdapterFactory, ChannelAdapter } from './types/adapter';
import { AdapterError } from './types/errors';

/**
 * Metadata stored for each registered adapter.
 * @satisfies REQ 6.1
 */
export interface AdapterRegistryEntry {
  channelId: string;
  factory: AdapterFactory;
  registrationIndex: number;
  factoryError?: Error;
}

/**
 * Central registry that maps channelId strings to adapter factories.
 * Factories are invoked lazily on first `instantiate` call — registration
 * itself never triggers construction.
 *
 * Last-write-wins: re-registering a channelId replaces the prior entry.
 *
 * @satisfies REQ 6.1, REQ 6.3, REQ 6.4, REQ 22.4, REQ 27.6
 */
export class AdapterRegistry {
  private entries = new Map<string, AdapterRegistryEntry>();
  private nextIndex = 0;

  /**
   * Register a factory under the given channelId. Later registrations
   * replace earlier ones (last-write-wins). The factory is NOT invoked
   * at registration time — construction is strictly lazy.
   */
  registerAdapter(channelId: string, factory: AdapterFactory): void {
    this.entries.set(channelId, {
      channelId,
      factory,
      registrationIndex: this.nextIndex++,
    });
  }

  /**
   * Invoke the registered factory for `channelId` and return the adapter.
   * If the factory throws, the error is recorded on the entry (marking it
   * as failed for `list()`) and then re-thrown to the caller.
   */
  instantiate(channelId: string): ChannelAdapter {
    const entry = this.entries.get(channelId);
    if (!entry) {
      throw new AdapterError(
        'PROVIDER_ERROR',
        `channelId '${channelId}' is not registered`,
      );
    }
    try {
      return entry.factory();
    } catch (err) {
      entry.factoryError = err as Error;
      throw err;
    }
  }

  /**
   * Return the list of registered channelIds that have not experienced a
   * factory error, sorted by registration order (monotonic index).
   */
  list(): string[] {
    return Array.from(this.entries.values())
      .filter((e) => !e.factoryError)
      .sort((a, b) => a.registrationIndex - b.registrationIndex)
      .map((e) => e.channelId);
  }

  /**
   * Returns `true` if the given channelId has been registered
   * (regardless of whether the factory has errored).
   */
  has(channelId: string): boolean {
    return this.entries.has(channelId);
  }
}
