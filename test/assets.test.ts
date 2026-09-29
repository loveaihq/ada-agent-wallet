import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_ASSETS, cip67Label, describeKnown, displayName, knownAsset, lookalike } from "../src/assets.ts";

const USDCX = "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34.5553444378";
const USDM = "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d";
const DJED = "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61.446a65644d6963726f555344";
const IUSD = "f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880.69555344";
const USDA = "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456.55534441";
const TUSDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";

/** A policy id that is nobody's: 56 hex digits made up for the test. */
const NOBODY = "ab".repeat(28);
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

test("every listed id has the shape policy.json accepts, and the ids are unique", () => {
  const seen = new Set<string>();
  for (const [network, assets] of Object.entries(KNOWN_ASSETS)) {
    for (const a of assets) {
      assert.match(a.id, /^[0-9a-f]{56}\.[0-9a-f]{0,64}$/, `${network} ${a.ticker}`);
      assert.ok(Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 18, `${a.ticker} decimals`);
      assert.ok(!seen.has(a.id), `${a.id} listed twice`);
      seen.add(a.id);
    }
  }
});

test("known ids resolve on their own network and nowhere else", () => {
  assert.equal(knownAsset("mainnet", USDCX)?.ticker, "USDCx");
  assert.equal(knownAsset("mainnet", USDM)?.ticker, "USDM");
  assert.equal(knownAsset("mainnet", DJED)?.ticker, "DJED");
  assert.equal(knownAsset("mainnet", IUSD)?.ticker, "iUSD");
  assert.equal(knownAsset("mainnet", USDA)?.ticker, "USDA");
  assert.equal(knownAsset("preprod", TUSDM)?.ticker, "tUSDM");
  for (const a of KNOWN_ASSETS.mainnet) assert.equal(a.decimals, 6, a.ticker);
  // A mainnet id on preprod is not "known" there, and the preprod test token is worth nothing on mainnet.
  assert.equal(knownAsset("preprod", USDCX), undefined);
  assert.equal(knownAsset("mainnet", TUSDM), undefined);
  assert.equal(knownAsset("preview", USDCX), undefined);
  assert.equal(knownAsset("mainnet", "lovelace"), undefined);
  // Ids are matched exactly: the policy alone, or another case, is not the asset.
  assert.equal(knownAsset("mainnet", USDCX.split(".")[0]), undefined);
  assert.equal(knownAsset("mainnet", USDCX.toUpperCase()), undefined);
});

test("CIP-67 labels are recognised by their checksum, not by their look", () => {
  // The four vectors in CIP-67 itself.
  assert.equal(cip67Label("000643b0"), 100);
  assert.equal(cip67Label("000de140"), 222);
  assert.equal(cip67Label("0014df10"), 333);
  assert.equal(cip67Label("001bc280"), 444);
  assert.equal(cip67Label("0014df105553444d"), 333);
  assert.equal(cip67Label("0014DF105553444D"), 333);
  // Wrong checksum, wrong framing digits, too short, and a plain name: none of them is a label.
  assert.equal(cip67Label("0014df11"), undefined);
  assert.equal(cip67Label("1014df10"), undefined);
  assert.equal(cip67Label("0014df1"), undefined);
  assert.equal(cip67Label("5553444d"), undefined);
  assert.equal(cip67Label(""), undefined);
});

test("displayName drops a CIP-67 prefix and nothing else", () => {
  assert.equal(displayName(USDM), "USDM");
  assert.equal(displayName(USDCX), "USDCx");
  assert.equal(displayName(DJED), "DjedMicroUSD");
  assert.equal(displayName(TUSDM), "tUSDM");
  assert.equal(displayName(`${NOBODY}.000643b05553444d`), "USDM");
  assert.equal(displayName(`${NOBODY}.`), "");
  assert.equal(displayName("lovelace"), undefined);
  assert.equal(displayName("not an id"), undefined);
});

test("the USDCx copycats found on mainnet on 2026-09-29 are each caught, and name the real id", () => {
  // Koios asset_list?asset_name=eq.5553444378: five policies, one of them Circle's.
  for (const policy of [
    "038f14bd637e6c7b4ecdb2bf5dde2ccfd69b415f10d01bb5bd0f31da",
    "325fb65426e2a2af4749d9347e28d4c109d0895340dec5547036ab05",
    "4e74a46ecac6d7cde02e07e4e829659dcec39bc4704b0a40506f2c70",
    "82db3e78cea2810a39a97a65820d19621848d132db566ae88105813e",
  ]) {
    assert.equal(lookalike("mainnet", `${policy}.5553444378`)?.id, USDCX, policy);
  }
  assert.equal(lookalike("mainnet", USDCX), undefined, "the real one is not a copy of itself");
});

