import { test } from "node:test";
import assert from "node:assert/strict";
import { isCoinSelectionFailure, isShortOfFunds, isTokenShortage, isTransientProviderError, withRetries } from "../src/retry.ts";

/** What undici throws: `fetch failed`, with the socket's reason as the cause, carrying a code. */
const fetchFailed = (code: string, message = code) =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });

test("a provider read that failed is transient, in the words the SDK uses", () => {
  for (const message of [
    "Blockfrost getUtxos failed",
    "Koios getUtxosByOutRef failed",
    "blockfrost getAddressInfo failed: 429",
    "sign_failed: Koios getProtocolParameters failed",
  ]) {
    assert.equal(isTransientProviderError(new Error(message)), true, message);
  }
});

test("the network under a provider read is transient, whether it is in the message, the cause or a code", () => {
  assert.equal(isTransientProviderError(new TypeError("fetch failed")), true);
  assert.equal(isTransientProviderError(new Error("read ECONNRESET")), true);
  assert.equal(isTransientProviderError(new Error("connect ETIMEDOUT 1.2.3.4:443")), true);
  assert.equal(isTransientProviderError(new Error("getaddrinfo EAI_AGAIN cardano-preprod.blockfrost.io")), true);
  assert.equal(isTransientProviderError(new Error("socket hang up")), true);
  assert.equal(isTransientProviderError(new Error("failed", { cause: "read ECONNRESET" })), true);
  // undici names the reason on the cause's `code`, and that string is nowhere in a message.
  assert.equal(isTransientProviderError(fetchFailed("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error")), true);
  assert.equal(isTransientProviderError(fetchFailed("UND_ERR_SOCKET", "other side closed")), true);
  assert.equal(isTransientProviderError(new Error("outer", { cause: new Error("middle", { cause: { code: "ECONNRESET" } }) })), true);
});

test("a submit failure is never retried, whatever else it says", () => {
  for (const message of [
    "Koios submitTx failed",
    "Blockfrost submitTransaction failed",
    "Blockfrost submit failed",
    "fetch failed while submitting",
  ]) {
    assert.equal(isTransientProviderError(new Error(message)), false, message);
  }
  assert.equal(isTransientProviderError(new Error("fetch failed", { cause: new Error("Koios submitTx failed") })), false);
});

test("a coin selection failure is an answer about the wallet, not the network", () => {
  for (const message of [
    "Coin selection failed: insufficient funds",
    "cannot create valid change",
    "Blockfrost getUtxos failed: coin selection failed",
    "fetch failed: cannot create valid change",
  ]) {
    assert.equal(isTransientProviderError(new Error(message)), false, message);
    assert.equal(isCoinSelectionFailure(new Error(message)), true, message);
  }
  assert.equal(isTransientProviderError(new Error("failed", { cause: new Error("coin selection failed") })), false);
});

test("a builder that cannot balance the transaction is the same answer about the wallet", () => {
  // Word for word what an `exact` payment out of a wallet with one token-laden UTxO and 4.7 tADA got.
  const seen = "Cannot balance transaction: Native assets present in leftover but insufficient lovelace (3216191 < 3590230 minUTxO) after 1 selection attempts.";
  for (const message of [seen, seen.toLowerCase(), `sign_failed: ${seen}`, "CANNOT BALANCE TRANSACTION"]) {
    assert.equal(isCoinSelectionFailure(new Error(message)), true, message);
    assert.equal(isTransientProviderError(new Error(message)), false, message);
  }
  // It arrives wrapped, and after a provider read that did fail: still an answer about the wallet.
  assert.equal(isCoinSelectionFailure(new Error("build failed", { cause: new Error(seen) })), true);
  assert.equal(isTransientProviderError(new Error("Blockfrost getUtxos failed", { cause: new Error(seen) })), false);
  assert.equal(isTransientProviderError(new TypeError("fetch failed", { cause: new Error(seen) })), false);
  // Only errors count, as before.
  assert.equal(isCoinSelectionFailure(seen), false);
  // Near misses are not it.
  for (const message of ["Cannot balance", "cannot build transaction", "transaction balanced"]) assert.equal(isCoinSelectionFailure(new Error(message)), false, message);
});

test("what the channel client says when the wallet is short of funds for a step", () => {
  for (const message of [
    "no UTxO to open a lovelace channel from",
    "an opening of 3000000 would leave no ADA-only UTxOs large enough for the refund's collateral (left: 1500000)",
    "a top-up of 1000000 would leave no ADA-only UTxOs large enough for the refund's collateral (left: none)",
    // What a top-up or a refund says when the wallet has too little ADA-only ADA before it builds anything.
    "no ADA-only UTxOs large enough for collateral (largest three 1700000)",
    "no ADA-only UTxOs large enough for collateral (largest three )",
    "the wallet holds 0 of the currency, 1000 needed",
    "Coin selection failed: insufficient funds",
    "Cannot create valid change",
    "Cannot balance transaction: Native assets present in leftover but insufficient lovelace (1 < 2 minUTxO)",
  ]) {
    assert.equal(isShortOfFunds(new Error(message)), true, message);
  }
  for (const message of [
    "channel abababababababab… is still opening (tx); retry shortly",
    "channel abababababababab…: its top-up tx is not on chain yet; retry shortly",
    "Blockfrost getUtxos failed",
    "fetch failed",
    "owed 5 tokens; the server must claim them before a refund",
    "the builder put up collateral other than the offer",
  ]) {
    assert.equal(isShortOfFunds(new Error(message)), false, message);
  }
  assert.equal(isShortOfFunds("no UTxO to open a lovelace channel from"), false);
  assert.equal(isShortOfFunds(undefined), false);
});

