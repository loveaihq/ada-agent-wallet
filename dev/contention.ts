/**
 * One wallet, two builders, on preprod: an `exact` payment and a channel transaction never go out
 * spending the same UTxO while the first is unsettled. signerd keeps one set of every input it has
 * handed out; the channel client leaves those out of its coin selection, and an `exact` payment
 * that would spend one is refused as utxo_busy. A real MCP client spawns src/mcp.ts.
 *
 *   1. An `exact` purchase first (x402_fetch /quote on dev/resource.ts, 1.5 tADA). It is built on
 *      the wallet's first-listed UTxO, and while it is in flight a channel is asked to open
 *      (x402_mcp_call quote, 0.01 tADA). The opening would seed from the largest ADA-only UTxO,
 *      which is the purchase's; without it the wallet cannot fund the opening, so it is refused as
 *      insufficient_funds. Once the purchase is on chain the opening goes through.
 *   2. A channel transaction first: a purchase of /data (0.1 tADA) past the opening's capacity
 *      tops the channel up. While the top-up is in flight, an `exact` purchase is built on the
 *      wallet's first-listed UTxO, which holds tokens and only their min-UTxO of ADA, so the SDK
 *      adds the largest ADA-only UTxO: the top-up's. signerd refuses it as utxo_busy. Once the
 *      top-up is on chain and the wallet no longer lists that UTxO, the purchase goes through.
 *   3. Every transaction handed out landed, and no two of them spend the same input.
 *
 * Needs dev/batchseller.ts; dev/facilitator.ts and dev/resource.ts with SELLER_ADDRESS set to the
 * batch seller's payTo; and signerd with a fresh CHANNELS_DIR, BATCH_DEPOSIT_REQUESTS=10 (an opening
 * at 0.01 covers 0.1 tADA, so the 0.1 /data needs a top-up) and this agent's policy (amounts as
 * decimal strings):
 *
 *   perTxMax { lovelace: 2000000 }, dailyMax { lovelace: 5000000 }, approvalAbove { lovelace: 2000000 },
 *   allowedPayees [<the seller's payTo>], allowedSchemes ["exact", "batch-settlement"],
 *   allowedResources ["http://127.0.0.1:7401/*", "http://127.0.0.1:7411/*", "http://127.0.0.1:7414/*"],
 *   allowedProviderKeys [<the seller's providerKey>], channelDepositMax { lovelace: 5000000 },
 *   channelLockedMax { lovelace: 10000000 }
 *
 * The wallet must start with no channel and three UTxOs in this listed order: B, ADA-only, at
 * least 3.5 tADA; T, its tokens with just their min-UTxO of ADA; C, ADA-only and under the
 * opening's 3 tADA. A self-transfer lays them out; the run leaves the channel open, and the ADA it
 * leaves sits with the tokens (an `exact` payment's change keeps them together), so a
 * consolidation, the seller's claim and a refund come after it.
 *
 * Env: SIGNERD_URL, SIGNERD_TOKEN (the operator's), AGENT_TOKEN (the agent's), AGENT_ID, AUDIT_FILE,
 * BLOCKFROST_PROJECT_ID
 */
import { readFileSync } from "node:fs";
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
const TOOLS = "http://127.0.0.1:7414/mcp";
const SELLER = "http://127.0.0.1:7411";
const EXACT = "http://127.0.0.1:7401";
const BF = blockfrostBaseUrl("cardano:preprod");

const operator = { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" };
const signerd = async (path: string) => {
  const r = await fetch(SIGNERD_URL + path, { headers: operator });
  return (await r.json()) as Record<string, unknown>;
};
const firstSeq = auditRecords().at(-1)?.seq ?? 0;

const mcp = new Client({ name: "contention", version: "0.1.0" });
await mcp.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve(HERE, "../src/mcp.ts")],
    env: { ...(process.env as Record<string, string>), SIGNERD_URL, SIGNERD_TOKEN: AGENT_TOKEN, AGENT_ID },
    stderr: "inherit",
  }),
);

