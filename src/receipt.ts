/**
 * What a settlement response means for the agent that paid. Pure logic: no chain, no keys, no I/O.
 *
 * Both tools used to answer "did I pay?" by whether a settlement response existed at all. It exists
 * on failure too — core builds a PAYMENT-RESPONSE with `success: false` on every settle error path —
 * so a payment the seller did not settle was reported to the agent as paid.
 *
 * There are three answers rather than two, because a failed settlement can still carry a
 * transaction. A facilitator that stops waiting before the block arrives reports failure for a
 * transaction that was broadcast and may well confirm: funds gone, no goods. That agent was not
 * served, but its money may have moved, and the hash is the one thing it can check that against.
 */

export interface Receipt {
  /** Settled: the seller says so and names the transaction. Never true without one. */
  paid: boolean;
  transaction?: string;
  network?: string;
  reason?: string;
}

/** `undefined` when there is no settlement response to read at all. */
export function receiptOf(settlement: unknown): Receipt | undefined {
  if (typeof settlement !== "object" || settlement === null) return undefined;
  const s = settlement as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const transaction = str(s.transaction);
  const network = str(s.network);
  const reason = str(s.errorReason);
  return {
    // A success with no transaction names nothing that can be checked, so it is not treated as one.
    paid: s.success === true && transaction !== undefined,
    ...(transaction ? { transaction } : {}),
    ...(network ? { network } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * The payment fields a tool reports. `signed` comes from signerd, not from the seller: it means a
 * spend was recorded, so the budget is gone whatever the seller did with the transaction.
 */
export function describePayment(receipt: Receipt | undefined, signed: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { paid: receipt?.paid === true };
  if (receipt?.transaction) out.transaction = receipt.transaction;
  if (receipt?.network) out.network = receipt.network;
  if (signed && !out.paid) {
    out.unsettled = receipt?.transaction
      ? `the seller says this did not settle, but transaction ${receipt.transaction} was broadcast: it may still confirm, and it counts against this agent's budget either way`
      : "a payment was signed and sent, but the seller did not settle it and named no transaction; it still counts against this agent's budget";
    if (receipt?.reason) out.reason = receipt.reason;
  }
  return out;
}
