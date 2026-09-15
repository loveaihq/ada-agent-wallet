/**
 * Passphrase-encrypted storage for the mnemonic. Pure logic: no files, no chain, no I/O.
 *
 * scrypt to stretch the passphrase, AES-256-GCM to seal the mnemonic. The GCM tag means a
 * keystore that has been altered fails to open rather than opening onto something else, and the
 * salt and IV are fresh per write so encrypting the same mnemonic twice does not produce the same
 * bytes.
 *
 * Be clear about what this is for. It raises the cost of *reading a file*: a stolen backup, a disk
 * image, a stray copy in a repository, a directory whose permissions were wrong for a week. It
 * does nothing about a compromised signerd, because signerd holds the decrypted mnemonic in memory
 * for as long as it runs — that is what a hot wallet is. And it is worth nothing at all if the
 * passphrase sits beside the keystore, which is why signerd warns when it does.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

export interface Keystore {
  version: 1;
  kdf: "scrypt";
  kdfparams: { N: number; r: number; p: number; dklen: number; salt: string };
  cipher: "aes-256-gcm";
  cipherparams: { iv: string };
  ciphertext: string;
  tag: string;
}

/** ~1s and ~128 MiB to derive: slow enough to matter against a guessed passphrase. */
export const DEFAULT_KDF = { N: 131072, r: 8, p: 1, dklen: 32 } as const;
const SCRYPT_MAXMEM = 512 * 1024 * 1024;

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
  const key = derive(passphrase, salt, kdfparams);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
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
    // GCM cannot tell "wrong passphrase" from "altered file", and neither can we. Saying so beats
    // guessing, because the two call for very different responses.
    throw new Error("keystore: wrong passphrase, or the keystore has been modified");
  }
}

/** Rejects a shape we cannot safely interpret, before any of it reaches a cipher. */
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
  // A keystore names its own KDF cost, so a tampered file could ask for N=2 and make the passphrase
  // trivial to brute force. Refuse anything weaker than the floor rather than honouring it.
  if (p.N < 16384) throw new Error(`keystore: kdfparams.N of ${p.N} is too low to be worth encrypting with`);
  if (!isHex(p.salt, 16)) throw new Error("keystore: salt must be at least 16 bytes of hex");
  if (!isHex(k.cipherparams?.iv, 12, 12)) throw new Error("keystore: iv must be 12 bytes of hex");
  if (!isHex(k.tag, 16, 16)) throw new Error("keystore: tag must be 16 bytes of hex");
  if (!isHex(k.ciphertext, 1)) throw new Error("keystore: ciphertext must be hex");
}

function isHex(value: unknown, minBytes: number, maxBytes = Infinity): boolean {
  if (typeof value !== "string" || !/^[0-9a-f]*$/i.test(value) || value.length % 2 !== 0) return false;
  const bytes = value.length / 2;
  return bytes >= minBytes && bytes <= maxBytes;
}

/** Constant-time compare, for callers checking a passphrase against a known-good one. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
