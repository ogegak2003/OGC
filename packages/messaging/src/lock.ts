/**
 * Serializes async work per key. MLS state is a strict state machine: two
 * concurrent operations on one conversation (e.g. a send and a sync) would
 * fork it, so everything touching a conversation's group runs under its lock.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
