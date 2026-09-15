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
