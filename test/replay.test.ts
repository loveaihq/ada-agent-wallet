import { test } from "node:test";
import assert from "node:assert/strict";
import { replayAudit, sha256, type Checkpoint } from "../src/replay.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const WINDOW = { windowMs: DAY, now: NOW };

/** Writes records the way audit() does, so each line's `prev` is the hash of the line before it. */
function chain(records: Array<Record<string, unknown>>, startSeq = 0, startHash = ""): string[] {
  let seq = startSeq;
  let prev = startHash;
  return records.map(r => {
    const line = JSON.stringify({ ts: NOW, seq: ++seq, prev, ...r });
    prev = sha256(line);
    return line;
  });
}
const total = (spends: Array<{ amount: bigint }>) => spends.reduce((s, r) => s + r.amount, 0n);
const signed = (amount: string, over: Record<string, unknown> = {}) => ({
  event: "signed",
  agentId: "a",
  asset: "lovelace",
  amount,
  ...over,
});

test("an empty log yields an empty window", async () => {
  const r = await replayAudit([], WINDOW);
  assert.equal(r.spends.length, 0);
  assert.equal(r.hasRecords, false);
  assert.equal(r.lastSeq, 0);
  assert.equal(r.sawCheckpoint, true);
});

test("spends outside the window are skipped", async () => {
  const lines = chain([signed("100", { ts: NOW - DAY - 1 }), signed("200")]);
  const r = await replayAudit(lines, WINDOW);
  assert.equal(total(r.spends), 200n);
  assert.equal(r.skipped, 1);
});

test("a checkpoint is not re-counted from the log it was written against", async () => {
  // The bug this exists for: pre-chain records carry no seq, and treating that as "the checkpoint
  // cannot have seen it" added them again on every restart, without bound.
  const legacy = JSON.stringify({ ts: NOW, event: "signed", agentId: "a", asset: "lovelace", amount: "1000000" });
  const first = await replayAudit([legacy], WINDOW);
  assert.equal(total(first.spends), 1_000_000n);

  const checkpoint: Checkpoint = {
    version: 1,
    seq: first.lastSeq,
    hash: first.lastHash,
    updatedAt: NOW,
    spends: first.spends.map(s => ({ ts: s.ts, agentId: s.agentId, asset: s.asset, amount: s.amount.toString() })),
  };
  for (let restart = 0; restart < 3; restart++) {
    const again = await replayAudit([legacy], { ...WINDOW, checkpoint });
    assert.equal(total(again.spends), 1_000_000n, `restart ${restart + 1} changed the recorded spend`);
  }
});

test("spends logged after the checkpoint are added to it", async () => {
  const lines = chain([signed("100"), signed("200"), signed("300")]);
  const upTo2 = await replayAudit(lines.slice(0, 2), WINDOW);
  const checkpoint: Checkpoint = {
    version: 1,
    seq: upTo2.lastSeq,
    hash: upTo2.lastHash,
    updatedAt: NOW,
    spends: upTo2.spends.map(s => ({ ts: s.ts, agentId: s.agentId, asset: s.asset, amount: s.amount.toString() })),
  };
  const r = await replayAudit(lines, { ...WINDOW, checkpoint });
  assert.equal(total(r.spends), 600n); // 300 from the checkpoint, 300 logged after it
  assert.equal(r.sawCheckpoint, true);
});

test("a checkpoint whose record is gone is reported, not silently accepted", async () => {
  const lines = chain([signed("100"), signed("200")]);
  const full = await replayAudit(lines, WINDOW);
  const checkpoint: Checkpoint = { version: 1, seq: full.lastSeq, hash: full.lastHash, updatedAt: NOW, spends: [] };
  assert.equal((await replayAudit(lines, { ...WINDOW, checkpoint })).sawCheckpoint, true);
  assert.equal((await replayAudit([], { ...WINDOW, checkpoint })).sawCheckpoint, false);
  assert.equal((await replayAudit(lines.slice(0, 1), { ...WINDOW, checkpoint })).sawCheckpoint, false);
});

