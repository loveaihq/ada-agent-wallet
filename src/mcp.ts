/**
 * MCP server the agent talks to. Tools:
 *   wallet_status()                       — address, remaining budget, pending approvals
 *   x402_fetch(url, reason, method?, body?) — GET/POST a paid endpoint; pays automatically if the
 *                                           policy allows, otherwise returns the denial / pending id
 *   x402_mcp_tools(server)                — what a remote MCP server offers, and what it charges
 *   x402_mcp_call(server, tool, args, reason) — a paid MCP tool, through the same policy gate
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
import { decodePaymentResponseHeader } from "@x402/core/http";
import { receiptOf, describePayment, type Receipt } from "./receipt.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { wrapMCPClientWithPayment, type x402MCPClient } from "@x402/mcp";

const SIGNERD_URL = process.env.SIGNERD_URL ?? "http://127.0.0.1:7402";
const TOKEN = process.env.SIGNERD_TOKEN ?? "";
const AGENT_ID = process.env.AGENT_ID ?? "default";
const headers = { authorization: `Bearer ${TOKEN}` };

/**
 * Per-call state. The signer callbacks below are reached through `@x402/fetch` with no argument of
 * ours to thread state through, and module-level slots would let one concurrent tool call's reason
 * land in another's audit record.
 */
