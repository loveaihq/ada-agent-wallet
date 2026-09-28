import { test } from "node:test";
import assert from "node:assert/strict";
import { COLLATERAL_MAX, FEE_MAX, summaryProblem, type TxSummary } from "../src/channelTx.ts";

const WALLET = "addr_test1wallet";
const SELLER = "addr_test1seller";
const STRANGER = "addr_test1stranger";

const out = (address: string, lovelace: bigint, over: Partial<TxSummary["outputs"][number]> = {}) => ({ address, lovelace, tokens: false, atValidator: false, ...over });
const channel = (lovelace: bigint) => out("addr_test1script", lovelace, { atValidator: true });
const tx = (outputs: TxSummary["outputs"], over: Partial<TxSummary> = {}): TxSummary => ({ fee: 200_000n, inputs: [], outputs, extras: false, ...over });
const own = { wallet: WALLET };
/** Refs: one of this wallet's UTxOs, the seller's fee-sponsor offer, and another of the seller's. */
const MINE = `${"aa".repeat(32)}#0`;
const OFFER = `${"0f".repeat(32)}#3`;
const OTHER = `${"0f".repeat(32)}#4`;

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
  assert.match(summaryProblem("open", tx([channel(1n)], { collateral: { inputs: [MINE], total: 1n } }), own)!, /no collateral/);
});

