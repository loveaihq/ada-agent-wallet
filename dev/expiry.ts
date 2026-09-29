/**
 * A payment that never lands gives its budget back, and one that did land does not.
 *
 * signerd counts a payment as spent when it signs it, and never hears whether the facilitator got
 * it on chain. It gives the budget back only when it has read, from the chain provider, that the
 * transaction's TTL has passed by the margin and the provider still does not have it. Two payments
 * show both halves of that, on preprod, with the margin cut to its 60s floor:
 *
 *   A  signed with a 60s TTL, and never submitted anywhere. Its budget must come back.
 *   B  signed with a 180s TTL and submitted straight to the provider from here, standing in for a
 *      facilitator. It lands, so its budget must stay spent — including once its own TTL and the
 *      margin have passed, which is the moment a wrong release would happen.
 *
 * A and B are built from the same UTXO, since neither is submitted before the other is signed;
 * that is harmless, because A is never submitted and B lands first.
 *
 * Then signerd is restarted, to show the release is in the audit and the checkpoint and not only
 * in memory.
 *
 * Moves real (test) ADA: B is one payment of 1.6 tADA to SELLER_ADDRESS, plus its fee. Takes about
 * seven minutes, and gives up after fifteen. Preprod and preview only.
 *
 * Env: SIGNERD_TOKEN, WALLET_MNEMONIC (or WALLET_MNEMONIC_FILE, or a keystore), SELLER_ADDRESS,
 *      CARDANO_NETWORK (default preprod), BLOCKFROST_PROJECT_ID (else Koios), KOIOS_TOKEN
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeCardanoTransaction, decodeCardanoTransactionBytes } from "@x402/cardano";
import { chainLookup } from "../src/expiry.js";
import { blockfrostBaseUrl, koiosBaseUrl, networkName } from "../src/network.js";
import { freePort } from "./port.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNERD = resolvePath(HERE, "../src/signerd.ts");
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
const MARGIN_SECONDS = 60; // signerd's floor, so the demo is as short as it can be
const NONCE_HOLD_SECONDS = 5; // short, so B is not refused for the UTXO A claimed
const A = { amount: "1500000", ttl: 60 };
const B = { amount: "1600000", ttl: 180 };
const DEADLINE = Date.now() + 15 * 60_000;

const TOKEN = process.env.SIGNERD_TOKEN;
const PAY_TO = process.env.SELLER_ADDRESS;
if (!TOKEN || !PAY_TO) {
  console.error("expiry: SIGNERD_TOKEN and SELLER_ADDRESS are required (source .env.local)");
  process.exit(1);
}
// This submits a transaction. Nothing here has any business on mainnet.
if (networkName(NETWORK) === "mainnet") {
  console.error("expiry: refusing to run on mainnet; it submits a real transaction");
  process.exit(1);
}
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const problems: string[] = [];
const check = (condition: boolean, description: string) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) problems.push(description);
};
const note = (text: string) => console.log(`        ${text}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const since = (from = t0) => `${Math.round((Date.now() - from) / 1000)}s`;

const dir = mkdtempSync(join(tmpdir(), "ada-expiry-"));
const auditFile = join(dir, "audit.jsonl");
const ledgerFile = join(dir, "ledger.json");
writeFileSync(
  join(dir, "policy.json"),
  JSON.stringify({
    network: NETWORK,
    agents: { default: { perTxMax: { lovelace: "5000000" }, dailyMax: { lovelace: "20000000" }, allowedPayees: ["*"] } },
  }),
);

const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const stderrLog = join(dir, "signerd.log");
let child: ChildProcess | undefined;

/** signerd, on files of its own, with the release margin at its floor and the loop switched on. */
async function start() {
  const log = openSync(stderrLog, "a");
  child = spawn(process.execPath, ["--import", "tsx", SIGNERD], {
    env: {
      ...process.env,
      SIGNERD_PORT: String(port),
      NONCE_HOLD_SECONDS: String(NONCE_HOLD_SECONDS),
      RELEASE_MARGIN_SECONDS: String(MARGIN_SECONDS),
      RELEASE_EXPIRED_SPENDS: "1",
      POLICY_FILE: join(dir, "policy.json"),
      AUDIT_FILE: auditFile,
      LEDGER_FILE: ledgerFile,
      CHANNELS_DIR: join(dir, "channels"),
    },
    stdio: ["ignore", "ignore", log],
  });
  closeSync(log); // the child has its own copy
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) throw new Error(`signerd exited ${child.exitCode}: ${tail()}`);
    try {
      if ((await fetch(`${url}/status`, { headers })).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error(`signerd did not come up: ${tail()}`);
}
async function stop() {
  if (!child) return;
  child.kill("SIGTERM");
  await sleep(2000);
  child.kill("SIGKILL");
  child = undefined;
}
const tail = () => (existsSync(stderrLog) ? readFileSync(stderrLog, "utf8").split("\n").slice(-8).join(" | ") : "no log");

const records = (): Array<Record<string, unknown>> =>
  existsSync(auditFile)
    ? readFileSync(auditFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return { event: "?" };
          }
        })
    : [];