test("an edited record breaks the chain at the line after it", async () => {
  const lines = chain([signed("100"), signed("200"), signed("300")]);
  const clean = await replayAudit(lines, WINDOW);
  assert.equal(clean.chainBrokenAt, undefined);

  const tampered = [...lines];
  tampered[0] = JSON.stringify({ ...JSON.parse(tampered[0]), amount: "1" });
  const r = await replayAudit(tampered, WINDOW);
  assert.equal(r.chainBrokenAt, 2); // line 2's `prev` no longer matches line 1
});

test("a removed record breaks the chain", async () => {
  const lines = chain([signed("100"), signed("200"), signed("300")]);
  const r = await replayAudit([lines[0], lines[2]], WINDOW);
  assert.equal(r.chainBrokenAt, 2);
});

test("pre-chain records are not chain-checked", async () => {
  const legacy = [
    JSON.stringify({ ts: NOW, event: "signed", agentId: "a", asset: "lovelace", amount: "1" }),
    JSON.stringify({ ts: NOW, event: "signed", agentId: "a", asset: "lovelace", amount: "2" }),
  ];
  const r = await replayAudit(legacy, WINDOW);
  assert.equal(r.chainBrokenAt, undefined);
  assert.equal(total(r.spends), 3n);
});

test("a malformed line is reported with its line number", async () => {
  const lines = chain([signed("100")]);
  const r = await replayAudit([lines[0], "{not json", ""], WINDOW);
  assert.equal(r.malformedAt, 2);
  assert.equal(total(r.spends), 100n);
});

test("an approval with no terminal record is left open", async () => {
  const lines = chain([
    { event: "pending", id: "aaa", agentId: "a", reason: "buy" },
    { event: "pending", id: "bbb", agentId: "a", reason: "also buy" },
    { event: "approved", id: "bbb", agentId: "a" },
  ]);
  const r = await replayAudit(lines, WINDOW);
  assert.deepEqual(r.openApprovals.map(p => p.id), ["aaa"]);
  assert.equal(r.openApprovals[0].reason, "buy");
});

test("every terminal event closes an approval", async () => {
  for (const event of ["approved", "approval_denied", "approval_timeout", "shutdown_denied", "approval_sign_error", "pending_abandoned"]) {
    const lines = chain([{ event: "pending", id: "x", agentId: "a" }, { event, id: "x", agentId: "a" }]);
    assert.deepEqual((await replayAudit(lines, WINDOW)).openApprovals, [], `${event} did not close it`);
  }
});

test("approvals older than the window are not tracked at all", async () => {
  // An approval cannot outlive its timeout, so an old `pending` is settled whatever the log says —
  // and holding every id ever seen would grow without bound.
  const lines = chain([{ event: "pending", id: "ancient", agentId: "a", ts: NOW - DAY - 1 }]);
  assert.deepEqual((await replayAudit(lines, WINDOW)).openApprovals, []);
});

test("the window is returned in time order", async () => {
  const lines = chain([signed("1", { ts: NOW - 300 }), signed("2", { ts: NOW - 900 }), signed("3", { ts: NOW - 600 })]);
  const r = await replayAudit(lines, WINDOW);
  assert.deepEqual(r.spends.map(s => s.ts), [NOW - 900, NOW - 600, NOW - 300]);
});

test("a spend that cannot be read is reported, never skipped", async () => {
  // Skipping it would hand the agent back its budget; throwing took startup down with a BigInt
  // error and no line number.
  const base = { ts: NOW, event: "signed", agentId: "a", asset: "lovelace", amount: "100" };
  for (const [label, bad] of [
    ["fractional amount", { ...base, amount: "1.5" }],
    ["missing amount", { ts: NOW, event: "signed", agentId: "a", asset: "lovelace" }],
    ["negative amount", { ...base, amount: "-5" }],
    ["missing agentId", { ts: NOW, event: "signed", asset: "lovelace", amount: "100" }],
    ["missing asset", { ts: NOW, event: "signed", agentId: "a", amount: "100" }],
  ] as const) {
    const r = await replayAudit([JSON.stringify(bad)], WINDOW);
    assert.equal(r.malformedAt, 1, `${label} was not reported`);
    assert.equal(r.spends.length, 0, `${label} was counted anyway`);
  }
  assert.equal((await replayAudit([JSON.stringify(base)], WINDOW)).malformedAt, undefined);
});

