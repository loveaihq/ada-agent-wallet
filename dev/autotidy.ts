/**
 * signerd tidies the wallet by itself, on preprod, the way an agent meets it: a real MCP client
 * spawns src/mcp.ts and calls x402_fetch against dev/batchseller.ts, and signerd decides.
 *
 *   a. The wallet is put out of order on purpose, by a self-transfer this script builds from the
 *      same mnemonic (account 0): every token and nearly all the ADA in one output, and one small
 *      ADA-only UTxO, too small for a channel opening and its collateral. That is where a run of
 *      `exact` payments leaves a wallet. It waits until the provider lists the result.
 *   b. The agent buys from the seller. The opening cannot be funded, so signerd starts a tidy in the
 *      background and answers 409 wallet_tidying, retryable, at once, not insufficient_funds. The
 *      audit has one `auto_tidy` record naming the agent, the step and the shortage. A second ask
 *      straight after gets the same answer, and no second tidy.
 *   c. It waits until the provider lists the tidy's outputs, then asks again: the channel opens and
 *      the purchase is paid by voucher. The audit's `tidied` record says `auto: true`.
 *   d. The wallet is put out of order a second time and the agent buys until the channel needs a
 *      top-up. That is a second shortage inside the interval, so nothing is tidied: the answer is
 *      insufficient_funds as always, and its audit record says why no tidy was tried. Then a tidy
 *      by hand (the operator's, `POST /tidy`) puts the wallet right, and the same purchase that
 *      was refused goes through, topping the channel up.
 *   e. The refund, through walletctl, and the reconciliation against the chain: the seller got
 *      exactly what the vouchers signed, and the wallet lost exactly that, the fees of the channel's
 *      transactions, this script's two self-transfers, the automatic tidy's fee and the by-hand
 *      tidy's, to the lovelace.
 *
 * Needs dev/batchseller.ts, and signerd started with a fresh CHANNELS_DIR, AGENT_TOKENS_FILE,
 * BATCH_DEPOSIT_REQUESTS=10 (so that the top-up comes at the eleventh voucher) and this agent's
 * policy, the one dev/batch.ts asks for:
 *
 *   perTxMax { lovelace: 300000 }, dailyMax { lovelace: 2500000 }, approvalAbove { lovelace: 150000 },
 *   allowedPayees [<the seller's payTo>], allowedResources ["http://127.0.0.1:7411/*"],
 *   allowedSchemes ["exact", "batch-settlement"], allowedProviderKeys [<the seller's providerKey>],
 *   channelDepositMax { lovelace: 5000000 }, channelLockedMax { lovelace: 10000000 }
 *
 * (amounts as decimal strings), and neither AUTO_TIDY=0 nor an AUTO_TIDY_MIN_INTERVAL_SECONDS under
 * what step d needs (a few minutes); the default 600 is right. If signerd was given another one,
 * give it to this script too.
 *
 * The wallet needs tokens (it is the tokens that fold the ADA away) and at least 15 tADA, and no
 * channel yet. Moves real (test) ADA only in fees: about 0.2 tADA for each self-transfer and each
 * tidy, and the channel's; nothing leaves the wallet but the vouchers, which are the seller's.
 * Gives up after 20 minutes. Preprod only.
 *
 * Env: SIGNERD_URL, SIGNERD_TOKEN (the operator's), AGENT_TOKEN (the agent's), AGENT_ID, AUDIT_FILE,
 *      BLOCKFROST_PROJECT_ID, WALLET_MNEMONIC (the wallet signerd holds), and optionally
 *      AUTO_TIDY_MIN_INTERVAL_SECONDS (as signerd has it), CARDANO_NETWORK (default preprod)
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Address, Assets, Client, preprod } from "@evolution-sdk/evolution";
import { BlockfrostChain } from "subbit-x402/x402/chain";
import { signedHex } from "subbit-x402/x402/client";
import { refOf } from "subbit-x402/x402/cardano";
import { blockfrostBaseUrl, networkName } from "../src/network.js";
import { adaOnlyLovelace, describeLayout, formatAda, type Utxo } from "../src/tidy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
// This submits transactions from a wallet. Nothing here has any business on mainnet.
if (networkName(NETWORK) === "mainnet") {
  console.error("autotidy: refusing to run on mainnet; it submits transactions from the wallet");
  process.exit(1);
}
if (networkName(NETWORK) !== "preprod") {
  console.error(`autotidy: batch-settlement runs on preprod only, and this is ${NETWORK}`);
  process.exit(1);
}
const SIGNERD_URL = process.env.SIGNERD_URL ?? "http://127.0.0.1:7402";
const OPERATOR = must("SIGNERD_TOKEN");
const AGENT_TOKEN = must("AGENT_TOKEN");
const AGENT_ID = process.env.AGENT_ID ?? "default";
const AUDIT_FILE = must("AUDIT_FILE");
const PROJECT_ID = must("BLOCKFROST_PROJECT_ID");
const MNEMONIC = must("WALLET_MNEMONIC");
const SELLER = "http://127.0.0.1:7411";
const BF = blockfrostBaseUrl("cardano:preprod");
const INTERVAL_MS = Number(process.env.AUTO_TIDY_MIN_INTERVAL_SECONDS ?? 600) * 1000;

/** What the wallet needs to start: two self-transfers and two tidies, the deposit, a top-up and collateral. */
const MIN_TOTAL = 15_000_000n;
/** What it still needs for the second disarrangement, once the opening has locked its deposit and taken its fee. */
const MIN_TOTAL_AFTER_OPENING = 10_000_000n;
/** The ADA-only UTxO a disarrangement leaves, before the fee room comes back to it. */
const SMALL = 1_500_000n;
/** Held back from the big output so that the change is at least SMALL whatever the fee turns out to be. */
const FEE_ROOM = 600_000n;
/** An opening's deposit and its collateral come to more than this; the disarranged wallet holds less in ADA-only UTxOs. */
const TOO_LITTLE = 3_000_000n;
const LISTING_WAIT_MS = 5 * 60_000;
const OVERALL_MS = 20 * 60_000;