const releasesOf = (tx: string) => records().filter(r => r.event === "spend_released" && r.tx === tx);

async function dailySpent(): Promise<string> {
  const s = (await fetch(`${url}/status`, { headers }).then(r => r.json())) as {
    agents: Record<string, { assets: Record<string, { dailySpent: string }> }>;
  };
  return s.agents.default.assets.lovelace.dailySpent;
}

interface Signed {
  tx: string;
  ttlSlot: number;
  transaction: string;
  amount: string;
}
/** A 409 `utxo_busy` is signerd saying "come back", so this does, a few times. */
async function sign(reason: string, p: { amount: string; ttl: number }): Promise<Signed> {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`${url}/sign`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agentId: "default",
        reason,
        input: { network: NETWORK, payTo: PAY_TO, asset: "lovelace", amount: p.amount, maxTimeoutSeconds: p.ttl },
      }),
    });
    const body = (await r.json().catch(() => ({}))) as { transaction?: string; error?: string; detail?: string };
    if (r.status === 409 && body.error === "utxo_busy" && attempt < 6) {
      await sleep((NONCE_HOLD_SECONDS + 2) * 1000);
      continue;
    }
    if (r.status !== 200 || !body.transaction) throw new Error(`/sign ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
    const decoded = decodeCardanoTransaction(body.transaction);
    if (decoded.ttlSlot === undefined) throw new Error("the signed transaction has no TTL, so there is nothing to demonstrate");
    return { tx: decoded.txHash, ttlSlot: Number(decoded.ttlSlot), transaction: body.transaction, amount: p.amount };
  }
}

/** Straight to the provider, as a facilitator would. This is dev code; signerd never does this. */
async function submit(signed: Signed): Promise<string> {
  const bytes = Buffer.from(decodeCardanoTransactionBytes(signed.transaction));
  const blockfrost = process.env.BLOCKFROST_PROJECT_ID;
  const r = blockfrost
    ? await fetch(`${blockfrostBaseUrl(NETWORK)}/tx/submit`, { method: "POST", headers: { project_id: blockfrost, "content-type": "application/cbor" }, body: bytes })
    : await fetch(`${koiosBaseUrl(NETWORK)}/submittx`, {
        method: "POST",
        headers: { "content-type": "application/cbor", ...(process.env.KOIOS_TOKEN ? { authorization: `Bearer ${process.env.KOIOS_TOKEN}` } : {}) },
        body: bytes,
      });
  const text = await r.text();
  if (!r.ok) throw new Error(`the provider refused B's submit: HTTP ${r.status} ${text.slice(0, 300)}`);
  return text.replace(/"/g, "").trim();
}

const chain = chainLookup({
  network: NETWORK,
  blockfrostProjectId: process.env.BLOCKFROST_PROJECT_ID,
  koiosToken: process.env.KOIOS_TOKEN,
  timeoutMs: 20_000,
});

/** Polls, and gives up at the overall deadline, so a run that is going nowhere ends. */
async function until(condition: () => Promise<boolean>, what: string, every = 5000) {
  for (;;) {
    if (child && child.exitCode !== null) throw new Error(`signerd exited ${child.exitCode} while waiting for ${what}: ${tail()}`);
    if (await condition()) return;
    if (Date.now() > DEADLINE) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

let a: Signed | undefined;
let b: Signed | undefined;
let aReleasedAt: number | undefined;
let aReleasedAfter: string | undefined;
let bLandedAt: number | undefined;
try {
  await start();
  console.log(`signerd up on ${url}, margin ${MARGIN_SECONDS}s, ${process.env.BLOCKFROST_PROJECT_ID ? "Blockfrost" : "Koios"}`);

  // === 1. two payments ==========================================================================
  console.log("\n1. sign A, which nobody will submit, and B, which we submit ourselves");
  a = await sign("expiry demo: A, signed and never submitted", A);
  note(`A  ${a.tx}  ttl slot ${a.ttlSlot} (${A.ttl}s)`);
  check((await dailySpent()) === A.amount, `A is counted when signed (dailySpent ${await dailySpent()})`);
  const signedA = records().find(r => r.event === "signed" && r.tx === a!.tx);
  check(signedA?.ttlSlot === a.ttlSlot, "the audit's `signed` record names A's transaction and TTL slot");

  await sleep((NONCE_HOLD_SECONDS + 2) * 1000);
  b = await sign("expiry demo: B, signed and submitted", B);
  note(`B  ${b.tx}  ttl slot ${b.ttlSlot} (${B.ttl}s)`);
  const both = (BigInt(A.amount) + BigInt(B.amount)).toString();
  check((await dailySpent()) === both, `both are counted (dailySpent ${await dailySpent()}, expected ${both})`);

  const submitted = await submit(b);
  check(submitted === b.tx, `the provider took B and says its hash is ${submitted.slice(0, 16)}…`);
  const submittedAt = Date.now();

  await until(
    async () => {
      if ((await chain.onChain([b!.tx])).get(b!.tx) === true) return true;
      // Past its TTL and not in a block, it never will be: no point waiting out the deadline for it.
      if ((await chain.tip().catch(() => 0)) > b!.ttlSlot) throw new Error("B did not land before its own TTL, so this run shows nothing; run it again");
      return false;
    },
    "B to land",
  );
  bLandedAt = Date.now();
  note(`B is in a block, ${since(submittedAt)} after it was submitted`);

  // === 2. A's budget comes back ==================================================================
  console.log(`\n2. wait for A's TTL and the ${MARGIN_SECONDS}s margin to pass, and for the release`);
  let lastNote = 0;
  await until(
    async () => {
      if (releasesOf(a!.tx).length > 0) return true;
      if (Date.now() - lastNote > 30_000) {
        lastNote = Date.now();
        note(`${since()}: tip ${await chain.tip().catch(() => "?")}, A releasable past slot ${a!.ttlSlot + MARGIN_SECONDS}, dailySpent ${await dailySpent()}`);
      }
      return false;
    },
    "A's budget to be given back",
    10_000,
  );
  aReleasedAt = Date.now();
  aReleasedAfter = since();
  const release = releasesOf(a.tx)[0];
  note(`A was released ${aReleasedAfter} after the run started, ${since(bLandedAt)} after B landed`);
  check(release.agentId === "default" && release.asset === "lovelace" && release.amount === A.amount, "the `spend_released` record names A's agent, asset and amount");
  check(release.ttlSlot === a.ttlSlot && typeof release.signedTs === "number", "and its TTL slot and when it was signed");
  check(releasesOf(a.tx).length === 1, "and only once");
  check((await dailySpent()) === B.amount, `A's budget is back and B's is not (dailySpent ${await dailySpent()}, expected ${B.amount})`);

  // === 3. B's is not ============================================================================
  console.log(`\n3. wait past B's own TTL and margin: B is on chain, so it must stay counted`);
  let pastB: number | undefined;
  await until(
    async () => {
      if (releasesOf(b!.tx).length > 0) return true; // a wrong release: stop waiting and fail below
      const tip = await chain.tip().catch(() => 0);
      if (tip > b!.ttlSlot + MARGIN_SECONDS) pastB ??= Date.now();
      // Two reconcile passes' worth after the tip is past it, so the loop has certainly looked.
      return pastB !== undefined && Date.now() - pastB >= 150_000;
    },
    "B's TTL and margin to pass",
    10_000,
  );
  check(releasesOf(b.tx).length === 0, "B was not released, though its TTL and the margin have passed");
  check((await dailySpent()) === B.amount, `B is still counted (dailySpent ${await dailySpent()}, expected ${B.amount})`);

  // === 4. it survives a restart =================================================================
  console.log("\n4. restart signerd: the release is in the audit and the checkpoint, not only in memory");
  await stop();
  await start();
  check((await dailySpent()) === B.amount, `after a restart A is still not counted and B still is (dailySpent ${await dailySpent()})`);
  const checkpoint = JSON.parse(readFileSync(ledgerFile, "utf8")) as { spends: Array<{ tx?: string; ttlSlot?: number }> };
  check(checkpoint.spends.length === 1 && checkpoint.spends[0].tx === b.tx && checkpoint.spends[0].ttlSlot === b.ttlSlot, "the checkpoint holds one spend, B, with its transaction and TTL slot");
} catch (e) {
  check(false, String(e instanceof Error ? e.message : e));
  note(`signerd log, last lines: ${tail()}`);
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}

console.log("\n----");
console.log(`A  never submitted   ${a?.tx ?? "(not signed)"}${aReleasedAt ? `   budget returned ${aReleasedAfter} into the run` : "   budget NOT returned"}`);
console.log(`B  submitted, landed ${b?.tx ?? "(not signed)"}${bLandedAt ? `   in a block ${since(bLandedAt)} before the end, budget kept` : "   did not land"}`);
console.log(problems.length ? `FAIL: ${problems.length} check(s) failed (${since()})` : `PASS: the payment that never landed gave its budget back, and the one that did kept it (${since()})`);
process.exit(problems.length ? 1 : 0);
