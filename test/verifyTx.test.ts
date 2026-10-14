import { test } from "node:test";
import assert from "node:assert/strict";
import { mismatch, overheadOf, rideOf, type SignedTransaction, type Authorised } from "../src/verifyTx.ts";

const PAYEE = "addr_test1payee";
const WALLET = "addr_test1wallet";
const STRANGER = "addr_test1stranger";
const USDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
const NONCE = "aa".repeat(32) + "#1";
/** What signerd runs with unless told otherwise: MAX_FEE_LOVELACE and MAX_RIDE_LOVELACE. */
const MAX_FEE = 1_000_000n;
const MAX_RIDE = 2_000_000n;

const want = (over: Partial<Authorised> = {}): Authorised => ({
  payTo: PAYEE,
  asset: "lovelace",
  amount: "1500000",
  changeTo: WALLET,
  nonce: NONCE,
  maxFeeLovelace: MAX_FEE,
  maxRideLovelace: MAX_RIDE,
  ...over,
});
// Updated for the fee and the balance-changing operations the checker now reads: a transaction
// without them is no longer a SignedTransaction. 180000 is an ordinary mainnet fee.
const tx = (outputs: SignedTransaction["outputs"], inputs = [NONCE], over: Partial<SignedTransaction> = {}): SignedTransaction => ({
  inputs,
  outputs,
  fee: 180_000n,
  balanceChangingOperations: [],
  ...over,
});

test("a payment to the payee with change back is fine", () => {
  assert.equal(
    mismatch(tx([{ address: PAYEE, coin: 1_500_000n }, { address: WALLET, coin: 9_000_000n }]), want()),
    undefined,
  );
});

test("paying more than authorised is fine; paying less is not", () => {
  assert.equal(mismatch(tx([{ address: PAYEE, coin: 1_600_000n }]), want()), undefined);
  assert.match(mismatch(tx([{ address: PAYEE, coin: 1_400_000n }]), want())!, /pays .* 1400000 .* not the 1500000/);
});

test("paying somebody else instead of the payee is caught", () => {
  assert.match(mismatch(tx([{ address: STRANGER, coin: 1_500_000n }]), want())!, /pays .* 0 of lovelace/);
});

test("paying the payee AND somebody else is caught", () => {
  // The facilitator would accept this: the seller got paid. It is the buyer's wallet that lost more
  // than it authorised, and the buyer is the only party who would notice.
  const t = tx([
    { address: PAYEE, coin: 1_500_000n },
    { address: STRANGER, coin: 5_000_000n },
    { address: WALLET, coin: 3_000_000n },
  ]);
  assert.match(mismatch(t, want())!, /also pays 1 address\(es\).*stranger/);
});

test("several outputs to the payee add up", () => {
  assert.equal(
    mismatch(tx([{ address: PAYEE, coin: 1_000_000n }, { address: PAYEE, coin: 500_000n }]), want()),
    undefined,
  );
});

test("a native asset is matched on its own key, not on the lovelace", () => {
  const w = want({ asset: USDM, amount: "2000000" });
  // Plenty of lovelace, none of the asset.
  assert.match(mismatch(tx([{ address: PAYEE, coin: 9_000_000n, assets: {} }]), w)!, /pays .* 0 of e675b46e/);
  assert.equal(mismatch(tx([{ address: PAYEE, coin: 1_200_000n, assets: { [USDM]: 2_000_000n } }]), w), undefined);
  assert.match(mismatch(tx([{ address: PAYEE, coin: 1_200_000n, assets: { [USDM]: 1_999_999n } }]), w)!, /1999999/);
});

test("the asset key is matched case-insensitively", () => {
  const w = want({ asset: USDM.toUpperCase(), amount: "1" });
  assert.equal(mismatch(tx([{ address: PAYEE, coin: 1n, assets: { [USDM]: 5n } }]), w), undefined);
});

test("a transaction that does not spend the nonce it reported is caught", () => {
  const t = tx([{ address: PAYEE, coin: 1_500_000n }], ["bb".repeat(32) + "#0"]);
  assert.match(mismatch(t, want())!, /does not spend the nonce it reported/);
});

// ---- the fee ---------------------------------------------------------------------------------

test("a fee up to the limit is fine, and one lovelace above it is refused", () => {
  const out = [{ address: PAYEE, coin: 1_500_000n }];
  assert.equal(mismatch(tx(out, [NONCE], { fee: MAX_FEE }), want()), undefined);
  assert.match(mismatch(tx(out, [NONCE], { fee: MAX_FEE + 1n }), want())!, /fee is 1000001 lovelace, above the 1000000 allowed \(MAX_FEE_LOVELACE\)/);
});

test("the 34 ADA fee a provider with an inflated min_fee_a produced is refused", () => {
  // From the review's probe: min_fee_a 88000 instead of 44, a one-unit tUSDM payment.
  const t = tx([{ address: PAYEE, coin: 1_159_390n, assets: { [USDM]: 1n } }], [NONCE], { fee: 34_299_381n });
  assert.match(mismatch(t, want({ asset: USDM, amount: "1" }))!, /fee is 34299381 lovelace/);
});