test("an unreadable checkpoint spend is refused rather than silently dropped", async () => {
  const checkpoint = {
    version: 1 as const,
    seq: 0,
    hash: "",
    updatedAt: NOW,
    spends: [{ ts: NOW, agentId: "a", asset: "lovelace", amount: "oops" }],
  };
  await assert.rejects(() => replayAudit([], { ...WINDOW, checkpoint }), /unreadable spend/);
});

test("a voucher's increment is a spend, kept apart from transactions; a re-sign is not", async () => {
  const channelId = "cc".repeat(32);
  const lines = chain([
    signed("1000000"),
    { event: "voucher_signed", agentId: "a", asset: "lovelace", amount: "1000", cumulative: "1000", channelId },
    { event: "voucher_resigned", agentId: "a", channelId, cumulative: "1000" },
    // The event says which kind a spend is; a field on the record cannot say otherwise.
    signed("5", { voucher: true }),
    { event: "voucher_signed", agentId: "a", asset: "lovelace", amount: "2000", cumulative: "3000", channelId, voucher: false },
  ]);
  const r = await replayAudit(lines, WINDOW);
  assert.deepEqual(r.spends.map(s => [s.amount, Boolean(s.voucher)]), [[1_000_000n, false], [1000n, true], [5n, false], [2000n, true]]);
});

test("the checkpoint keeps which of its spends were vouchers", async () => {
  const checkpoint: Checkpoint = {
    version: 1,
    seq: 0,
    hash: "",
    updatedAt: NOW,
    spends: [
      { ts: NOW, agentId: "a", asset: "lovelace", amount: "7", voucher: true },
      { ts: NOW, agentId: "a", asset: "lovelace", amount: "9" },
    ],
  };
  const r = await replayAudit([], { ...WINDOW, checkpoint });
  assert.deepEqual(r.spends.map(s => [s.amount, Boolean(s.voucher)]), [[7n, true], [9n, false]]);
});

// A budget given back is the one thing in this file that moves spend down, so these are written
// against the ways it could go down by more than it should.
const TX_A = "aa".repeat(32);
const TX_B = "bb".repeat(32);
const released = (tx: unknown, over: Record<string, unknown> = {}) => ({
  event: "spend_released",
  agentId: "a",
  asset: "lovelace",
  amount: "100",
  tx,
  ttlSlot: 500,
  signedTs: NOW,
  ...over,
});
const asCheckpoint = (r: {
  lastSeq: number;
  lastHash: string;
  spends: Array<{ ts: number; agentId: string; asset: string; amount: bigint; voucher?: boolean; tx?: string; ttlSlot?: number }>;
}): Checkpoint => ({
  version: 1,
  seq: r.lastSeq,
  hash: r.lastHash,
  updatedAt: NOW,
  spends: r.spends.map(s => ({
    ts: s.ts,
    agentId: s.agentId,
    asset: s.asset,
    amount: s.amount.toString(),
    ...(s.voucher ? { voucher: true } : {}),
    ...(s.tx ? { tx: s.tx } : {}),
    ...(s.ttlSlot !== undefined ? { ttlSlot: s.ttlSlot } : {}),
  })),
});

test("a signed record's transaction and TTL reach the window, and the checkpoint keeps them", async () => {
  const lines = chain([signed("100", { tx: TX_A, ttlSlot: 500 })]);
  const first = await replayAudit(lines, WINDOW);
  assert.deepEqual(first.spends.map(s => [s.tx, s.ttlSlot]), [[TX_A, 500]]);
  const again = await replayAudit(lines, { ...WINDOW, checkpoint: asCheckpoint(first) });
  assert.deepEqual(again.spends.map(s => [s.tx, s.ttlSlot]), [[TX_A, 500]]);
});

