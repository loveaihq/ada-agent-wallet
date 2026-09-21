#!/usr/bin/env node
/**
 * Creates and checks the passphrase-encrypted keystore signerd reads.
 *
 *   npm run keystore -- create --mnemonic-file ~/.ada-agent-wallet/mnemonic --out ~/.ada-agent-wallet/keystore.json
 *   npm run keystore -- create --out keystore.json            # reads the mnemonic from stdin
 *   npm run keystore -- verify --keystore keystore.json       # does this passphrase open it?
 *
 * The passphrase is asked for twice on create and never echoed. Deleting the plaintext mnemonic
 * afterwards is the step that makes any of this worth doing, and it is left to you on purpose:
 * nothing here should delete the only copy of a wallet.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { toClientCardanoSigner } from "@x402/cardano";
import { encryptMnemonic, decryptMnemonic, assertKeystore } from "./keystore.js";
import { koiosBaseUrl } from "./network.js";

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

// A declaration rather than a const arrow: TypeScript only treats a call as `never` (so that the
// code after it is known not to run) when the callee's type is declared, not inferred.
function die(msg: string): never {
  console.error(`keystore: ${msg.replace(/^keystore: /, "")}`);
  process.exit(1);
}

const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";

/**
 * Derives the wallet address, offline, which is also the only real check that a mnemonic is the
 * right one: 24 words with a typo is still 24 words, and the SDK rejects a bad BIP-39 checksum.
 * Without this the tool would happily encrypt a mistyped mnemonic, tell you to delete the
 * plaintext, and hand you a keystore for a wallet that has never held anything.
 */
function addressOf(mnemonic: string): string {
  try {
    return toClientCardanoSigner({
      mnemonic,
      network: NETWORK,
      provider: { koios: { baseUrl: koiosBaseUrl(NETWORK) } },
    }).getAddress();
  } catch (e) {
    die(`that is not a usable mnemonic: ${e instanceof Error ? e.message : e}`);
  }
}

switch (command) {
  case "create": {
    const out = flag("out") ?? die("create needs --out <path>");
    const force = argv.includes("--force");
    if (existsSync(out) && !force) die(`${resolve(out)} already exists; pass --force to replace it`);

    const mnemonicFile = flag("mnemonic-file");
    if (!mnemonicFile && !process.stdin.isTTY)
      die("without a terminal, stdin carries the passphrase — pass --mnemonic-file so the mnemonic has its own source");
    const mnemonic = (mnemonicFile ? readFileSync(mnemonicFile, "utf8") : readFileSync(0, "utf8")).trim();
    const words = mnemonic.split(/\s+/).filter(Boolean);
    if (words.length !== 24) die(`expected a 24-word mnemonic, got ${words.length} word(s)`);
    const address = addressOf(mnemonic);

    const passphrase = await prompt("passphrase: ");
    if (passphrase.length < 12) die("use at least 12 characters; this is the only thing standing between a copied file and the wallet");
    // Asking twice guards against a typo nobody can see. A pipe cannot make that mistake, and
    // asking it twice would only consume input meant for something else.
    if (process.stdin.isTTY && (await prompt("passphrase (again): ")) !== passphrase) die("the two passphrases differ");

    process.stderr.write("deriving (this is deliberately slow)…\n");
    const keystore = encryptMnemonic(mnemonic, passphrase);
    // Prove it opens before anything is written, rather than discovering at the next restart that
    // the only copy of the wallet is a file nobody can decrypt.
    if (decryptMnemonic(keystore, passphrase) !== mnemonic) die("the keystore did not round-trip; nothing was written");

    writeFileSync(out, JSON.stringify(keystore, null, 2) + "\n", { mode: 0o600 });
    chmodSync(out, 0o600);
    console.log(`wrote ${resolve(out)} (mode 600)`);
    console.log(`  network ${NETWORK}`);
    console.log(`  address ${address}`);
    console.log(`\nPoint signerd at it:`);
    console.log(`  WALLET_KEYSTORE_FILE=${resolve(out)}`);
    console.log(`  WALLET_PASSPHRASE_FILE=<somewhere the keystore is not>   # or leave unset to be prompted`);
    console.log(`\nCheck that address against "walletctl status" before removing the plaintext mnemonic,`);
    console.log(`and only once you are certain the passphrase is recoverable.`);
    if (mnemonicFile) console.log(`  ${resolve(mnemonicFile)}`);
    break;
  }

  case "verify": {
    const file = flag("keystore") ?? die("verify needs --keystore <path>");
    let keystore: unknown;
    try {
      keystore = JSON.parse(readFileSync(file, "utf8"));
      assertKeystore(keystore);
    } catch (e) {
      die(`${resolve(file)}: ${e instanceof Error ? e.message : e}`);
    }
    const passphrase = await prompt("passphrase: ");
    process.stderr.write("deriving…\n");
    let mnemonic: string;
    try {
      mnemonic = decryptMnemonic(keystore as Parameters<typeof decryptMnemonic>[0], passphrase);
    } catch (e) {
      die(String(e instanceof Error ? e.message : e));
    }
    const words = mnemonic.split(/\s+/).filter(Boolean);
    // The address, never the words: "it opens" is not the question, "onto which wallet" is.
    console.log(`ok — opens onto a ${words.length}-word mnemonic`);
    console.log(`  network ${NETWORK}`);
    console.log(`  address ${addressOf(mnemonic)}`);
    break;
  }

  default:
    console.log("keystore create --out <path> [--mnemonic-file <path>] [--force]");
    console.log("keystore verify --keystore <path>");
}

/** Reads a line with the terminal echo suppressed. */
function prompt(label: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve(readFileSync(0, "utf8").replace(/\r?\n$/, ""));
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const out = (rl as unknown as { output: NodeJS.WriteStream & { muted?: boolean } }).output;
  const write = out.write.bind(out);
  (out as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => (out.muted ? true : write(chunk));
  process.stderr.write(label);
  out.muted = true;
  return new Promise(res =>
    rl.question("", answer => {
      out.muted = false;
      process.stderr.write("\n");
      rl.close();
      res(answer);
    }),
  );
}