interface CallContext {
  reason: string;
  /** The URL this call is fetching, so signerd can check it against the agent's allowedResources. */
  resource: string;
  denial?: PolicyDenied;
  /** signerd signed during this call, so a spend is on the ledger whatever the seller does next. */
  signed?: boolean;
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
  onSigned: () => {
    const store = callContext.getStore();
    if (store) store.signed = true;
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
  try {
    const r = await fetch(`${SIGNERD_URL}/status`, { headers });
    const s = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    // A 401 or a 503 body is not a status; an agent told "here is your wallet" would read it as one.
    if (!r.ok) return { content: [{ type: "text", text: `wallet unavailable: signerd returned ${r.status} ${JSON.stringify(s)}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify({ agentId: AGENT_ID, ...s }, null, 2) }] };
  } catch (e) {
    // An agent can act on "the daemon is not running"; it cannot act on a fetch stack trace.
    return {
      content: [{ type: "text", text: `wallet unavailable: signerd is not answering at ${SIGNERD_URL} (${e instanceof Error ? e.message : String(e)})` }],
      isError: true,
    };
  }
});

server.tool(
  "x402_fetch",
  "Fetch a URL that may require x402 payment on Cardano. If it returns 402, the wallet pays within policy and retries. Always give a concrete reason — it goes in the audit log.",
  {
    // `z.string().url()` accepts every scheme the URL parser does, file: and data: included.
    url: z
      .string()
      .url()
      .refine(u => /^https?:$/.test(new URL(u).protocol), { message: "url must be http or https" }),
    // Capped because it is written verbatim into an append-only log that signerd replays at every
    // start, not because a sentence needs a limit.
    reason: z.string().min(3).max(1000),
    method: z.enum(["GET", "POST"]).default("GET"),
    body: z.string().optional(),
  },
  async ({ url, reason, method, body }) =>
    callContext.run({ reason, resource: url }, async () => {
      try {
        const r = await payingFetch(url, { method, body, headers: body ? { "content-type": "application/json" } : undefined });
        const text = await r.text();
        // That the header exists is not that the payment settled: core sends it with `success: false`
        // on every settle failure, and this used to report each of those to the agent as paid.
        const header = r.headers.get("payment-response") ?? r.headers.get("x-payment-response");
        let receipt: Receipt | undefined;
        if (header) {
          try {
            receipt = receiptOf(decodePaymentResponseHeader(header));
          } catch {
            receipt = { paid: false, reason: "the seller's settlement header could not be decoded" };
          }
        }
        const LIMIT = 20000;
        return {
          content: [
            {
              type: "text",
              // An agent that does not know it is reading a fragment will reason from the half it got.
              text: JSON.stringify(
                {
                  status: r.status,
                  ...describePayment(receipt, Boolean(callContext.getStore()?.signed)),
                  truncated: text.length > LIMIT,
                  bytes: text.length,
                  body: text.slice(0, LIMIT),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        // `@x402/fetch` rethrows as a plain Error with no `cause`, so the verdict comes from the
        // call context rather than from the caught value.
        const denied = e instanceof PolicyDenied ? e : callContext.getStore()?.denial;
        if (denied) {
          return { content: [{ type: "text", text: JSON.stringify({ denied: true, rule: denied.rule, detail: denied.detail, pendingId: denied.pendingId }) }], isError: true };
        }
        return { content: [{ type: "text", text: `error: ${String(e)}` }], isError: true };
      }
    }),
);

/**
 * The other half of x402: a 402 that arrives over MCP itself rather than over HTTP.
 *
 * `x402_fetch` above pays for a web resource. A paid MCP *tool* is a different thing — the charge
 * comes back inside the tool call — and `@x402/mcp` is the official client for it. It takes an
 * `x402Client`, and the one built above already has the gated signer inside, so the same policy,
 * the same audit log and the same approval queue cover both without a second code path.
 *
 * Worth naming: `@x402/mcp`'s own `onPaymentRequested` hook is documented as the place to put
 * human-in-the-loop approval, and it runs in *this* process — which is the thing signerd exists in
 * order not to rely on. It is deliberately left unset. The verdict is signerd's.
 *
 * Connections are per call. A pool would be faster and would have to answer what happens to a
 * half-open session while a payment sits in the approval queue; reconnecting costs a round trip
 * and answers nothing.
 */
const httpUrl = z
  .string()
  .url()
  .refine(u => /^https?:$/.test(new URL(u).protocol), { message: "must be http or https" });

/**
 * Two copies of `@x402/core` are installed: the vendored 2.25.0 this wallet is built against, and
 * the 2.26.0 that `@x402/mcp` declares. They are the same client structurally, but `x402Client`
 * carries a private field, so TypeScript compares the two nominally and refuses the hand-off.
 *
 * Checked before taking the cast rather than after: `@x402/mcp` does no `instanceof` on the payment
 * client and calls exactly two of its methods — `createPaymentPayload(paymentRequired)` and
 * `handlePaymentResponse(ctx)` — and both signatures match on both copies. The assertion fails at
 * startup rather than mid-payment if a later version widens that surface.
 *
 * All of this goes away when `@x402/cardano` is published and vendor/ can be dropped: one core.
 */
for (const method of ["createPaymentPayload", "handlePaymentResponse"] as const) {
  if (typeof (client as unknown as Record<string, unknown>)[method] !== "function")
    throw new Error(`@x402/mcp needs x402Client.${method}, which the installed @x402/core does not have`);
}
const paymentClient = client as unknown as Parameters<typeof wrapMCPClientWithPayment>[1];

async function withRemote<T>(serverUrl: string, kind: "http" | "sse", use: (paid: x402MCPClient) => Promise<T>): Promise<T> {
  const paid = wrapMCPClientWithPayment(new McpClient({ name: "ada-agent-wallet", version: "0.1.0" }), paymentClient, {
    autoPayment: true,
  });
  try {
    await paid.connect(kind === "sse" ? new SSEClientTransport(new URL(serverUrl)) : new StreamableHTTPClientTransport(new URL(serverUrl)));
  } catch (e) {
    // Naming the transport matters: "http" against an SSE-only server fails here and nowhere else.
    throw new Error(`could not connect to the MCP server at ${serverUrl} over ${kind}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    return await use(paid);
  } finally {
    await paid.close().catch(() => {});
  }
}

server.tool(
  "x402_mcp_tools",
  "List the tools a remote MCP server offers, and what each one charges. Free: this asks, it does not buy.",
  { server: httpUrl, transport: z.enum(["http", "sse"]).default("http") },
  async ({ server: serverUrl, transport }) => {
    try {
      const tools = await withRemote(serverUrl, transport, async paid => {
        const { tools } = await paid.listTools();
        // Price per tool, so the agent can choose before it spends rather than after.
        return Promise.all(
          tools.map(async t => {
            const req = await paid.getToolPaymentRequirements(t.name).catch(() => null);
            const accept = req?.accepts?.[0];
            return {
              name: t.name,
              description: t.description,
              price: accept ? { amount: accept.amount, asset: accept.asset, network: accept.network, payTo: accept.payTo } : "free",
            };
          }),
        );
      });
      return { content: [{ type: "text", text: JSON.stringify({ server: serverUrl, tools }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  },
);

server.tool(
  "x402_mcp_call",
  "Call a tool on a remote MCP server that may charge for it. If it asks for payment, the wallet pays within policy and retries. Always give a concrete reason — it goes in the audit log.",
  {
    server: httpUrl,
    tool: z.string().min(1).max(200),
    args: z.record(z.unknown()).default({}),
    // Same cap and the same reason as x402_fetch: it is written verbatim into an append-only log
    // that signerd replays at every start.
    reason: z.string().min(3).max(1000),
    transport: z.enum(["http", "sse"]).default("http"),
  },
  async ({ server: serverUrl, tool, args, reason, transport }) =>
    // The resource is the server, not the tool: it is the URL the agent reports it is paying for,
    // which is what `allowedResources` is written against. Per-tool allowlisting would need a
    // resource shape the policy file does not have; the tool name is in the audit record instead.
    callContext.run({ reason: `${reason} [mcp tool ${tool}]`, resource: serverUrl }, async () => {
      try {
        const result = await withRemote(serverUrl, transport, paid => paid.callTool(tool, args));
        // `paymentMade` means a payment went out with the retry, not that it settled, and a seller
        // whose facilitator rejects it still sets it. Settled is read from the settlement itself, and
        // whether anything was spent from signerd, which is the one that knows.
        const text = JSON.stringify(result.content);
        const LIMIT = 20000;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  tool,
                  ...describePayment(receiptOf(result.paymentResponse), Boolean(callContext.getStore()?.signed)),
                  truncated: text.length > LIMIT,
                  bytes: text.length,
                  content: text.length > LIMIT ? text.slice(0, LIMIT) : result.content,
                },
                null,
                2,
              ),
            },
          ],
          isError: Boolean(result.isError),
        };
      } catch (e) {
        // Same reason as x402_fetch: the verdict does not survive being rethrown, so it comes from
        // the call context rather than from the caught value.
        const denied = e instanceof PolicyDenied ? e : callContext.getStore()?.denial;
        if (denied)
          return {
            content: [{ type: "text", text: JSON.stringify({ denied: true, rule: denied.rule, detail: denied.detail, pendingId: denied.pendingId }) }],
            isError: true,
          };
        return { content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }),
);

await server.connect(new StdioServerTransport());
