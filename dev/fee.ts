import { decodeCardanoTransaction } from "@x402/cardano";

/**
 * The fee of a transaction signerd handed out. A signed payment is recorded as the payment and, beside
 * it, the ADA that left with it (see SpendRecord.overhead in src/policy.ts) — for a lovelace payment
 * that is its fee — so a check that compares `dailySpent` with an amount has to add this to it.
 */
export function feeOf(transaction: unknown): bigint {
  return decodeCardanoTransaction(String(transaction)).fee;
}
