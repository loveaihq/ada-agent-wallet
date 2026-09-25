/**
 * The seller settles, the buyer ends — on a token channel, through the wallet, on preprod:
 *
 *   1. five purchases of /token, priced in Moneta's tUSDM: the first opens a tUSDM channel
 *   2. `walletctl close`; an `elapse` straight after is refused (not_yet) rather than waited out
 *      inside the wallet lock
 *   3. the seller's watcher (dev/batchseller.ts with BATCH_SELLER_SETTLES=1) settles the channel
 *      with the latest voucher
 *   4. `walletctl end` takes the rest back
 *   5. reconciled on chain in both currencies: the seller up exactly the vouchers in tUSDM and down
 *      only its settle fee in ADA; the wallet down exactly the vouchers in tUSDM and its three fees
 *      in ADA, the channel's ADA reserve back
 *
 * Needs signerd with a policy that allows batch-settlement in tUSDM (channelLockedMax with a
 * lovelace entry, for the reserve), and the seller. Env: SIGNERD_URL, SIGNERD_TOKEN (the
 * operator's), AGENT_TOKEN, AGENT_ID, AUDIT_FILE, BLOCKFROST_PROJECT_ID
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
const BF = blockfrostBaseUrl("cardano:preprod");
/** tUSDM as Blockfrost names units: policy and asset name run together. */
const TUSDM_UNIT = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9" + "0014df10745553444d";

// ---- 1 ------------------------------------------------------------------------------------------
log("1. five purchases priced in tUSDM: the first opens a token channel");
const mcp = new Client({ name: "batchend", version: "0.1.0" });
await mcp.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve(HERE, "../src/mcp.ts")],
    env: { ...(process.env as Record<string, string>), SIGNERD_URL, SIGNERD_TOKEN: AGENT_TOKEN, AGENT_ID },
    stderr: "inherit",
  }),
);
for (let i = 1; i <= 5; i++) {
  const t = Date.now();
  const r = await mcp.callTool({ name: "x402_fetch", arguments: { url: `${SELLER}/token`, reason: `token run: datum ${i}` } }, undefined, { timeout: 600_000 });
  const out = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { status?: number; paid?: boolean; voucher?: string };
  expect(`purchase ${i} paid by voucher (${Date.now() - t} ms)`, out.status === 200 && out.paid === true && typeof out.voucher === "string", out);
}
await mcp.close();
const ch = (await channels()).find(c => c.status === "open")!;
expect("one tUSDM channel, signed for 0.005 tUSDM", ch?.asset === `${TUSDM_UNIT.slice(0, 56)}.${TUSDM_UNIT.slice(56)}` && ch.signed === "5000", ch);
const channelId = ch.channelId as string;
const openTx = audit().find(e => e.event === "channel_opened" && e.channelId === channelId)!.transaction as string;

// ---- 2 ------------------------------------------------------------------------------------------
log("2. the buyer closes; an elapse before elapse_at is refused");
const closed = await walletctl(["close", channelId]);
expect("walletctl close", closed.code === 0, closed);
const { transaction: closeTx, elapseAt } = JSON.parse(closed.out.trim().split("\n").at(-1)!) as { transaction: string; elapseAt: string };
log(`  closed in ${closeTx}; elapse_at ${new Date(Number(elapseAt)).toISOString()}`);
let early = await walletctl(["elapse", channelId]);
// The index may not show the close for a few seconds; until it does the channel reads as open.
for (let i = 0; i < 3 && !/not_yet/.test(early.out); i++) {
  await sleep(10_000);
  early = await walletctl(["elapse", channelId]);
}
expect("elapse before elapse_at is refused as not_yet", early.code !== 0 && /not_yet/.test(early.out), early);

// ---- 3, 4 ---------------------------------------------------------------------------------------
log("3. waiting for the seller to settle, then 4. the buyer ends");
let ended: { code: number; out: string; err: string } | undefined;
for (let i = 0; i < 40; i++) {
  const r = await walletctl(["end", channelId]);
  if (r.code === 0) {
    ended = r;
    break;
  }
  if (!/not settled/.test(r.out)) expect("end fails only for want of the seller's settle", false, r);
  await sleep(15_000);
}
expect("walletctl end, once the seller had settled", ended !== undefined, {});
const endTx = (JSON.parse(ended!.out.trim().split("\n").at(-1)!) as { transaction: string }).transaction;
// The settle is whatever made the channel output the end spent.
const endIo = await blockfrost(`/txs/${endTx}/utxos`);
const settleTx = (endIo.inputs as Array<{ tx_hash: string; address: string; collateral?: boolean; reference?: boolean }>).find(
  i => !i.collateral && !i.reference && i.address.startsWith("addr_test1w"),
)!.tx_hash;

// ---- 5 ------------------------------------------------------------------------------------------
log("5. reconciliation");
const status = (await signerd("/status")).data as { address: string };
const payTo = ch.payTo as string;
const spent = audit()
  .filter(e => e.event === "voucher_signed" && e.channelId === channelId)
  .reduce((s, e) => s + BigInt(e.amount as string), 0n);
const net = { wallet: { ada: 0n, tusdm: 0n }, seller: { ada: 0n, tusdm: 0n } };
const fee: Record<string, bigint> = {};
for (const [name, hash] of Object.entries({ open: openTx, close: closeTx, settle: settleTx, end: endTx })) {
  const io = await blockfrost(`/txs/${hash}/utxos`);
  net.wallet.ada += netFor(io, status.address, "lovelace");
  net.wallet.tusdm += netFor(io, status.address, TUSDM_UNIT);
  net.seller.ada += netFor(io, payTo, "lovelace");
  net.seller.tusdm += netFor(io, payTo, TUSDM_UNIT);
  fee[name] = BigInt((await blockfrost(`/txs/${hash}`)).fees as string);
  log(`  ${name.padEnd(6)} ${hash}  fee ${ada(fee[name]!)}`);
}
log(`  wallet ${ada(net.wallet.ada)} tADA ${units(net.wallet.tusdm)} tUSDM; seller ${ada(net.seller.ada)} tADA ${units(net.seller.tusdm)} tUSDM; vouchers ${units(spent)} tUSDM`);
expect("the seller got exactly what the vouchers signed, in tUSDM", net.seller.tusdm === spent, { net, spent });
expect("the wallet gave exactly that", net.wallet.tusdm === -spent, { net, spent });
expect("the wallet's ADA is down its three fees and no more: the reserve came back", net.wallet.ada === -(fee.open! + fee.close! + fee.end!), { net, fee });
expect("the seller's ADA is down its settle fee and no more", net.seller.ada === -fee.settle!, { net, fee });
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
    if (r.status !== 404 || attempt >= 20) throw new Error(`Blockfrost ${path}: ${r.status}`);
    await sleep(3000);
  }
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
    console.error(`batchend: ${name} is required`);
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
  console.log(`[batchend ${new Date().toISOString().slice(11, 19)}] ${s}`);
}
