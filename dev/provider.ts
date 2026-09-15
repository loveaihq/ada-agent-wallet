/** Shared Koios/Blockfrost provider config for the dev x402 stack. */
import type { CardanoProviderConfig } from "@x402/cardano";
import { blockfrostBaseUrl, koiosBaseUrl } from "../src/network.js";

/**
 * `requestTimeoutMs` bounds every provider call, `awaitTx` included. Without an evidence hook
 * the facilitator's settle verdict is exactly whether `submitTransaction`'s `awaitTx` returned
 * before that deadline, so the default of 10s — under preprod's ~20s average block — would
 * report `mempool` on a payment that lands moments later. Callers that wait for a block must
 * pass a budget that covers one; the ceiling the SDK accepts is 120_000.
 */
export function cardanoProvider(network: string, requestTimeoutMs?: number): CardanoProviderConfig {
  if (process.env.BLOCKFROST_PROJECT_ID) {
    return {
      blockfrost: { baseUrl: blockfrostBaseUrl(network), projectId: process.env.BLOCKFROST_PROJECT_ID },
      ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    };
  }
  return {
    koios: { baseUrl: koiosBaseUrl(network), token: process.env.KOIOS_TOKEN },
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
  };
}

export function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", c => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

export function json(res: import("node:http").ServerResponse, code: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