type Called = { error?: string; isError?: boolean; paid?: boolean; voucher?: string; transaction?: string; denied?: boolean; rule?: string; detail?: string; status?: number };
async function tool(name: string, args: Record<string, unknown>): Promise<Called> {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const text = (r.content as Array<{ text?: string }>)[0]?.text ?? "";
  try {
    return { ...(JSON.parse(text) as Called), isError: Boolean(r.isError) };
  } catch {
    return { error: text, isError: Boolean(r.isError) };
  }
}
const buyExact = (reason: string) => tool("x402_fetch", { url: `${EXACT}/quote`, reason });
/** Asked again while signerd says to come back (utxo_busy, channel_busy) or the wallet's list has not caught up. */
async function again(what: string, ask: () => Promise<Called>, ok: (r: Called) => boolean): Promise<Called> {
  let r = await ask();
  for (let i = 0; i < 10 && !ok(r); i++) {
    log(`  ${what}: ${r.rule ?? r.error ?? "not yet"}; asking again in 15 s`);
    await sleep(15_000);
    r = await ask();
  }
  return r;
}

const buyer = (await signerd("/status")).address as string;
const start = await utxosOf(buyer);
const [B, T, C] = start;

// ---- 0 ------------------------------------------------------------------------------------------
step("0. the wallet as laid out: B, then T, then C");
expect("no channel yet", (await channels()).length === 0, await channels());
expect("B, listed first, is ADA-only and holds at least 3.5 tADA", isAdaOnly(B) && lovelace(B) >= 3_500_000n, B);
expect("T, listed second, holds tokens", !isAdaOnly(T), T);
expect("C, listed third, is ADA-only and under 3 tADA", isAdaOnly(C) && lovelace(C) < 3_000_000n, C);
log(`  B ${ada(lovelace(B))}, T ${ada(lovelace(T))} with ${T.amount.length - 1} token unit(s), C ${ada(lovelace(C))} tADA`);

// ---- 1 ------------------------------------------------------------------------------------------
step("1. an exact purchase in flight, and a channel asked to open meanwhile");
let seq = lastSeq();
const purchase = buyExact("contention run: an exact purchase, in flight");
const signed = await untilAudit(e => e.seq > seq && e.event === "signed");
log(`  the purchase is signed (${String(signed.nonce).slice(0, 16)}…); the channel is asked for now`);
const refusedOpening = await tool("x402_mcp_call", { server: TOOLS, tool: "quote", args: {}, reason: "contention run: open a channel while the purchase is in flight" });
expect("the opening is refused as insufficient_funds", refusedOpening.denied === true && refusedOpening.rule === "insufficient_funds", refusedOpening);
const bought1 = await purchase;
expect("the purchase goes through", bought1.status === 200 && bought1.paid === true && typeof bought1.transaction === "string", bought1);
const purchase1 = bought1.transaction as string;
const opening = await again("the opening", () => tool("x402_mcp_call", { server: TOOLS, tool: "quote", args: {}, reason: "contention run: open a channel" }), r => r.paid === true && !r.isError);
expect("once the purchase is on chain, the channel opens", opening.paid === true && typeof opening.voucher === "string", opening);
const openingTx = auditRecords().find(e => e.seq > firstSeq && e.event === "channel_opened")?.transaction as string;
const p1 = await spends(purchase1);
const op = await spends(openingTx);
expect("the purchase spent B, the UTxO the opening would have seeded from", p1.includes(ref(B)), { purchase: p1, B: ref(B) });
expect("and the opening did not", !op.includes(ref(B)), { opening: op });

// ---- 2 ------------------------------------------------------------------------------------------
step("2. a top-up in flight, and an exact purchase built meanwhile");
seq = lastSeq();
const data = tool("x402_fetch", { url: `${SELLER}/data`, reason: "contention run: a purchase past the channel's capacity" });
const toppedUp = await untilAudit(e => e.seq > seq && e.event === "channel_topped_up");
log(`  the top-up is signed (${String(toppedUp.transaction).slice(0, 16)}…); the exact purchase is asked for now`);
const busy = await buyExact("contention run: an exact purchase while the top-up is in flight");
expect("the purchase is refused as utxo_busy", busy.denied === true && busy.rule === "utxo_busy", busy);
const held = auditRecords().find(e => e.seq > seq && e.event === "input_in_flight");
expect("audited as input_in_flight, naming the input it would have spent", typeof held?.input === "string", held);
const web = await data;
expect("the top-up and its purchase go through", web.status === 200 && web.paid === true, web);
const topUpTx = toppedUp.transaction as string;
const bought2 = await again("the exact purchase", () => buyExact("contention run: the exact purchase, asked again"), r => r.status === 200 && r.paid === true);
expect("once the top-up is on chain, the purchase goes through", bought2.status === 200 && bought2.paid === true && typeof bought2.transaction === "string", bought2);
const purchase2 = bought2.transaction as string;
const tu = await spends(topUpTx);
const p2 = await spends(purchase2);
expect("the input it was refused over is one the top-up spent", tu.includes(held!.input as string), { held: held!.input, topUp: tu });
expect("and the purchase that went through did not", !p2.includes(held!.input as string), { purchase: p2 });

