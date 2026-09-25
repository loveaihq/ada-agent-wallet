/**
 * A batch-settlement seller on preprod, for dev/batch.ts: subbit-x402's facilitator and resource
 * server, with account 1 of the mnemonic as the channels' provider. It is the other party to the
 * run, not part of the wallet.
 *
 *   :7411  GET /data   0.1 tADA  the run's ordinary purchase
 *          GET /big    0.2 tADA  over the run's approvalAbove, so it queues for a human
 *          GET /lossy  0.1 tADA  settles its first request and drops the response, as a lost connection would
 *          GET /token  0.001 tUSDM  the same in Moneta's preprod tUSDM, for a token channel
 *   :7412  GET /other  0.1 tADA  a seller whose channels would name a provider key the policy does not allow
 *   :7413  the facilitator: verifies, broadcasts, and waits for each deposit's block
 *
 * Prints one JSON line once listening: {"payTo", "providerKey", "otherKey"}, for the policy.
 *
 * Env: WALLET_MNEMONIC (the public test mnemonic: this key sells, it never holds anything of the
 *      user's), BLOCKFROST_PROJECT_ID, SUBBIT_REFERENCE_SCRIPT (optional txHash#index of the
 *      deployed validator), BATCH_SELLER_OUT (where the server keeps its channel records),
 *      BATCH_SELLER_SETTLES=1 (run the watcher that settles a channel its buyer closes; off, the
 *      seller never settles, which is what dev/batchexit.ts needs)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type HTTPAdapter, type RoutesConfig } from "@x402/core/server";
import { Address, Client, KeyHash, preprod } from "@evolution-sdk/evolution";
import { SUBBIT_HASH } from "subbit-x402/subbit";
import { BlockfrostChain } from "subbit-x402/x402/chain";
import { BatchSettlementCardanoFacilitator } from "subbit-x402/x402/facilitator";
import { ChannelManager } from "subbit-x402/x402/manager";
import { BatchSettlementCardanoServer, FileChannelStorage, walletProviderSigner } from "subbit-x402/x402/server";
import { blockfrostBaseUrl } from "../src/network.js";
import { readBody } from "./provider.js";

const NETWORK = "cardano:preprod" as const;
const MNEMONIC = process.env.WALLET_MNEMONIC;
const PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
const OUT = process.env.BATCH_SELLER_OUT ?? "./.batch-seller";
const REFERENCE_SCRIPT = process.env.SUBBIT_REFERENCE_SCRIPT;
/** Moneta's preprod tUSDM, 6 decimals. */
const TUSDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
if (!MNEMONIC || !PROJECT_ID) {
  console.error("batchseller: WALLET_MNEMONIC and BLOCKFROST_PROJECT_ID are required");
  process.exit(1);
}

const baseUrl = blockfrostBaseUrl(NETWORK);
const chain = new BlockfrostChain(NETWORK, baseUrl, PROJECT_ID);
const provider = Client.make(preprod).withBlockfrost({ baseUrl, projectId: PROJECT_ID }).withSeed({ mnemonic: MNEMONIC, accountIndex: 1 });
const providerAddress = await provider.address();
const payTo = Address.toBech32(providerAddress);
const providerKey = KeyHash.toHex(providerAddress.paymentCredential as KeyHash.KeyHash);
/** A key nobody holds: the second seller's 402 names it, and the wallet must refuse to open a channel to it. */
const otherKey = randomBytes(28).toString("hex");

const facilitator = new x402Facilitator().register(NETWORK, new BatchSettlementCardanoFacilitator(chain, { scriptHash: SUBBIT_HASH, confirmationTimeoutMs: 120_000 }));
await listen(7413, async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/supported") return send(res, 200, {}, facilitator.getSupported());
  if (req.method === "POST" && (url.pathname === "/verify" || url.pathname === "/settle")) {
    const { paymentPayload, paymentRequirements } = JSON.parse((await readBody(req)) || "{}");
    const out = url.pathname === "/verify" ? await facilitator.verify(paymentPayload, paymentRequirements) : await facilitator.settle(paymentPayload, paymentRequirements);
    if ((out as { isValid?: boolean }).isValid === false || (out as { success?: boolean }).success === false) log(`facilitator ${url.pathname}: ${JSON.stringify(out).slice(0, 300)}`);
    return send(res, 200, {}, out);
  }
  send(res, 404, {}, { error: "not found" });
});
const facilitatorClient = new HTTPFacilitatorClient({ url: "http://127.0.0.1:7413", timeoutMs: 300_000 });

