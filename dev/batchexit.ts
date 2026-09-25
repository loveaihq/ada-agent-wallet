/**
 * batch-settlement's way out without the seller, on preprod, in two phases around a signerd that
 * loses its channel records in between:
 *
 *   open  three purchases through x402_fetch (the first opens a channel), then `walletctl close`
 *   exit  (signerd restarted on an empty CHANNELS_DIR) `walletctl recover` finds the channel on
 *         chain again, and once its close period has run, `walletctl elapse` takes it all back;
 *         the seller never settled, so its vouchers are void and it gets nothing
 *
 * Reconciled on chain: over the opening, the close and the elapse, the wallet is down exactly the
 * three fees and the seller neither up nor down. The three vouchers stay spent in the ledger: a
 * spend is recorded when it is signed, whatever becomes of it (README, "Known behaviour").
 *
 * Needs dev/batchseller.ts and signerd, as for dev/batch.ts. Env: SIGNERD_URL, SIGNERD_TOKEN (the
 * operator's), AGENT_TOKEN, AGENT_ID, EXIT_STATE (a file the two phases share),
 * BLOCKFROST_PROJECT_ID
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
const AGENT_ID = process.env.AGENT_ID ?? "default";
const STATE = must("EXIT_STATE");
const PROJECT_ID = must("BLOCKFROST_PROJECT_ID");
const SELLER = "http://127.0.0.1:7411";
const BF = blockfrostBaseUrl("cardano:preprod");
const phase = process.argv[2];

interface State {
  channelId: string;
  openTx: string;
  closeTx: string;
  elapseAt: string;
  payTo: string;
  wallet: string;
}

if (phase === "open") {
  const token = must("AGENT_TOKEN");
  const mcp = new Client({ name: "batchexit", version: "0.1.0" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve(HERE, "../src/mcp.ts")],
      env: { ...(process.env as Record<string, string>), SIGNERD_URL, SIGNERD_TOKEN: token, AGENT_ID },
      stderr: "inherit",
    }),
  );
  for (let i = 1; i <= 3; i++) {
    const r = await mcp.callTool({ name: "x402_fetch", arguments: { url: `${SELLER}/data`, reason: `exit run: datum ${i}` } }, undefined, { timeout: 600_000 });
    const out = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { status?: number; paid?: boolean; voucher?: string };
    expect(`purchase ${i} paid`, out.status === 200 && out.paid === true, out);
  }
  await mcp.close();
  const ch = (await channels())[0]!;
  const opened = auditOf("channel_opened")[0]!;
  const closed = await walletctl(["close", ch.channelId as string]);
  expect("walletctl close", closed.code === 0, closed);
  const c = JSON.parse(closed.out.trim().split("\n").at(-1)!) as { transaction: string; elapseAt: string };
  const status = (await signerd("/status")).data as { address: string };
  const state: State = { channelId: ch.channelId as string, openTx: opened.transaction as string, closeTx: c.transaction, elapseAt: c.elapseAt, payTo: ch.payTo as string, wallet: status.address };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  log(`closed ${state.channelId.slice(0, 16)}… in ${c.transaction}; elapse_at ${new Date(Number(c.elapseAt)).toISOString()}`);
} else if (phase === "exit") {
  if (!existsSync(STATE)) fail("run the open phase first");
  const s = JSON.parse(readFileSync(STATE, "utf8")) as State;
  expect("signerd starts with no record of the channel", (await channels()).length === 0, await channels());
  const found = await walletctl(["recover", AGENT_ID]);
  expect("walletctl recover", found.code === 0, found);
  const r = JSON.parse(found.out) as { found: Array<{ channelId: string; status: string; exitOnly: boolean }>; indexed: number };
  const mine = r.found.find(f => f.channelId === s.channelId);
  expect("recover finds the closed channel, with its IOU key derived again", mine?.status === "closing" && mine.exitOnly === false, r);
  const indexed = (await channels()).find(c => c.channelId === s.channelId);
  expect("and indexes it", indexed !== undefined, await channels());
  // elapse_at as the chain has it: the recovered record carries it from the channel's datum.
  const elapseAt = String((indexed!.client as { elapseAt?: string } | undefined)?.elapseAt ?? s.elapseAt);
  if (Number(elapseAt) > Date.now() + 60_000) {
    const early = await walletctl(["elapse", s.channelId]);
    expect("elapse before elapse_at is refused, not waited out inside the wallet lock", early.code !== 0 && /not_yet/.test(early.out), early);
  } else log("  elapse_at has passed already, so there is no early elapse to refuse");
  const wait = Number(elapseAt) - Date.now() + 30_000;
  if (wait > 0) {
    log(`waiting ${Math.round(wait / 1000)} s for elapse_at`);
    await sleep(wait);
  }
  const el = await walletctl(["elapse", s.channelId]);
  expect("walletctl elapse", el.code === 0, el);
  const elapseTx = (JSON.parse(el.out.trim().split("\n").at(-1)!) as { transaction: string }).transaction;

  let walletNet = 0n;
  let sellerNet = 0n;
  let fees = 0n;
  for (const hash of [s.openTx, s.closeTx, elapseTx]) {
    const utxos = await blockfrost(`/txs/${hash}/utxos`);
    walletNet += netFor(utxos, s.wallet);
    sellerNet += netFor(utxos, s.payTo);
    fees += BigInt((await blockfrost(`/txs/${hash}`)).fees as string);
  }
  log(`  opening ${s.openTx}, close ${s.closeTx}, elapse ${elapseTx}`);
  log(`  wallet ${ada(walletNet)}, seller ${ada(sellerNet)}, fees ${ada(fees)} tADA`);
  expect("the seller, which never settled, got nothing", sellerNet === 0n, { sellerNet });
  expect("the wallet got everything back but the three fees", walletNet === -fees, { walletNet, fees });
} else {
  fail("phase must be open or exit");
}
log(`${phase}: all checks passed`);

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

function auditOf(event: string): Array<Record<string, unknown>> {
  const file = must("AUDIT_FILE");
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(e => e.event === event);
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

/** What a transaction moved to or from an address: outputs less inputs, collateral and reference inputs aside. */
function netFor(utxos: Record<string, unknown>, address: string): bigint {
  type Io = { address: string; amount: Array<{ unit: string; quantity: string }>; collateral?: boolean; reference?: boolean };
  const lovelace = (xs: Io[]) => xs.filter(x => x.address === address && !x.collateral && !x.reference).reduce((s, x) => s + BigInt(x.amount.find(a => a.unit === "lovelace")?.quantity ?? "0"), 0n);
  return lovelace(utxos.outputs as Io[]) - lovelace(utxos.inputs as Io[]);
}

function expect(what: string, ok: boolean, detail: unknown) {
  if (!ok) fail(`${what}\n${JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}`);
  log(`  ok  ${what}`);
}

function fail(why: string): never {
  console.error(`FAILED: ${why}`);
  process.exit(1);
}

function must(name: string): string {
  const v = process.env[name];
  if (!v) fail(`${name} is required`);
  return v;
}

function ada(l: bigint): string {
  const v = l < 0n ? -l : l;
  return `${l < 0n ? "-" : ""}${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
}
function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}
function log(s: string) {
  console.log(`[batchexit ${new Date().toISOString().slice(11, 19)}] ${s}`);
}
