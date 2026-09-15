/**
 * signerd — the only process that holds the mnemonic.
 *
 * Listens on 127.0.0.1 (never 0.0.0.0). Every request needs `Authorization: Bearer <SIGNERD_TOKEN>`.
 * The policy file is read here, so an agent process cannot loosen its own limits — provided it
 * cannot write POLICY_FILE or AUDIT_FILE either. See "Deployment contract" below.
 *
 * Endpoints (JSON):
 *   GET  /status                       -> address, network, per-agent spend against cap
 *   POST /sign     {agentId, reason, input}  -> {transaction, nonce} | {pending: id} | 4xx
 *   GET  /pending                      -> approval queue
 *   POST /approve  {id}                -> signs the queued request
 *   POST /deny     {id}
 *
 * Deployment contract: the ledger enforcing the daily cap is a replay of AUDIT_FILE, and the
 * limits are re-read from POLICY_FILE on every decision. An agent that can write either file can
 * raise its own budget without touching this process — deleting the audit file alone resets the
 * day's spend to zero. Both must live where the agent's user has no write access.
 *
 * Env:
 *   WALLET_MNEMONIC   24 words (required)   — or WALLET_MNEMONIC_FILE
 *   CARDANO_NETWORK   cardano:preprod | cardano:mainnet   (default preprod)
 *   BLOCKFROST_PROJECT_ID   optional; without it the daemon uses Koios (free, no key)
 *   KOIOS_TOKEN             optional
 *   POLICY_FILE       default ./policy.json
 *   AUDIT_FILE        default ./audit.jsonl
 *   SIGNERD_PORT      default 7402
 *   SIGNERD_TOKEN     shared secret (required)
 *   MASUMI_MAX_COLLATERAL_LOVELACE  ceiling on the collateral a masumi escrow may lock
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, openSync, writeSync, fsyncSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { toClientCardanoSigner, type ClientCardanoSignInput, type ClientCardanoSigner } from "@x402/cardano";
import { decide, parsePolicy, remaining, type Policy, type SpendRecord } from "./policy.js";
import { createKeyedLock, createLock } from "./serialize.js";

const PORT = Number(process.env.SIGNERD_PORT ?? 7402);
const TOKEN = process.env.SIGNERD_TOKEN;
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
const POLICY_FILE = process.env.POLICY_FILE ?? "./policy.json";
const AUDIT_FILE = process.env.AUDIT_FILE ?? "./audit.jsonl";
const MAX_BODY_BYTES = 1 << 20;
const MAX_APPROVAL_SECONDS = 900;
// Long enough to cover one settle attempt (facilitator awaitTx 100s inside a 115s client timeout
// in dev/), short enough that a failed settlement does not strand the wallet.
const NONCE_HOLD_SECONDS = Number(process.env.NONCE_HOLD_SECONDS ?? 120);

if (!TOKEN) fail("SIGNERD_TOKEN is required");
const mnemonic =
  process.env.WALLET_MNEMONIC ??
  (process.env.WALLET_MNEMONIC_FILE ? readFileSync(process.env.WALLET_MNEMONIC_FILE, "utf8").trim() : undefined);
if (!mnemonic) fail("WALLET_MNEMONIC or WALLET_MNEMONIC_FILE is required");

function fail(msg: string): never {
  console.error(`signerd: ${msg}`);
  process.exit(1);
}

let policy: Policy = loadPolicy();
function loadPolicy(): Policy {
  return parsePolicy(JSON.parse(readFileSync(POLICY_FILE, "utf8")));
}

// Ledger = replay of the audit file (only signed payments count against budgets).
const ledger: SpendRecord[] = [];
if (existsSync(AUDIT_FILE)) {
  for (const line of readFileSync(AUDIT_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.event === "signed") ledger.push({ ts: e.ts, agentId: e.agentId, asset: e.asset, amount: BigInt(e.amount) });
  }
}

/**
 * Budget held by a queued approval. A request waiting on a human has not spent anything yet, but
 * it will if the operator says yes — so queuing two requests must not be a way to promise the
 * same budget twice. Reservations count as spend until the request resolves either way.
 */
const reserved = new Map<string, SpendRecord>();
const effectiveLedger = (): readonly SpendRecord[] =>
  reserved.size === 0 ? ledger : [...ledger, ...reserved.values()];

