/**
 * Local x402 seller over MCP, for preprod — the paid *tools* an agent buys, where dev/resource.ts
 * is the paid *endpoints*.
 *
 * Priced exactly like resource.ts, so the same three policy verdicts are reached a different way
 * (against policy.example.json: perTxMax 5 tADA, approvalAbove 3 tADA):
 *   quote    1.5 tADA -> under the approval threshold: signerd signs unattended
 *   report   4.0 tADA -> over it: queues for `walletctl approve <id>`
 *   premium  6.0 tADA -> over perTxMax: signerd denies, nothing is signed
 *   ping     free     -> so a client can tell "this server is up" from "this server charges"
 *
 * The payment wrapper is `@x402/mcp`'s own `createPaymentWrapper`, so the seller is the official
 * code path as well. The point is to check this wallet against the stack as shipped, not against
 * a seller written to agree with it.
 *
 * Stateless: a fresh MCP server per HTTP request. The payment travels in the request's `_meta`, so
 * nothing has to survive between the unpaid probe and the paid retry.
 *
 * Env: MCP_RESOURCE_PORT (7404), FACILITATOR_URL, SELLER_ADDRESS, CARDANO_NETWORK, L1_CONFIRMATIONS
 */
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { createPaymentWrapper, createToolResourceUrl } from "@x402/mcp";
import { readBody, json } from "./provider.js";

const PORT = Number(process.env.MCP_RESOURCE_PORT ?? 7404);
const NETWORK = (process.env.CARDANO_NETWORK ?? "cardano:preprod") as `${string}:${string}`;
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://127.0.0.1:7403";
const PAY_TO = process.env.SELLER_ADDRESS;
// As in resource.ts: depth above inclusion needs the evidence hook only Blockfrost supplies.
const L1_CONFIRMATIONS = Number(process.env.L1_CONFIRMATIONS ?? (process.env.BLOCKFROST_PROJECT_ID ? 1 : 0));
if (!PAY_TO) {
  console.error("mcpresource: SELLER_ADDRESS is required");
  process.exit(1);
}

// As in resource.ts: must outlast the facilitator's own awaitTx budget.
const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: FACILITATOR_URL, timeoutMs: Number(process.env.FACILITATOR_TIMEOUT_MS ?? 115_000) }),
);
resourceServer.register(NETWORK, new ExactCardanoScheme());
await resourceServer.initialize();

async function priced(tool: string, description: string, lovelace: string, maxTimeoutSeconds: number) {
  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: NETWORK,
    payTo: PAY_TO!,
    price: { asset: "lovelace", amount: lovelace },
    maxTimeoutSeconds,
    extra: { confirmationPolicy: { l1Confirmations: L1_CONFIRMATIONS } },
  });
  // Without `resource` the wrapper cannot know which tool it is wrapping, and every 402 names itself
  // `mcp://tool/paid_tool` — which is what an agent reads when it decides whether to pay.
  return createPaymentWrapper(resourceServer, {
    accepts,
    resource: { url: createToolResourceUrl(tool), description, mimeType: "application/json" },
  });
}

const paid = {
  quote: await priced("quote", "A price quote (1.5 tADA)", "1500000", 180),
  report: await priced("report", "A full report (4 tADA)", "4000000", 600),
  premium: await priced("premium", "Premium data (6 tADA)", "6000000", 180),
};

const reply = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

function build() {
  const mcp = new McpServer({ name: "x402-dev-seller", version: "0.1.0" });
  mcp.tool("ping", "Free. Says the server is up.", {}, async () => reply({ pong: true }));
  mcp.tool("quote", "A price quote. Costs 1.5 tADA.", {}, paid.quote(async () => reply({ symbol: "ADA/USD", price: "0.3412", ts: new Date().toISOString() })));
  mcp.tool("report", "A full report. Costs 4 tADA.", {}, paid.report(async () => reply({ title: "Q3 chain report", pages: 12, ts: new Date().toISOString() })));
  mcp.tool("premium", "Premium data. Costs 6 tADA.", {}, paid.premium(async () => reply({ secret: "you should not be able to read this without paying 6 tADA" })));
  return mcp;
}

function log(msg: string) {
  console.log(`[mcpresource] ${msg}`);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : undefined;
    if (body?.method === "tools/call") log(`tools/call ${body.params?.name}${body.params?._meta?.["x402/payment"] ? " (with payment)" : ""}`);
    const mcp = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    log(`error: ${String(e)}`);
    if (!res.headersSent) json(res, 500, { error: String(e) });
  }
}).listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${PORT}/mcp  network=${NETWORK}  payTo=${PAY_TO}`);
  log(`facilitator=${FACILITATOR_URL}  tools: ping (free), quote 1.5, report 4, premium 6 tADA`);
});