test("a release logged after the checkpoint takes the spend out of the checkpoint's own", async () => {
  const head = chain([signed("100", { tx: TX_A, ttlSlot: 500 }), signed("200", { tx: TX_B, ttlSlot: 500 })]);
  const upTo = await replayAudit(head, WINDOW);
  const checkpoint = asCheckpoint(upTo);
  assert.equal(total(checkpoint.spends.map(s => ({ amount: BigInt(s.amount) }))), 300n);

  const tail = chain([released(TX_A)], upTo.lastSeq, upTo.lastHash);
  const r = await replayAudit([...head, ...tail], { ...WINDOW, checkpoint });
  assert.deepEqual(r.spends.map(s => [s.amount, s.tx]), [[200n, TX_B]]);
  assert.equal(r.malformedAt, undefined);
  assert.equal(r.chainBrokenAt, undefined);
});

test("a release takes a spend logged after the checkpoint just as it takes one before it", async () => {
  const lines = chain([signed("100", { tx: TX_A, ttlSlot: 500 }), signed("200", { tx: TX_B, ttlSlot: 500 }), released(TX_A)]);
  // No checkpoint at all: everything comes from the log.
  assert.deepEqual((await replayAudit(lines, WINDOW)).spends.map(s => s.tx), [TX_B]);
  // A checkpoint that holds neither: both spends and the release come after it.
  const empty: Checkpoint = { version: 1, seq: 0, hash: "", updatedAt: NOW, spends: [] };
  assert.deepEqual((await replayAudit(lines, { ...WINDOW, checkpoint: empty })).spends.map(s => s.tx), [TX_B]);
});

test("a release the checkpoint was written after is already in the checkpoint, and is ignored", async () => {
  const lines = chain([signed("100", { tx: TX_A, ttlSlot: 500 }), released(TX_A), signed("5")]);
  assert.equal(total((await replayAudit(lines, WINDOW)).spends), 5n);

  // A checkpoint that still lists the spend, written at the release's own seq and then after it:
  // if the release were applied it would remove it, so keeping it is what shows it was ignored.
  const holds = [{ ts: NOW, agentId: "a", asset: "lovelace", amount: "100", tx: TX_A, ttlSlot: 500 }];
  for (const seq of [2, 3]) {
    const upTo = await replayAudit(lines.slice(0, seq), WINDOW);
    const checkpoint: Checkpoint = { version: 1, seq: upTo.lastSeq, hash: upTo.lastHash, updatedAt: NOW, spends: holds };
    const r = await replayAudit(lines, { ...WINDOW, checkpoint });
    assert.equal(r.sawCheckpoint, true);
    assert.ok(r.spends.some(s => s.tx === TX_A), `a release at or before the checkpoint (seq ${seq}) was applied again`);
  }
});

test("a release that names nothing removes nothing", async () => {
  const base = [signed("100", { tx: TX_A, ttlSlot: 500 }), signed("200", { tx: TX_B, ttlSlot: 500 })];
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a transaction that was never signed", released("cc".repeat(32))],
    ["no transaction", released(undefined)],
    ["a transaction that is not a hash", released("not-a-hash")],
    ["an upper-case hash, which signerd never writes", released(TX_A.toUpperCase())],
    ["a number", released(12345)],
    // Its own record is older than the window, so it can only name a spend that has aged out.
    ["a release older than the window", released(TX_A, { ts: NOW - DAY - 1 })],
    ["a release with no timestamp", released(TX_A, { ts: undefined })],
  ];
  for (const [label, release] of cases) {
    const r = await replayAudit(chain([...base, release]), WINDOW);
    assert.equal(total(r.spends), 300n, `${label} changed the spend`);
    assert.equal(r.malformedAt, undefined, `${label} was reported as a malformed record`);
  }
});