test("the USDM, USDA, iUSD and DJED copycats found on mainnet are caught too", () => {
  // Same name and CIP-68 label as Moneta's, from Koios asset_list?asset_name=like.*5553444d.
  for (const policy of [
    "3aba99e1127e78ea172153501c06163340f65906845e65cc2ecb04ad", // copied the reference token too, before Moneta's own mint
    "376eaf4826ae76534bbc6b531a6b420139197107e495ce43062734fc",
    "806d7f1354efc45477748f537b7da1ee40335d85ebe8eb36907250c7",
    "f97e20c4c1b52cd8a7ea85cc6dffcfead3563c4670545ab9c5d05be2",
  ]) {
    assert.equal(lookalike("mainnet", `${policy}.0014df105553444d`)?.id, USDM, policy);
  }
  // A copy of the reference token's label (100) is still the same name.
  assert.equal(lookalike("mainnet", "45ab136be4f4ebf7103b83316d041b034584966c15102da3c739a63e.000643b05553444d")?.id, USDM);
  // And the ones with no label at all.
  for (const policy of [
    "5e226aa2f8ebeaf89ff733499134778f7b65641ca40cbe68798404a3",
    "6396718c93a9f63da624634cca7fd321518a3c6b510c419d1ddf8930",
    "36a2d845803fd9e9c81e3bb677fa83deecabe33521d0f2738d176c10",
  ]) {
    assert.equal(lookalike("mainnet", `${policy}.5553444d`)?.id, USDM, policy);
  }
  // 36a2d845… mints its USDM and a USDA; both are copies.
  for (const policy of [
    "0b17e18e1a3f5635e837041ac48f2684c7f8d5654a2fb936d00d3de6",
    "203b808c61bdb0cc925ec1845ba105d9eb23a7e39de1d7864e0e542b",
    "36a2d845803fd9e9c81e3bb677fa83deecabe33521d0f2738d176c10",
    "8bb07d0aaa16d5335490295d04cce6bcdeb6d0361fae5296ce2bf28f",
  ]) {
    assert.equal(lookalike("mainnet", `${policy}.55534441`)?.id, USDA, policy);
  }
  assert.equal(lookalike("mainnet", "648823ffdad1610b4162f4dbc87bd47f6f9cf45d772ddef661eff198.69555344")?.id, IUSD);
  assert.equal(lookalike("mainnet", "4eea0f3c96825d83a42ecffd9f2b4fb6683977ffc557284644c4ee3c.446a65644d6963726f555344")?.id, DJED);
});

test("decorated and re-cased names are caught, including behind a CIP-67 prefix", () => {
  const cases: Array<[string, string]> = [
    ["USDC", USDCX],
    ["USDCX", USDCX],
    ["usdcx", USDCX],
    ["USDC-x", USDCX],
    ["ＵＳＤＣｘ", USDCX], // fullwidth
    ["USDM", USDM],
    ["tUSDM", USDM],
    ["iUSD", IUSD],
    ["IUSD", IUSD],
    ["DJED", DJED],
    ["DjedMicroUSD", DJED],
    ["Djed USD", DJED],
    ["USDA", USDA],
    ["usda", USDA],
  ];
  for (const [name, real] of cases) {
    assert.equal(lookalike("mainnet", `${NOBODY}.${hex(name)}`)?.id, real, name);
    assert.equal(lookalike("mainnet", `${NOBODY}.0014df10${hex(name)}`)?.id, real, `333 ${name}`);
    assert.equal(lookalike("mainnet", `${NOBODY}.000de140${hex(name)}`)?.id, real, `222 ${name}`);
  }
});

test("a prefix with a wrong checksum still does not hide the name from a copycat check", () => {
  // 0014df11 is not a label, so the bytes stay in the name; they are control characters and the
  // comparison ignores anything that is not a letter or a digit.
  assert.equal(lookalike("mainnet", `${NOBODY}.0014df11${hex("USDM")}`)?.id, USDM);
});

test("preprod: a token called USDM there is not the test token", () => {
  assert.equal(lookalike("preprod", `${NOBODY}.0014df10745553444d`)?.id, TUSDM);
  assert.equal(lookalike("preprod", `${NOBODY}.${hex("USDM")}`)?.id, TUSDM);
  assert.equal(lookalike("preprod", TUSDM), undefined);
  // Mainnet's names are not policed on preprod, nor anything on preview, which lists nothing.
  assert.equal(lookalike("preprod", `${NOBODY}.${hex("USDCx")}`), undefined);
  assert.equal(lookalike("preview", `${NOBODY}.${hex("USDCx")}`), undefined);
});

test("an unrelated token is neither known nor a lookalike", () => {
  for (const name of ["SNEK", "MIN", "HOSKY", "USDM_ETH_LQ", "USDMx2", "MyUSD", "", "a".repeat(64)]) {
    const id = `${NOBODY}.${name.length === 64 ? name : hex(name)}`;
    assert.equal(knownAsset("mainnet", id), undefined, name);
    assert.equal(lookalike("mainnet", id), undefined, name);
  }
  // Bytes that are not UTF-8 do not throw.
  assert.equal(lookalike("mainnet", `${NOBODY}.fffefdfc`), undefined);
  // Things that are not asset ids never match.
  for (const id of ["lovelace", "", "nope", `${NOBODY}`, `${"AB".repeat(28)}.${hex("USDM")}`]) {
    assert.equal(lookalike("mainnet", id), undefined, id);
  }
});

test("the issuer's own policy is not a copy of the issuer's token", () => {
  // Moneta's policy also holds the label-100 reference token for USDM; that is not a copycat.
  assert.equal(lookalike("mainnet", "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.000643b05553444d"), undefined);
  // Nor is another name under the DJED policy, which also mints SHEN.
  assert.equal(lookalike("mainnet", `${DJED.split(".")[0]}.${hex("ShenMicroUSD")}`), undefined);
});

test("the line preflight prints names the ticker, the decimals and what one whole token is", () => {
  assert.equal(describeKnown(knownAsset("mainnet", USDCX)!), "USDCx, 6 decimals: 1000000 = 1 USDCx");
  assert.equal(describeKnown({ id: USDCX, ticker: "X", decimals: 0, issuer: "" }), "X, 0 decimals: 1 = 1 X");
});
