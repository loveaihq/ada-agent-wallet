/**
 * Local x402 facilitator for preprod.
 *
 * Verifies the buyer's signed-but-unbroadcast transaction against the payment requirements,
 * broadcasts it, and waits (bounded) for the evidence the confirmation policy requires.
 *
 * It holds no key and no funds: the buyer's transaction is already signed and balances its own
 * fee, so this only reads the chain and submits. `toFacilitatorCardanoSigner` runs provider-only.
 *
 * Endpoints — the contract @x402/core's HTTPFacilitatorClient speaks:
 *   GET  /supported
 *   POST /verify   {x402Version, paymentPayload, paymentRequirements}
 *   POST /settle   {x402Version, paymentPayload, paymentRequirements}
 *
 * Env: FACILITATOR_PORT (7403), CARDANO_NETWORK, BLOCKFROST_PROJECT_ID | KOIOS_TOKEN
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";
import { toFacilitatorCardanoSigner } from "@x402/cardano";
import { cardanoProvider, readBody, json } from "./provider.js";

const PORT = Number(process.env.FACILITATOR_PORT ?? 7403);
const NETWORK = (process.env.CARDANO_NETWORK ?? "cardano:preprod") as `${string}:${string}`;

// Budget chain, widest first, so a slow block is waited out rather than reported as mempool:
//   resource server's facilitator-client timeout (dev/resource.ts, 115s)
//     > this provider's requestTimeoutMs, which bounds awaitTx (100s)
//       > a preprod block (~20s typical, 80s gaps observed)
const AWAIT_TX_BUDGET_MS = Number(process.env.PROVIDER_TIMEOUT_MS ?? 100_000);

const signer = toFacilitatorCardanoSigner({
  network: NETWORK,
  provider: cardanoProvider(NETWORK, AWAIT_TX_BUDGET_MS),
});

const facilitator = new x402Facilitator().register(
  NETWORK,
  // A preprod block gap of 80s has been observed; core retries settle() once, so the
  // effective budget is roughly twice this.
  new ExactCardanoScheme(signer, { confirmationTimeoutMs: 75_000 }),
);

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/supported") {
    return json(res, 200, facilitator.getSupported());
  }

  if (req.method === "POST" && (url.pathname === "/verify" || url.pathname === "/settle")) {
    const { paymentPayload, paymentRequirements } = JSON.parse((await readBody(req)) || "{}");
    const op = url.pathname === "/verify" ? "verify" : "settle";
    log(`${op} <- ${paymentRequirements?.amount} ${paymentRequirements?.asset} -> ${paymentRequirements?.payTo}`);
    const out =
      op === "verify"
        ? await facilitator.verify(paymentPayload, paymentRequirements)
        : await facilitator.settle(paymentPayload, paymentRequirements);
    log(`${op} -> ${JSON.stringify(out)}`);
    return json(res, 200, out);
  }

  json(res, 404, { error: "not found" });
}

function log(msg: string) {
  console.log(`[facilitator] ${msg}`);
}

createServer((req, res) =>
  handle(req, res).catch(e => {
    log(`error: ${String(e)}`);
    json(res, 500, { error: String(e) });
  }),
).listen(PORT, "127.0.0.1", () => {
  log(`listening on 127.0.0.1:${PORT}  network=${NETWORK}  (no key, no funds — broadcast only)`);
  log(`awaitTx budget: ${AWAIT_TX_BUDGET_MS}ms`);
});
