/**
 * Checking that the transaction we signed says what we authorised. Pure logic: no chain, no keys.
 *
 * The policy decides on the requested payment, the SDK builds a transaction from it, and nothing
 * looked at what came back. The facilitator does check the payee was paid — but the facilitator is
 * the seller's, and the one thing it has no reason to check is whether this wallet also paid
 * somebody else.
 *
 * It is also not only who is paid but how much leaves. The fee and the minimum ADA an output must
 * carry are computed by the builder from protocol parameters the chain provider supplies, and a
 * provider that inflates `min_fee_a` or `coins_per_utxo_size` gets a bigger fee, or a bigger
 * lovelace amount riding to the payee with a token payment, out of an honest builder. Neither is in
 * the policy's `amount`, so both are bounded here instead (`maxFeeLovelace`, `maxRideLovelace`) and
 * counted by signerd against the agent's lovelace caps (`overheadOf`).
 *
 * This runs against the same bundle that built the transaction, so it catches a builder that is
 * wrong rather than a bundle that is lying. That is still the difference between one code path
 * being right and two agreeing.
 */

export interface Output {
  address: string;
  coin: bigint;
  assets?: Record<string, bigint>;
}
export interface SignedTransaction {
  inputs: string[];
  outputs: Output[];
  /** Lovelace the transaction pays the network. */
  fee: bigint;
  /**
   * What the decoder found that moves value without being an output: "mint", "withdrawals",
   * "certificates", "proposalProcedures", "donation". No payment this wallet makes needs any of them.
   */
  balanceChangingOperations: readonly string[];
}
export interface Authorised {
  payTo: string;
  asset: string;
  amount: string;
  /** This wallet's own address, so change can be told apart from a payment to a stranger. */
  changeTo: string;
  nonce: string;
  /** The most the transaction may pay in fee. */
  maxFeeLovelace: bigint;
  /**
   * The most lovelace the payee's outputs may carry beyond the authorised amount: for a token
   * payment, the whole of it (the min-UTxO ADA the output must hold, and more with a datum); for a
   * lovelace payment, what exceeds `amount`.
   */
  maxRideLovelace: bigint;
}

/** The lovelace in every output to `payTo`. */
export function payeeLovelace(tx: SignedTransaction, payTo: string): bigint {
  return tx.outputs.filter(o => o.address === payTo).reduce((sum, o) => sum + o.coin, 0n);
}

/**
 * The lovelace that goes to the payee on top of what was authorised: all of it for a token payment,
 * the part over `amount` for a lovelace one. Zero when the payee is this wallet itself, because
 * nothing then leaves it but the fee.
 */
export function rideOf(tx: SignedTransaction, want: Pick<Authorised, "payTo" | "asset" | "amount" | "changeTo">): bigint {
  if (want.payTo === want.changeTo) return 0n;
  const authorised = want.asset.toLowerCase() === "lovelace" ? BigInt(want.amount) : 0n;
  const ride = payeeLovelace(tx, want.payTo) - authorised;
  return ride > 0n ? ride : 0n;
}

/**
 * The ADA that leaves the wallet with a payment beyond the payment itself: the fee, and the ride.
 * For a lovelace payment to an ordinary address this is the fee alone; for a token payment it is
 * the fee and the min-UTxO ADA the payee's output carries.
 */
export function overheadOf(tx: SignedTransaction, want: Pick<Authorised, "payTo" | "asset" | "amount" | "changeTo">): bigint {
  return tx.fee + rideOf(tx, want);
}

/** Returns the reason it does not match, or undefined. */
export function mismatch(tx: SignedTransaction, want: Authorised): string | undefined {
  if (!tx.inputs.includes(want.nonce)) return `it does not spend the nonce it reported (${want.nonce})`;

  // Before anything about amounts: a payment has no use for a certificate, a withdrawal, a mint, a
  // vote or a donation, and each of them moves value the outputs do not show.
  if (tx.balanceChangingOperations.length)
    return `it carries ${tx.balanceChangingOperations.join(", ")}, which no payment needs`;

  if (tx.fee > want.maxFeeLovelace)
    return `its fee is ${tx.fee} lovelace, above the ${want.maxFeeLovelace} allowed (MAX_FEE_LOVELACE); the chain provider's protocol parameters may be wrong`;

  const key = want.asset.toLowerCase();
  const wanted = BigInt(want.amount);
  const paid = tx.outputs
    .filter(o => o.address === want.payTo)
    .reduce((sum, o) => sum + (key === "lovelace" ? o.coin : (o.assets?.[key] ?? 0n)), 0n);
  if (paid < wanted) return `it pays ${want.payTo} ${paid} of ${want.asset}, not the ${wanted} authorised`;

  // The only thing the builder puts in this wallet's transaction besides change is the one output
  // to `payTo`, in every transfer method: an escrow or script payment is that same output with a
  // datum on it, so none of them has a reason to pay a third address.
  const ride = rideOf(tx, want);
  if (ride > want.maxRideLovelace)
    return `it sends ${want.payTo} ${ride} lovelace on top of the payment itself, above the ${want.maxRideLovelace} allowed (MAX_RIDE_LOVELACE); the chain provider's protocol parameters, or the seller's datum, may be inflating it`;

  const strangers = [...new Set(tx.outputs.filter(o => o.address !== want.payTo && o.address !== want.changeTo).map(o => o.address))];
  if (strangers.length) return `it also pays ${strangers.length} address(es) that are neither the payee nor this wallet: ${strangers.join(", ")}`;

  return undefined;
}