const accept = (amount: string, asset = "lovelace") => ({ scheme: "batch-settlement", network: NETWORK, payTo, price: { asset, amount }, maxTimeoutSeconds: 300, extra: {} });
const shop = (receiverAuthorizer: string, storage: FileChannelStorage, signs: boolean) =>
  new BatchSettlementCardanoServer({
    payTo,
    receiverAuthorizer,
    scriptHash: SUBBIT_HASH,
    ...(REFERENCE_SCRIPT ? { referenceScript: REFERENCE_SCRIPT } : {}),
    withdrawDelay: 900,
    storage,
    signAsProvider: signs
      ? walletProviderSigner(provider)
      : async () => {
          throw new Error("this seller holds no key");
        },
    chain,
    assetDecimals: { [TUSDM]: 6 },
  });

const mainStorage = new FileChannelStorage(`${OUT}/main`);
const main = new x402HTTPResourceServer(new x402ResourceServer(facilitatorClient).register(NETWORK, shop(providerKey, mainStorage, true)), {
  "GET /data": { accepts: accept("100000"), description: "one datum for 0.1 tADA" },
  "GET /big": { accepts: accept("200000"), description: "a bigger datum, over the run's approval threshold" },
  "GET /lossy": { accepts: accept("100000"), description: "one datum whose first response never arrives" },
  "GET /token": { accepts: accept("1000", TUSDM), description: "one datum for 0.001 tUSDM" },
} as RoutesConfig);
await main.initialize();
const other = new x402HTTPResourceServer(new x402ResourceServer(facilitatorClient).register(NETWORK, shop(otherKey, new FileChannelStorage(`${OUT}/other`), false)), {
  "GET /other": { accepts: accept("100000"), description: "a seller the policy does not know" },
} as RoutesConfig);
await other.initialize();

let served = 0;
let dropped = false;
const serve = (http: x402HTTPResourceServer, port: number) => async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  await readBody(req);
  const context = { adapter: adapter(req, url), path: url.pathname, method: req.method ?? "GET" };
  const result = await http.processHTTPRequest(context);
  if (result.type === "no-payment-required") return send(res, 404, {}, { error: "not found" });
  if (result.type === "payment-error") return send(res, result.response.status, result.response.headers, result.response.body ?? {});
  const body = JSON.stringify({ route: url.pathname, n: ++served, at: new Date().toISOString() });
  const settle = await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: context, responseBody: Buffer.from(body) }, undefined, result.beforeHandlerSettlement);
  if (!settle.success) {
    log(`${url.pathname}: settlement failed ${settle.errorReason} ${settle.errorMessage ?? ""}`);
    return send(res, settle.response.status, { ...settle.headers, ...settle.response.headers }, settle.response.body ?? {});
  }
  // Charged, and the answer never reaches the buyer: its retry must not be charged again.
  if (url.pathname === "/lossy" && !dropped) {
    dropped = true;
    log(`/lossy: request ${served} settled, its response dropped`);
    return void res.destroy();
  }
  send(res, 200, settle.headers, body);
};
await listen(7411, serve(main, 7411));
await listen(7412, serve(other, 7412));
if (process.env.BATCH_SELLER_SETTLES === "1") {
  // A seller that looks after its channels: when a buyer closes one, it settles the latest voucher.
  const manager = new ChannelManager({ storage: mainStorage, wallet: provider, providerKeyHash: providerKey, chain, facilitator: facilitatorClient, network: NETWORK, payTo, scriptHash: SUBBIT_HASH, ...(REFERENCE_SCRIPT ? { referenceScript: REFERENCE_SCRIPT } : {}) });
  manager.watch({
    intervalMs: 15_000,
    onEvent: e => {
      if (e.kind === "closed") log(`watcher: ${e.channelId.slice(0, 16)}… closed by its buyer`);
      else if (e.kind === "settled") for (const x of e.results) log(`watcher: settled ${x.channels.length} channel(s) in ${x.transaction}`);
      else if (e.kind === "error") log(`watcher: a pass failed, the next one retries: ${String((e.error as Error)?.message ?? e.error).slice(0, 200)}`);
    },
  });
  log("watcher on: channels their buyers close are settled");
}
console.log(JSON.stringify({ payTo, providerKey, otherKey }));
log(`selling on 7411 and 7412, facilitator on 7413; provider ${payTo}`);

function listen(port: number, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<Server> {
  const srv = createServer((req, res) =>
    handler(req, res).catch(e => {
      log(`${port}: ${(e as Error).stack ?? String(e)}`);
      if (!res.headersSent) send(res, 500, {}, { error: String(e) });
    }),
  );
  return new Promise(ok => srv.listen(port, "127.0.0.1", () => ok(srv)));
}

function adapter(req: IncomingMessage, url: URL): HTTPAdapter {
  return {
    getHeader: (name: string) => req.headers[name.toLowerCase()] as string | undefined,
    getMethod: () => req.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => (req.headers.accept as string) ?? "application/json",
    getUserAgent: () => (req.headers["user-agent"] as string) ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name: string) => url.searchParams.get(name) ?? undefined,
  };
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, b: unknown) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof b === "string" ? b : JSON.stringify(b));
}

function log(s: string) {
  console.error(`[seller ${new Date().toISOString().slice(11, 19)}] ${s}`);
}
