/**
 * Minimal async mutexes. Pure logic: no chain, no keys, no I/O.
 *
 * signerd needs two of these for two different reasons, both of which are about a read and a
 * write that must not be interleaved:
 *
 *   - per agent: `decide` reads the spend ledger, and the spend is appended only once the
 *     transaction is built. Building queries the chain, so the gap is hundreds of milliseconds —
 *     long enough for a second request to read the same pre-spend ledger and pass a cap that fits
 *     one payment.
 *   - per wallet: there is one key, and two builds racing over its UTXO set may pick the same one.
 *
 * A task that rejects must not wedge everything queued behind it, so the chain continues through
 * failures; the rejection still reaches that task's own caller.
 */

/** Runs tasks one at a time within each key, and concurrently across keys. */
export function createKeyedLock() {
  const chains = new Map<string, Promise<unknown>>();
  return function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = chains.get(key) ?? Promise.resolve();
    const result = prior.then(task, task);
    const settled = result.then(
      () => {},
      () => {},
    );
    chains.set(key, settled);
    // Forget the key once nothing is queued behind it, so the map holds live work rather than
    // every key the process has ever seen.
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
