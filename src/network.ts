/**
 * Which chain a network id names, and where its public providers live. Pure logic: no chain, no
 * keys, no I/O.
 *
 * `cardano:preview` is a real testnet, and "not preprod, so mainnet" pointed a preview wallet at
 * mainnet Koios — where its address holds nothing, which reads as an empty wallet rather than as
 * the wrong one. Every place that turns a network id into a URL goes through here.
 */
export type CardanoNetworkName = "mainnet" | "preprod" | "preview";

/** CAIP-2 ids, and the CIP-34 aliases the SDK also accepts. */
const NAMES: Record<string, CardanoNetworkName> = {
  "cardano:mainnet": "mainnet",
  "cardano:preprod": "preprod",
  "cardano:preview": "preview",
  "cip34:1-764824073": "mainnet",
  "cip34:0-1": "preprod",
  "cip34:0-2": "preview",
};

export const KNOWN_NETWORKS = Object.keys(NAMES);

export function networkName(network: string): CardanoNetworkName {
  const name = NAMES[network];
  if (!name) throw new Error(`unknown Cardano network "${network}" (known: ${KNOWN_NETWORKS.join(", ")})`);
  return name;
}

export const isMainnet = (network: string): boolean => networkName(network) === "mainnet";

/** Two ids name the same chain when they resolve to the same name; unknown ids match nothing. */
export function sameNetwork(a: string, b: string): boolean {
  return a in NAMES && b in NAMES && NAMES[a] === NAMES[b];
}

export function koiosBaseUrl(network: string): string {
  const name = networkName(network);
  return name === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${name}.koios.rest/api/v1`;
}

export function blockfrostBaseUrl(network: string): string {
  return `https://cardano-${networkName(network)}.blockfrost.io/api/v0`;
}
