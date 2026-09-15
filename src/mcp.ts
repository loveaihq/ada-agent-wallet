/**
 * MCP server the agent talks to. Tools:
 *   wallet_status()                       — address, remaining budget, pending approvals
 *   x402_fetch(url, reason, method?, body?) — GET/POST a paid endpoint; pays automatically if the
 *                                           policy allows, otherwise returns the denial / pending id
 * The agent never sees a key. It never sees the signed tx either — @x402/core handles the 402 round-trip.
 *
 * Env: SIGNERD_URL (default http://127.0.0.1:7402), SIGNERD_TOKEN, AGENT_ID (default "default")
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactCardanoScheme } from "@x402/cardano";
import { createGatedSigner, PolicyDenied } from "./gatedSigner.js";

const SIGNERD_URL = process.env.SIGNERD_URL ?? "http://127.0.0.1:7402";
const TOKEN = process.env.SIGNERD_TOKEN ?? "";
const AGENT_ID = process.env.AGENT_ID ?? "default";
const headers = { authorization: `Bearer ${TOKEN}` };

/**
 * Per-call state, carried by async context rather than by module-level slots.
 *
 * An MCP server may have several tool calls in flight, and the signer callbacks below are reached
 * through `@x402/fetch` with no argument of ours to thread state through. Module-level slots would
 * let one call's reason be written into another call's audit record — and tying a payment to the
 * reason the agent gave for it is the whole point of that record. AsyncLocalStorage follows the
 * await chain into the callbacks instead, so each payment reads its own.
 */
interface CallContext {
  reason: string;
  /** The URL this call is fetching, so signerd can check it against the agent's allowedResources. */
  resource: string;
  denial?: PolicyDenied;
}
const callContext = new AsyncLocalStorage<CallContext>();

const signer = await createGatedSigner({
  signerdUrl: SIGNERD_URL,
  token: TOKEN,
  agentId: AGENT_ID,
  reason: () => callContext.getStore()?.reason ?? "",
  resource: () => callContext.getStore()?.resource,
  onDenied: d => {
    const store = callContext.getStore();
    if (store) store.denial = d;
  },
});
// spendControls: false — the per-payment USD cap in @x402/core is replaced by signerd's policy
// (per-tx, rolling daily, hourly rate, payee allowlist, human approval), enforced where the key lives.
const client = x402Client.fromConfig({
  schemes: [{ network: "cardano:*", client: new ExactCardanoScheme(signer) }],
  spendControls: false,
});
const payingFetch = wrapFetchWithPayment(fetch, client);

const server = new McpServer({ name: "ada-agent-wallet", version: "0.1.0" });

server.tool("wallet_status", "Wallet address, per-agent remaining budget (rolling 24h), pending approvals.", {}, async () => {
  const s = await fetch(`${SIGNERD_URL}/status`, { headers }).then(r => r.json());
  return { content: [{ type: "text", text: JSON.stringify({ agentId: AGENT_ID, ...s }, null, 2) }] };
});

server.tool(
  "x402_fetch",
  "Fetch a URL that may require x402 payment on Cardano. If it returns 402, the wallet pays within policy and retries. Always give a concrete reason — it goes in the audit log.",
  { url: z.string().url(), reason: z.string().min(3), method: z.enum(["GET", "POST"]).default("GET"), body: z.string().optional() },
  async ({ url, reason, method, body }) =>
    callContext.run({ reason, resource: url }, async () => {
      try {
        const r = await payingFetch(url, { method, body, headers: body ? { "content-type": "application/json" } : undefined });
        const text = await r.text();
        const paid = r.headers.get("payment-response") ?? r.headers.get("x-payment-response");
        return { content: [{ type: "text", text: JSON.stringify({ status: r.status, paid: Boolean(paid), body: text.slice(0, 20000) }, null, 2) }] };
      } catch (e) {
        // `@x402/fetch` rethrows the signer's error as a plain Error with no `cause`, so the
        // verdict is recovered from this call's context rather than from the caught value.
        const denied = e instanceof PolicyDenied ? e : callContext.getStore()?.denial;
        if (denied) {
          return { content: [{ type: "text", text: JSON.stringify({ denied: true, rule: denied.rule, detail: denied.detail, pendingId: denied.pendingId }) }], isError: true };
        }
        return { content: [{ type: "text", text: `error: ${String(e)}` }], isError: true };
      }
    }),
);

await server.connect(new StdioServerTransport());