test("the limit is the operator's to move", () => {
  const t = tx([{ address: PAYEE, coin: 1_500_000n }], [NONCE], { fee: 3_000_000n });
  assert.match(mismatch(t, want())!, /MAX_FEE_LOVELACE/);
  assert.equal(mismatch(t, want({ maxFeeLovelace: 5_000_000n })), undefined);
});

// ---- the lovelace that rides to the payee --------------------------------------------------------

test("a token payment may carry its min-UTxO ADA to the payee, up to the limit", () => {
  const w = want({ asset: USDM, amount: "1" });
  const ok = (coin: bigint) => tx([{ address: PAYEE, coin, assets: { [USDM]: 1n } }]);
  // Mainnet's real parameters: about 1.16 ADA for a plain token output.
  assert.equal(mismatch(ok(1_159_390n), w), undefined);
  assert.equal(mismatch(ok(MAX_RIDE), w), undefined);
  assert.match(mismatch(ok(MAX_RIDE + 1n), w)!, /sends addr_test1payee 2000001 lovelace on top of the payment itself, above the 2000000 allowed \(MAX_RIDE_LOVELACE\)/);
});

test("the 347 ADA a provider with an inflated coins_per_utxo_size sent to the payee is refused", () => {
  const t = tx([{ address: PAYEE, coin: 347_817_000n, assets: { [USDM]: 1n } }]);
  assert.match(mismatch(t, want({ asset: USDM, amount: "1" }))!, /347817000 lovelace on top/);
});

test("for a lovelace payment the ride is what exceeds the amount", () => {
  const w = want({ amount: "5000000" });
  assert.equal(mismatch(tx([{ address: PAYEE, coin: 5_000_000n + MAX_RIDE }]), w), undefined);
  assert.match(mismatch(tx([{ address: PAYEE, coin: 5_000_000n + MAX_RIDE + 1n }]), w)!, /MAX_RIDE_LOVELACE/);
});

test("the payee's outputs are bounded together, not one at a time", () => {
  const w = want({ asset: USDM, amount: "2" });
  const split = tx([
    { address: PAYEE, coin: 1_500_000n, assets: { [USDM]: 1n } },
    { address: PAYEE, coin: 1_500_000n, assets: { [USDM]: 1n } },
  ]);
  assert.match(mismatch(split, w)!, /3000000 lovelace on top/);
});

test("a payee that is this wallet itself is bounded by the fee only: nothing else leaves", () => {
  const w = want({ payTo: WALLET, asset: USDM, amount: "1" });
  const t = tx([{ address: WALLET, coin: 900_000_000n, assets: { [USDM]: 10n } }]);
  assert.equal(mismatch(t, w), undefined);
  assert.equal(overheadOf(t, w), 180_000n);
});

// ---- operations that move value without an output --------------------------------------------

test("each balance-changing operation is refused", () => {
  const out = [{ address: PAYEE, coin: 1_500_000n }];
  for (const op of ["mint", "withdrawals", "certificates", "proposalProcedures", "donation"]) {
    assert.match(mismatch(tx(out, [NONCE], { balanceChangingOperations: [op] }), want())!, new RegExp(`carries ${op}, which no payment needs`), op);
  }
  assert.match(mismatch(tx(out, [NONCE], { balanceChangingOperations: ["mint", "donation"] }), want())!, /carries mint, donation/);
});

// ---- who else is paid -------------------------------------------------------------------------

test("no transfer method may pay a third address: escrow and script payments are the payee's output with a datum on it", () => {
  // Changed from "an escrow flow may pay an address that is neither", which exempted masumi and
  // script payments from this check. The builder (@x402/cardano 2.27, signer.buildAndSignPaymentTransaction)
  // makes exactly one payToAddress({ address: input.payTo }) output for the default, script and
  // masumi methods alike — the datum is attached to that output — so none of them has a reason to
  // pay anyone else, and the exemption was only a way for a third output to go unchecked.
  const t = tx([{ address: PAYEE, coin: 1_500_000n }, { address: STRANGER, coin: 1n }]);
  assert.match(mismatch(t, want())!, /also pays 1 address\(es\).*stranger/);
  assert.match(mismatch(tx([{ address: STRANGER, coin: 9n }]), want())!, /pays .* 0 of lovelace/);
});

// ---- what leaves beyond the payment -----------------------------------------------------------

test("the overhead of a lovelace payment to an ordinary address is the fee alone", () => {
  const t = tx([{ address: PAYEE, coin: 1_500_000n }, { address: WALLET, coin: 9_000_000n }]);
  assert.equal(rideOf(t, want()), 0n);
  assert.equal(overheadOf(t, want()), 180_000n);
});

test("the overhead of a token payment is the fee and the lovelace that rode to the payee", () => {
  const w = want({ asset: USDM, amount: "1" });
  const t = tx([{ address: PAYEE, coin: 1_159_390n, assets: { [USDM]: 1n } }, { address: WALLET, coin: 9_000_000n }], [NONCE], { fee: 172_453n });
  assert.equal(rideOf(t, w), 1_159_390n);
  assert.equal(overheadOf(t, w), 1_331_843n);
});

test("a lovelace payment with a datum counts what rode above its amount", () => {
  const t = tx([{ address: PAYEE, coin: 6_500_000n }], [NONCE], { fee: 200_000n });
  assert.equal(overheadOf(t, want({ amount: "5000000" })), 1_700_000n);
});
