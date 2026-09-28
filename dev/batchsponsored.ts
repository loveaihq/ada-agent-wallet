/**
 * A token channel the seller pays for, through the wallet, on preprod (subbit-x402's SPONSORSHIP.md):
 *
 *   1. the wallet holds tUSDM and the ADA that came with it, and no ADA-only UTxO
 *   2. 25 purchases of /token at 0.001 tUSDM: the first opens a tUSDM channel on the seller's
 *      fee-sponsor offer; with BATCH_DEPOSIT_REQUESTS=10 the 11th and the 21st top it up, each on
 *      another offer. signerd records the channel's reserve as the seller's
 *   3. the seller claims the vouchers
 *   4. `walletctl refund`: the seller's offer is the collateral, and the channel's ADA goes back to
 *      the seller
 *   5. reconciled on chain: the wallet's ADA unchanged to the lovelace and its tUSDM down exactly
 *      the vouchers; the seller's ADA, across payTo and its sponsor key, down exactly the fees
 *
 * A run that stops part way resumes: it keeps the wallet's starting holdings beside AUDIT_FILE and
 * carries on with the purchases the channel has not had yet.
 *
 * BATCHSPONSORED_PHASE splits it for a signerd that loses its records between the claim and the
 * refund: `pay` stops after the claim; `recover` starts with `walletctl recover`, expects the
 * channel back with its reserve the seller's, and goes on to the refund. Without it, all at once.
 *
 * Needs the seller (dev/batchseller.ts with BATCH_SELLER_SPONSOR_ACCOUNT) and signerd with
 * BATCH_DEPOSIT_REQUESTS=10 and a policy that allows batch-settlement in tUSDM and has no lovelace
 * entry at all: a sponsored channel locks none of the wallet's ADA. Env: SIGNERD_URL,
 * SIGNERD_TOKEN (the operator's), AGENT_TOKEN, AGENT_ID, AUDIT_FILE, BLOCKFROST_PROJECT_ID,
 * SPONSOR_ADDRESS (the seller's sponsor key's address, which the seller prints)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { blockfrostBaseUrl } from "../src/network.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNERD_URL = process.env.SIGNERD_URL ?? "http://127.0.0.1:7402";
const OPERATOR = must("SIGNERD_TOKEN");
const AGENT_TOKEN = must("AGENT_TOKEN");
const AGENT_ID = process.env.AGENT_ID ?? "default";
const AUDIT_FILE = must("AUDIT_FILE");
const PROJECT_ID = must("BLOCKFROST_PROJECT_ID");
const SPONSOR = must("SPONSOR_ADDRESS");
const SELLER = "http://127.0.0.1:7411";
const BF = blockfrostBaseUrl("cardano:preprod");
/** tUSDM as Blockfrost names units: policy and asset name run together. */
const TUSDM_UNIT = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9" + "0014df10745553444d";
const PURCHASES = 25;
const STATE = resolve(dirname(AUDIT_FILE), "batchsponsored.json");
const PHASE = process.env.BATCHSPONSORED_PHASE ?? "all";
if (!["all", "pay", "recover"].includes(PHASE)) {
  console.error("batchsponsored: BATCHSPONSORED_PHASE is all, pay or recover");
  process.exit(1);
}

// ---- 1 ------------------------------------------------------------------------------------------
log("1. a wallet that holds only tUSDM and the ADA that came with it");
const status = (await signerd("/status")).data as { address: string };
// The holdings before the channel: measured on the first run, kept for a resumed one.
const kept = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as Record<string, string | number>) : undefined;
const before = kept ? { utxos: Number(kept.utxos), lovelace: BigInt(kept.lovelace!), tusdm: BigInt(kept.tusdm!), adaOnly: Number(kept.adaOnly) } : await holdings(status.address);
if (!kept) writeFileSync(STATE, JSON.stringify({ ...before, lovelace: before.lovelace.toString(), tusdm: before.tusdm.toString() }));
const keep = (k: string, v: string) => writeFileSync(STATE, JSON.stringify({ ...(JSON.parse(readFileSync(STATE, "utf8")) as object), [k]: v }));
log(`  ${status.address}: ${before.utxos} UTxO(s), ${ada(before.lovelace)} tADA, ${units(before.tusdm)} tUSDM, ${before.adaOnly} ADA-only${kept ? " (kept from the first run)" : ""}`);
expect("the wallet holds tUSDM and no ADA-only UTxO", before.tusdm > 0n && before.adaOnly === 0, before);

