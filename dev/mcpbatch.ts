/**
 * batch-settlement over paid MCP tools, on preprod: an agent calls a seller's MCP tools through the
 * wallet's x402_mcp_call, and each call is paid with a voucher on one channel, at prices one Cardano
 * output could not carry. A real MCP client spawns src/mcp.ts; signerd decides and signs.
 *
 *   1. the seller's tools, listed, and the free one called: nothing paid, nothing opened
 *   2. QUOTES calls of `quote` (0.01 tADA): the first opens the channel (a transaction), the rest are vouchers
 *   3. REPORTS calls of `report` (0.05 tADA), on the same channel
 *   4. one purchase of the seller's HTTP /data (0.1 tADA) through x402_fetch: the same channel again
 *   5. the seller claims every voucher in one transaction, into its own wallet. It has to go first:
 *      what it is owed is below what one Cardano output can hold, so a refund could not pay it
 *   6. the refund of the rest, through walletctl, owing the seller nothing
 *   7. the reconciliation, and what the calls cost on chain
 *
 * Needs dev/batchseller.ts, and signerd started with a fresh CHANNELS_DIR and AGENT_TOKENS_FILE and
 * this agent's policy (amounts as decimal strings):
 *
 *   perTxMax { lovelace: 300000 }, dailyMax { lovelace: 5000000 }, approvalAbove { lovelace: 150000 },
 *   allowedPayees [<the seller's payTo>], allowedResources ["http://127.0.0.1:7411/*", "http://127.0.0.1:7414/*"],
 *   allowedSchemes ["exact", "batch-settlement"], allowedProviderKeys [<the seller's providerKey>],
 *   channelDepositMax { lovelace: 5000000 }, channelLockedMax { lovelace: 10000000 }
 *
 * and BATCH_DEPOSIT_REQUESTS=135, so that the opening covers the default run (1.35 tADA) and no
 * top-up is needed. A top-up is sized as requests x the price that ran short: the first report
 * would ask for 100 x 0.05 tADA at once, more than the public test wallet can put up beside its
 * collateral. dev/batch.ts is the run that exercises top-ups.
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
const DATA = 100_000n;

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
expect("the seller offers ping, quote and report", ["ping", "quote", "report"].every(n => names.includes(n)), listed);
const ping = await call("ping", "mcp batch run: is the seller up");
expect("ping is free: nothing paid", ping.paid === false && !ping.isError && answer(ping).pong === true, ping);
expect("and no channel opened", (await channels()).length === 0, await channels());

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
step(`3. ${REPORTS} reports at 0.05 tADA, on the same channel`);
for (let i = 1; i <= REPORTS; i++) {
  const r = await call("report", `mcp batch run: report ${i}`);
  expect(`report ${i} paid by voucher on the channel`, r.paid === true && r.voucher?.startsWith(`${channelId}:`) === true && !r.isError, r);
}

// ---- 4 ------------------------------------------------------------------------------------------
step("4. the same seller's HTTP /data, through x402_fetch");
const web = await tool("x402_fetch", { url: `${SELLER}/data`, reason: "mcp batch run: one datum over HTTP" });
expect("paid by voucher on the same channel", web.status === 200 && web.paid === true && web.voucher?.startsWith(`${channelId}:`) === true, web);
const expected = BigInt(QUOTES) * QUOTE + BigInt(REPORTS) * REPORT + DATA;
channel = (await channels()).find(c => c.channelId === channelId)!;
expect("still one channel", (await channels()).length === 1, await channels());
expect(`signed for ${ada(expected)} tADA in all`, channel.signed === expected.toString(), channel);

// ---- 5 ------------------------------------------------------------------------------------------
step("5. the seller claims every voucher, in one transaction");
const claimed = (await (await fetch(CLAIMS, { method: "POST" })).json()) as Array<{ transaction: string; channels: Array<{ channelId: string; totalClaimed: string }> }>;
expect("one claim transaction, redeeming this channel in full", claimed.length === 1 && claimed[0].channels.some(c => c.channelId === channelId && c.totalClaimed === expected.toString()), claimed);
const claimTx = claimed[0].transaction;

// ---- 6 ------------------------------------------------------------------------------------------
step("6. the refund of the rest, through walletctl");
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

// ---- 7 ------------------------------------------------------------------------------------------
step("7. reconciliation");
const all = auditRecords().filter(e => e.seq > firstSeq);
const vouchers = all.filter(e => e.event === "voucher_signed");
const spent = vouchers.reduce((s, e) => s + BigInt(e.amount as string), 0n);
const final = (await channels()).find(c => c.channelId === channelId)!;
expect("the audit's voucher increments add up to what signerd signed", spent.toString() === final.signed, { spent, signed: final.signed });
expect("one voucher per paid call", vouchers.length === QUOTES + REPORTS + 1, { vouchers: vouchers.length });
const ledger = JSON.parse(readFileSync(resolve(dirname(AUDIT_FILE), "ledger.json"), "utf8")) as { spends: Array<{ amount: string; voucher?: boolean; agentId: string }> };
const onLedger = ledger.spends.filter(s => s.voucher && s.agentId === AGENT_ID).reduce((s, x) => s + BigInt(x.amount), 0n);
expect("and so does the ledger the caps are computed from", onLedger === spent, { onLedger, spent });

// The buyer pays for the opening, any top-up and the refund; the seller for its claim.
const status = (await signerd("/status")).data as { address: string };
const buyerTxs = [...all.filter(e => e.event === "channel_opened" || e.event === "channel_topped_up").map(e => e.transaction as string), refundTx];
let walletNet = 0n;
let sellerNet = 0n;
let buyerFees = 0n;
let sellerFees = 0n;
for (const hash of [...buyerTxs, claimTx]) {
  const utxos = await blockfrost(`/txs/${hash}/utxos`);
  walletNet += netFor(utxos, status.address);
  sellerNet += netFor(utxos, final.payTo as string);
  const fee = BigInt((await blockfrost(`/txs/${hash}`)).fees as string);
  if (hash === claimTx) sellerFees += fee;
  else buyerFees += fee;
}
expect("the seller gained exactly what the vouchers signed, less its claim's fee", sellerNet === spent - sellerFees, { sellerNet, spent, sellerFees });
expect("the wallet lost exactly that and its own fees", walletNet === -(spent + buyerFees), { walletNet, spent, buyerFees });

const calls = QUOTES + REPORTS + 1;
const fees = buyerFees + sellerFees;
const later = [...times.slice(1)].sort((a, b) => a - b);
log(`  ${calls} paid calls (${QUOTES} quote and ${REPORTS} report over MCP, 1 /data over HTTP), ${ada(spent)} tADA to the seller`);
log(`  ${buyerTxs.length + 1} transactions on chain, ${ada(fees)} tADA in fees (buyer ${ada(buyerFees)}, seller ${ada(sellerFees)}), ${ada(fees / BigInt(calls))} per call`);
log(`  opened ${buyerTxs[0]}, claimed ${claimTx}, refunded ${refundTx}`);
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
