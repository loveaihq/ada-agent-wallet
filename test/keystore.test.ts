import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptMnemonic, decryptMnemonic, assertKeystore, type Keystore } from "../src/keystore.ts";

// The real parameters take ~1s per derivation, which is the point of them; the tests use the
// lowest cost the validator will accept so the suite stays fast.
const FAST = { N: 16384, r: 8, p: 1, dklen: 32 } as const;
const MNEMONIC = "abandon ".repeat(23) + "art";
const PASSPHRASE = "correct horse battery staple";

test("a mnemonic survives a round trip", () => {
  const k = encryptMnemonic(MNEMONIC, PASSPHRASE, FAST);
  assert.equal(decryptMnemonic(k, PASSPHRASE), MNEMONIC);
});

test("the plaintext is nowhere in the keystore", () => {
  const k = encryptMnemonic(MNEMONIC, PASSPHRASE, FAST);
  const blob = JSON.stringify(k);
  assert.ok(!blob.includes("abandon"));
  assert.ok(!blob.includes(PASSPHRASE));
});

test("the wrong passphrase fails rather than returning something else", () => {
  const k = encryptMnemonic(MNEMONIC, PASSPHRASE, FAST);
  assert.throws(() => decryptMnemonic(k, "not it"), /wrong passphrase, or the keystore has been modified/);
});

test("encrypting twice produces different bytes", () => {
  const a = encryptMnemonic(MNEMONIC, PASSPHRASE, FAST);
  const b = encryptMnemonic(MNEMONIC, PASSPHRASE, FAST);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.kdfparams.salt, b.kdfparams.salt);
  assert.notEqual(a.cipherparams.iv, b.cipherparams.iv);
});

test("a modified keystore fails to open instead of opening onto something else", () => {
  const k = encryptMnemonic(MNEMONIC, PASSPHRASE, FAST);
  const flipped = Buffer.from(k.ciphertext, "hex");
  flipped[0] ^= 0xff;
  assert.throws(() => decryptMnemonic({ ...k, ciphertext: flipped.toString("hex") }, PASSPHRASE), /modified/);
  assert.throws(() => decryptMnemonic({ ...k, tag: "0".repeat(32) }, PASSPHRASE), /modified/);
});

test("a keystore cannot talk us into a weak derivation", () => {
  // The file names its own KDF cost, so honouring it blindly would let an attacker who can write
  // the file replace N with 2 and brute force the passphrase at their leisure.
  const k = encryptMnemonic(MNEMONIC, PASSPHRASE, FAST);
  assert.throws(() => assertKeystore({ ...k, kdfparams: { ...k.kdfparams, N: 2 } }), /too low/);
});

test("assertKeystore rejects shapes it cannot safely interpret", () => {
  const k = encryptMnemonic(MNEMONIC, PASSPHRASE, FAST);
  assert.doesNotThrow(() => assertKeystore(k));
  assert.throws(() => assertKeystore(null), /not an object/);
  assert.throws(() => assertKeystore({ ...k, version: 2 } as unknown as Keystore), /unsupported version/);
  assert.throws(() => assertKeystore({ ...k, kdf: "pbkdf2" } as unknown as Keystore), /unsupported kdf/);
  assert.throws(() => assertKeystore({ ...k, cipher: "aes-128-ctr" } as unknown as Keystore), /unsupported cipher/);
  assert.throws(() => assertKeystore({ ...k, cipherparams: { iv: "00" } }), /iv must be 12 bytes/);
  assert.throws(() => assertKeystore({ ...k, tag: "00" }), /tag must be 16 bytes/);
  assert.throws(() => assertKeystore({ ...k, kdfparams: { ...k.kdfparams, dklen: 16 } }), /32-byte key/);
  assert.throws(() => assertKeystore({ ...k, kdfparams: { ...k.kdfparams, salt: "abcd" } }), /salt must be at least 16 bytes/);
});

test("an empty passphrase is refused at write time", () => {
  assert.throws(() => encryptMnemonic(MNEMONIC, "", FAST), /passphrase is required/);
});
