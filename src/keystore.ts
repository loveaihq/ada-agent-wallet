/**
 * Passphrase-encrypted storage for the mnemonic: scrypt to stretch the passphrase, AES-256-GCM to
 * seal it. Pure logic — no files, no chain, no I/O.
 *
 * Raises the cost of reading a file, and nothing else; see README "The key" for where that stops.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";

export interface Keystore {
  version: 1;
  kdf: "scrypt";
  kdfparams: { N: number; r: number; p: number; dklen: number; salt: string };
  cipher: "aes-256-gcm";
  cipherparams: { iv: string };
  ciphertext: string;
  tag: string;
}

/** ~1s and ~128 MiB to derive. */
const DEFAULT_KDF = { N: 131072, r: 8, p: 1, dklen: 32 } as const;
const SCRYPT_MAXMEM = 512 * 1024 * 1024;
/** Below this, encrypting the file is not worth the trouble it implies. */
const MIN_N = 16384;

function derive(passphrase: string, salt: Buffer, params: Keystore["kdfparams"]): Buffer {
  return scryptSync(passphrase.normalize("NFKD"), salt, params.dklen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

export function encryptMnemonic(mnemonic: string, passphrase: string, kdf = DEFAULT_KDF): Keystore {
  if (!passphrase) throw new Error("keystore: a passphrase is required");
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const kdfparams = { ...kdf, salt: salt.toString("hex") };
  const cipher = createCipheriv("aes-256-gcm", derive(passphrase, salt, kdfparams), iv);
  const ciphertext = Buffer.concat([cipher.update(mnemonic.trim(), "utf8"), cipher.final()]);
  return {
    version: 1,
    kdf: "scrypt",
    kdfparams,
    cipher: "aes-256-gcm",
    cipherparams: { iv: iv.toString("hex") },
    ciphertext: ciphertext.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptMnemonic(keystore: Keystore, passphrase: string): string {
  assertKeystore(keystore);
  const key = derive(passphrase, Buffer.from(keystore.kdfparams.salt, "hex"), keystore.kdfparams);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(keystore.cipherparams.iv, "hex"));
  decipher.setAuthTag(Buffer.from(keystore.tag, "hex"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(keystore.ciphertext, "hex")), decipher.final()]).toString("utf8");
  } catch {
    // GCM cannot separate "wrong passphrase" from "altered file", and the two call for very
    // different responses, so say both rather than guess.
    throw new Error("keystore: wrong passphrase, or the keystore has been modified");
  }
}

export function assertKeystore(value: unknown): asserts value is Keystore {
  const k = value as Keystore;
  if (!k || typeof k !== "object") throw new Error("keystore: not an object");
  if (k.version !== 1) throw new Error(`keystore: unsupported version ${String(k.version)}`);
  if (k.kdf !== "scrypt") throw new Error(`keystore: unsupported kdf ${String(k.kdf)}`);
  if (k.cipher !== "aes-256-gcm") throw new Error(`keystore: unsupported cipher ${String(k.cipher)}`);
  const p = k.kdfparams;
  if (!p || typeof p !== "object") throw new Error("keystore: missing kdfparams");
  for (const field of ["N", "r", "p", "dklen"] as const) {
    if (!Number.isInteger(p[field]) || p[field] <= 0) throw new Error(`keystore: kdfparams.${field} must be a positive integer`);
  }
  if (p.dklen !== 32) throw new Error("keystore: aes-256-gcm needs a 32-byte key");
  // The file names its own KDF cost, so anyone who can write it could ask for N=2 and brute force
  // the passphrase at their leisure.
  if (p.N < MIN_N) throw new Error(`keystore: kdfparams.N of ${p.N} is too low to be worth encrypting with`);
  if (!isHex(p.salt, 16)) throw new Error("keystore: salt must be at least 16 bytes of hex");
  if (!isHex(k.cipherparams?.iv, 12, 12)) throw new Error("keystore: iv must be 12 bytes of hex");
  if (!isHex(k.tag, 16, 16)) throw new Error("keystore: tag must be 16 bytes of hex");
  if (!isHex(k.ciphertext, 1)) throw new Error("keystore: ciphertext must be hex");
}

function isHex(value: unknown, minBytes: number, maxBytes = Infinity): boolean {
  if (typeof value !== "string" || !/^[0-9a-f]*$/i.test(value) || value.length % 2 !== 0) return false;
  return value.length / 2 >= minBytes && value.length / 2 <= maxBytes;
}
