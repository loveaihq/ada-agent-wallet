/**
 * batch-settlement over paid MCP tools, on preprod: an agent calls a seller's MCP tools through the
 * wallet's x402_mcp_call, and each call is paid with a voucher on one channel, at prices one Cardano
 * output could not carry. A real MCP client spawns src/mcp.ts; signerd decides and signs.
 *
 *   1. the seller's tools, listed, and the free one called: nothing paid, nothing opened
 *   2. QUOTES calls of `quote` (0.01 tADA): the first opens the channel (a transaction), the rest are vouchers
 *   3. REPORTS calls of `report` (0.05 tADA), on the same channel. The opening covers 100 quotes, so
 *      a report tops it up, sized as 100 x the price that ran short: 5 tADA, more than the public
 *      test wallet holds. The top-up falls back to what the wallet can fund, keeping back its fee
 *      and an ADA-only UTxO the refund can put up as collateral
 *   4. a `digest` (0.02 tADA) whose answer the seller drops after charging for it, and the retry:
 *      the same voucher, answered with the lost call's answer, and no second charge
 *   5. one purchase of the seller's HTTP /data (0.1 tADA) through x402_fetch: the same channel again
 *   6. the seller claims every voucher in one transaction, into its own wallet. It has to go first:
 *      what it is owed is below what one Cardano output can hold, so a refund could not pay it
 *   7. the refund of the rest, through walletctl, owing the seller nothing
 *   8. the reconciliation, and what the calls cost on chain
 *
 * Needs dev/batchseller.ts, and signerd started with a fresh CHANNELS_DIR and AGENT_TOKENS_FILE, the
 * default BATCH_DEPOSIT_REQUESTS (100), and this agent's policy (amounts as decimal strings):
 *
 *   perTxMax { lovelace: 300000 }, dailyMax { lovelace: 5000000 }, approvalAbove { lovelace: 150000 },
 *   allowedPayees [<the seller's payTo>], allowedResources ["http://127.0.0.1:7411/*", "http://127.0.0.1:7414/*"],
 *   allowedSchemes ["exact", "batch-settlement"], allowedProviderKeys [<the seller's providerKey>],
 *   channelDepositMax { lovelace: 5000000 }, channelLockedMax { lovelace: 10000000 }
 *
 * The run does not wait for Blockfrost's index. Blockfrost lists a transaction's change some 20 s
 * after its block, and the first report comes a few seconds after the opening's. The client
 * (subbit-x402 0.1.2) waits for its own change before it builds: without that, the top-up would see
 * the wallet poorer than it is.
 *
 * Env: SIGNERD_URL, SIGNERD_TOKEN (the operator's), AGENT_TOKEN (the agent's), AGENT_ID, AUDIT_FILE
 * (the ledger checkpoint is read beside it), BLOCKFROST_PROJECT_ID, QUOTES (100), REPORTS (5)
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOP_UP_HEADROOM } from "subbit-x402/x402/client";
import { blockfrostBaseUrl } from "../src/network.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNERD_URL = process.env.SIGNERD_URL ?? "http://127.0.0.1:7402";
const OPERATOR = must("SIGNERD_TOKEN");
const AGENT_TOKEN = must("AGENT_TOKEN");
const AGENT_ID = process.env.AGENT_ID ?? "default";
const AUDIT_FILE = must("AUDIT_FILE");
const PROJECT_ID = must("BLOCKFROST_PROJECT_ID");
const QUOTES = Number(process.env.QUOTES ?? 100);
const REPORTS = Number(process.env.REPORTS ?? 5);
const TOOLS = "http://127.0.0.1:7414/mcp";
const SELLER = "http://127.0.0.1:7411";
const CLAIMS = "http://127.0.0.1:7415/claim";
const BF = blockfrostBaseUrl("cardano:preprod");
const QUOTE = 10_000n;
const REPORT = 50_000n;
const DIGEST = 20_000n;
const DATA = 100_000n;
/** signerd's default BATCH_DEPOSIT_REQUESTS: a deposit covers 100 requests at the price that ran short. */
const DEPOSIT_REQUESTS = 100n;
/** The policy's channelDepositMax: no one deposit goes above it. */
const DEPOSIT_MAX = 5_000_000n;