const t0 = Date.now();
const since = (from = t0) => `${Math.round((Date.now() - from) / 1000)}s`;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const log = (s: string) => console.log(`[autotidy ${new Date().toISOString().slice(11, 19)}] ${s}`);
const note = (s: string) => console.log(`        ${s}`);

/** Not `unref`'d: nothing else in this process is guaranteed to keep it alive while it waits on the chain. */
const overall = setTimeout(() => {
  console.error(`FAIL: still running after ${OVERALL_MS / 60_000} minutes (${since()}); giving up`);
  process.exit(1);
}, OVERALL_MS);

const problems: string[] = [];
/** Records a failed check, and goes on. */
function check(ok: boolean, what: string, detail?: unknown): boolean {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) {
    problems.push(what);
    if (detail !== undefined) note(JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 600));
  }
  return ok;
}
class Abort extends Error {}
/** A check the rest of the run stands on: when it fails there is nothing further to show. */
function need(ok: boolean, what: string, detail?: unknown) {
  if (!check(ok, what, detail)) throw new Abort(what);
}

const operator = { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" };
const signerd = async (path: string, body?: unknown) => {
  const r = await fetch(SIGNERD_URL + path, { method: body ? "POST" : "GET", headers: operator, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};

// ---- the wallet, as this script holds it ----------------------------------------------------------

// The key signerd's channel client uses: the same mnemonic, normalised as signerd does, account 0.
const wallet = Client.make(preprod)
  .withBlockfrost({ baseUrl: BF, projectId: PROJECT_ID })
  .withSeed({ mnemonic: MNEMONIC.trim().replace(/\s+/g, " ").toLowerCase(), accountIndex: 0 });
const me = await wallet.address();
const chain = new BlockfrostChain("cardano:preprod", BF, PROJECT_ID);

/** The wallet's UTxOs as the provider lists them, as tidy.ts sees them. Nothing here asks signerd. */
async function listUtxos(address: string): Promise<Utxo[]> {
  const out: Utxo[] = [];
  for (let page = 1; ; page++) {
    const r = await fetch(`${BF}/addresses/${address}/utxos?count=100&page=${page}`, { headers: { project_id: PROJECT_ID } });
    if (r.status === 404) return out; // an address that has never held anything
    if (!r.ok) throw new Error(`Blockfrost answered ${r.status} for the wallet's UTxOs`);
    const rows = (await r.json()) as Array<{ tx_hash: string; output_index: number; amount: Array<{ unit: string; quantity: string }> }>;
    for (const row of rows) {
      const assets: Record<string, bigint> = {};
      let lovelace = 0n;
      for (const a of row.amount) {
        // Blockfrost's unit is the policy and the name run together.
        if (a.unit === "lovelace") lovelace = BigInt(a.quantity);
        else assets[`${a.unit.slice(0, 56)}.${a.unit.slice(56)}`] = BigInt(a.quantity);
      }
      out.push({ ref: `${row.tx_hash}#${row.output_index}`, lovelace, assets });
    }
    if (rows.length < 100) return out;
  }
}
const holdsTokens = (u: Utxo) => Object.values(u.assets).some(q => q > 0n);
const lovelaceOf = (utxos: Utxo[]) => utxos.reduce((s, u) => s + u.lovelace, 0n);

/**
 * Waits until the provider lists all `outputs` of `tx` and none of `old`: the wallet as the next
 * builder will see it. Blockfrost lists a transaction's outputs some 20 s after its block.
 */
async function listed(tx: string, outputs: number, old: Set<string>, what: string): Promise<Utxo[]> {
  const from = Date.now();
  for (let lastNote = 0; ; ) {
    const now = await listUtxos(Address.toBech32(me));
    const fresh = now.filter(u => u.ref.startsWith(`${tx}#`)).length;
    const left = now.filter(u => old.has(u.ref)).length;
    if (fresh === outputs && left === 0) {
      note(`${what}: listed ${since(from)} after it was submitted`);
      return now;
    }
    if (Date.now() - from > LISTING_WAIT_MS) throw new Abort(`${what}: the provider still lists ${fresh} of ${outputs} new outputs and ${left} old one(s) ${since(from)} after the submit`);
    if (Date.now() - lastNote > 30_000) {
      lastNote = Date.now();
      note(`${what}: ${since(from)}: ${fresh} of ${outputs} new outputs listed, ${left} old one(s) still there`);
    }
    await sleep(10_000);
  }
}

/**
 * The self-transfer that undoes a tidy: all tokens and all the ADA but a little into one output,
 * and the little as change. Built with the SDK from the same key, submitted through the provider.
 */
async function disarrange(label: string, min: bigint): Promise<{ tx: string; outputs: number; old: Set<string> }> {
  const all = await wallet.getWalletUtxos();
  const utxos = all.filter(u => u.scriptRef === undefined);
  const tokens: Record<string, bigint> = {};
  let total = 0n;
  for (const u of utxos) {
    total += Assets.lovelaceOf(u.assets);
    for (const unit of Assets.getUnits(u.assets)) {
      if (unit === "lovelace") continue;
      const q = Assets.getByUnit(u.assets, unit);
      if (q > 0n) tokens[unit] = (tokens[unit] ?? 0n) + q;
    }
  }
  need(Object.keys(tokens).length > 0, `${label}: the wallet holds tokens to fold the ADA into`);
  need(total >= min, `${label}: the wallet holds at least ${formatAda(min)} (${formatAda(total)})`);
  const big = total - SMALL - FEE_ROOM;
  const tx = wallet
    .newTx()
    .collectFrom({ inputs: utxos })
    .payToAddress({ address: me, assets: Assets.fromRecord({ lovelace: big, ...tokens }) });
  // Every UTxO is an input, so there is nothing for coin selection to add: what the output and the
  // fee leave is the change.
  const built = await tx.build({ changeAddress: me, availableUtxos: [] });
  const hash = await chain.submit(await signedHex(built));
  note(`${label}: tx ${hash}, ${utxos.length} UTxO(s) into one with ${Object.keys(tokens).length} kind(s) of token and ${formatAda(big)}`);
  return { tx: hash, outputs: 2, old: new Set(utxos.map(refOf)) };
}

/** Whether the wallet, as the provider lists it, is disarranged: one UTxO of tokens, and too little ADA-only. */
function disarranged(utxos: Utxo[]): boolean {
  return utxos.filter(holdsTokens).length === 1 && adaOnlyLovelace(utxos) < TOO_LITTLE;
}

// ---- the agent ------------------------------------------------------------------------------------

const mcp = new McpClient({ name: "autotidy", version: "0.1.0" });
await mcp.connect(
  new StdioClientTransport({
    // node itself rather than npx: Windows will not spawn a .cmd without a shell.
    command: process.execPath,
    args: ["--import", "tsx", resolve(HERE, "../src/mcp.ts")],
    env: { ...(process.env as Record<string, string>), SIGNERD_URL, SIGNERD_TOKEN: AGENT_TOKEN, AGENT_ID },
    stderr: "inherit",
  }),
);

type Fetched = { error?: string; status?: number; paid?: boolean; voucher?: string; denied?: boolean; rule?: string; detail?: string; retryable?: boolean; retryAfterSeconds?: number };
async function buy(reason: string): Promise<Fetched> {
  const r = await mcp.callTool({ name: "x402_fetch", arguments: { url: `${SELLER}/data`, reason } }, undefined, { timeout: 600_000 });
  const text = (r.content as Array<{ text?: string }>)[0]?.text ?? "";
  try {
    return JSON.parse(text) as Fetched;
  } catch {
    return { error: text };
  }
}
/** What an agent does with `retryable`: waits as long as it is told, and asks again, a few times. */
async function buyPatiently(reason: string, tries = 6): Promise<Fetched> {
  for (let i = 0; ; i++) {
    const r = await buy(reason);
    if (r.denied !== true || r.retryable !== true || i >= tries) return r;
    const wait = r.retryAfterSeconds ?? 30;
    note(`answered ${r.rule} (${r.detail ?? ""}); asking again in ${wait}s`);
    await sleep(wait * 1000);
  }
}

function auditRecords(): Array<Record<string, unknown> & { seq: number; ts: number; event: string }> {
  return readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}
const firstSeq = auditRecords().at(-1)?.seq ?? 0;
const mine = (event: string) => auditRecords().filter(e => e.seq > firstSeq && e.event === event);

/** This agent's channels in signerd's index; the run starts from an empty one. */
async function channels(): Promise<Array<Record<string, unknown>>> {
  return ((await signerd("/channels")).data.channels as Array<Record<string, unknown>>).filter(c => c.agentId === AGENT_ID);
}

function walletctl(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise(ok => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(HERE, "../src/walletctl.ts"), ...args], {
      env: { ...process.env, SIGNERD_URL, SIGNERD_TOKEN: OPERATOR },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (err += d));
    child.on("close", code => ok({ code: code ?? 1, out, err }));
  });
}

async function blockfrost(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(BF + path, { headers: { project_id: PROJECT_ID } });
    if (r.ok) return (await r.json()) as Record<string, unknown>;
    // The index trails a confirmed transaction by a few seconds.
    if (r.status !== 404 || attempt >= 20) throw new Error(`Blockfrost ${path}: ${r.status}`);
    await sleep(3000);
  }
}

