import { test } from "node:test";
import assert from "node:assert/strict";
import { mismatch, type SignedTransaction, type Authorised } from "../src/verifyTx.ts";

const PAYEE = "addr_test1payee";
const WALLET = "addr_test1wallet";
const STRANGER = "addr_test1stranger";
const USDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
const NONCE = "aa".repeat(32) + "#1";

const want = (over: Partial<Authorised> = {}): Authorised => ({
  payTo: PAYEE,
  asset: "lovelace",
  amount: "1500000",
  changeTo: WALLET,
  nonce: NONCE,
  ...over,
});
const tx = (outputs: SignedTransaction["outputs"], inputs = [NONCE]): SignedTransaction => ({ inputs, outputs });

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

test("an escrow flow may pay an address that is neither, but must still pay the payee", () => {
  const escrow = want({ assetTransferMethod: "masumi" });
  assert.equal(
    mismatch(tx([{ address: PAYEE, coin: 1_500_000n }, { address: STRANGER, coin: 1n }]), escrow),
    undefined,
  );
  assert.match(mismatch(tx([{ address: STRANGER, coin: 9n }]), escrow)!, /pays .* 0 of lovelace/);
});