let claimTx = (kept?.claimTx as string | undefined) ?? "";
if (PHASE !== "recover") {
// ---- 2 ------------------------------------------------------------------------------------------
log(`2. ${PURCHASES} purchases of /token: an opening and two top-ups, each on an offer of the seller's`);
const mcp = new Client({ name: "batchsponsored", version: "0.1.0" });
await mcp.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve(HERE, "../src/mcp.ts")],
    env: { ...(process.env as Record<string, string>), SIGNERD_URL, SIGNERD_TOKEN: AGENT_TOKEN, AGENT_ID },
    stderr: "inherit",
  }),
);
// A resumed run carries on the open channel from its last voucher.
const open = (await channels()).find(c => c.status === "open");
const done = open ? audit().filter(e => e.event === "voucher_signed" && e.channelId === open.channelId).length : 0;
if (done) log(`  resuming after purchase ${done} on channel ${String(open!.channelId).slice(0, 16)}…`);
for (let i = done + 1; i <= PURCHASES; i++) {
  const t = Date.now();
  const r = await mcp.callTool({ name: "x402_fetch", arguments: { url: `${SELLER}/token`, reason: `sponsored run: datum ${i}` } }, undefined, { timeout: 600_000 });
  const out = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { status?: number; paid?: boolean; voucher?: string };
  if (out.status !== 200 || out.paid !== true) expect(`purchase ${i} paid`, false, out);
  if (i === 1 || i % 10 === 1 || i === PURCHASES) log(`  purchase ${i} paid in ${Date.now() - t} ms`);
}
await mcp.close();
const ch = (await channels()).find(c => c.status === "open");
expect("one open tUSDM channel, signed for 0.025 tUSDM, its reserve the seller's", ch?.signed === "25000" && ch.reserveFrom === "seller", ch);
const channelId = ch!.channelId as string;
keep("payTo", ch!.payTo as string);
const steps = audit().filter(e => e.channelId === channelId && (e.event === "channel_opened" || e.event === "channel_topped_up"));
expect(
  "an opening and two top-ups, each on a different offer of the seller's",
  steps.length === 3 && steps[0]!.event === "channel_opened" && steps.every(e => typeof e.sponsoredBy === "string") && new Set(steps.map(e => e.sponsoredBy)).size === 3,
  steps,
);
expect("nothing refused or mismatched on the way", !audit().some(e => e.event === "denied" || e.event === "transaction_mismatch"), audit().filter(e => e.event === "denied" || e.event === "transaction_mismatch"));
const failed = audit().filter(e => e.event === "batch_error");
if (failed.length) log(`  earlier failures, before this run resumed: ${failed.map(e => `${e.reason}: ${e.error}`).join("; ")}`);

// ---- 3 ------------------------------------------------------------------------------------------
log("3. the seller claims");
const claims = (await (await fetch("http://127.0.0.1:7415/claim", { method: "POST" })).json()) as Array<{ transaction: string; channels: Array<{ channelId: string; taken: string }> }>;
expect("one claim, taking this channel's 0.025 tUSDM", claims.length === 1 && claims[0]!.channels.some(c => c.channelId === channelId && c.taken === "25000"), claims);
claimTx = claims[0]!.transaction;
keep("claimTx", claimTx);
await blockfrost(`/txs/${claimTx}`);
if (PHASE === "pay") {
  log("stopping after the claim, as BATCHSPONSORED_PHASE=pay asks");
  process.exit(0);
}
// Blockfrost's index trails a block; a refund built on the channel's position before the claim fails.
await sleep(25_000);
}

if (PHASE === "recover") {
  log("3b. walletctl recover: the channel back from the chain, its reserve the seller's");
  const found = await walletctl(["recover", AGENT_ID]);
  expect("walletctl recover", found.code === 0, found);
  expect("recover indexed the channel again", /"indexed":\s*1/.test(found.out), found.out);
}
const ch = (await channels()).find(c => c.status === "open");
expect("the open channel's record says its reserve is the seller's", ch?.reserveFrom === "seller", ch);
const channelId = ch!.channelId as string;
const steps = audit().filter(e => e.channelId === channelId && (e.event === "channel_opened" || e.event === "channel_topped_up"));

// ---- 4 ------------------------------------------------------------------------------------------
log("4. walletctl refund: the seller's offer is its collateral, and the channel's ADA goes back to the seller");
let refunded = await walletctl(["refund", channelId, `${SELLER}/token`]);
if (refunded.code !== 0) {
  log(`  the first refund failed (${refunded.out.slice(0, 200).replace(/\s+/g, " ")}), trying once more`);
  await sleep(20_000);
  refunded = await walletctl(["refund", channelId, `${SELLER}/token`]);
}
expect("walletctl refund", refunded.code === 0, refunded);
const refundTx = (JSON.parse(refunded.out.trim().split("\n").at(-1)!) as { transaction: string }).transaction;
expect("signerd signed it as a sponsored refund", audit().some(e => e.event === "refund_signed" && e.channelId === channelId && typeof e.sponsoredBy === "string"), {});

// ---- 5 ------------------------------------------------------------------------------------------
log("5. reconciliation");
await blockfrost(`/txs/${refundTx}`);
await sleep(25_000);
// A record found again by recover has no payTo until a 402 binds it; the paying phase kept it.
const payTo = (kept?.payTo as string | undefined) ?? (ch!.payTo as string);
const spent = audit()
  .filter(e => e.event === "voucher_signed" && e.channelId === channelId)
  .reduce((s, e) => s + BigInt(e.amount as string), 0n);
