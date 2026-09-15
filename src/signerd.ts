/**
 * signerd — the only process that holds the mnemonic.
 *
 * Listens on 127.0.0.1 (never 0.0.0.0). Every request needs `Authorization: Bearer <SIGNERD_TOKEN>`.
 * The policy file is read here, so an agent process cannot loosen its own limits.
 *
 * Endpoints (JSON):
 *   GET  /status                       -> address, network, per-agent remaining budget
 *   POST /sign     {agentId, reason, input}  -> {transaction, nonce} | {pending: id} | 4xx
 *   GET  /pending                      -> approval queue
 *   POST /approve  {id}                -> signs the queued request
 *   POST /deny     {id}
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
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { toClientCardanoSigner, type ClientCardanoSignInput, type ClientCardanoSigner } from "@x402/cardano";
import { decide, parsePolicy, remaining, type Policy, type SpendRecord } from "./policy.js";

const PORT = Number(process.env.SIGNERD_PORT ?? 7402);
const TOKEN = process.env.SIGNERD_TOKEN;
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
const POLICY_FILE = process.env.POLICY_FILE ?? "./policy.json";
const AUDIT_FILE = process.env.AUDIT_FILE ?? "./audit.jsonl";

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

function audit(event: string, data: Record<string, unknown>) {
  const entry = { ts: Date.now(), event, ...data };
  appendFileSync(AUDIT_FILE, JSON.stringify(entry, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
  return entry;
}

const signer: ClientCardanoSigner = toClientCardanoSigner({
  mnemonic: mnemonic!,
  network: NETWORK,
  provider: providerConfig(),
});
function providerConfig() {
  const preprod = NETWORK.endsWith("preprod");
  if (process.env.BLOCKFROST_PROJECT_ID) {
    return { blockfrost: { baseUrl: `https://cardano-${preprod ? "preprod" : "mainnet"}.blockfrost.io/api/v0`, projectId: process.env.BLOCKFROST_PROJECT_ID } };
  }
  return { koios: { baseUrl: preprod ? "https://preprod.koios.rest/api/v1" : "https://api.koios.rest/api/v1", token: process.env.KOIOS_TOKEN } };
}
const address = signer.getAddress();

interface Pending {
  id: string;
  createdAt: number;
  agentId: string;
  reason: string;
  input: ClientCardanoSignInput;
  resolve: (v: { transaction: string; nonce: string } | { denied: string }) => void;
}
const pending = new Map<string, Pending>();

async function sign(agentId: string, reason: string, input: ClientCardanoSignInput) {
  const res = await signer.buildAndSignPaymentTransaction(input);
  ledger.push({ ts: Date.now(), agentId, asset: input.asset, amount: BigInt(input.amount) });
  audit("signed", { agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, nonce: res.nonce, network: input.network });
  return res;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: "unauthorized" });
  const url = new URL(req.url ?? "/", "http://localhost");
  const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};

  if (req.method === "GET" && url.pathname === "/status") {
    policy = loadPolicy(); // hot-reload so edits to policy.json apply without restart
    const agents: Record<string, unknown> = {};
    for (const id of Object.keys(policy.agents)) agents[id] = remaining(policy, ledger, id);
    return json(res, 200, { address, network: NETWORK, agents, pending: pending.size });
  }

  if (req.method === "POST" && url.pathname === "/sign") {
    const { agentId, reason, input } = body as { agentId: string; reason: string; input: ClientCardanoSignInput };
    if (!agentId || !input?.payTo || !input?.asset || !input?.amount) return json(res, 400, { error: "agentId, reason, input{payTo,asset,amount} required" });
    policy = loadPolicy();
    const d = decide(policy, ledger, { agentId, payTo: input.payTo, asset: input.asset, amount: BigInt(input.amount), reason });
    if (d.verdict === "deny") {
      audit("denied", { agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, rule: d.rule, detail: d.detail });
      return json(res, 403, { error: "policy_denied", rule: d.rule, detail: d.detail });
    }
    if (d.verdict === "needs_approval") {
      const id = randomUUID().slice(0, 8);
      audit("pending", { id, agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, detail: d.detail });
      const outcome = await new Promise<{ transaction: string; nonce: string } | { denied: string }>(resolve => {
        pending.set(id, { id, createdAt: Date.now(), agentId, reason, input, resolve });
        setTimeout(() => {
          if (pending.delete(id)) resolve({ denied: "approval timed out" });
        }, Math.min(input.maxTimeoutSeconds ?? 300, 900) * 1000);
      });
      if ("denied" in outcome) return json(res, 403, { error: "approval_denied", detail: outcome.denied, id });
      return json(res, 200, outcome);
    }
    try {
      return json(res, 200, await sign(agentId, reason, input));
    } catch (e) {
      audit("sign_error", { agentId, reason, error: String(e) });
      return json(res, 500, { error: "sign_failed", detail: String(e) });
    }
  }

  if (req.method === "GET" && url.pathname === "/pending") {
    return json(res, 200, [...pending.values()].map(p => ({ id: p.id, createdAt: p.createdAt, agentId: p.agentId, reason: p.reason, payTo: p.input.payTo, asset: p.input.asset, amount: p.input.amount })));
  }
  if (req.method === "POST" && (url.pathname === "/approve" || url.pathname === "/deny")) {
    const p = pending.get(body.id);
    if (!p) return json(res, 404, { error: "no such pending id" });
    pending.delete(p.id);
    if (url.pathname === "/deny") {
      audit("approval_denied", { id: p.id, agentId: p.agentId });
      p.resolve({ denied: "denied by operator" });
      return json(res, 200, { ok: true });
    }
    try {
      const out = await sign(p.agentId, p.reason, p.input);
      audit("approved", { id: p.id, agentId: p.agentId });
      p.resolve(out);
      return json(res, 200, { ok: true, nonce: out.nonce });
    } catch (e) {
      p.resolve({ denied: `sign failed: ${String(e)}` });
      return json(res, 500, { error: String(e) });
    }
  }
  json(res, 404, { error: "not found" });
}

function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}
function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let s = "";
    req.on("data", c => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

createServer((req, res) => handle(req, res).catch(e => json(res, 500, { error: String(e) }))).listen(PORT, "127.0.0.1", () => {
  console.error(`signerd listening on 127.0.0.1:${PORT}  network=${NETWORK}  address=${address}`);
  console.error(`policy: ${POLICY_FILE}  audit: ${AUDIT_FILE}  agents: ${Object.keys(policy.agents).join(", ")}`);
});