test("a shortage of the token itself is told apart, since rearranging the wallet cannot make it up", () => {
  assert.equal(isTokenShortage(new Error("the wallet holds 0 of the currency, 1000 needed")), true);
  assert.equal(isTokenShortage(new Error("the wallet holds 999 of the currency, 1000 needed")), true);
  for (const message of ["no UTxO to open a lovelace channel from", "Coin selection failed", "no ADA-only UTxOs large enough for collateral (largest three )"]) {
    assert.equal(isTokenShortage(new Error(message)), false, message);
  }
  assert.equal(isTokenShortage("the wallet holds 0 of the currency, 1 needed"), false);
});

test("anything else, and anything that is not an error, is not transient", () => {
  for (const e of [
    new Error("the wallet holds 0 of the currency"),
    new Error("policy said no"),
    new Error("Blockfrost is a service"), // names a provider, but no read that failed
    new Error("failed"),
    "Blockfrost getUtxos failed", // a bare string is not an Error the SDK threw
    undefined,
    null,
    42,
    {},
  ]) {
    assert.equal(isTransientProviderError(e), false, String(e));
  }
});

test("only an Error can be a coin selection failure, as it always was", () => {
  assert.equal(isCoinSelectionFailure("coin selection failed"), false);
  assert.equal(isCoinSelectionFailure(undefined), false);
  assert.equal(isCoinSelectionFailure(new Error("policy said no")), false);
});

// --- withRetries -------------------------------------------------------------------------------

/** A function that throws `errors` in turn and then returns `value`, and counts its calls. */
function flaky<T>(errors: unknown[], value: T) {
  const state = { calls: 0 };
  return {
    state,
    fn: async () => {
      const n = state.calls++;
      if (n < errors.length) throw errors[n];
      return value;
    },
  };
}
const always = () => true;

test("a success the first time is not retried and waits for nothing", async () => {
  const { fn, state } = flaky([], "ok");
  const waits: number[] = [];
  assert.equal(await withRetries(fn, { delaysMs: [1000, 3000], retryIf: always, sleep: async ms => void waits.push(ms) }), "ok");
  assert.equal(state.calls, 1);
  assert.deepEqual(waits, []);
});

test("it waits the given delays between attempts, and tells onRetry which attempt failed", async () => {
  const errors = [new Error("one"), new Error("two")];
  const { fn, state } = flaky(errors, "third time");
  const waits: number[] = [];
  const told: Array<[unknown, number]> = [];
  const out = await withRetries(fn, {
    delaysMs: [1000, 3000],
    retryIf: always,
    onRetry: (e, attempt) => told.push([e, attempt]),
    sleep: async ms => void waits.push(ms),
  });
  assert.equal(out, "third time");
  assert.equal(state.calls, 3);
  assert.deepEqual(waits, [1000, 3000]);
  assert.deepEqual(told, [[errors[0], 1], [errors[1], 2]]);
});

test("after the last attempt the last error comes out as it went in", async () => {
  const errors = [new Error("one"), new Error("two"), new Error("three")];
  const { fn, state } = flaky(errors, "never");
  const waits: number[] = [];
  const told: number[] = [];
  await assert.rejects(
    () => withRetries(fn, { delaysMs: [1000, 3000], retryIf: always, onRetry: (_e, n) => told.push(n), sleep: async ms => void waits.push(ms) }),
    e => e === errors[2], // the same object, so what a caller matches on afterwards is what it matched before
  );
  assert.equal(state.calls, 3); // delaysMs.length + 1, and no more
  assert.deepEqual(waits, [1000, 3000]);
  assert.deepEqual(told, [1, 2]); // never told of a retry that did not happen
});

test("an error retryIf refuses stops it at once, even after a retry that was accepted", async () => {
  const transient = new Error("Blockfrost getUtxos failed");
  const hard = new Error("coin selection failed");
  const { fn, state } = flaky([transient, hard, transient], "never");
  const waits: number[] = [];
  await assert.rejects(
    () => withRetries(fn, { delaysMs: [1, 1, 1], retryIf: isTransientProviderError, sleep: async ms => void waits.push(ms) }),
    e => e === hard,
  );
  assert.equal(state.calls, 2);
  assert.deepEqual(waits, [1]);
});

test("no delays means one attempt", async () => {
  const boom = new Error("Blockfrost getUtxos failed");
  const { fn, state } = flaky([boom], "never");
  await assert.rejects(() => withRetries(fn, { delaysMs: [], retryIf: always }), e => e === boom);
  assert.equal(state.calls, 1);
});

test("with the real timer and zero delays it still retries the classified errors", async () => {
  const { fn, state } = flaky([new Error("Blockfrost getUtxos failed"), fetchFailed("ECONNRESET")], 7);
  assert.equal(await withRetries(fn, { delaysMs: [0, 0], retryIf: isTransientProviderError }), 7);
  assert.equal(state.calls, 3);
});

test("a submit failure goes through withRetries as one attempt", async () => {
  const boom = new Error("Koios submitTx failed");
  const { fn, state } = flaky([boom], "never");
  await assert.rejects(() => withRetries(fn, { delaysMs: [0, 0], retryIf: isTransientProviderError }), e => e === boom);
  assert.equal(state.calls, 1);
});