/** What a transaction moved to or from an address: outputs less inputs, collateral and reference inputs aside. */
function netFor(utxos: Record<string, unknown>, address: string): bigint {
  type Io = { address: string; amount: Array<{ unit: string; quantity: string }>; collateral?: boolean; reference?: boolean };
  const lovelace = (xs: Io[]) => xs.filter(x => x.address === address && !x.collateral && !x.reference).reduce((s, x) => s + BigInt(x.amount.find(a => a.unit === "lovelace")?.quantity ?? "0"), 0n);
  return lovelace(utxos.outputs as Io[]) - lovelace(utxos.inputs as Io[]);
}
const ada = (l: bigint) => `${l < 0n ? "-" : ""}${(l < 0n ? -l : l) / 1_000_000n}.${((l < 0n ? -l : l) % 1_000_000n).toString().padStart(6, "0")}`;
function must(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`autotidy: ${name} is required`);
    process.exit(1);
  }
  return v;
}

// ---- the run ----------------------------------------------------------------------------------------

/** Every transaction that moved the wallet's ADA, for the reconciliation at the end. */
const txs: Array<{ what: string; hash: string }> = [];
let refundTx: string | undefined;
let autoTidyTx: string | undefined;

try {
  const address = Address.toBech32(me);
  const status = (await signerd("/status")).data as { address?: string; network?: string; batch?: { available?: boolean; detail?: string } };
  need(status.network === "cardano:preprod", `signerd is on cardano:preprod (${status.network})`);
  need(status.address === address, "WALLET_MNEMONIC is the wallet signerd holds (account 0)", { signerd: status.address, mnemonic: address });
  need(status.batch?.available === true, `batch-settlement is available in signerd${status.batch?.available ? "" : `: ${status.batch?.detail}`}`);
  need((await channels()).length === 0, "the agent has no channel yet (start signerd with a fresh CHANNELS_DIR)");
  const start = await listUtxos(address);
  log(`the wallet: ${describeLayout(start)}`);
  const lovelaceStart = lovelaceOf(start);

  // === a. =========================================================================================
  log("a. the wallet is put out of order, as a run of `exact` payments does");
  const first = await disarrange("a", MIN_TOTAL);
  txs.push({ what: "self-transfer 1", hash: first.tx });
  const afterFirst = await listed(first.tx, first.outputs, first.old, "a");
  note(describeLayout(afterFirst));
  need(disarranged(afterFirst), `the tokens are in one UTxO and the ADA-only UTxOs hold under ${formatAda(TOO_LITTLE)} (${formatAda(adaOnlyLovelace(afterFirst))})`);
  const dry = await signerd("/tidy", { dryRun: true });
  need(dry.status === 200 && dry.data.alreadyTidy === false, "signerd sees the same wallet, and says it needs tidying", dry.data);
  note(`signerd: ${String(dry.data.why)}`);

  // === b. =========================================================================================
  log("b. the agent buys: the opening cannot be funded, and signerd starts a tidy");
  const askedAt = Date.now();
  const short = await buy("autotidy run: the first datum, from a wallet that cannot open a channel");
  const answeredIn = Date.now() - askedAt;
  check(short.denied === true && short.rule === "wallet_tidying", `answered wallet_tidying, not insufficient_funds (${short.rule ?? short.error})`, short);
  check(short.retryable === true, "marked retryable", short);
  check(short.retryAfterSeconds === 60, `asked to wait 60 seconds (${short.retryAfterSeconds})`, short);
  check(/rearranging its funds; try again in about a minute/.test(short.detail ?? ""), `in a plain sentence: "${short.detail}"`, short);
  check(answeredIn < 60_000, `and at once, not after a transaction confirmed (${Math.round(answeredIn / 1000)}s)`);
  const started = mine("auto_tidy");
  check(started.length === 1, `one auto_tidy record (${started.length})`);
  const trigger = started[0];
  check(
    trigger?.agentId === AGENT_ID && trigger?.step === "batch/payload" && typeof trigger?.message === "string" && trigger.message.length > 0 && typeof trigger?.why === "string",
    "naming the agent, the step and the shortage",
    trigger,
  );
  note(`shortage: ${String(trigger?.message)}`);
  note(`why a tidy: ${String(trigger?.why)}`);
  check(mine("insufficient_funds").length === 0, "and no insufficient_funds was audited");
  need(started.length === 1, "one tidy was started");

  const again = await buy("autotidy run: the same datum, asked again at once");
  check(again.denied === true && again.rule === "wallet_tidying" && again.retryable === true, `asked again at once: told to wait again (${again.rule ?? again.error})`, again);
  check(mine("auto_tidy").length === 1, "and no second tidy was started");

  // === c. =========================================================================================
  log("c. the tidy lands, and the same purchase goes through");
  // The tidy is built and submitted in the background; its record says when it has been.
  let tidied: (Record<string, unknown> & { seq: number; ts: number; event: string }) | undefined;
  for (let i = 0; i < 60 && !tidied; i++) {
    tidied = mine("tidied").find(e => e.auto === true);
    const failedRecord = ["auto_tidy_failed", "auto_tidy_skipped", "tidy_refused", "tidy_error"].map(mine).flat()[0];
    if (failedRecord) throw new Abort(`the automatic tidy did not go through: ${JSON.stringify(failedRecord)}`);
    if (!tidied) await sleep(3000);
  }
  need(tidied !== undefined, "the audit has a tidied record with auto: true");
  autoTidyTx = String(tidied!.tx);
  txs.push({ what: "automatic tidy", hash: autoTidyTx });
  check(mine("tidied").length === 1, "and it is the only tidy so far");
  note(`automatic tidy ${autoTidyTx}, fee ${formatAda(BigInt(String(tidied!.fee)))}, ${since(trigger!.ts)} after the first ask`);
  const afterTidy = await listed(autoTidyTx, 3, new Set(afterFirst.map(u => u.ref)), "c");
  note(describeLayout(afterTidy));
  check(!disarranged(afterTidy) && afterTidy.filter(holdsTokens).length === 1 && afterTidy.some(u => !holdsTokens(u) && u.lovelace === 5_000_000n), "the tokens are in one UTxO and an ADA-only UTxO holds exactly 5 tADA of collateral");

  const paid = await buyPatiently("autotidy run: the first datum, asked again once the tidy has landed");
  need(paid.status === 200 && paid.paid === true && typeof paid.voucher === "string", "paid by voucher", paid);
  note(`voucher ${paid.voucher}`);
  const opened = mine("channel_opened");
  check(opened.length === 1, `the channel was opened (${opened.length})`);
  const openTx = String(opened[0]?.transaction);
  txs.push({ what: "channel opening", hash: openTx });
  const channel = (await channels())[0];
  need(channel !== undefined && channel.signed === "100000", "one channel, signed for 0.1 tADA", channel);
  const channelId = String(channel!.channelId);
  check(mine("auto_tidy").length === 1, "still one auto_tidy record");

  // === d. =========================================================================================
  const sinceTidy = Date.now() - trigger!.ts;
  // Step d takes a few minutes (the provider lists the wallet twice in it); it shows the interval only if it ends inside it.
  if (sinceTidy + 5 * 60_000 > INTERVAL_MS) {
    log(`d. skipped: ${Math.round(sinceTidy / 1000)}s have passed since the automatic tidy and the interval is ${INTERVAL_MS / 1000}s, so a second shortage may now start another tidy legitimately`);
  } else {
    log("d. a second shortage inside the interval starts no tidy");
    // The opening's change must be listed before the wallet is disarranged again, or it would stay
    // out of the self-transfer and leave the wallet funded.
    for (let i = 0, seen = false; i < 30 && !seen; i++) {
      seen = (await listUtxos(address)).some(u => u.ref.startsWith(`${openTx}#`));
      if (!seen) await sleep(10_000);
      else note("the opening's change is listed");
    }
    const second = await disarrange("d", MIN_TOTAL_AFTER_OPENING);
    txs.push({ what: "self-transfer 2", hash: second.tx });
    const afterSecond = await listed(second.tx, second.outputs, second.old, "d");
    need(disarranged(afterSecond), `disarranged again (${formatAda(adaOnlyLovelace(afterSecond))} ADA-only)`);

    // Vouchers cost nothing and need no ADA; the eleventh needs a top-up, which does.
    let refused: Fetched | undefined;
    let vouchers = 1;
    for (let i = 2; i <= 30 && !refused; i++) {
      const r = await buy(`autotidy run: datum ${i}`);
      if (r.status === 200 && r.paid === true) vouchers++;
      else refused = r;
    }
    note(`${vouchers} vouchers were paid before the first one that did not go through`);
    check(refused?.denied === true && refused.rule === "insufficient_funds", `the top-up's shortage is insufficient_funds (${refused?.rule ?? refused?.error})`, refused);
    check(refused?.retryable === false, "and not retryable", refused);
    check(mine("auto_tidy").length === 1 && mine("tidied").length === 1, "no second tidy was started");
    const why = mine("insufficient_funds").at(-1)?.tidy;
    check(typeof why === "string" && /^tidied \d+ (second|minute|hour)s? ago; at most one automatic tidy every \d+ (second|minute|hour)s?$/.test(why), `the audit says why none was tried: "${String(why)}"`);

    log("d. and a tidy by hand puts the wallet right, so the same purchase goes through");
    // signerd holds off while an output of its own opening is "not listed yet": this script has spent
    // that output outside signerd, so it waits out the five minutes signerd allows for a listing.
    let hand = await signerd("/tidy", {});
    for (let i = 0; i < 24 && hand.status === 409 && hand.data.error === "utxo_busy"; i++) {
      note(String(hand.data.detail));
      await sleep(15_000);
      hand = await signerd("/tidy", {});
    }
    need(hand.status === 200 && hand.data.tidied === true && typeof hand.data.tx === "string", "tidied by hand", hand.data);
    const handTx = String(hand.data.tx);
    txs.push({ what: "tidy by hand", hash: handTx });
    const handTidied = mine("tidied").filter(e => e.auto !== true);
    check(handTidied.length === 1 && handTidied[0].tx === handTx, "its record has no auto flag");
    await listed(handTx, 3, new Set(afterSecond.map(u => u.ref)), "d");
    const topped = await buyPatiently("autotidy run: the datum that was refused, asked again after the tidy");
    need(topped.status === 200 && topped.paid === true, "paid, the channel topped up on the way", topped);
    const tops = mine("channel_topped_up");
    check(tops.length >= 1, `the channel was topped up (${tops.length})`);
    for (const t of tops) txs.push({ what: "channel top-up", hash: String(t.transaction) });
    // More vouchers, so that what the refund owes the seller is above the least an output can hold.
    for (let i = 0; i < 2; i++) {
      const r = await buyPatiently(`autotidy run: one more datum (${i + 1})`);
      check(r.status === 200 && r.paid === true, `another purchase paid (${r.rule ?? r.status})`, r);
    }
  }

  // === e. =========================================================================================
  log("e. the refund, through walletctl");
  const refund = await walletctl(["refund", channelId, `${SELLER}/data`]);
  check(refund.code === 0 && /"settled":true/.test(refund.out), "the refund settled", refund);
  refundTx = JSON.parse(refund.out.trim().split("\n").at(-1)!).transaction as string;
  txs.push({ what: "refund", hash: refundTx });

  log("e. reconciliation");
  const vouchers = mine("voucher_signed");
  const spent = vouchers.reduce((s, e) => s + BigInt(String(e.amount)), 0n);
  const final = (await channels()).find(c => c.channelId === channelId)!;
  check(spent.toString() === final.signed, "the audit's voucher increments add up to what signerd signed", { spent, signed: final.signed });
  let walletNet = 0n;
  let sellerNet = 0n;
  let fees = 0n;
  const feeOf: Record<string, bigint> = {};
  for (const { what, hash } of txs) {
    const utxos = await blockfrost(`/txs/${hash}/utxos`);
    const fee = BigInt((await blockfrost(`/txs/${hash}`)).fees as string);
    walletNet += netFor(utxos, address);
    sellerNet += netFor(utxos, String(final.payTo));
    fees += fee;
    feeOf[what] = (feeOf[what] ?? 0n) + fee;
    note(`${what.padEnd(18)} ${hash}  fee ${ada(fee)}`);
  }
  log(`  ${txs.length} transactions; wallet ${ada(walletNet)}, seller ${ada(sellerNet)}, fees ${ada(fees)} tADA`);
  check(sellerNet === spent, "the seller got exactly what the vouchers signed", { sellerNet, spent });
  check(walletNet === -(spent + fees), "the wallet lost exactly that, and the fees", { walletNet, spent, fees });
  const autoRecord = mine("tidied").find(e => e.auto === true);
  check(autoRecord !== undefined && BigInt(String(autoRecord.fee)) === feeOf["automatic tidy"], `and the one automatic tidy cost ${ada(feeOf["automatic tidy"] ?? 0n)}, as its record says`, autoRecord);
  const lovelaceEnd = lovelaceOf(await listUtxos(address));
  note(`the wallet held ${ada(lovelaceStart)} at the start and ${ada(lovelaceEnd)} now (the listing may still be catching up with the refund)`);
  check(mine("auto_tidy").length === 1, "one automatic tidy in all");
} catch (e) {
  if (!(e instanceof Abort)) check(false, String(e instanceof Error ? e.message : e));
  else if (!problems.includes(e.message)) problems.push(e.message);
} finally {
  clearTimeout(overall);
  await mcp.close().catch(() => {});
}

console.log("\n----");
for (const { what, hash } of txs) console.log(`${what.padEnd(18)} ${hash}`);
if (refundTx === undefined) console.log("(the run did not reach the refund: the channel, if it opened, is still open; walletctl channels)");
console.log(problems.length ? `FAIL: ${problems.length} check(s) failed (${since()}): ${problems.join("; ")}` : `PASS: signerd tidied the wallet by itself once, told the agent to wait, and the books balance to the lovelace (${since()})`);
process.exit(problems.length ? 1 : 0);