test("a voucher's spend is never released, whatever it or the release says", async () => {
  const channelId = "cc".repeat(32);
  // A voucher lands in no transaction of its own, so a `tx` on one is not something to trust.
  const lines = chain([
    { event: "voucher_signed", agentId: "a", asset: "lovelace", amount: "1000", cumulative: "1000", channelId, tx: TX_A, ttlSlot: 500 },
    released(TX_A),
  ]);
  const r = await replayAudit(lines, WINDOW);
  assert.deepEqual(r.spends.map(s => [s.amount, Boolean(s.voucher), s.tx]), [[1000n, true, undefined]]);

  // Nor from the checkpoint, even if one were written carrying the pair.
  const checkpoint: Checkpoint = {
    version: 1,
    seq: 0,
    hash: "",
    updatedAt: NOW,
    spends: [{ ts: NOW, agentId: "a", asset: "lovelace", amount: "7", voucher: true, tx: TX_A, ttlSlot: 500 }],
  };
  const later = await replayAudit(chain([released(TX_A)]), { ...WINDOW, checkpoint });
  assert.deepEqual(later.spends.map(s => [s.amount, Boolean(s.voucher)]), [[7n, true]]);
});

test("a transaction or TTL that cannot be read keeps the spend, and is not a malformed record", async () => {
  const badTx: unknown[] = ["abc", 123, TX_A.toUpperCase(), null, "aa".repeat(31), `${"aa".repeat(32)}0`];
  for (const tx of badTx) {
    const r = await replayAudit(chain([signed("100", { tx, ttlSlot: 500 })]), WINDOW);
    assert.equal(r.malformedAt, undefined, `tx ${JSON.stringify(tx)} made the record malformed`);
    assert.deepEqual(r.spends.map(s => [s.amount, s.tx, s.ttlSlot]), [[100n, undefined, 500]], `tx ${JSON.stringify(tx)}`);
  }
  const badSlot: unknown[] = [-1, 1.5, "500", null, 2 ** 60, true];
  for (const ttlSlot of badSlot) {
    const r = await replayAudit(chain([signed("100", { tx: TX_A, ttlSlot })]), WINDOW);
    assert.equal(r.malformedAt, undefined, `ttlSlot ${JSON.stringify(ttlSlot)} made the record malformed`);
    assert.deepEqual(r.spends.map(s => [s.amount, s.tx, s.ttlSlot]), [[100n, TX_A, undefined]], `ttlSlot ${JSON.stringify(ttlSlot)}`);
  }
  // The checkpoint's spends are held to the same rule, and refusing one over these would take startup down.
  const checkpoint: Checkpoint = {
    version: 1,
    seq: 0,
    hash: "",
    updatedAt: NOW,
    spends: [{ ts: NOW, agentId: "a", asset: "lovelace", amount: "9", tx: "nonsense", ttlSlot: -4 }],
  };
  assert.deepEqual((await replayAudit([], { ...WINDOW, checkpoint })).spends.map(s => [s.amount, s.tx, s.ttlSlot]), [[9n, undefined, undefined]]);
});

test("two releases of one transaction remove one spend, and never more than exist", async () => {
  const twice = chain([signed("100", { tx: TX_A, ttlSlot: 500 }), signed("200", { tx: TX_B, ttlSlot: 500 }), released(TX_A), released(TX_A)]);
  assert.deepEqual((await replayAudit(twice, WINDOW)).spends.map(s => s.amount), [200n]);

  // Two records sharing a hash would be a bug somewhere else; one release must not hide it by taking both.
  const doubled = chain([signed("100", { tx: TX_A, ttlSlot: 500 }), signed("100", { tx: TX_A, ttlSlot: 500 }), released(TX_A)]);
  assert.equal((await replayAudit(doubled, WINDOW)).spends.length, 1);

  // And a release with nothing to release leaves spend where it was, never below it.
  const nothing = await replayAudit(chain([released(TX_A), released(TX_B)]), WINDOW);
  assert.equal(nothing.spends.length, 0);
});

test("a release does not disturb the approvals or the chain around it", async () => {
  const lines = chain([
    { event: "pending", id: "aaa", agentId: "a" },
    signed("100", { tx: TX_A, ttlSlot: 500 }),
    released(TX_A),
    { event: "approved", id: "aaa", agentId: "a" },
  ]);
  const r = await replayAudit(lines, WINDOW);
  assert.equal(r.chainBrokenAt, undefined);
  assert.equal(r.lastSeq, 4);
  assert.deepEqual(r.openApprovals, []);
  assert.equal(r.spends.length, 0);
});
