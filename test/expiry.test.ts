import { test } from "node:test";
import assert from "node:assert/strict";
import { blockfrostLookup, chainLookup, koiosLookup, landing, reconcile, releasable, type ChainLookup } from "../src/expiry.ts";
import { blockfrostBaseUrl, koiosBaseUrl } from "../src/network.ts";
import type { SpendRecord } from "../src/policy.ts";

const NETWORK = "cardano:preprod";
const hash = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const spend = (over: Partial<SpendRecord> = {}): SpendRecord => ({ ts: 1, agentId: "a", asset: "lovelace", amount: 100n, ...over });
const NONE: ReadonlySet<string> = new Set();

// --- what is releasable ------------------------------------------------------------------------

test("a spend is releasable only once the tip is past its TTL plus the margin", () => {
  const s = spend({ tx: hash(1), ttlSlot: 1000 });
  // Strictly past: at the boundary it is not, and one slot later it is.
  assert.equal(releasable([s], 1000, 60, NONE).length, 0);
  assert.equal(releasable([s], 1059, 60, NONE).length, 0);
  assert.equal(releasable([s], 1060, 60, NONE).length, 0);
  assert.equal(releasable([s], 1061, 60, NONE).length, 1);
  // A tip before the TTL, which is the ordinary case for a payment just signed.
  assert.equal(releasable([s], 10, 60, NONE).length, 0);
});

test("a spend with no transaction, no TTL, or that is a voucher is never releasable", () => {
  const way = 1_000_000_000;
  const spends = [
    spend({ ttlSlot: 10 }), // a spend from before transactions were recorded
    spend({ tx: hash(2) }), // no TTL: nothing to compare the tip with
    spend({ tx: hash(3), ttlSlot: 10, voucher: true }),
    spend({ tx: "not-a-hash", ttlSlot: 10 }),
    spend({ tx: hash(4), ttlSlot: 10 }),
  ];
  assert.deepEqual(releasable(spends, way, 60, NONE).map(s => s.tx), [hash(4)]);
});

test("a transaction already seen in a block is not asked about again", () => {
  const spends = [spend({ tx: hash(1), ttlSlot: 10 }), spend({ tx: hash(2), ttlSlot: 10 })];
  assert.deepEqual(releasable(spends, 10_000, 60, new Set([hash(1)])).map(s => s.tx), [hash(2)]);
});

test("a tip that is not a number releases nothing", () => {
  const s = spend({ tx: hash(1), ttlSlot: 10 });
  assert.equal(releasable([s], Number.NaN, 60, NONE).length, 0);
});

test("landing reads the hash and slot from a decoded transaction, and drops what it cannot hold", () => {
  assert.deepEqual(landing(hash(5), 123n), { tx: hash(5), ttlSlot: 123 });
  // Lower-cased, since that is the one spelling every later comparison uses.
  assert.deepEqual(landing(hash(0xab).toUpperCase(), 0n), { tx: hash(0xab), ttlSlot: 0 });
  // No TTL, a negative one, one a JSON number cannot hold exactly: no slot, and never a guess at one.
  assert.deepEqual(landing(hash(5), undefined), { tx: hash(5) });
  assert.deepEqual(landing(hash(5), -1n), { tx: hash(5) });
  assert.deepEqual(landing(hash(5), BigInt(Number.MAX_SAFE_INTEGER) + 1n), { tx: hash(5) });
  assert.deepEqual(landing(hash(5), BigInt(Number.MAX_SAFE_INTEGER)), { tx: hash(5), ttlSlot: Number.MAX_SAFE_INTEGER });
  // A hash that is not one is not kept.
  assert.deepEqual(landing("nope", 5n), { ttlSlot: 5 });
});

// --- the providers, against a fetch that answers whatever the test says -------------------------

interface Seen {
  url: string;
  init: RequestInit;
}
/** A fetch that records what it was asked and answers from `handler`. */
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fn, seen };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/**
 * Never answers, but gives up when the caller's signal does, as a real fetch does. A real fetch
 * also keeps the process alive while it waits, and this has to as well: `AbortSignal.timeout`'s
 * timer is unref'd, so with nothing else pending Node 22 ends the event loop before it fires and
 * cancels the test (Node 24's runner happened to keep the loop alive). signerd is never in that
 * position, since its server holds the loop open.
 */