const net = { wallet: { ada: 0n, tusdm: 0n }, seller: { ada: 0n, tusdm: 0n } };
let fees = 0n;
const txs: Array<[string, string]> = [["open", steps[0]!.transaction as string], ["top-up", steps[1]!.transaction as string], ["top-up", steps[2]!.transaction as string], ["claim", claimTx], ["refund", refundTx]];
for (const [name, hash] of txs) {
  const io = await blockfrost(`/txs/${hash}/utxos`);
  const tx = await blockfrost(`/txs/${hash}`);
  net.wallet.ada += netFor(io, status.address, "lovelace");
  net.wallet.tusdm += netFor(io, status.address, TUSDM_UNIT);
  for (const a of [payTo, SPONSOR]) {
    net.seller.ada += netFor(io, a, "lovelace");
    net.seller.tusdm += netFor(io, a, TUSDM_UNIT);
  }
  fees += BigInt(tx.fees as string);
  log(`  ${name.padEnd(7)} ${hash}  block ${tx.block_height}  ${tx.size} B  fee ${ada(BigInt(tx.fees as string))}`);
}
const after = await holdings(status.address);
log(`  wallet ${ada(net.wallet.ada)} tADA ${units(net.wallet.tusdm)} tUSDM; seller (payTo and sponsor key) ${ada(net.seller.ada)} tADA ${units(net.seller.tusdm)} tUSDM; fees ${ada(fees)}; vouchers ${units(spent)} tUSDM`);
expect("the wallet's ADA did not move, to the lovelace", net.wallet.ada === 0n && after.lovelace === before.lovelace, { net, before, after });
expect("the wallet gave exactly what the vouchers signed, in tUSDM", net.wallet.tusdm === -spent && after.tusdm === before.tusdm - spent, { net, spent });
expect("the seller got exactly that", net.seller.tusdm === spent, { net, spent });
expect("the seller's ADA is down exactly the five fees: its reserve came back", net.seller.ada === -fees, { net, fees });
expect("the wallet still holds no ADA-only UTxO", after.adaOnly === 0, after);
log("all checks passed");

// ---- helpers ------------------------------------------------------------------------------------

async function signerd(path: string, body?: unknown) {
  const r = await fetch(SIGNERD_URL + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: (await r.json()) as Record<string, unknown> };
}

async function channels(): Promise<Array<Record<string, unknown>>> {
  return ((await signerd("/channels")).data.channels as Array<Record<string, unknown>>).filter(c => c.agentId === AGENT_ID);
}

function audit(): Array<Record<string, unknown>> {
  return readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
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
    if (r.status !== 404 || attempt >= 40) throw new Error(`Blockfrost ${path}: ${r.status}`);
    await sleep(3000);
  }
}

/** An address's UTxOs as Blockfrost lists them: their lovelace and tUSDM, and how many hold ADA alone. */
async function holdings(address: string) {
  let lovelace = 0n;
  let tusdm = 0n;
  let utxos = 0;
  let adaOnly = 0;
  for (let page = 1; ; page++) {
    const r = await fetch(`${BF}/addresses/${address}/utxos?page=${page}`, { headers: { project_id: PROJECT_ID } });
    // An address that has never held anything is a 404.
    const rows = r.status === 404 ? [] : ((await r.json()) as Array<{ amount: Array<{ unit: string; quantity: string }> }>);
    for (const u of rows) {
      utxos++;
      if (u.amount.length === 1) adaOnly++;
      for (const a of u.amount) {
        if (a.unit === "lovelace") lovelace += BigInt(a.quantity);
        else if (a.unit === TUSDM_UNIT) tusdm += BigInt(a.quantity);
      }
    }
    if (rows.length < 100) break;
  }
  return { utxos, lovelace, tusdm, adaOnly };
}

/** What a transaction moved to or from an address in one unit: outputs less inputs, collateral and reference inputs aside. */
function netFor(io: Record<string, unknown>, address: string, unit: string): bigint {
  type Io = { address: string; amount: Array<{ unit: string; quantity: string }>; collateral?: boolean; reference?: boolean };
  const sum = (xs: Io[]) => xs.filter(x => x.address === address && !x.collateral && !x.reference).reduce((s, x) => s + BigInt(x.amount.find(a => a.unit === unit)?.quantity ?? "0"), 0n);
  return sum(io.outputs as Io[]) - sum(io.inputs as Io[]);
}

function expect(what: string, ok: boolean, detail: unknown) {
  if (!ok) {
    console.error(`FAILED: ${what}\n${JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}`);
    process.exit(1);
  }
  log(`  ok  ${what}`);
}

function must(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`batchsponsored: ${name} is required`);
    process.exit(1);
  }
  return v;
}

function ada(l: bigint): string {
  const v = l < 0n ? -l : l;
  return `${l < 0n ? "-" : ""}${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
}
function units(l: bigint): string {
  return ada(l);
}
function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}
function log(s: string) {
  console.log(`[batchsponsored ${new Date().toISOString().slice(11, 19)}] ${s}`);
}