const auditFd = openSync(AUDIT_FILE, "a");
function audit(event: string, data: Record<string, unknown>) {
  const entry = { ts: Date.now(), event, ...data };
  writeSync(auditFd, JSON.stringify(entry, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
  fsyncSync(auditFd); // an audit record lost in a crash is not an audit record
  return entry;
}

const signer: ClientCardanoSigner = toClientCardanoSigner({
  mnemonic: mnemonic!,
  network: NETWORK,
  provider: providerConfig(),
  // A masumi escrow locks collateral derived from the datum size, and the datum carries the
  // seller's own bytes verbatim — so without a ceiling a seller chooses how much this wallet locks.
  ...(process.env.MASUMI_MAX_COLLATERAL_LOVELACE
    ? { masumiMaxCollateralLovelace: BigInt(process.env.MASUMI_MAX_COLLATERAL_LOVELACE) }
    : {}),
});
function providerConfig() {
  const preprod = NETWORK.endsWith("preprod");
  if (process.env.BLOCKFROST_PROJECT_ID) {
    return { blockfrost: { baseUrl: `https://cardano-${preprod ? "preprod" : "mainnet"}.blockfrost.io/api/v0`, projectId: process.env.BLOCKFROST_PROJECT_ID } };
  }
  return { koios: { baseUrl: preprod ? "https://preprod.koios.rest/api/v1" : "https://api.koios.rest/api/v1", token: process.env.KOIOS_TOKEN } };
}
const address = signer.getAddress();

/**
 * Two different things need ordering, so there are two locks.
 *
 * The agent lock covers "decide, then record the spend". `decide` reads the ledger and the spend
 * is appended only after the transaction is built — and building queries the chain — so without
 * it, two concurrent requests for one agent both read the same pre-spend ledger and both pass a
 * cap that fits one. Measured on preprod before this existed: a 2 ADA daily cap signed two 1.5 ADA
 * payments, and status then reported a remaining budget of zero rather than the overspend.
 *
 * The wallet lock covers signing, which belongs to the key rather than to the agent: there is one
 * wallet, so two builds racing over its UTXO set are free to pick the same one.
 */
const withAgentLock = createKeyedLock();
const withWalletLock = createLock();

/**
 * UTXOs committed to a transaction that has been handed out but has not settled.
 *
 * signerd never learns when a payment settles — it returns the signed transaction to the agent and
 * the facilitator broadcasts it. What it can see is the signer picking a UTXO that another
 * unsettled transaction already spends: the chain still reports it unspent, so serializing the
 * builds does not prevent this, and only one of the two can ever land. Refusing beats handing back
 * a transaction that is already dead.
 *
 * The hold is deliberately short, and shorter than the transaction's own TTL. What actually stops
 * an agent overspending is the ledger; this is only an optimization against wasted signatures, and
 * a real double-spend is refused by the chain regardless. Holding too long is the worse mistake:
 * a settlement that fails is never reported back here, so an over-long hold wedges the wallet —
 * on a single-UTXO wallet, completely — for no safety gained. One settle attempt finishes inside
 * the resource server's facilitator timeout, so by then the outcome is known and a retry should be
 * allowed to proceed.
 */
const inflightNonces = new Map<string, number>();
function claimNonce(nonce: string, ttlSeconds: number): boolean {
  const now = Date.now();
  for (const [n, expiry] of inflightNonces) if (expiry <= now) inflightNonces.delete(n);
  if (inflightNonces.has(nonce)) return false;
  inflightNonces.set(nonce, now + ttlSeconds * 1000);
  return true;
}

const approvalWindow = (input: ClientCardanoSignInput) =>
  Math.min(input.maxTimeoutSeconds ?? 300, MAX_APPROVAL_SECONDS);

async function sign(agentId: string, reason: string, input: ClientCardanoSignInput) {
  return withWalletLock(async () => {
    const res = await signer.buildAndSignPaymentTransaction(input);
    if (!claimNonce(res.nonce, Math.min(approvalWindow(input), NONCE_HOLD_SECONDS))) {
      audit("nonce_collision", { agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, nonce: res.nonce });
      throw new Error(`utxo ${res.nonce} is already committed to an unsettled payment; retry once it settles`);
    }
    ledger.push({ ts: Date.now(), agentId, asset: input.asset, amount: BigInt(input.amount) });
    audit("signed", { agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, nonce: res.nonce, network: input.network });
    return res;
  });
}

interface Pending {
  id: string;
  createdAt: number;
  agentId: string;
  reason: string;
  input: ClientCardanoSignInput;
  resolve: (v: { transaction: string; nonce: string } | { denied: string }) => void;
}
const pending = new Map<string, Pending>();

type Settled = { transaction: string; nonce: string } | { denied: string };
type SignOutcome =
  | { kind: "deny"; rule: string; detail: string }
  | { kind: "signed"; out: { transaction: string; nonce: string } }
  | { kind: "error"; error: unknown }
  | { kind: "queued"; id: string; settled: Promise<Settled> };

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!authorized(req.headers.authorization)) return json(res, 401, { error: "unauthorized" });
  const url = new URL(req.url ?? "/", "http://localhost");
  const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};

  if (req.method === "GET" && url.pathname === "/status") {
    policy = loadPolicy(); // hot-reload so edits to policy.json apply without restart
    const agents: Record<string, unknown> = {};
    for (const id of Object.keys(policy.agents)) agents[id] = remaining(policy, effectiveLedger(), id);
    return json(res, 200, { address, network: NETWORK, agents, pending: pending.size });
  }

  if (req.method === "POST" && url.pathname === "/sign") {
    const { agentId, reason, input } = body as { agentId: string; reason: string; input: ClientCardanoSignInput };
    if (!agentId || !input?.payTo || !input?.asset || !input?.amount)
      return json(res, 400, { error: "agentId, reason, input{payTo,asset,amount} required" });

    // Everything from reading the ledger to recording the spend runs under this agent's lock.
    const outcome = await withAgentLock(agentId, async (): Promise<SignOutcome> => {
      policy = loadPolicy();
      const method = input.extra?.assetTransferMethod;
      const d = decide(policy, effectiveLedger(), {
        agentId,
        payTo: input.payTo,
        asset: input.asset,
        amount: BigInt(input.amount),
        reason,
        assetTransferMethod: typeof method === "string" ? method : undefined,
      });

      if (d.verdict === "deny") {
        audit("denied", { agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, rule: d.rule, detail: d.detail });
        return { kind: "deny", rule: d.rule, detail: d.detail };
      }

      if (d.verdict === "needs_approval") {
        const id = randomUUID().slice(0, 8);
        // Hold the budget while the operator decides, but release the lock: a human may take
        // minutes, and nothing else for this agent should be stalled behind them.
        reserved.set(id, { ts: Date.now(), agentId, asset: input.asset, amount: BigInt(input.amount) });
        audit("pending", { id, agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, detail: d.detail });
        const settled = new Promise<Settled>(resolve => {
          pending.set(id, { id, createdAt: Date.now(), agentId, reason, input, resolve });
          setTimeout(() => {
            if (pending.delete(id)) {
              reserved.delete(id);
              audit("approval_timeout", { id, agentId, reason, asset: input.asset, amount: input.amount });
              resolve({ denied: "approval timed out" });
            }
          }, approvalWindow(input) * 1000);
        });
        return { kind: "queued", id, settled };
      }

      try {
        return { kind: "signed", out: await sign(agentId, reason, input) };
      } catch (e) {
        audit("sign_error", { agentId, reason, error: String(e) });
        return { kind: "error", error: e };
      }
    });

    if (outcome.kind === "deny") return json(res, 403, { error: "policy_denied", rule: outcome.rule, detail: outcome.detail });
    if (outcome.kind === "error") return json(res, 500, { error: "sign_failed", detail: String(outcome.error) });
    if (outcome.kind === "signed") return json(res, 200, outcome.out);

    const verdict = await outcome.settled; // waited for outside the lock
    if ("denied" in verdict) return json(res, 403, { error: "approval_denied", detail: verdict.denied, id: outcome.id });
    return json(res, 200, verdict);
  }

  if (req.method === "GET" && url.pathname === "/pending") {
    return json(res, 200, [...pending.values()].map(p => ({ id: p.id, createdAt: p.createdAt, agentId: p.agentId, reason: p.reason, payTo: p.input.payTo, asset: p.input.asset, amount: p.input.amount })));
  }
  if (req.method === "POST" && (url.pathname === "/approve" || url.pathname === "/deny")) {
    const p = pending.get(body.id);
    if (!p) return json(res, 404, { error: "no such pending id" });
    pending.delete(p.id);
    if (url.pathname === "/deny") {
      reserved.delete(p.id);
      audit("approval_denied", { id: p.id, agentId: p.agentId });
      p.resolve({ denied: "denied by operator" });
      return json(res, 200, { ok: true });
    }
    try {
      // Signing appends the real spend; the reservation standing in for it is dropped only
      // afterwards, so the budget is never momentarily unheld.
      const out = await withAgentLock(p.agentId, () => sign(p.agentId, p.reason, p.input));
      reserved.delete(p.id);
      audit("approved", { id: p.id, agentId: p.agentId });
      p.resolve(out);
      return json(res, 200, { ok: true, nonce: out.nonce });
    } catch (e) {
      reserved.delete(p.id);
      audit("approval_sign_error", { id: p.id, agentId: p.agentId, error: String(e) });
      p.resolve({ denied: `sign failed: ${String(e)}` });
      return json(res, 500, { error: String(e) });
    }
  }
  json(res, 404, { error: "not found" });
}

function authorized(header: string | undefined): boolean {
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  const got = Buffer.from(header ?? "");
  // timingSafeEqual throws on unequal lengths, and a bearer token's length is not the secret.
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}
function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let s = "";
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      s += c;
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

createServer((req, res) => handle(req, res).catch(e => json(res, 500, { error: String(e) }))).listen(PORT, "127.0.0.1", () => {
  console.error(`signerd listening on 127.0.0.1:${PORT}  network=${NETWORK}  address=${address}`);
  console.error(`policy: ${resolvePath(POLICY_FILE)}`);
  console.error(`audit:  ${resolvePath(AUDIT_FILE)}`);
  console.error(`agents: ${Object.keys(policy.agents).join(", ")}`);
  console.error(`neither file may be writable by the agent's user: the daily cap is a replay of the audit file, and the limits are re-read from the policy file on every decision`);
});
