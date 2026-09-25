import { test } from "node:test";
import assert from "node:assert/strict";
import { COLLATERAL_MAX, FEE_MAX, summaryProblem, type TxSummary } from "../src/channelTx.ts";

const WALLET = "addr_test1wallet";
const SELLER = "addr_test1seller";
const STRANGER = "addr_test1stranger";

const out = (address: string, lovelace: bigint, over: Partial<TxSummary["outputs"][number]> = {}) => ({ address, lovelace, tokens: false, atValidator: false, ...over });
const channel = (lovelace: bigint) => out("addr_test1script", lovelace, { atValidator: true });
const tx = (outputs: TxSummary["outputs"], over: Partial<TxSummary> = {}): TxSummary => ({ fee: 200_000n, outputs, extras: false, ...over });
const own = { wallet: WALLET };

test("an opening that locks the deposit and returns the change is fine", () => {
  assert.equal(summaryProblem("open", tx([channel(12_000_000n), out(WALLET, 30_000_000n)]), own), undefined);
});

test("an opening that also pays somebody else is caught", () => {
  // The seller's facilitator would accept it: the channel is there. Only this wallet would notice.
  assert.match(summaryProblem("open", tx([channel(12_000_000n), out(STRANGER, 1_000_000n), out(WALLET, 29_000_000n)]), own)!, /neither the channel nor this wallet: addr_test1stranger/);
  assert.match(summaryProblem("open", tx([channel(1n), channel(1n)]), own)!, /one output at the validator, found 2/);
  assert.match(summaryProblem("open", tx([out(WALLET, 1n)]), own)!, /one output at the validator, found 0/);
});

test("an opening runs no script, so it puts up no collateral", () => {
  assert.match(summaryProblem("open", tx([channel(1n)], { collateral: { total: 1n } }), own)!, /no collateral/);
});

test("fees and collateral stay small", () => {
  const ok = tx([channel(1n), out(WALLET, 1n)], { collateral: { total: COLLATERAL_MAX, returnTo: WALLET } });
  assert.equal(summaryProblem("topUp", ok, own), undefined);
  assert.match(summaryProblem("topUp", { ...ok, fee: FEE_MAX + 1n }, own)!, /fee is/);
  assert.match(summaryProblem("topUp", { ...ok, collateral: { total: COLLATERAL_MAX + 1n, returnTo: WALLET } }, own)!, /of collateral/);
  // Without a total, every collateral input is at stake.
  assert.match(summaryProblem("topUp", { ...ok, collateral: { returnTo: WALLET } }, own)!, /without stating how much/);
  assert.match(summaryProblem("topUp", { ...ok, collateral: { total: 1n, returnTo: STRANGER } }, own)!, /collateral return/);
});

test("minting, withdrawals, certificates and governance have no place in a channel step", () => {
  assert.match(summaryProblem("close", tx([channel(1n)], { extras: true }), own)!, /certificates, withdrawals, minting/);
});

test("a refund pays the seller at most what was signed and not yet redeemed", () => {
  const refund = (paid: bigint) => tx([out(SELLER, paid), out(WALLET, 8_000_000n)]);
  const want = { wallet: WALLET, payTo: SELLER, maxPayout: 2_000_000n };
  assert.equal(summaryProblem("refund", refund(2_000_000n), want), undefined);
  assert.match(summaryProblem("refund", refund(2_000_001n), want)!, /pays the seller 2000001, more than the 2000000/);
  // Split across outputs, it is the same money.
  assert.match(summaryProblem("refund", tx([out(SELLER, 1_500_000n), out(SELLER, 600_000n)]), want)!, /pays the seller 2100000/);
  assert.match(summaryProblem("refund", tx([out(SELLER, 1n, { tokens: true })]), want)!, /carries tokens/);
  assert.match(summaryProblem("refund", tx([channel(1n), out(WALLET, 1n)]), want)!, /nothing left at the validator/);
  // Only a refund pays the seller: the same output in an end is a stranger.
  assert.match(summaryProblem("end", refund(1n), want)!, /neither the channel nor this wallet/);
});

test("a close keeps the channel; an end or an elapse leaves nothing behind", () => {
  assert.equal(summaryProblem("close", tx([channel(5_000_000n), out(WALLET, 1n)]), own), undefined);
  assert.match(summaryProblem("close", tx([out(WALLET, 5_000_000n)]), own)!, /one output at the validator/);
  assert.equal(summaryProblem("end", tx([out(WALLET, 5_000_000n)]), own), undefined);
  assert.match(summaryProblem("elapse", tx([channel(1n), out(WALLET, 1n)]), own)!, /nothing left at the validator/);
});