const hang = (init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const alive = setInterval(() => {}, 1000);
    init.signal?.addEventListener("abort", () => {
      clearInterval(alive);
      reject(init.signal!.reason);
    });
  });
/** For `assert.rejects`, which wants to be told what to expect: any error will do here. */
const anyError = () => true;
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

test("Blockfrost: the tip is the latest block's slot, asked with the project id", async () => {
  const { fn, seen } = fakeFetch(() => json({ slot: 424242, hash: "x" }));
  const chain = blockfrostLookup({ network: NETWORK, timeoutMs: 1000, fetch: fn }, "preprodKEY");
  assert.equal(await chain.tip(), 424242);
  assert.equal(seen[0].url, `${blockfrostBaseUrl(NETWORK)}/blocks/latest`);
  assert.equal(header(seen[0].init, "project_id"), "preprodKEY");
});

test("Blockfrost: a tip it cannot read is an error, not a slot", async () => {
  for (const [label, respond] of [
    ["HTTP 500", () => json({ error: "boom" }, 500)],
    ["HTTP 429", () => json({}, 429)],
    ["no slot", () => json({ hash: "x" })],
    ["a null slot", () => json({ slot: null })],
    ["a negative slot", () => json({ slot: -5 })],
    ["a fractional slot", () => json({ slot: 1.5 })],
    ["not JSON", () => new Response("<html>bad gateway</html>", { status: 200 })],
    ["a null body", () => json(null)],
  ] as const) {
    const chain = blockfrostLookup({ network: NETWORK, timeoutMs: 1000, fetch: fakeFetch(respond).fn }, "k");
    await assert.rejects(() => chain.tip(), anyError, label);
  }
  const chain = blockfrostLookup({ network: NETWORK, timeoutMs: 20, fetch: fakeFetch((_u, init) => hang(init)).fn }, "k");
  await assert.rejects(() => chain.tip(), anyError, "a timeout");
});

test("Blockfrost: 200 is in a block, 404 is definitely not, and anything else is unknown", async () => {
  const [A, B, C, D, E, F] = [1, 2, 3, 4, 5, 6].map(hash);
  const { fn, seen } = fakeFetch((url, init) => {
    if (url.endsWith(A)) return json({ hash: A, block: "b" });
    if (url.endsWith(B)) return json({ status_code: 404, error: "Not Found" }, 404);
    if (url.endsWith(C)) return json({ error: "server" }, 500);
    if (url.endsWith(D)) return json({ error: "rate" }, 429);
    if (url.endsWith(E)) return Promise.reject(new TypeError("fetch failed"));
    return hang(init); // F: a provider that never answers
  });
  const chain = blockfrostLookup({ network: NETWORK, timeoutMs: 30, fetch: fn }, "k");
  const answers = await chain.onChain([A, B, C, D, E, F]);
  assert.deepEqual([...answers], [[A, true], [B, false]]);
  assert.equal(answers.has(C) || answers.has(D) || answers.has(E) || answers.has(F), false);
  assert.deepEqual(seen.map(s => s.url).sort(), [A, B, C, D, E, F].map(h => `${blockfrostBaseUrl(NETWORK)}/txs/${h}`).sort());
  assert.ok(seen.every(s => header(s.init, "project_id") === "k"));
});

test("Blockfrost: nothing to ask is nothing asked", async () => {
  const { fn, seen } = fakeFetch(() => json({}));
  assert.equal((await blockfrostLookup({ network: NETWORK, timeoutMs: 1000, fetch: fn }, "k").onChain([])).size, 0);
  assert.equal(seen.length, 0);
});

test("Koios: the tip is the first row's abs_slot", async () => {
  const { fn, seen } = fakeFetch(() => json([{ hash: "x", epoch_no: 9, abs_slot: 777, block_no: 3 }]));
  const chain = koiosLookup({ network: NETWORK, timeoutMs: 1000, fetch: fn });
  assert.equal(await chain.tip(), 777);
  assert.equal(seen[0].url, `${koiosBaseUrl(NETWORK)}/tip`);
  assert.equal(header(seen[0].init, "authorization"), null);
});

test("Koios: a token is sent as a bearer token, and only when there is one", async () => {
  const tip = fakeFetch(() => json([{ abs_slot: 1 }]));
  await koiosLookup({ network: NETWORK, timeoutMs: 1000, koiosToken: "tok", fetch: tip.fn }).tip();
  assert.equal(header(tip.seen[0].init, "authorization"), "Bearer tok");

  const status = fakeFetch(() => json([]));
  await koiosLookup({ network: NETWORK, timeoutMs: 1000, koiosToken: "tok", fetch: status.fn }).onChain([hash(1)]);
  assert.equal(header(status.seen[0].init, "authorization"), "Bearer tok");
  assert.equal(header(status.seen[0].init, "content-type"), "application/json");
});