test("fees and collateral stay small", () => {
  const ok = tx([channel(1n), out(WALLET, 1n)], { collateral: { inputs: [MINE], total: COLLATERAL_MAX, returnTo: WALLET } });
  assert.equal(summaryProblem("topUp", ok, own), undefined);
  assert.match(summaryProblem("topUp", { ...ok, fee: FEE_MAX + 1n }, own)!, /fee is/);
  assert.match(summaryProblem("topUp", { ...ok, collateral: { inputs: [MINE], total: COLLATERAL_MAX + 1n, returnTo: WALLET } }, own)!, /of collateral/);
  // Without a total, every collateral input is at stake.
  assert.match(summaryProblem("topUp", { ...ok, collateral: { inputs: [MINE], returnTo: WALLET } }, own)!, /without stating how much/);
  assert.match(summaryProblem("topUp", { ...ok, collateral: { inputs: [MINE], total: 1n, returnTo: STRANGER } }, own)!, /collateral return/);
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

// ---- sponsored steps: the seller's fee-sponsor offer pays (subbit-x402's SPONSORSHIP.md) ----

const S = 4_000_000n; // the offer's lovelace, as the chain holds it
const RESERVE = 2_133_450n;
const OWN = 1_176_630n; // what this wallet's token UTxO carries
const offered = { wallet: WALLET, payTo: SELLER, sponsor: { input: OFFER, lovelace: S } };
const tokens = (address: string, lovelace: bigint) => out(address, lovelace, { tokens: true });

test("a sponsored opening: the offer pays the channel's reserve and the fee, the rest goes to the seller, this wallet's ADA comes back", () => {
  const fee = 190_185n;
  const opening = (paid: bigint, over: Partial<TxSummary> = {}) =>
    tx([tokens(WALLET, OWN), channel(RESERVE), out(SELLER, paid)], { fee, inputs: [MINE, OFFER], ...over });
  assert.equal(summaryProblem("open", opening(S - RESERVE - fee), offered), undefined);
  // One lovelace more to the seller would be this wallet's.
  assert.match(summaryProblem("open", opening(S - RESERVE - fee + 1n), offered)!, /this wallet's ADA would pay the rest/);
  // An offer the opening does not spend brings nothing: the reserve and the fee would be this wallet's.
  assert.match(summaryProblem("open", opening(S - RESERVE - fee, { inputs: [MINE] }), offered)!, /does not spend the seller's offer/);
  assert.match(summaryProblem("open", tx([tokens(WALLET, OWN), channel(RESERVE), tokens(SELLER, S - RESERVE - fee)], { fee, inputs: [MINE, OFFER] }), offered)!, /carries tokens/);
  // Unsponsored, the same payment to the seller is a stranger's.
  assert.match(summaryProblem("open", opening(S - RESERVE - fee), { wallet: WALLET, payTo: SELLER })!, /neither the channel nor this wallet: addr_test1seller/);
});

test("a sponsored top-up: the offer pays the fee and stands as the only collateral, and the channel's ADA does not grow on this wallet's", () => {
  const fee = 266_182n;
  const collateral = { inputs: [OFFER], total: 1_000_000n, returnTo: SELLER };
  const topUp = (kept: bigint, over: Partial<TxSummary> = {}) =>
    tx([tokens(WALLET, OWN), channel(kept), out(SELLER, S - fee)], { fee, inputs: [MINE, OFFER, `${"cc".repeat(32)}#0`], collateral, ...over });
  const want = { ...offered, channelLovelace: RESERVE };
  assert.equal(summaryProblem("topUp", topUp(RESERVE), want), undefined);
  assert.match(summaryProblem("topUp", topUp(RESERVE + 1n), want)!, /this wallet's ADA would pay the rest/);
  // Collateral of this wallet's, with its return at the seller, or beside the offer: refused.
  assert.match(summaryProblem("topUp", topUp(RESERVE, { collateral: { ...collateral, inputs: [MINE] } }), want)!, /collateral is the seller's offer and nothing else/);
  assert.match(summaryProblem("topUp", topUp(RESERVE, { collateral: { ...collateral, inputs: [OFFER, MINE] } }), want)!, /collateral is the seller's offer and nothing else/);
  // Without the channel's own ADA counted, its reserve would look like this wallet's paying.
  assert.match(summaryProblem("topUp", topUp(RESERVE), offered)!, /this wallet's ADA would pay the rest/);
});

test("a sponsored refund: the offer is only collateral, the channel's ADA less the fee goes back to the seller, and no more", () => {
  const fee = 244_491n;
  const collateral = { inputs: [OFFER], total: 1_000_000n, returnTo: SELLER };
  const refund = (paid: bigint, over: Partial<TxSummary> = {}) =>
    tx([tokens(WALLET, OWN), out(SELLER, paid)], { fee, inputs: [`${"cc".repeat(32)}#0`, MINE], collateral, ...over });
  const want = { ...offered, maxPayout: 0n, channelLovelace: RESERVE };
  assert.equal(summaryProblem("refund", refund(RESERVE - fee), want), undefined);
  // The whole reserve to the seller would leave the fee to this wallet.
  assert.match(summaryProblem("refund", refund(RESERVE), want)!, /this wallet's ADA would pay the rest/);
  assert.match(summaryProblem("refund", refund(RESERVE - fee, { inputs: [`${"cc".repeat(32)}#0`, MINE, OFFER] }), want)!, /spends the seller's offer/);
  assert.match(summaryProblem("refund", refund(RESERVE - fee, { collateral: undefined }), want)!, /puts up none/);
  assert.match(summaryProblem("refund", refund(RESERVE - fee, { collateral: { ...collateral, inputs: [OTHER] } }), want)!, /the seller's offer and nothing else/);
  // Unsponsored, the channel's ADA is this wallet's reserve: none of it may go to the seller.
  assert.match(summaryProblem("refund", tx([tokens(WALLET, OWN + RESERVE - fee)], { fee, collateral: { inputs: [MINE], total: 1_000_000n, returnTo: SELLER } }), { wallet: WALLET, payTo: SELLER, maxPayout: 0n })!, /collateral return goes to another address/);
  assert.match(summaryProblem("refund", refund(RESERVE - fee, { collateral: { inputs: [MINE], total: 1_000_000n, returnTo: WALLET } }), { wallet: WALLET, payTo: SELLER, maxPayout: 0n })!, /pays the seller 1888959, more than the 0/);
});

test("a close, an end or an elapse is never sponsored", () => {
  for (const step of ["close", "end", "elapse"] as const) {
    assert.match(summaryProblem(step, tx([out(WALLET, 5_000_000n)], { inputs: [OFFER] }), offered)!, new RegExp(`a ${step} is never sponsored`));
  }
});
