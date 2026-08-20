/** A small FIFO mutex for serializing async critical sections. */
export class FifoAsyncLock {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let unlock!: () => void;
    const current = new Promise<void>(resolve => {
      unlock = resolve;
    });
    const predecessor = this.tail;
    this.tail = predecessor.then(() => current);
    await predecessor;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock();
    };
  }
}