// ---- 3 ------------------------------------------------------------------------------------------
step("3. what was handed out");
const sent = { "purchase 1": purchase1, opening: openingTx, "top-up": topUpTx, "purchase 2": purchase2 };
const inputs = new Map<string, string>();
for (const [what, hash] of Object.entries(sent)) {
  const tx = await blockfrost(`/txs/${hash}`);
  expect(`${what} landed (${hash.slice(0, 16)}…, block ${tx.block_height})`, typeof tx.block_height === "number", tx);
  for (const r of await spends(hash)) {
    expect(`no other transaction spends ${r.slice(0, 20)}…`, !inputs.has(r), { r, by: inputs.get(r), and: what });
    inputs.set(r, what);
  }
}
const refusals = auditRecords().filter(e => e.seq > firstSeq && (e.event === "input_in_flight" || e.event === "insufficient_funds"));
log(`  ${Object.keys(sent).length} transactions landed, none sharing an input; signerd refused ${refusals.length} it would have had to build on one: ${refusals.map(e => e.event).join(", ")}`);
log(`  channel ${String(opening.voucher).split(":")[0]} left open, 0.11 tADA signed, for the claim and refund`);

await mcp.close();
log("all checks passed");

// ---- helpers ------------------------------------------------------------------------------------

type Utxo = { tx_hash: string; output_index: number; amount: Array<{ unit: string; quantity: string }> };

function ref(u: { tx_hash: string; output_index: number }): string {
  return `${u.tx_hash}#${u.output_index}`;
}
function isAdaOnly(u: Utxo | undefined): u is Utxo {
  return u !== undefined && u.amount.length === 1;
}
function lovelace(u: Utxo | undefined): bigint {
  return BigInt(u?.amount.find(a => a.unit === "lovelace")?.quantity ?? "0");
}

/** An address's UTxOs as Blockfrost lists them, oldest first: what both builders see. */
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

/** The inputs a transaction spent, collateral and reference inputs aside. */
async function spends(hash: string): Promise<string[]> {
  type Io = { tx_hash: string; output_index: number; collateral?: boolean; reference?: boolean };
  const io = (await blockfrost(`/txs/${hash}/utxos`)) as unknown as { inputs: Io[] };
  return io.inputs.filter(i => !i.collateral && !i.reference).map(ref);
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

/** This agent's channels in signerd's index; the run starts from an empty one. */
async function channels(): Promise<Array<Record<string, unknown>>> {
  return ((await signerd("/channels")).channels as Array<Record<string, unknown>>).filter(c => c.agentId === AGENT_ID);
}

function auditRecords(): Array<Record<string, unknown> & { seq: number; event: string }> {
  return readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}
function lastSeq(): number {
  return auditRecords().at(-1)?.seq ?? 0;
}
/** Waits for an audit record: signerd writes it once a payment is signed, before it is handed out. */
async function untilAudit(match: (e: Record<string, unknown> & { seq: number; event: string }) => boolean): Promise<Record<string, unknown>> {
  for (let i = 0; i < 600; i++) {
    const found = auditRecords().find(match);
    if (found) return found;
    await sleep(100);
  }
  throw new Error("no such audit record in 60 s");
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
    console.error(`contention: ${name} is required`);
    process.exit(1);
  }
  return v;
}
function ada(l: bigint): string {
  return `${l / 1_000_000n}.${(l % 1_000_000n).toString().padStart(6, "0")}`;
}
function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}
function step(s: string) {
  log(s);
}
function log(s: string) {
  console.log(`[contention ${new Date().toISOString().slice(11, 19)}] ${s}`);
}