const operator = { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" };
const signerd = async (path: string, body?: unknown) => {
  const r = await fetch(SIGNERD_URL + path, { method: body ? "POST" : "GET", headers: operator, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (await r.json()) as Record<string, unknown> };
};
const firstSeq = auditRecords().at(-1)?.seq ?? 0;

const mcp = new Client({ name: "mcpbatch", version: "0.1.0" });
await mcp.connect(
  new StdioClientTransport({
    // node itself rather than npx: Windows will not spawn a .cmd without a shell.
    command: process.execPath,
    args: ["--import", "tsx", resolve(HERE, "../src/mcp.ts")],
    env: { ...(process.env as Record<string, string>), SIGNERD_URL, SIGNERD_TOKEN: AGENT_TOKEN, AGENT_ID },
    stderr: "inherit",
  }),
);

type Called = { error?: string; isError?: boolean; paid?: boolean; voucher?: string; transaction?: string; denied?: boolean; rule?: string; status?: number; content?: unknown };
async function tool(name: string, args: Record<string, unknown>): Promise<Called> {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const text = (r.content as Array<{ text?: string }>)[0]?.text ?? "";
  try {
    return { ...(JSON.parse(text) as Called), isError: Boolean(r.isError) };
  } catch {
    return { error: text, isError: Boolean(r.isError) };
  }
}
async function call(name: string, reason: string): Promise<Called> {
  let r = await tool("x402_mcp_call", { server: TOOLS, tool: name, args: {}, reason });
  // A top-up the chain's index does not show yet: signerd says to retry (channel_busy), and an agent would.
  for (let i = 0; i < 3 && r.rule === "channel_busy"; i++) {
    log(`  ${name} answered channel_busy; asking again`);
    await sleep(15_000);
    r = await tool("x402_mcp_call", { server: TOOLS, tool: name, args: {}, reason });
  }
  return r;
}
/** The remote tool's own answer, inside x402_mcp_call's. */
const answer = (r: Called) => JSON.parse((r.content as Array<{ text?: string }>)?.[0]?.text ?? "{}") as Record<string, unknown>;

// ---- 1 ------------------------------------------------------------------------------------------
step("1. the seller's tools, and the free one");
const listed = (await tool("x402_mcp_tools", { server: TOOLS })) as unknown as { tools?: Array<{ name: string }> };
const names = (listed.tools ?? []).map(t => t.name);
expect("the seller offers ping, quote, report and digest", ["ping", "quote", "report", "digest"].every(n => names.includes(n)), listed);
const ping = await call("ping", "mcp batch run: is the seller up");
expect("ping is free: nothing paid", ping.paid === false && !ping.isError && answer(ping).pong === true, ping);
expect("and no channel opened", (await channels()).length === 0, await channels());
const buyer = ((await signerd("/status")).data as { address: string }).address;
const startListing = await utxosOf(buyer);

// ---- 2 ------------------------------------------------------------------------------------------
step(`2. ${QUOTES} quotes at 0.01 tADA: the first opens a channel`);
const times: number[] = [];
for (let i = 1; i <= QUOTES; i++) {
  const t = Date.now();
  const r = await call("quote", `mcp batch run: quote ${i}`);
  times.push(Date.now() - t);
  expect(`quote ${i} paid by voucher`, r.paid === true && typeof r.voucher === "string" && !r.isError && answer(r).symbol === "ADA/USD", r);
  if (i === 1 || i % 10 === 0) log(`  ${i}: ${r.voucher} in ${times.at(-1)} ms`);
}
let channel = (await channels())[0];
expect(`one channel, signed for ${ada(BigInt(QUOTES) * QUOTE)} tADA`, channel?.signed === (BigInt(QUOTES) * QUOTE).toString(), channel);
const channelId = channel.channelId as string;

// ---- 3 ------------------------------------------------------------------------------------------
step(`3. ${REPORTS} reports at 0.05 tADA, on the same channel: past the opening's capacity, a top-up`);
// What the wallet holds with the opening in: the ADA-only UTxOs listed before it, less those it
// spent, plus the change it paid back. Read from the transaction, which Blockfrost has as soon as
// the block, not from the wallet's listing, which shows the change some 20 s later.
const openingTx = lastTransaction();
const opening = (await blockfrost(`/txs/${openingTx}/utxos`)) as unknown as { inputs: Io[]; outputs: Io[] };
const adaOnlyOf = (xs: Io[]) => xs.filter(x => x.address === buyer && !x.collateral && !x.reference && x.amount.length === 1).reduce((s, x) => s + BigInt(x.amount[0].quantity), 0n);
const visible = adaOnlyTotal(startListing) - adaOnlyOf(opening.inputs) + adaOnlyOf(opening.outputs);
const listedYet = (await utxosOf(buyer)).some(u => u.tx_hash === openingTx);
log(`  the index ${listedYet ? "already lists" : "does not list yet"} the opening's change${listedYet ? "" : ": the client has to wait for it"}`);
// The opening covers DEPOSIT_REQUESTS quotes; the first report past that is short by what it overshoots.
const capacity = QUOTE * DEPOSIT_REQUESTS;
let used = BigInt(QUOTES) * QUOTE;
let short = 0n;
for (let i = 1; i <= REPORTS && short === 0n; i++) if ((used += REPORT) > capacity) short = used - capacity;
const want = REPORT * DEPOSIT_REQUESTS < DEPOSIT_MAX ? REPORT * DEPOSIT_REQUESTS : DEPOSIT_MAX;
const fundable = visible - TOP_UP_HEADROOM;
log(`  the wallet holds ${ada(visible)} tADA in ADA-only UTxOs; a top-up asks for ${ada(want)}`);
let lastN = 0;
for (let i = 1; i <= REPORTS; i++) {
  const t = Date.now();
  const r = await call("report", `mcp batch run: report ${i}`);
  if (i === 1) log(`  report 1 took ${Math.round((Date.now() - t) / 1000)} s`);
  expect(`report ${i} paid by voucher on the channel`, r.paid === true && r.voucher?.startsWith(`${channelId}:`) === true && !r.isError, r);
  lastN = answer(r).n as number;
}
const topUps = auditRecords().filter(e => e.seq > firstSeq && e.event === "channel_topped_up");
if (short > 0n) {
  expect("one top-up, of the same channel", topUps.length === 1 && topUps[0].channelId === channelId, topUps);
  const deposit = BigInt(topUps[0].deposit as string);
  // Largest first: the whole top-up, then what the wallet can fund beside the fee and the refund's
  // collateral, then only the shortfall.
  const fallback = fundable > short ? fundable : short;
  // The whole top-up needs its fee and a change output of at least min-UTxO besides (over 1.15
  // tADA together); short of that the SDK finds no valid change for it.
  if (visible < want + 1_150_000n) expect(`the wallet cannot put up ${ada(want)} tADA with its fee and change, so it tops up ${ada(fallback)}: what it can`, deposit === fallback, { deposit, want, visible, fundable, short });
  else if (visible >= want + TOP_UP_HEADROOM) expect(`a top-up of the whole ${ada(want)} tADA`, deposit === want, { deposit, want, visible });
  else expect(`a top-up of ${ada(want)} tADA, or ${ada(fallback)} if that left too little for collateral`, deposit === want || deposit === fallback, { deposit, want, visible, fallback });
  log(`  topped up ${ada(deposit)} tADA in ${topUps[0].transaction}`);
} else expect("no top-up: the opening covers every report", topUps.length === 0, topUps);

// ---- 4 ------------------------------------------------------------------------------------------
step("4. a digest whose answer is lost after the seller charged for it, and the retry");
const signedNow = async () => BigInt((await channels()).find(c => c.channelId === channelId)!.signed as string);
const beforeLost = await signedNow();
const lost = await tool("x402_mcp_call", { server: TOOLS, tool: "digest", args: {}, reason: "mcp batch run: a digest whose answer is lost" });
expect("the first digest fails in transit", lost.isError === true && !lost.denied, lost);
const lostAt = await signedNow();
expect("after its voucher went out", lostAt === beforeLost + DIGEST, { beforeLost, lostAt });
const asked = Date.now();
const retried = await call("digest", "mcp batch run: the same digest, asked again");
expect("the retry is served, on the lost call's voucher", retried.paid === true && !retried.isError && retried.voucher === `${channelId}:${lostAt}`, retried);
const digest = answer(retried);
expect("with the answer the seller gave the lost call: the tool did not run again", digest.kind === "digest" && digest.n === lastN + 1 && Date.parse(digest.at as string) < asked, digest);
expect("the retry signed nothing new", (await signedNow()) === lostAt, { lostAt });
expect("and was audited as a re-sign", auditRecords().some(e => e.seq > firstSeq && e.event === "voucher_resigned"), {});

// ---- 5 ------------------------------------------------------------------------------------------
step("5. the same seller's HTTP /data, through x402_fetch");
const web = await tool("x402_fetch", { url: `${SELLER}/data`, reason: "mcp batch run: one datum over HTTP" });
expect("paid by voucher on the same channel", web.status === 200 && web.paid === true && web.voucher?.startsWith(`${channelId}:`) === true, web);
const expected = BigInt(QUOTES) * QUOTE + BigInt(REPORTS) * REPORT + DIGEST + DATA;
channel = (await channels()).find(c => c.channelId === channelId)!;
expect("still one channel", (await channels()).length === 1, await channels());
expect(`signed for ${ada(expected)} tADA in all`, channel.signed === expected.toString(), channel);

// ---- 6 ------------------------------------------------------------------------------------------
step("6. the seller claims every voucher, in one transaction");
const claimed = (await (await fetch(CLAIMS, { method: "POST" })).json()) as Array<{ transaction: string; channels: Array<{ channelId: string; totalClaimed: string }> }>;
expect("one claim transaction, redeeming this channel in full", claimed.length === 1 && claimed[0].channels.some(c => c.channelId === channelId && c.totalClaimed === expected.toString()), claimed);
const claimTx = claimed[0].transaction;

// ---- 7 ------------------------------------------------------------------------------------------
step("7. the refund of the rest, through walletctl");
// Its collateral is the ADA-only UTxO the top-up left, which the client waits to see listed.
let refund = await walletctl(["refund", channelId, `${SELLER}/data`]);
// Blockfrost's index trails the claim's block by ~20 s; until it catches up, signerd still sees the
// vouchers as owed and refuses a refund that would have to pay them.
for (let i = 0; i < 3 && /must claim it first/.test(refund.err); i++) {
  log("  signerd does not see the claim yet; asking again");
  await sleep(15_000);
  refund = await walletctl(["refund", channelId, `${SELLER}/data`]);
}
expect("the refund settled", refund.code === 0 && /"settled":true/.test(refund.out), refund);
const refundTx = JSON.parse(refund.out.trim().split("\n").at(-1)!).transaction as string;

// ---- 8 ------------------------------------------------------------------------------------------
step("8. reconciliation");
const all = auditRecords().filter(e => e.seq > firstSeq);
const vouchers = all.filter(e => e.event === "voucher_signed");
const spent = vouchers.reduce((s, e) => s + BigInt(e.amount as string), 0n);
const final = (await channels()).find(c => c.channelId === channelId)!;
expect("the audit's voucher increments add up to what signerd signed", spent.toString() === final.signed, { spent, signed: final.signed });
// The digest's retry re-signed the lost call's voucher, so it is one of them, not two.
expect("one voucher per paid call", vouchers.length === QUOTES + REPORTS + 2, { vouchers: vouchers.length });
const ledger = JSON.parse(readFileSync(resolve(dirname(AUDIT_FILE), "ledger.json"), "utf8")) as { spends: Array<{ amount: string; voucher?: boolean; agentId: string }> };
const onLedger = ledger.spends.filter(s => s.voucher && s.agentId === AGENT_ID).reduce((s, x) => s + BigInt(x.amount), 0n);
expect("and so does the ledger the caps are computed from", onLedger === spent, { onLedger, spent });

// The buyer pays for the opening, any top-up and the refund; the seller for its claim.
const buyerTxs = [...all.filter(e => e.event === "channel_opened" || e.event === "channel_topped_up").map(e => e.transaction as string), refundTx];
let walletNet = 0n;
let sellerNet = 0n;
let buyerFees = 0n;
let sellerFees = 0n;
for (const hash of [...buyerTxs, claimTx]) {
  const utxos = await blockfrost(`/txs/${hash}/utxos`);
  walletNet += netFor(utxos, buyer);
  sellerNet += netFor(utxos, final.payTo as string);
  const fee = BigInt((await blockfrost(`/txs/${hash}`)).fees as string);
  if (hash === claimTx) sellerFees += fee;
  else buyerFees += fee;
}
expect("the seller gained exactly what the vouchers signed, less its claim's fee", sellerNet === spent - sellerFees, { sellerNet, spent, sellerFees });
expect("the wallet lost exactly that and its own fees", walletNet === -(spent + buyerFees), { walletNet, spent, buyerFees });

const calls = QUOTES + REPORTS + 2;
const fees = buyerFees + sellerFees;
const later = [...times.slice(1)].sort((a, b) => a - b);
log(`  ${calls} paid calls (${QUOTES} quote, ${REPORTS} report and 1 digest, answered twice, over MCP; 1 /data over HTTP), ${ada(spent)} tADA to the seller`);
log(`  ${buyerTxs.length + 1} transactions on chain, ${ada(fees)} tADA in fees (buyer ${ada(buyerFees)}, seller ${ada(sellerFees)}), ${ada(fees / BigInt(calls))} per call`);
log(`  opened ${buyerTxs[0]}, ${buyerTxs.length > 2 ? `topped up ${buyerTxs.slice(1, -1).join(", ")}, ` : ""}claimed ${claimTx}, refunded ${refundTx}`);
log(`  the first quote, which opened the channel, took ${times[0]} ms; the others ${later[0]}-${later.at(-1)} ms, median ${later[Math.floor(later.length / 2)]} ms`);

await mcp.close();
log("all checks passed");

// ---- helpers ------------------------------------------------------------------------------------

/** This agent's channels in signerd's index; the run starts from an empty one. */
async function channels(): Promise<Array<Record<string, unknown>>> {
  return ((await signerd("/channels")).data.channels as Array<Record<string, unknown>>).filter(c => c.agentId === AGENT_ID);
}

function auditRecords(): Array<Record<string, unknown> & { seq: number; event: string }> {
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

type Utxo = { tx_hash: string; output_index: number; amount: Array<{ unit: string; quantity: string }> };
/** A transaction's input or output, as Blockfrost's `/txs/{hash}/utxos` gives it. */
type Io = Utxo & { address: string; collateral?: boolean; reference?: boolean };

/** An address's UTxOs as Blockfrost lists them, which is what the client builds from. */
async function utxosOf(address: string): Promise<Utxo[]> {
  const out: Utxo[] = [];
  for (let page = 1; ; page++) {
    const r = await fetch(`${BF}/addresses/${address}/utxos?page=${page}`, { headers: { project_id: PROJECT_ID } });
    if (r.status === 404) return out;
    if (!r.ok) throw new Error(`Blockfrost /addresses/…/utxos: ${r.status}`);
    const xs = (await r.json()) as Utxo[];
    out.push(...xs);
    if (xs.length < 100) return out;
  }
}

function adaOnlyTotal(xs: Utxo[]): bigint {
  return xs.filter(u => u.amount.length === 1).reduce((s, u) => s + BigInt(u.amount[0].quantity), 0n);
}

/** The run's latest transaction of the wallet's own: its opening, or a top-up. */
function lastTransaction(): string {
  return auditRecords()
    .filter(e => e.seq > firstSeq && (e.event === "channel_opened" || e.event === "channel_topped_up"))
    .at(-1)!.transaction as string;
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
    console.error(`mcpbatch: ${name} is required`);
    process.exit(1);
  }
  return v;
}

function ada(l: bigint): string {
  const v = l < 0n ? -l : l;
  return `${l < 0n ? "-" : ""}${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
}
function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}
function step(s: string) {
  log(s);
}
function log(s: string) {
  console.log(`[mcpbatch ${new Date().toISOString().slice(11, 19)}] ${s}`);
}
