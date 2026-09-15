/** Prints the buyer and seller balances, so you can tell when the faucet has landed. */
import { koiosBaseUrl } from "../src/network.js";

const KOIOS = process.env.KOIOS_BASE_URL ?? koiosBaseUrl(process.env.CARDANO_NETWORK ?? "cardano:preprod");

const addrs = [
  ["buyer (agent wallet)", process.env.BUYER_ADDRESS],
  ["seller (payTo)", process.env.SELLER_ADDRESS],
].filter(([, a]) => a) as [string, string][];

if (addrs.length === 0) {
  console.error("balance: set BUYER_ADDRESS and/or SELLER_ADDRESS");
  process.exit(1);
}

const res = await fetch(`${KOIOS}/address_info`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(process.env.KOIOS_TOKEN ? { authorization: `Bearer ${process.env.KOIOS_TOKEN}` } : {}) },
  body: JSON.stringify({ _addresses: addrs.map(([, a]) => a) }),
});
if (!res.ok) {
  console.error(`koios address_info failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const info = (await res.json()) as Array<{ address: string; balance: string; utxo_set?: unknown[] }>;

for (const [label, address] of addrs) {
  const row = info.find(i => i.address === address);
  const lovelace = BigInt(row?.balance ?? "0");
  const utxos = row?.utxo_set?.length ?? 0;
  console.log(`${label.padEnd(22)} ${(Number(lovelace) / 1e6).toFixed(6).padStart(14)} tADA  (${lovelace} lovelace, ${utxos} utxo)`);
  console.log(`${"".padEnd(22)} ${address}`);
}