test("Koios: a tip it cannot read is an error, not a slot", async () => {
  for (const [label, respond] of [
    ["HTTP 500", () => json({}, 500)],
    ["an empty list", () => json([])],
    ["no abs_slot", () => json([{ hash: "x" }])],
    ["a null slot", () => json([{ abs_slot: null }])],
    ["not a list", () => json({ abs_slot: 5 })],
    ["not JSON", () => new Response("nope", { status: 200 })],
  ] as const) {
    const chain = koiosLookup({ network: NETWORK, timeoutMs: 1000, fetch: fakeFetch(respond).fn });
    await assert.rejects(() => chain.tip(), anyError, label);
  }
  const chain = koiosLookup({ network: NETWORK, timeoutMs: 20, fetch: fakeFetch((_u, init) => hang(init)).fn });
  await assert.rejects(() => chain.tip(), anyError, "a timeout");
});

test("Koios: a number of confirmations at least 1 is in a block, null is definitely not, a missing row is unknown", async () => {
  const [A, B, C, D, E, F] = [1, 2, 3, 4, 5, 6].map(hash);
  const G = hash(0xab); // has letters in it, so its upper-case spelling differs
  const { fn, seen } = fakeFetch(() =>
    json([
      { tx_hash: A, num_confirmations: 12 },
      { tx_hash: B, num_confirmations: null },
      // C has no row at all.
      { tx_hash: D, num_confirmations: 0 }, // not a depth anyone should read as "in a block" or as "absent"
      { tx_hash: E, num_confirmations: "9" }, // a string is not the number that was asked for
      { tx_hash: F }, // no field at all
      { tx_hash: hash(99), num_confirmations: null }, // a row for a transaction nobody asked about
      { tx_hash: G.toUpperCase(), num_confirmations: 1 },
      null,
    ]),
  );
  const answers = await koiosLookup({ network: NETWORK, timeoutMs: 1000, fetch: fn }).onChain([A, B, C, D, E, F, G]);
  assert.deepEqual([...answers].sort(), [[A, true], [B, false], [G, true]].sort());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${koiosBaseUrl(NETWORK)}/tx_status`);
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { _tx_hashes: [A, B, C, D, E, F, G] });
});

test("Koios: a repeated hash with two answers keeps the one that leaves the budget spent", async () => {
  for (const rows of [
    [{ tx_hash: hash(1), num_confirmations: 4 }, { tx_hash: hash(1), num_confirmations: null }],
    [{ tx_hash: hash(1), num_confirmations: null }, { tx_hash: hash(1), num_confirmations: 4 }],
  ]) {
    const answers = await koiosLookup({ network: NETWORK, timeoutMs: 1000, fetch: fakeFetch(() => json(rows)).fn }).onChain([hash(1)]);
    assert.deepEqual([...answers], [[hash(1), true]]);
  }
});

test("Koios: an error, a body that is not a list, or a timeout leaves every transaction unknown", async () => {
  const txs = [hash(1), hash(2)];
  const failing: Array<[string, (url: string, init: RequestInit) => Response | Promise<Response>]> = [
    ["HTTP 500", () => json([{ tx_hash: hash(1), num_confirmations: null }], 500)],
    ["HTTP 429", () => json({}, 429)],
    ["an object", () => json({ tx_hash: hash(1), num_confirmations: null })],
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["a timeout", (_u, init) => hang(init)],
  ];
  for (const [label, respond] of failing) {
    const answers = await koiosLookup({ network: NETWORK, timeoutMs: 20, fetch: fakeFetch(respond).fn }).onChain(txs);
    assert.equal(answers.size, 0, label);
  }
});

test("Blockfrost is used when there is a project id, and Koios when there is not", async () => {
  const withKey = fakeFetch(() => json({ slot: 1 }));
  await chainLookup({ network: NETWORK, blockfrostProjectId: "k", timeoutMs: 1000, fetch: withKey.fn }).tip();
  assert.match(withKey.seen[0].url, /^https:\/\/cardano-preprod\.blockfrost\.io\//);

  const without = fakeFetch(() => json([{ abs_slot: 1 }]));
  await chainLookup({ network: NETWORK, timeoutMs: 1000, fetch: without.fn }).tip();
  assert.match(without.seen[0].url, /^https:\/\/preprod\.koios\.rest\//);
});

// --- one pass ----------------------------------------------------------------------------------

/** A chain that says what it is told to and counts what it was asked. */
function fakeChain(o: { tip?: number | Error; answers?: Record<string, boolean> } = {}) {
  const asked = { tip: 0, txs: [] as string[][] };
  const chain: ChainLookup = {
    async tip() {
      asked.tip++;
      if (o.tip instanceof Error) throw o.tip;
      return o.tip ?? 0;
    },
    async onChain(txs) {
      asked.txs.push(txs);
      return new Map(txs.filter(t => o.answers && t in o.answers).map(t => [t, o.answers![t]] as [string, boolean]));
    },
  };
  return { chain, asked };
}
const PASS = { marginSlots: 60, settled: NONE, max: 20, round: 0 };

test("an idle wallet asks the provider nothing, not even for the tip", async () => {
  const { chain, asked } = fakeChain({ tip: 5_000_000 });
  // Nothing recordable, a voucher, and one already seen in a block.
  const spends = [spend(), spend({ voucher: true, tx: hash(1), ttlSlot: 1 }), spend({ tx: hash(2), ttlSlot: 1 })];
  const r = await reconcile(spends, chain, { ...PASS, settled: new Set([hash(2)]) });
  assert.deepEqual(r, { onChain: [], absent: [] });
  assert.equal(asked.tip, 0);
  assert.equal(asked.txs.length, 0);
});

test("a tip that has not passed any TTL asks about no transaction", async () => {
  const { chain, asked } = fakeChain({ tip: 1000 });
  const r = await reconcile([spend({ tx: hash(1), ttlSlot: 1000 })], chain, PASS);
  assert.deepEqual(r, { onChain: [], absent: [] });
  assert.equal(asked.tip, 1);
  assert.equal(asked.txs.length, 0);
});

test("what the chain has, what it definitely lacks, and what it would not say are told apart", async () => {
  const [have, lack, unsure] = [hash(1), hash(2), hash(3)];
  const spends = [spend({ tx: have, ttlSlot: 10 }), spend({ tx: lack, ttlSlot: 10, amount: 7n }), spend({ tx: unsure, ttlSlot: 10 }), spend({ tx: hash(4), ttlSlot: 9_999_999 })];
  const { chain, asked } = fakeChain({ tip: 10_000, answers: { [have]: true, [lack]: false } });
  const r = await reconcile(spends, chain, PASS);
  assert.deepEqual(r.onChain, [have]);
  assert.deepEqual(r.absent.map(s => [s.tx, s.amount]), [[lack, 7n]]);
  // Asked about the three the tip has passed, and not the fourth, whose TTL is far ahead.
  assert.deepEqual(asked.txs, [[have, lack, unsure]]);
});

test("a tip that cannot be read releases nothing, and says so", async () => {
  const { chain } = fakeChain({ tip: new Error("blockfrost /blocks/latest answered 500") });
  await assert.rejects(() => reconcile([spend({ tx: hash(1), ttlSlot: 1 })], chain, PASS), /answered 500/);
});

test("with more due than one pass asks about, later passes reach the rest", async () => {
  const spends = [1, 2, 3, 4, 5].map(n => spend({ tx: hash(n), ttlSlot: 1 }));
  const { chain, asked } = fakeChain({ tip: 10_000 });
  for (let round = 0; round < 3; round++) await reconcile(spends, chain, { ...PASS, max: 2, round });
  assert.ok(asked.txs.every(t => t.length === 2), "a pass asked about more than max");
  const seen = new Set(asked.txs.flat());
  assert.equal(seen.size, 5, `only ${seen.size} of 5 were ever asked about`);
});

test("a pass never asks about more than max, and asks about all when there are fewer", async () => {
  const spends = Array.from({ length: 30 }, (_, n) => spend({ tx: hash(n + 1), ttlSlot: 1 }));
  const { chain, asked } = fakeChain({ tip: 10_000 });
  await reconcile(spends, chain, PASS);
  assert.equal(asked.txs[0].length, 20);
  await reconcile(spends.slice(0, 3), chain, PASS);
  assert.equal(asked.txs[1].length, 3);
});
