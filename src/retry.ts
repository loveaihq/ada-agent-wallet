/**
 * Retrying a read that failed for a reason worth a second try. No chain, no keys, no files; the
 * only thing it touches is a timer, and a test can hand it another.
 *
 * What is worth retrying is narrow on purpose. signerd builds a payment by reading the wallet's
 * UTxOs from a free public provider, and those reads fail now and then for reasons that pass on
 * their own — `Blockfrost getUtxos failed` was seen once and did. Retrying the *build* is safe
 * because when it throws nothing has been signed and nothing has been handed out. That stops being
 * true the moment anything is submitted, so a submit failure is never retried here, and a coin
 * selection failure is an answer about the wallet, not about the network.
 */

/** The builder's own words for a wallet that cannot fund the payment. There is no code to match on. */
const COIN_SELECTION = /coin selection failed|cannot create valid change/i;
const PROVIDER_READ = /\b(blockfrost|koios) \w+ failed\b/i;
const NETWORK = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|UND_ERR_\w+/i;
const SUBMIT = /submit/i;

/** How deep a chain of `cause` is followed: undici nests the socket error two levels down. */
const CAUSE_DEPTH = 5;

/** Everything an error says about itself and its causes, as one string. */
function describe(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < CAUSE_DEPTH && cur !== undefined && cur !== null; i++) {
    if (typeof cur !== "object") {
      parts.push(String(cur));
      break;
    }
    const link = cur as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof link.message === "string") parts.push(link.message);
    // `fetch failed` carries its reason as an errno-style `code` on the cause, not in any message.
    if (typeof link.code === "string") parts.push(link.code);
    parts.push(String(cur));
    cur = link.cause;
  }
  return parts.join(" ");
}

export const isCoinSelectionFailure = (e: unknown) => e instanceof Error && COIN_SELECTION.test(describe(e));

/**
 * A provider read that failed, or the network under one. False for anything that mentions a submit
 * and for a coin selection failure, whatever else the message says.
 */
export function isTransientProviderError(e: unknown): boolean {
  // The SDK and the fetch under it throw Errors; a bare string or object is not one of theirs.
  if (!(e instanceof Error)) return false;
  const text = describe(e);
  if (SUBMIT.test(text) || COIN_SELECTION.test(text)) return false;
  return PROVIDER_READ.test(text) || NETWORK.test(text);
}

const sleepFor = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Calls `fn`, and again after each delay in `delaysMs` while it throws something `retryIf` accepts:
 * `delaysMs.length + 1` attempts at most. The last error is rethrown as it was, so what a caller
 * matches on after the final attempt is what it matched on before there were retries.
 * `onRetry` gets the error and the number of the attempt that just failed, starting at 1.
 */
export async function withRetries<T>(
  fn: () => T | PromiseLike<T>,
  o: {
    delaysMs: readonly number[];
    retryIf: (e: unknown) => boolean;
    onRetry?: (e: unknown, attempt: number) => void;
    /** For a test that would rather record the waits than sit through them. */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt > o.delaysMs.length || !o.retryIf(e)) throw e;
      o.onRetry?.(e, attempt);
      await (o.sleep ?? sleepFor)(o.delaysMs[attempt - 1]);
    }
  }
}
