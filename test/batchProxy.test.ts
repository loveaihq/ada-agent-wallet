import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PaymentRequirements } from "@x402/core/types";
import { createBatchProxy, preferBatch } from "../src/batchProxy.ts";
import { PolicyDenied } from "../src/gatedSigner.ts";

const req = (scheme: string): PaymentRequirements => ({ scheme, network: "cardano:preprod", asset: "lovelace", amount: "1000", payTo: "addr_test1seller", maxTimeoutSeconds: 300, extra: {} });

/** A stand-in signerd: answers each path with the next canned reply, and keeps what it was sent. */
async function fakeSignerd(replies: Record<string, Array<{ status: number; body: unknown }>>) {
  const seen: Array<{ path: string; body: Record<string, unknown>; auth?: string }> = [];
  const server: Server = createServer((rq, rs) => {
    let raw = "";
    rq.on("data", c => (raw += c));
    rq.on("end", () => {
      seen.push({ path: rq.url ?? "", body: JSON.parse(raw || "{}"), auth: rq.headers.authorization });
      const r = replies[rq.url ?? ""]?.shift() ?? { status: 404, body: {} };
      rs.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise(ok => server.close(ok)) };
}

test("the proxy forwards the 402 and hands back signerd's payload; it holds nothing itself", async () => {
  const payload = { type: "voucher", voucher: { channelId: "ab".repeat(32), maxClaimableAmount: "1000", signature: "00".repeat(64) } };
  const s = await fakeSignerd({ "/batch/payload": [{ status: 200, body: { x402Version: 2, payload } }] });
  let signed = 0;
  const proxy = createBatchProxy({ signerdUrl: s.url, token: "t0ken", agentId: "default", reason: () => "one datum", resource: () => "http://x/data", onSigned: () => signed++ });
  try {
    assert.deepEqual(await proxy.createPaymentPayload(2, req("batch-settlement")), { x402Version: 2, payload });
    assert.equal(signed, 1);
    assert.deepEqual(s.seen[0]!.body, { agentId: "default", reason: "one datum", resource: "http://x/data", x402Version: 2, requirements: req("batch-settlement") });
    assert.equal(s.seen[0]!.auth, "Bearer t0ken");
  } finally {
    await s.close();
  }
});

test("a refusal comes back as the policy's verdict, before @x402/fetch flattens it", async () => {
  const s = await fakeSignerd({ "/batch/payload": [{ status: 403, body: { error: "policy_denied", rule: "provider_key", detail: "not allowed" } }] });
  let denied: PolicyDenied | undefined;
  const proxy = createBatchProxy({ signerdUrl: s.url, token: "t", agentId: "a", reason: () => "r", onDenied: d => (denied = d) });
  try {
    await assert.rejects(proxy.createPaymentPayload(2, req("batch-settlement")), (e: unknown) => e instanceof PolicyDenied && e.rule === "provider_key");
    assert.equal(denied?.detail, "not allowed");
  } finally {
    await s.close();
  }
});

test("the seller's answer goes to signerd; a corrected count asks for one retry", async () => {
  const s = await fakeSignerd({ "/batch/response": [{ status: 200, body: { recovered: true } }, { status: 200, body: { recovered: false } }] });
  const proxy = createBatchProxy({ signerdUrl: s.url, token: "t", agentId: "a", reason: () => "r" });
  const hook = proxy.schemeHooks!.onPaymentResponse!;
  const base = { paymentPayload: { x402Version: 2, accepted: req("batch-settlement"), payload: {} }, requirements: req("batch-settlement") };
  try {
    assert.deepEqual(await hook({ ...base, paymentRequired: { x402Version: 2, accepts: [], resource: { url: "x" } } as never }), { recovered: true });
    assert.equal(await hook({ ...base, settleResponse: { success: true, transaction: "", network: "cardano:preprod" } as never }), undefined);
    // A transport error carries nothing to apply, so nothing is sent.
    assert.equal(await hook({ ...base, error: new Error("socket hang up") }), undefined);
    assert.equal(s.seen.length, 2);
  } finally {
    await s.close();
  }
});

test("batch-settlement goes first when allowed and last otherwise; nothing is dropped", () => {
  const offered = [req("exact"), req("batch-settlement")];
  assert.deepEqual(preferBatch(() => true)(2, offered).map(r => r.scheme), ["batch-settlement", "exact"]);
  assert.deepEqual(preferBatch(() => false)(2, offered).map(r => r.scheme), ["exact", "batch-settlement"]);
  // Offered alone and not allowed, it still reaches signerd, whose denial says why.
  assert.deepEqual(preferBatch(() => false)(2, [req("batch-settlement")]).map(r => r.scheme), ["batch-settlement"]);
});
