/**
 * Checking that the transaction we signed says what we authorised. Pure logic: no chain, no keys.
 *
 * The policy decides on the requested payment, the SDK builds a transaction from it, and nothing
 * looked at what came back. The facilitator does check the payee was paid — but the facilitator is
 * the seller's, and the one thing it has no reason to check is whether this wallet also paid
 * somebody else.
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
}
export interface Authorised {
  payTo: string;
  asset: string;
  amount: string;
  /** This wallet's own address, so change can be told apart from a payment to a stranger. */
  changeTo: string;
  nonce: string;
  /** Only "default" keeps every output to the payee or to us; escrow flows pay a script. */
  assetTransferMethod?: string;
}

/** Returns the reason it does not match, or undefined. */
export function mismatch(tx: SignedTransaction, want: Authorised): string | undefined {
  if (!tx.inputs.includes(want.nonce)) return `it does not spend the nonce it reported (${want.nonce})`;

  const key = want.asset.toLowerCase();
  const wanted = BigInt(want.amount);
  const paid = tx.outputs
    .filter(o => o.address === want.payTo)
    .reduce((sum, o) => sum + (key === "lovelace" ? o.coin : (o.assets?.[key] ?? 0n)), 0n);
  if (paid < wanted) return `it pays ${want.payTo} ${paid} of ${want.asset}, not the ${wanted} authorised`;

  // An escrow flow pays a script address by design, so the only method whose outputs are fully
  // accounted for is the plain one.
  if ((want.assetTransferMethod ?? "default") !== "default") return undefined;
  const strangers = [...new Set(tx.outputs.filter(o => o.address !== want.payTo && o.address !== want.changeTo).map(o => o.address))];
  if (strangers.length) return `it also pays ${strangers.length} address(es) that are neither the payee nor this wallet: ${strangers.join(", ")}`;

  return undefined;
}
