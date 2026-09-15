/**
 * Local x402 resource server for preprod — the paid endpoint the agent buys from.
 *
 * Three routes, priced to exercise all three policy verdicts against policy.json
 * (perTxMax 5 ADA, approvalAbove 3 ADA):
 *   GET /quote    1.5 ADA  -> under the approval threshold: signerd signs unattended
 *   GET /report   4.0 ADA  -> over it: queues for `walletctl approve <id>`
 *   GET /premium  6.0 ADA  -> over perTxMax: signerd denies, nothing is signed
 *
 * Settlement runs through the local facilitator (dev/facilitator.ts), which broadcasts
 * the buyer's transaction and waits for the confirmation policy's evidence.
 *
 * Env: RESOURCE_PORT (7401), FACILITATOR_URL, SELLER_ADDRESS, CARDANO_NETWORK
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  x402ResourceServer,
  x402HTTPResourceServer,
  HTTPFacilitatorClient,
  type HTTPAdapter,
  type RoutesConfig,
} from "@x402/core/server";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { readBody } from "./provider.js";

const PORT = Number(process.env.RESOURCE_PORT ?? 7401);
const NETWORK = (process.env.CARDANO_NETWORK ?? "cardano:preprod") as `${string}:${string}`;
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://127.0.0.1:7403";
const PAY_TO = process.env.SELLER_ADDRESS;
const L1_CONFIRMATIONS = Number(process.env.L1_CONFIRMATIONS ?? (process.env.BLOCKFROST_PROJECT_ID ? 1 : 0));
if (!PAY_TO) {
  console.error("resource: SELLER_ADDRESS is required");
  process.exit(1);
}

const price = (lovelace: string) => ({ asset: "lovelace", amount: lovelace });
const accept = (lovelace: string, maxTimeoutSeconds: number) => ({
  scheme: "exact",
  network: NETWORK,
  payTo: PAY_TO!,
  price: price(lovelace),
  maxTimeoutSeconds,
  // Depth above canonical inclusion needs an evidence hook, which only the Blockfrost
  // provider supplies; a Koios facilitator advertises l1Confirmations 0..0, so asking for
  // the default 1 would make the 402 unserviceable. 0 still means the transaction is on
  // chain -- submitTransaction awaits confirmation -- just without extra depth.
  extra: { confirmationPolicy: { l1Confirmations: L1_CONFIRMATIONS } },
});

const routes: RoutesConfig = {
  "GET /quote": { accepts: accept("1500000", 180), description: "A price quote (1.5 tADA)" },
  "GET /report": { accepts: accept("4000000", 600), description: "A full report (4 tADA)" },
  "GET /premium": { accepts: accept("6000000", 180), description: "Premium data (6 tADA)" },
};

const handlers: Record<string, () => unknown> = {
  "/quote": () => ({ symbol: "ADA/USD", price: "0.3412", ts: new Date().toISOString() }),
  "/report": () => ({ title: "Q3 chain report", pages: 12, ts: new Date().toISOString() }),
  "/premium": () => ({ secret: "you should not be able to read this without paying 6 tADA" }),
};

// Must exceed the facilitator's own awaitTx budget, or a settle that is still waiting for a
// block is cut off here instead — a timed-out facilitator call is terminal for the resource server.
const server = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: FACILITATOR_URL, timeoutMs: Number(process.env.FACILITATOR_TIMEOUT_MS ?? 115_000) }),
);
server.register(NETWORK, new ExactCardanoScheme());
const http = new x402HTTPResourceServer(server, routes);
await http.initialize();

function adapterFor(req: IncomingMessage, url: URL): HTTPAdapter {
  return {
    getHeader: (name: string) => req.headers[name.toLowerCase()] as string | undefined,
    getMethod: () => req.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => `http://127.0.0.1:${PORT}${url.pathname}${url.search}`,
    getAcceptHeader: () => (req.headers.accept as string) ?? "application/json",
    getUserAgent: () => (req.headers["user-agent"] as string) ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name: string) => url.searchParams.get(name) ?? undefined,
  };
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const handler = handlers[url.pathname];
  if (!handler) return send(res, 404, {}, { error: "not found" });

  await readBody(req); // drain
  const context = { adapter: adapterFor(req, url), path: url.pathname, method: req.method ?? "GET" };
  const result = await http.processHTTPRequest(context);
  log(`${req.method} ${url.pathname} -> ${result.type}`);

  if (result.type === "no-payment-required") return send(res, 200, {}, handler());

  if (result.type === "payment-error") {
    const r = result.response;
    return send(res, r.status, r.headers, r.body ?? {});
  }

  // payment-verified: run the handler, then settle (Cardano's flow settles after the handler).
  const body = JSON.stringify(handler());
  const settle = await http.processSettlement(
    result.paymentPayload,
    result.paymentRequirements,
    result.declaredExtensions,
    { request: context, responseBody: Buffer.from(body) },
    undefined,
    result.beforeHandlerSettlement,
  );

  if (!settle.success) {
    log(`settlement failed: ${settle.errorReason} ${settle.errorMessage ?? ""}`);
    return send(res, settle.response.status, { ...settle.headers, ...settle.response.headers }, settle.response.body ?? {});
  }
  log(`settled: tx=${settle.transaction} payer=${settle.payer}`);
  send(res, 200, settle.headers, body);
}

function log(msg: string) {
  console.log(`[resource] ${msg}`);
}

createServer((req, res) =>
  handle(req, res).catch(e => {
    log(`error: ${String(e)}`);
    send(res, 500, {}, { error: String(e) });
  }),
).listen(PORT, "127.0.0.1", () => {
  log(`listening on 127.0.0.1:${PORT}  network=${NETWORK}  payTo=${PAY_TO}`);
  log(`facilitator=${FACILITATOR_URL}  routes: ${Object.keys(routes).join(", ")}`);
});
