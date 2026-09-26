/**
 * batch-settlement end to end on preprod, the way an agent pays: a real MCP client spawns
 * src/mcp.ts and calls x402_fetch against dev/batchseller.ts, and signerd decides and signs.
 *
 *   1. ten purchases: the first opens a channel (a transaction), the other nine are vouchers
 *   2. a purchase whose response is lost, and its retry: the same voucher, spent once
 *   3. a purchase over approvalAbove: queued, approved with the operator's token, then paid
 *   4. purchases until dailyMax refuses one, the channel topped up on the way as it runs short
 *   5. a seller whose provider key the policy does not allow: refused, nothing signed
 *   6. the refund, through walletctl: the seller paid what the vouchers allow, the rest back
 *   7. the reconciliation: the audit log against signerd's channel index, and the chain against both
 *
 * Needs dev/batchseller.ts, and signerd started with a fresh CHANNELS_DIR, AGENT_TOKENS_FILE,
 * BATCH_DEPOSIT_REQUESTS=10 (so that top-ups come quickly) and this agent's policy:
 *
 *   perTxMax { lovelace: 300000 }, dailyMax { lovelace: 2500000 }, approvalAbove { lovelace: 150000 },
 *   allowedPayees [<the seller's payTo>], allowedResources ["http://127.0.0.1:7411/*", "http://127.0.0.1:7412/*"],
 *   allowedSchemes ["exact", "batch-settlement"], allowedProviderKeys [<the seller's providerKey>],
 *   channelDepositMax { lovelace: 5000000 }, channelLockedMax { lovelace: 10000000 }
 *
 * (amounts as decimal strings). Env: SIGNERD_URL, SIGNERD_TOKEN (the operator's), AGENT_TOKEN
 * (the agent's), AGENT_ID, AUDIT_FILE (the ledger checkpoint is read beside it), BLOCKFROST_PROJECT_ID
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
const SELLER = "http://127.0.0.1:7411";
const OTHER = "http://127.0.0.1:7412";
const BF = blockfrostBaseUrl("cardano:preprod");

const operator = { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" };
const signerd = async (path: string, body?: unknown) => {
  const r = await fetch(SIGNERD_URL + path, { method: body ? "POST" : "GET", headers: operator, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (await r.json()) as Record<string, unknown> };
};
const firstSeq = auditRecords().at(-1)?.seq ?? 0;

const mcp = new Client({ name: "batch", version: "0.1.0" });
await mcp.connect(
  new StdioClientTransport({
    // node itself rather than npx: Windows will not spawn a .cmd without a shell.
    command: process.execPath,
    args: ["--import", "tsx", resolve(HERE, "../src/mcp.ts")],
    env: { ...(process.env as Record<string, string>), SIGNERD_URL, SIGNERD_TOKEN: AGENT_TOKEN, AGENT_ID },
    stderr: "inherit",
  }),
);

type Fetched = { error?: string; status?: number; paid?: boolean; voucher?: string; denied?: boolean; rule?: string; body?: string };
async function buy(url: string, reason: string): Promise<Fetched> {
  const r = await mcp.callTool({ name: "x402_fetch", arguments: { url, reason } }, undefined, { timeout: 600_000 });
  const text = (r.content as Array<{ text?: string }>)[0]?.text ?? "";
  try {
    return JSON.parse(text) as Fetched;
  } catch {
    return { error: text };
  }
}

// ---- 1 ------------------------------------------------------------------------------------------
step("1. ten purchases of /data: the first opens a channel");
for (let i = 1; i <= 10; i++) {
  const t = Date.now();
  const r = await buy(`${SELLER}/data`, `batch run: datum ${i}`);
  expect(`purchase ${i} paid by voucher`, r.status === 200 && r.paid === true && typeof r.voucher === "string", r);
  log(`  ${i}: ${r.voucher} in ${Date.now() - t} ms`);
}
const channel = (await channels())[0];
expect("one channel, signed for 1.0 tADA", channel?.signed === "1000000", channel);
const channelId = channel.channelId as string;

// ---- 2 ------------------------------------------------------------------------------------------
step("2. a lost response, and the retry");
const lost = await buy(`${SELLER}/lossy`, "batch run: a datum whose answer is lost");
expect("the first /lossy fails in transit", Boolean(lost.error) || lost.status !== 200, lost);
const afterLost = (await channels())[0].signed;
let retried = await buy(`${SELLER}/lossy`, "batch run: the same datum, asked again");
// The lost request carried a top-up; if the chain has not finished showing it, signerd says to
// retry (channel_busy), and an agent would.
for (let i = 0; i < 3 && retried.rule === "channel_busy"; i++) {
  log(`  retry answered channel_busy (${retried.error ?? ""}); asking again`);
  await sleep(15_000);
  retried = await buy(`${SELLER}/lossy`, "batch run: the same datum, asked again");
}
expect("the retry is served", retried.status === 200 && retried.paid === true, retried);
const afterRetry = (await channels())[0].signed;
expect("the retry signed nothing new", afterRetry === afterLost, { afterLost, afterRetry });
expect("and was audited as a re-sign", auditRecords().some(e => e.seq > firstSeq && e.event === "voucher_resigned"), {});

// ---- 3 ------------------------------------------------------------------------------------------
step("3. a purchase over approvalAbove, approved by the operator");
const big = buy(`${SELLER}/big`, "batch run: the bigger datum, which needs a human");
let queued: Record<string, unknown> | undefined;
for (let i = 0; i < 60 && !queued; i++) {
  await sleep(1000);
  queued = ((await signerd("/pending")).data as unknown as Array<Record<string, unknown>>).find(p => p.scheme === "batch-settlement");
}
expect("the voucher waits in the queue for its increment", queued?.amount === "200000", queued);
const approval = await signerd("/approve", { id: queued!.id });
expect("approved", approval.status === 200, approval.data);
const bigResult = await big;
expect("and the purchase goes through", bigResult.status === 200 && bigResult.paid === true, bigResult);

// ---- 4 ------------------------------------------------------------------------------------------
step("4. purchases until dailyMax refuses one");
let refused: Fetched | undefined;
for (let i = 11; i <= 40 && !refused; i++) {
  const r = await buy(`${SELLER}/data`, `batch run: datum ${i}`);
  if (r.denied) refused = r;
  else expect(`purchase ${i} paid`, r.status === 200 && r.paid === true, r);
}
expect("dailyMax refused one", refused?.rule === "daily_max", refused);
const run = auditRecords().filter(e => e.seq > firstSeq);
const topUps = run.filter(e => e.event === "channel_topped_up");
expect("the channel was topped up on the way", topUps.length >= 1, topUps);

// ---- 5 ------------------------------------------------------------------------------------------
step("5. a seller with a provider key the policy does not allow");
const other = await buy(`${OTHER}/other`, "batch run: a seller nobody allowed");
expect("refused for its key", other.denied === true && other.rule === "provider_key", other);
expect("and no channel was opened for it", (await channels()).length === 1, await channels());

// ---- 6 ------------------------------------------------------------------------------------------
step("6. the refund, through walletctl");
const refund = await walletctl(["refund", channelId, `${SELLER}/data`]);
expect("the refund settled", refund.code === 0 && /"settled":true/.test(refund.out), refund);
const refundTx = JSON.parse(refund.out.trim().split("\n").at(-1)!).transaction as string;

// ---- 7 ------------------------------------------------------------------------------------------
step("7. reconciliation");
const all = auditRecords().filter(e => e.seq > firstSeq);
const vouchers = all.filter(e => e.event === "voucher_signed");
const spent = vouchers.reduce((s, e) => s + BigInt(e.amount as string), 0n);
const final = (await channels()).find(c => c.channelId === channelId)!;
expect("the audit's voucher increments add up to what signerd signed", spent.toString() === final.signed, { spent, signed: final.signed });
const ledger = JSON.parse(readFileSync(resolve(dirname(AUDIT_FILE), "ledger.json"), "utf8")) as { spends: Array<{ amount: string; voucher?: boolean; agentId: string }> };
const onLedger = ledger.spends.filter(s => s.voucher && s.agentId === AGENT_ID).reduce((s, x) => s + BigInt(x.amount), 0n);
expect("and so does the ledger the caps are computed from", onLedger === spent, { onLedger, spent });

const status = (await signerd("/status")).data as { address: string };
const txs = [
  ...all.filter(e => e.event === "channel_opened" || e.event === "channel_topped_up").map(e => e.transaction as string),
  refundTx,
];
let walletNet = 0n;
let sellerNet = 0n;
let fees = 0n;
for (const hash of txs) {
  const utxos = await blockfrost(`/txs/${hash}/utxos`);
  walletNet += netFor(utxos, status.address);
  sellerNet += netFor(utxos, final.payTo as string);
  fees += BigInt((await blockfrost(`/txs/${hash}`)).fees as string);
}
log(`  ${txs.length} transactions: ${txs.join(", ")}`);
log(`  wallet ${ada(walletNet)}, seller ${ada(sellerNet)}, fees ${ada(fees)} tADA`);
expect("the seller got exactly what the vouchers signed", sellerNet === spent, { sellerNet, spent });
expect("the wallet lost exactly that and the fees", walletNet === -(spent + fees), { walletNet, spent, fees });

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
    console.error(`batch: ${name} is required`);
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
  console.log(`[batch ${new Date().toISOString().slice(11, 19)}] ${s}`);
}
