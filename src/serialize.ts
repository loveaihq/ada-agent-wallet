/**
 * Async mutexes. Pure logic: no chain, no keys, no I/O.
 *
 * A task that rejects must not wedge the ones queued behind it, so the chain continues through
 * failures while the rejection still reaches its own caller.
 */
const noop = () => {};

/** Runs tasks one at a time within each key, concurrently across keys. */
export function createKeyedLock() {
  const chains = new Map<string, Promise<unknown>>();
  return function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (chains.get(key) ?? Promise.resolve()).then(task, task);
    const settled = result.then(noop, noop);
    chains.set(key, settled);
    // Forget the key once nothing is queued behind it.
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return result;
  };
}

/** Runs tasks one at a time, full stop. */
export function createLock() {
  const keyed = createKeyedLock();
  return <T>(task: () => Promise<T>): Promise<T> => keyed("", task);
}
