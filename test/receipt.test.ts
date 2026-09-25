import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePaymentResponseHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { receiptOf, describePayment } from "../src/receipt.ts";

const TX = "6d94fdc0617a8e58ca23402826f36767bab9a00a77dfe02de851d5828428e7e0";

test("a settlement that succeeded and names its transaction is paid", () => {
  assert.deepEqual(receiptOf({ success: true, transaction: TX, network: "cardano:preprod" }), { paid: true, transaction: TX, network: "cardano:preprod" });
});

test("core's own failure shape is not paid", () => {
  // Exactly what core builds on a generic settle error: success false, transaction "".
  const r = receiptOf({ success: false, errorReason: "Settlement failed", errorMessage: "Settlement failed", network: "cardano:preprod", transaction: "" });
  assert.equal(r?.paid, false);
  assert.equal(r?.transaction, undefined);
  assert.equal(r?.reason, "Settlement failed");
});

test("a failed settlement that still broadcast keeps its transaction", () => {
  // The trap: the facilitator gave up before the block, so the seller reports failure for a
  // transaction that may confirm. Not paid — but the hash must survive, or the agent cannot check.
  const r = receiptOf({ success: false, errorReason: "mempool", transaction: TX });
  assert.equal(r?.paid, false);
  assert.equal(r?.transaction, TX);
});

test("a success that names no transaction is not trusted as one", () => {
  assert.equal(receiptOf({ success: true, transaction: "" })?.paid, false);
  assert.equal(receiptOf({ success: true })?.paid, false);
});

test("nothing to read is not a receipt", () => {
  for (const v of [undefined, null, "PAYMENT-RESPONSE", 42]) assert.equal(receiptOf(v), undefined);
});

test("the header the tool decodes is the header core encodes, on both outcomes", () => {
  // Pins receiptOf to the real wire format rather than to a guess at it: a change in core's encoding
  // fails here instead of turning every payment into "not paid", or every failure into "paid".
  const ok = decodePaymentResponseHeader(encodePaymentResponseHeader({ success: true, transaction: TX, network: "cardano:preprod" } as never));
  assert.equal(receiptOf(ok)?.paid, true);
  const failed = decodePaymentResponseHeader(encodePaymentResponseHeader({ success: false, errorReason: "Settlement failed", transaction: "", network: "cardano:preprod" } as never));
  assert.equal(receiptOf(failed)?.paid, false);
});

test("an unsigned call that was not paid says only that", () => {
  assert.deepEqual(describePayment(undefined, false), { paid: false });
});

test("a settled payment carries its receipt and no warning", () => {
  const out = describePayment({ paid: true, transaction: TX, network: "cardano:preprod" }, true);
  assert.equal(out.paid, true);
  assert.equal(out.transaction, TX);
  assert.equal(out.unsettled, undefined);
});

test("signed but never settled says the budget is spent anyway", () => {
  const out = describePayment({ paid: false, reason: "exact_cardano_facilitator_chain_lookup_failed" }, true);
  assert.equal(out.paid, false);
  assert.match(String(out.unsettled), /counts against this agent's budget/);
  assert.equal(out.reason, "exact_cardano_facilitator_chain_lookup_failed");
});

test("signed, reported failed, but broadcast: the warning names the transaction", () => {
  const out = describePayment({ paid: false, transaction: TX }, true);
  assert.equal(out.paid, false);
  assert.equal(out.transaction, TX);
  assert.match(String(out.unsettled), new RegExp(`transaction ${TX} was broadcast`));
});

test("signed with no settlement response at all still warns", () => {
  // A verify failure returns no PAYMENT-RESPONSE, but signerd already recorded the spend.
  assert.match(String(describePayment(undefined, true).unsettled), /counts against this agent's budget/);
});

test("a batch-settlement voucher settles with no transaction, and names the voucher instead", () => {
  // The seller redeems it later, with many others, in one transaction of its own.
  const commitmentId = `${"cc".repeat(32)}:5000`;
  const r = receiptOf({ success: true, transaction: "", network: "cardano:preprod", extra: { chargedAmount: "1000", commitmentId } });
  assert.deepEqual(r, { paid: true, voucher: commitmentId, network: "cardano:preprod" });
  assert.deepEqual(describePayment(r, true), { paid: true, network: "cardano:preprod", voucher: commitmentId });
  // A failure that names a voucher is still a failure.
  assert.equal(receiptOf({ success: false, transaction: "", extra: { commitmentId } })?.paid, false);
});
