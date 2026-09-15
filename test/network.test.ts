import { test } from "node:test";
import assert from "node:assert/strict";
import { blockfrostBaseUrl, isMainnet, koiosBaseUrl, networkName, sameNetwork } from "../src/network.ts";

test("every known network resolves to its own chain, not to 'whatever is not preprod'", () => {
  // The bug this exists for: `network.endsWith("preprod") ? preprod : mainnet` sent a preview
  // wallet to mainnet's providers, where its address reads as empty rather than as wrong.
  assert.equal(networkName("cardano:preview"), "preview");
  assert.equal(koiosBaseUrl("cardano:preview"), "https://preview.koios.rest/api/v1");
  assert.equal(blockfrostBaseUrl("cardano:preview"), "https://cardano-preview.blockfrost.io/api/v0");
  assert.equal(koiosBaseUrl("cardano:preprod"), "https://preprod.koios.rest/api/v1");
  assert.equal(koiosBaseUrl("cardano:mainnet"), "https://api.koios.rest/api/v1");
  assert.equal(blockfrostBaseUrl("cardano:mainnet"), "https://cardano-mainnet.blockfrost.io/api/v0");
});

test("mainnet is a fact about the chain, not a suffix", () => {
  assert.equal(isMainnet("cardano:mainnet"), true);
  assert.equal(isMainnet("cip34:1-764824073"), true);
  assert.equal(isMainnet("cardano:preprod"), false);
  assert.equal(isMainnet("cardano:preview"), false);
});

test("an unknown network is refused rather than mapped to mainnet", () => {
  assert.throws(() => networkName("cardano:notachain"), /unknown Cardano network/);
  assert.throws(() => koiosBaseUrl("ethereum:1"), /unknown Cardano network/);
  assert.throws(() => isMainnet("cardano:mainnet-but-not"), /unknown Cardano network/);
});

test("CAIP-2 and CIP-34 ids for the same chain match; unknown ids match nothing", () => {
  assert.equal(sameNetwork("cardano:preprod", "cip34:0-1"), true);
  assert.equal(sameNetwork("cardano:mainnet", "cardano:mainnet"), true);
  assert.equal(sameNetwork("cardano:preprod", "cardano:preview"), false);
  assert.equal(sameNetwork("cardano:preprod", "nope:1"), false);
  assert.equal(sameNetwork("nope:1", "nope:1"), false);
});
