/**
 * The stablecoins this wallet knows by id, and a check for tokens that only look like them. Pure
 * logic: no chain, no keys, no I/O.
 *
 * `policy.json` keys its caps by asset id, and the wallet already refuses any asset that is not
 * listed, so a lookalike token cannot be paid unless an operator writes its id into the file. The
 * one way that happens is a wrong copy: a policy id taken from an explorer search for "USDCx",
 * where five policies mint a token with that exact name and only one is the real, xReserve-backed
 * one. This module is what lets preflight say so.
 *
 * Every id below was read from the chain and cross-checked against a second source on
 * 2026-09-29. `decimals` is what the token registry and, where the token is CIP-68, the on-chain
 * datum say; amounts in policy.json are in the smallest unit, so 1000000 of a 6-decimal token is 1.
 */
import type { CardanoNetworkName } from "./network.js";

export interface KnownAsset {
  /** `<policyId>.<assetNameHex>`, the form `policy.json` uses. */
  id: string;
  ticker: string;
  decimals: number;
  issuer: string;
  note?: string;
  /** Other names a copycat is likely to use, beyond the ticker and the on-chain name. */
  imitatedAs?: readonly string[];
}

export const KNOWN_ASSETS: Readonly<Record<CardanoNetworkName, readonly KnownAsset[]>> = {
  mainnet: [
    {
      id: "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34.5553444378",
      ticker: "USDCx",
      decimals: 6,
      issuer: "Circle xReserve, bridged to Cardano by IOG",
      note: "four other policies mint a token named USDCx",
      imitatedAs: ["usdc"],
    },
    {
      id: "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d",
      ticker: "USDM",
      decimals: 6,
      issuer: "Moneta",
      note: "CIP-68 fungible token (label 333); many policies mint the same name",
      imitatedAs: ["tusdm"],
    },
    {
      id: "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61.446a65644d6963726f555344",
      ticker: "DJED",
      decimals: 6,
      issuer: "COTI, with IOG",
      note: "on chain the name is DjedMicroUSD; the same policy mints SHEN",
      imitatedAs: ["djedusd"],
    },
    {
      id: "f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880.69555344",
      ticker: "iUSD",
      decimals: 6,
      issuer: "Indigo Protocol",
      note: "the same policy mints Indigo's other iAssets",
    },
    {
      id: "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456.55534441",
      ticker: "USDA",
      decimals: 6,
      issuer: "Anzens",
    },
  ],
  preprod: [
    {
      id: "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d",
      ticker: "tUSDM",
      decimals: 6,
      issuer: "Moneta (test token, no value)",
      note: "the token this repo's preprod tests use",
      imitatedAs: ["usdm"],
    },
  ],
  preview: [],
};

const ASSET_ID = /^([0-9a-f]{56})\.([0-9a-f]{0,64})$/;

function policyOf(id: string): string | undefined {
  return ASSET_ID.exec(id)?.[1];
}

/** CRC-8, polynomial 0x07, no reflection, initial value 0: the checksum CIP-67 puts in a label. */
function crc8(bytes: readonly number[]): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/**
 * The CIP-67 label an asset name starts with, or undefined when it does not start with one.
 * The prefix is four bytes, `0` + a 16-bit label + its CRC-8 + `0`, so `0014df10` is label 333 and
 * `000de140` is 222. A wrong checksum is not a label: an ordinary name that happens to begin with
 * those digits is not stripped.
 */
export function cip67Label(nameHex: string): number | undefined {
  const h = nameHex.toLowerCase();
  if (!/^0[0-9a-f]{4}[0-9a-f]{2}0/.test(h)) return undefined;
  const label = parseInt(h.slice(1, 5), 16);
  return crc8([label >> 8, label & 0xff]) === parseInt(h.slice(5, 7), 16) ? label : undefined;
}

/** What an explorer would show for this asset name: the CIP-67 prefix dropped, the rest as UTF-8. */
export function displayName(id: string): string | undefined {
  const m = ASSET_ID.exec(id);
  if (!m) return undefined;
  let hex = m[2].length % 2 ? m[2].slice(0, -1) : m[2];
  if (cip67Label(hex) !== undefined) hex = hex.slice(8);
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], b => parseInt(b, 16));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Lower-case letters and digits only, so "USDCx", "USDCX", "usdc-x" and a fullwidth "ＵＳＤＣｘ" are
 * one name. Deliberately generous: a false match only raises a preflight line the operator reads.
 */
const flat = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The names an asset is imitated under: its ticker, its on-chain name and its listed aliases. */
function namesOf(a: KnownAsset): Set<string> {
  return new Set([a.ticker, displayName(a.id) ?? "", ...(a.imitatedAs ?? [])].map(flat).filter(Boolean));
}

export function knownAsset(network: CardanoNetworkName, id: string): KnownAsset | undefined {
  return KNOWN_ASSETS[network].find(a => a.id === id);
}

/**
 * The known asset this id imitates, when it is not itself known: its name, with a CIP-67 prefix
 * dropped and case and punctuation ignored, equals a known ticker, the asset's own on-chain name,
 * or one of its `imitatedAs` names ("USDC" for USDCx, "tUSDM" for USDM, "DjedMicroUSD" for DJED).
 * Names that merely contain a ticker ("USDM_ETH_LQ") are not matched. A token under the issuer's own
 * policy is not a copy of it, so it is not matched either.
 */
export function lookalike(network: CardanoNetworkName, id: string): KnownAsset | undefined {
  const policy = policyOf(id);
  if (!policy || knownAsset(network, id)) return undefined;
  const name = flat(displayName(id) ?? "");
  if (!name) return undefined;
  return KNOWN_ASSETS[network].find(a => policyOf(a.id) !== policy && namesOf(a).has(name));
}

/** "USDCx, 6 decimals: 1000000 = 1 USDCx". */
export function describeKnown(a: KnownAsset): string {
  return `${a.ticker}, ${a.decimals} decimals: ${10n ** BigInt(a.decimals)} = 1 ${a.ticker}`;
}
