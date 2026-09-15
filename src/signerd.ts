/**
 * signerd — the only process that holds the mnemonic.
 *
 * Listens on 127.0.0.1 (never 0.0.0.0). Every request needs `Authorization: Bearer <SIGNERD_TOKEN>`.
 * The policy file is read here, so an agent process cannot loosen its own limits — provided it
 * cannot write POLICY_FILE or AUDIT_FILE either. See "Deployment contract" below.
 *
 * Endpoints (JSON):
 *   GET  /status                       -> address, network, per-agent spend against cap
 *   GET  /preflight                    -> the checks worth passing before real money is involved
 *   GET  /metrics                      -> Prometheus exposition, same bearer token
 *   POST /sign     {agentId, reason, resource?, input}  -> {transaction, nonce} | 4xx
 *   GET  /pending                      -> approval queue
 *   POST /approve  {id}                -> signs the queued request
 *   POST /deny     {id}
 *
 * Neither POLICY_FILE nor AUDIT_FILE may be writable by the agent's user: between them they are
 * the limits and the spending they are measured against. See README, "Before mainnet".
 *
 * Env:
 *   WALLET_KEYSTORE_FILE    passphrase-encrypted mnemonic (preferred; see scripts/keystore.mjs)
 *   WALLET_PASSPHRASE_FILE  where to read its passphrase; otherwise prompted on a terminal
 *   WALLET_MNEMONIC_FILE    plaintext mnemonic on disk
 *   WALLET_MNEMONIC         plaintext mnemonic in the environment (worst of the three)
 *   MAX_HOT_BALANCE_LOVELACE  what this wallet should never exceed; preflight fails without it
 *   CARDANO_NETWORK   cardano:preprod | cardano:mainnet   (default preprod)
 *   BLOCKFROST_PROJECT_ID   optional; without it the daemon uses Koios (free, no key)
 *   KOIOS_TOKEN             optional
 *   POLICY_FILE       default ./policy.json
 *   AUDIT_FILE        default ./audit.jsonl   (append-only log; chained)
 *   LEDGER_FILE       default ./ledger.json  (the spend state the cap is computed from)
 *   ALLOW_UNVERIFIED_AUDIT  set to 1 to start when the audit chain no longer covers the checkpoint
 *                           (a deliberate rotation). It waives the check, not the ledger: recorded
 *                           spends come from the checkpoint and survive.
 *   SIGNERD_PORT      default 7402
 *   SIGNERD_TOKEN     shared secret (required)
 *   MASUMI_MAX_COLLATERAL_LOVELACE  ceiling on the collateral a masumi escrow may lock
 *   NONCE_HOLD_SECONDS              how long a handed-out UTXO is treated as in flight
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  writeSync,
  fsyncSync,
  ftruncateSync,
  closeSync,
  createReadStream,
} from "node:fs";
import { createInterface } from "node:readline";
import { resolve as resolvePath, dirname } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { toClientCardanoSigner, type ClientCardanoSignInput, type ClientCardanoSigner } from "@x402/cardano";
import { decide, parsePolicy, remaining, type Policy, type SpendRecord } from "./policy.js";
import { createKeyedLock, createLock } from "./serialize.js";
import { replayAudit, sha256, type Checkpoint } from "./replay.js";
import { decryptMnemonic, assertKeystore } from "./keystore.js";

const PORT = Number(process.env.SIGNERD_PORT ?? 7402);
const TOKEN = process.env.SIGNERD_TOKEN;
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
const POLICY_FILE = process.env.POLICY_FILE ?? "./policy.json";
const AUDIT_FILE = process.env.AUDIT_FILE ?? "./audit.jsonl";
const LEDGER_FILE = process.env.LEDGER_FILE ?? "./ledger.json";
const ALLOW_UNVERIFIED_AUDIT = process.env.ALLOW_UNVERIFIED_AUDIT === "1";
const MNEMONIC_FILE = process.env.WALLET_MNEMONIC_FILE;
const KEYSTORE_FILE = process.env.WALLET_KEYSTORE_FILE;
const PASSPHRASE_FILE = process.env.WALLET_PASSPHRASE_FILE;
const MAX_HOT_BALANCE = process.env.MAX_HOT_BALANCE_LOVELACE ? BigInt(process.env.MAX_HOT_BALANCE_LOVELACE) : undefined;
const IS_MAINNET = NETWORK.endsWith("mainnet");
const MAX_BODY_BYTES = 1 << 20;
const MAX_APPROVAL_SECONDS = 900;
// Long enough to cover one settle attempt (facilitator awaitTx 100s inside a 115s client timeout
// in dev/), short enough that a failed settlement does not strand the wallet.
const NONCE_HOLD_SECONDS = Number(process.env.NONCE_HOLD_SECONDS ?? 120);
// The longest window any rule looks at. Nothing older can change a decision, so nothing older is
// kept: the ledger stays bounded however long the process runs and however large the audit grows.
const LEDGER_WINDOW_MS = 24 * 60 * 60 * 1000;

function fail(msg: string): never {
  console.error(`signerd: ${msg}`);
  process.exit(1);
}

if (!TOKEN) fail("SIGNERD_TOKEN is required");

/** Keystore, then plaintext file, then environment — best to worst. See README, "The key". */
async function loadMnemonic(): Promise<string> {
  if (KEYSTORE_FILE) {
    let keystore: unknown;
    try {
      keystore = JSON.parse(readFileSync(KEYSTORE_FILE, "utf8"));
      assertKeystore(keystore);
    } catch (e) {
      fail(`keystore ${resolvePath(KEYSTORE_FILE)}: ${e instanceof Error ? e.message : e}`);
    }
    const passphrase = await readPassphrase();
    try {
      return decryptMnemonic(keystore as Parameters<typeof decryptMnemonic>[0], passphrase);
    } catch (e) {
      fail(String(e instanceof Error ? e.message : e));
    }
  }
  if (process.env.WALLET_MNEMONIC) return process.env.WALLET_MNEMONIC.trim();
  if (MNEMONIC_FILE) return readFileSync(MNEMONIC_FILE, "utf8").trim();
  fail("one of WALLET_KEYSTORE_FILE, WALLET_MNEMONIC_FILE or WALLET_MNEMONIC is required");
}

async function readPassphrase(): Promise<string> {
  // Not an environment variable: a keystore is pointless if reading one thing still suffices.
  if (PASSPHRASE_FILE) return readFileSync(PASSPHRASE_FILE, "utf8").replace(/\r?\n$/, "");
  if (!process.stdin.isTTY)
    fail("keystore passphrase: set WALLET_PASSPHRASE_FILE, or start signerd attached to a terminal");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const muted = (rl as unknown as { output: NodeJS.WriteStream & { muted?: boolean } }).output;
  const write = muted.write.bind(muted);
  (muted as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) =>
    muted.muted ? true : write(chunk);
  process.stdout.write("keystore passphrase: ");
  muted.muted = true;
  const answer = await new Promise<string>(resolve => rl.question("", resolve));
  muted.muted = false;
  process.stdout.write("\n");
  rl.close();
  return answer;
}

const mnemonic = await loadMnemonic();

/** Group- or world-writable is fatal on mainnet, a warning elsewhere. */
const permissionNotes: Array<{ level: "ok" | "warn"; detail: string }> = [];
function checkFileMode(label: string, file: string) {
  if (!existsSync(file)) return;
  if (process.platform === "win32") {
    // A check that could not run is not a check that passed.
    permissionNotes.push({ level: "warn", detail: `${label}: not checked — Windows mode bits do not carry this meaning; verify the ACL by hand` });
    return;
  }
  const mode = statSync(file).mode & 0o777;
  if (!(mode & 0o022)) return permissionNotes.push({ level: "ok", detail: `${label}: mode ${mode.toString(8)}` });
  const msg = `${label} ${file} is writable by group or other (mode ${mode.toString(8)})`;
  if (IS_MAINNET) fail(`refusing to run on ${NETWORK}: ${msg}`);
  permissionNotes.push({ level: "warn", detail: msg });
}

/** Caps are bare integers, so a preprod file means something very different against real ADA. */
function assertPolicyNetwork(p: Policy) {
  if (p.network && p.network !== NETWORK)
    throw new Error(`policy declares network "${p.network}" but CARDANO_NETWORK is "${NETWORK}"`);
  if (IS_MAINNET && !p.network)
    throw new Error(`refusing to run on ${NETWORK} with a policy that does not declare "network": "${NETWORK}"`);
}

let policy: Policy;
let policyMtimeMs = -1;
function readPolicy(): Policy {
  const next = parsePolicy(JSON.parse(readFileSync(POLICY_FILE, "utf8")));
  assertPolicyNetwork(next);
  return next;
}
/**
 * Re-reads only when the file changed. A parse failure belongs to the caller and is fatal to the
 * request rather than to the process: an unreadable policy must never mean an unlimited one.
 */
function refreshPolicy(): Policy {
  const mtime = statSync(POLICY_FILE).mtimeMs;
  if (mtime === policyMtimeMs) return policy;
  const next = readPolicy();
  policy = next;
  policyMtimeMs = mtime;
  return policy;
}

try {
  policy = readPolicy();
  policyMtimeMs = statSync(POLICY_FILE).mtimeMs;
} catch (e) {
  fail(String(e instanceof Error ? e.message : e));
}
checkFileMode("policy", POLICY_FILE);
checkFileMode("audit", AUDIT_FILE);
if (MNEMONIC_FILE) checkFileMode("mnemonic", MNEMONIC_FILE);
if (KEYSTORE_FILE) checkFileMode("keystore", KEYSTORE_FILE);
if (PASSPHRASE_FILE) checkFileMode("passphrase", PASSPHRASE_FILE);

/**
 * The cap is computed from this checkpoint, not from the audit log. The log is chained, and the
 * checkpoint records where in that chain it was written, so each can detect the other's loss:
 * `npm run integrity` is the executable version of what that does and does not cover.
 */
const ledger: SpendRecord[] = [];
let auditSeq = 0;
let auditPrevHash = "";
let replayedSkipped = 0;
const openPending: Array<{ id: string; agentId: string; reason?: string }> = [];
const AUDIT_TAIL_BYTES = 1 << 16;

function readCheckpoint(): Checkpoint | undefined {
  if (!existsSync(LEDGER_FILE)) return undefined;
  try {
    const c = JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as Checkpoint;
    if (c.version !== 1 || !Array.isArray(c.spends)) throw new Error("unrecognized checkpoint shape");
    if (!Number.isInteger(c.seq) || typeof c.hash !== "string") throw new Error("checkpoint has no chain position");
    return c;
  } catch (e) {
    fail(`ledger checkpoint ${resolvePath(LEDGER_FILE)} is unreadable: ${e instanceof Error ? e.message : e}`);
  }
}

/** Atomic: a torn write is indistinguishable from a tampered one. */
function writeCheckpoint() {
  const body: Checkpoint = {
    version: 1,
    seq: auditSeq,
    hash: auditPrevHash,
    updatedAt: Date.now(),
    spends: ledger.map(r => ({ ts: r.ts, agentId: r.agentId, asset: r.asset, amount: r.amount.toString() })),
  };
  const tmp = `${LEDGER_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  renameSync(tmp, LEDGER_FILE);
}

/**
 * A crash during an append leaves a line with no terminating newline, and the next record would be
 * written onto the end of it — merging two records into one line that never parses again, so a
 * committed spend becomes invisible to every later replay. The partial line was never completed,
 * so cutting it off loses nothing that was written.
 */
function repairTornAppend() {
  if (!existsSync(AUDIT_FILE)) return;
  const size = statSync(AUDIT_FILE).size;
  if (size === 0) return;
  const fd = openSync(AUDIT_FILE, "r+");
  try {
    const want = Math.min(size, AUDIT_TAIL_BYTES);
    const tail = Buffer.alloc(want);
    const read = readSync(fd, tail, 0, want, size - want);
    if (read === 0 || tail[read - 1] === 0x0a) return;
    const lastNewline = tail.subarray(0, read).lastIndexOf(0x0a);
    if (lastNewline === -1 && size > want) return; // a single line longer than the tail: leave it
    const keep = lastNewline === -1 ? 0 : size - read + lastNewline + 1;
    ftruncateSync(fd, keep);
    console.error(`signerd: audit ended mid-record; dropped ${size - keep} unterminated byte(s)`);
  } finally {
    closeSync(fd);
  }
}

repairTornAppend();
{
  const checkpoint = readCheckpoint();
  const lines = existsSync(AUDIT_FILE)
    ? createInterface({ input: createReadStream(AUDIT_FILE, "utf8"), crlfDelay: Infinity })
    : [];
  const replay = await replayAudit(lines, { checkpoint, windowMs: LEDGER_WINDOW_MS });

  const where = resolvePath(AUDIT_FILE);
  const escape = "Set ALLOW_UNVERIFIED_AUDIT=1 to start anyway.";
  if (!ALLOW_UNVERIFIED_AUDIT) {
    if (replay.malformedAt !== undefined) fail(`audit ${where} line ${replay.malformedAt} is malformed. ${escape}`);
    if (replay.chainBrokenAt !== undefined)
      fail(`audit ${where} line ${replay.chainBrokenAt} does not follow the record before it; the log has been rewritten. ${escape}`);
    if (checkpoint && !replay.sawCheckpoint)
      fail(
        `audit ${where} no longer contains record #${checkpoint.seq}, which the ledger checkpoint was written against. ` +
          `Rotation must keep everything from the last checkpointed record onward. ${escape} Recorded spends come from the checkpoint either way.`,
      );
  }
  if (!checkpoint && replay.hasRecords)
    console.error(`signerd: no ledger checkpoint yet; rebuilding the 24h window from the audit log`);

  auditSeq = replay.lastSeq;
  auditPrevHash = replay.lastHash;
  replayedSkipped = replay.skipped;
  ledger.push(...replay.spends);
  openPending.push(...replay.openApprovals);
}

/** Appended in time order, so what has expired is always a prefix. */
function pruneLedger(now = Date.now()) {
  const cutoff = now - LEDGER_WINDOW_MS;
  let drop = 0;
  while (drop < ledger.length && ledger[drop].ts < cutoff) drop++;
  if (drop) ledger.splice(0, drop);
}

/**
 * Budget held by a queued approval, counted as spend until it resolves: queuing two requests must
 * not be a way to promise the same budget twice.
 */
const reserved = new Map<string, SpendRecord>();
const effectiveLedger = (): readonly SpendRecord[] =>
  reserved.size === 0 ? ledger : [...ledger, ...reserved.values()];

const auditFd = openSync(AUDIT_FILE, "a");
/** Every record passes through here, so it is also where they are counted for /metrics. */
const eventCounts = new Map<string, number>();
let unauthorizedRequests = 0;

function audit(event: string, data: Record<string, unknown>) {
  eventCounts.set(event, (eventCounts.get(event) ?? 0) + 1);
  // `seq` and `prev` chain the log: a removed or edited record stops matching the one after it.
  const entry = { ts: Date.now(), seq: ++auditSeq, prev: auditPrevHash, event, ...data };
  const line = JSON.stringify(entry, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  writeSync(auditFd, line + "\n");
  fsyncSync(auditFd); // an audit record lost in a crash is not an audit record
  auditPrevHash = sha256(line);
  return entry;
}

// A SIGKILL cannot drain the approval queue the way a signal handler does, so anything a previous
// run left open is closed here rather than staying a `pending` nothing ever answers.
for (const abandoned of openPending)
  audit("pending_abandoned", { id: abandoned.id, agentId: abandoned.agentId, reason: abandoned.reason });
if (openPending.length)
  console.error(`signerd: closed ${openPending.length} approval request(s) left open by a previous run`);

// Now, not at the next payment: an idle wallet would otherwise sit with no checkpoint at all, and
// so with nothing protecting the cap.
writeCheckpoint();

const signer: ClientCardanoSigner = toClientCardanoSigner({
  mnemonic,
  network: NETWORK,
  provider: providerConfig(),
  // Masumi collateral scales with datum size, and the datum carries the seller's own bytes: with
  // no ceiling, the seller chooses how much this wallet locks.
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
 * What the wallet holds. The daily cap bounds an agent, not someone holding the key — only the
 * balance does that. Cached so a metrics scrape never waits on a rate-limited provider.
 */
let hotBalance: bigint | undefined;
let hotBalanceAt = 0;
let hotBalanceError: string | undefined;
let balanceInFlight = false;

async function refreshBalance() {
  if (balanceInFlight) return; // a slow provider must not stack up one request per interval
  balanceInFlight = true;
  try {
    const preprod = NETWORK.endsWith("preprod");
    let lovelace: bigint;
    if (process.env.BLOCKFROST_PROJECT_ID) {
      const r = await fetch(`https://cardano-${preprod ? "preprod" : "mainnet"}.blockfrost.io/api/v0/addresses/${address}`, {
        headers: { project_id: process.env.BLOCKFROST_PROJECT_ID },
      });
      if (!r.ok) throw new Error(`blockfrost ${r.status}`);
      const body = (await r.json()) as { amount?: Array<{ unit: string; quantity: string }> };
      lovelace = BigInt(body.amount?.find(a => a.unit === "lovelace")?.quantity ?? "0");
    } else {
      const r = await fetch(`${preprod ? "https://preprod.koios.rest" : "https://api.koios.rest"}/api/v1/address_info`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(process.env.KOIOS_TOKEN ? { authorization: `Bearer ${process.env.KOIOS_TOKEN}` } : {}) },
        body: JSON.stringify({ _addresses: [address] }),
      });
      if (!r.ok) throw new Error(`koios ${r.status}`);
      const rows = (await r.json()) as Array<{ balance?: string }>;
      lovelace = BigInt(rows[0]?.balance ?? "0");
    }
    hotBalance = lovelace;
    hotBalanceAt = Date.now();
    hotBalanceError = undefined;
  } catch (e) {
    hotBalanceError = String(e instanceof Error ? e.message : e);
  } finally {
    balanceInFlight = false;
  }
}
void refreshBalance();
setInterval(refreshBalance, 60_000).unref();

/**
 * Two locks, because two things need ordering. The agent lock spans "decide, then record the
 * spend" — building the transaction queries the chain, so without it two concurrent requests read
 * the same pre-spend ledger and both pass a cap that fits one. The wallet lock spans signing, which
 * belongs to the key rather than the agent: one wallet, one UTXO set. `npm run concurrency`.
 */
const withAgentLock = createKeyedLock();
const withWalletLock = createLock();

/**
 * UTXOs committed to a handed-out payment that has not settled. The facilitator broadcasts, so
 * settlement is never reported back here — which is why the hold is short: a failed settlement
 * would otherwise wedge the wallet, and the ledger, not this, is what bounds spending.
 */
const inflightNonces = new Map<string, number>();
function claimNonce(nonce: string, ttlSeconds: number): boolean {
  const now = Date.now();
  for (const [n, expiry] of inflightNonces) if (expiry <= now) inflightNonces.delete(n);
  if (inflightNonces.has(nonce)) return false;
  inflightNonces.set(nonce, now + ttlSeconds * 1000);
  return true;
}

/** `maxTimeoutSeconds` comes from the seller's 402: unclamped, zero times out every approval. */
const approvalWindow = (input: ClientCardanoSignInput) =>
  Math.max(30, Math.min(input.maxTimeoutSeconds ?? 300, MAX_APPROVAL_SECONDS));

async function sign(agentId: string, reason: string, input: ClientCardanoSignInput) {
  return withWalletLock(async () => {
    const res = await signer.buildAndSignPaymentTransaction(input);
    if (!claimNonce(res.nonce, Math.min(approvalWindow(input), NONCE_HOLD_SECONDS))) {
      audit("nonce_collision", { agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, nonce: res.nonce });
      throw new Error(`utxo ${res.nonce} is already committed to an unsettled payment; retry once it settles`);
    }
    ledger.push({ ts: Date.now(), agentId, asset: input.asset, amount: BigInt(input.amount) });
    pruneLedger();
    audit("signed", { agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, nonce: res.nonce, network: input.network });
    writeCheckpoint(); // after the audit record, so the checkpoint names it
    return res;
  });
}

interface Pending {
  id: string;
  createdAt: number;
  agentId: string;
  reason: string;
  input: ClientCardanoSignInput;
  /** Cleared when the request resolves, so a settled approval stops holding the event loop open. */
  timer: NodeJS.Timeout;
  resolve: (v: { transaction: string; nonce: string } | { denied: string }) => void;
}
const pending = new Map<string, Pending>();

type Settled = { transaction: string; nonce: string } | { denied: string };
type SignOutcome =
  | { kind: "deny"; rule: string; detail: string }
  | { kind: "signed"; out: { transaction: string; nonce: string } }
  | { kind: "error"; error: unknown }
  | { kind: "queued"; id: string; settled: Promise<Settled> };

let shuttingDown = false;

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!authorized(req.headers.authorization)) {
    unauthorizedRequests++;
    return json(res, 401, { error: "unauthorized" });
  }
  if (shuttingDown) return json(res, 503, { error: "shutting_down" });
  const url = new URL(req.url ?? "/", "http://localhost");
  const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};

  if (req.method === "GET" && url.pathname === "/status") {
    let current: Policy;
    try {
      current = refreshPolicy();
    } catch (e) {
      return json(res, 503, { error: "policy_unreadable", detail: String(e instanceof Error ? e.message : e) });
    }
    const agents: Record<string, unknown> = {};
    for (const id of Object.keys(current.agents)) agents[id] = remaining(current, effectiveLedger(), id);
    return json(res, 200, { address, network: NETWORK, agents, pending: pending.size });
  }

  if (req.method === "GET" && url.pathname === "/preflight") return json(res, 200, preflight());

  if (req.method === "GET" && url.pathname === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    return res.end(metrics());
  }

  if (req.method === "POST" && url.pathname === "/sign") {
    const { agentId, reason, resource, input } = body as {
      agentId: string;
      reason: string;
      resource?: string;
      input: ClientCardanoSignInput;
    };
    if (!agentId || !input?.payTo || !input?.asset || !input?.amount)
      return json(res, 400, { error: "agentId, reason, input{payTo,asset,amount} required" });
    // Otherwise BigInt() turns the caller's mistake into a 500.
    if (typeof input.amount !== "string" || !/^[0-9]+$/.test(input.amount))
      return json(res, 400, { error: "input.amount must be a decimal integer string" });
    if (typeof input.payTo !== "string" || typeof input.asset !== "string")
      return json(res, 400, { error: "input.payTo and input.asset must be strings" });

    // Everything from reading the ledger to recording the spend runs under this agent's lock.
    const outcome = await withAgentLock(agentId, async (): Promise<SignOutcome> => {
      let current: Policy;
      try {
        current = refreshPolicy();
      } catch (e) {
        // An unreadable policy is not a permissive one.
        const detail = String(e instanceof Error ? e.message : e);
        audit("policy_error", { agentId, reason, detail });
        return { kind: "deny", rule: "policy_unreadable", detail };
      }
      const method = input.extra?.assetTransferMethod;
      const d = decide(current, effectiveLedger(), {
        agentId,
        payTo: input.payTo,
        asset: input.asset,
        amount: BigInt(input.amount),
        reason,
        assetTransferMethod: typeof method === "string" ? method : undefined,
        resource: typeof resource === "string" ? resource : undefined,
      });

      if (d.verdict === "deny") {
        audit("denied", { agentId, reason, resource, payTo: input.payTo, asset: input.asset, amount: input.amount, rule: d.rule, detail: d.detail });
        return { kind: "deny", rule: d.rule, detail: d.detail };
      }

      if (d.verdict === "needs_approval") {
        const id = randomUUID().slice(0, 8);
        // Hold the budget, release the lock: a human may take minutes.
        reserved.set(id, { ts: Date.now(), agentId, asset: input.asset, amount: BigInt(input.amount) });
        audit("pending", { id, agentId, reason, resource, payTo: input.payTo, asset: input.asset, amount: input.amount, detail: d.detail });
        const settled = new Promise<Settled>(resolve => {
          const timer = setTimeout(() => {
            if (pending.delete(id)) {
              reserved.delete(id);
              audit("approval_timeout", { id, agentId, reason, asset: input.asset, amount: input.amount });
              resolve({ denied: "approval timed out" });
            }
          }, approvalWindow(input) * 1000);
          pending.set(id, { id, createdAt: Date.now(), agentId, reason, input, timer, resolve });
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
    clearTimeout(p.timer);
    if (url.pathname === "/deny") {
      reserved.delete(p.id);
      audit("approval_denied", { id: p.id, agentId: p.agentId });
      p.resolve({ denied: "denied by operator" });
      return json(res, 200, { ok: true });
    }
    try {
      // Drop the reservation only after signing has recorded the real spend.
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

type Sample = [labels: string, value: string | number];

/** Prometheus exposition, behind the same bearer token: what this wallet has spent is not public. */
function metrics(): string {
  const out: string[] = [];
  const series = (name: string, help: string, type: "counter" | "gauge", samples: Sample[]) => {
    if (samples.length === 0) return;
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) out.push(labels ? `${name}{${labels}} ${value}` : `${name} ${value}`);
  };
  const one = (name: string, help: string, type: "counter" | "gauge", value: string | number) =>
    series(name, help, type, [["", value]]);
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  one("ada_wallet_up", "1 when signerd is serving.", "gauge", 1);
  series("ada_wallet_audit_events_total", "Audit records written since this process started, by event.", "counter",
    [...eventCounts].map(([event, n]): Sample => [`event="${esc(event)}"`, n]));
  one("ada_wallet_unauthorized_requests_total", "Requests rejected for a bad or missing bearer token.", "counter", unauthorizedRequests);
  one("ada_wallet_audit_seq", "Sequence number of the last audit record.", "gauge", auditSeq);
  one("ada_wallet_pending_approvals", "Payments waiting on a human right now.", "gauge", pending.size);
  one("ada_wallet_inflight_utxos", "UTXOs committed to a handed-out payment that has not settled.", "gauge", inflightNonces.size);
  if (hotBalance !== undefined) {
    one("ada_wallet_balance_lovelace", "Lovelace held by the wallet, as of the last refresh.", "gauge", hotBalance.toString());
    one("ada_wallet_balance_age_seconds", "Seconds since the balance was last refreshed.", "gauge", Math.round((Date.now() - hotBalanceAt) / 1000));
  }
  if (MAX_HOT_BALANCE !== undefined) {
    one("ada_wallet_balance_ceiling_lovelace", "Configured ceiling on what this hot wallet should hold.", "gauge", MAX_HOT_BALANCE.toString());
    one("ada_wallet_balance_over_ceiling", "1 when the wallet holds more than the configured ceiling.", "gauge",
      hotBalance !== undefined && hotBalance > MAX_HOT_BALANCE ? 1 : 0);
  }

  let current: Policy;
  try {
    current = refreshPolicy();
  } catch {
    one("ada_wallet_policy_readable", "1 when the policy file parses.", "gauge", 0);
    return out.join("\n") + "\n";
  }
  one("ada_wallet_policy_readable", "1 when the policy file parses.", "gauge", 1);

  const spent: Sample[] = [];
  const capped: Sample[] = [];
  const over: Sample[] = [];
  for (const agentId of Object.keys(current.agents)) {
    const r = remaining(current, effectiveLedger(), agentId);
    if (!r) continue;
    for (const [asset, a] of Object.entries(r.assets)) {
      const labels = `agent="${esc(agentId)}",asset="${esc(asset)}"`;
      spent.push([labels, a.dailySpent]);
      capped.push([labels, a.dailyMax]);
      over.push([labels, a.overBudget ? 1 : 0]);
    }
  }
  series("ada_wallet_daily_spent", "Spent in the rolling 24h window, smallest unit of the asset.", "gauge", spent);
  series("ada_wallet_daily_max", "The 24h cap, smallest unit of the asset.", "gauge", capped);
  series("ada_wallet_over_budget", "1 when the 24h cap has been exceeded.", "gauge", over);
  return out.join("\n") + "\n";
}

type CheckLevel = "ok" | "warn" | "fail";

/** What to look at before this wallet holds anything you would miss. */
function preflight() {
  const checks: Array<{ level: CheckLevel; check: string; detail: string }> = [];
  const add = (level: CheckLevel, check: string, detail: string) => checks.push({ level, check, detail });

  let current: Policy | undefined;
  try {
    current = refreshPolicy();
    add("ok", "policy readable", resolvePath(POLICY_FILE));
  } catch (e) {
    add("fail", "policy readable", String(e instanceof Error ? e.message : e));
  }

  add(
    current?.network ? "ok" : IS_MAINNET ? "fail" : "warn",
    "policy declares its network",
    current?.network ?? "absent; caps carry no unit, so this file cannot tell preprod from mainnet",
  );

  for (const note of permissionNotes) add(note.level, "file permissions", note.detail);

  add(
    KEYSTORE_FILE ? "ok" : IS_MAINNET ? "fail" : "warn",
    "key at rest",
    KEYSTORE_FILE
      ? `passphrase-encrypted keystore (${resolvePath(KEYSTORE_FILE)})`
      : process.env.WALLET_MNEMONIC
        ? "WALLET_MNEMONIC: the mnemonic is in the environment, readable by anything that can read this process"
        : "WALLET_MNEMONIC_FILE: the mnemonic is plaintext on disk; anyone who can read the file has the wallet",
  );
  if (KEYSTORE_FILE && PASSPHRASE_FILE && dirname(resolvePath(KEYSTORE_FILE)) === dirname(resolvePath(PASSPHRASE_FILE)))
    add("warn", "keystore passphrase", "the passphrase file sits in the same directory as the keystore, so one directory still yields the wallet");
  else if (KEYSTORE_FILE)
    add("ok", "keystore passphrase", PASSPHRASE_FILE ? resolvePath(PASSPHRASE_FILE) : "prompted on the terminal at startup");

  if (MAX_HOT_BALANCE === undefined) {
    add(IS_MAINNET ? "fail" : "warn", "hot wallet ceiling",
      "MAX_HOT_BALANCE_LOVELACE is unset. The daily cap bounds an agent; nothing here bounds what someone with the key can take, except how much is in the wallet");
  } else if (hotBalance === undefined) {
    add("warn", "hot wallet ceiling", `ceiling ${MAX_HOT_BALANCE} lovelace, but the balance could not be read${hotBalanceError ? ` (${hotBalanceError})` : ""}`);
  } else {
    add(hotBalance > MAX_HOT_BALANCE ? (IS_MAINNET ? "fail" : "warn") : "ok", "hot wallet ceiling",
      `holding ${hotBalance} of a ${MAX_HOT_BALANCE} lovelace ceiling`);
  }

  const cp = existsSync(LEDGER_FILE);
  add(cp ? "ok" : ledger.length ? "warn" : "ok", "spend ledger checkpoint",
    cp
      ? `${resolvePath(LEDGER_FILE)} (seq ${auditSeq})`
      : "not written yet; until the first payment the cap is rebuilt from the audit log alone");
  add(ALLOW_UNVERIFIED_AUDIT ? "warn" : "ok", "audit chain enforcement",
    ALLOW_UNVERIFIED_AUDIT
      ? "ALLOW_UNVERIFIED_AUDIT=1 — a rewritten or truncated audit log is accepted instead of refused"
      : "a rewritten or truncated audit log refuses to start");

  add(
    process.env.BLOCKFROST_PROJECT_ID || !IS_MAINNET ? "ok" : "warn",
    "chain provider",
    process.env.BLOCKFROST_PROJECT_ID
      ? "blockfrost: transaction evidence available, so a facilitator on it can require confirmations"
      : IS_MAINNET
        ? "koios: a free public service with no SLA, and no evidence hook — so a facilitator on it can only settle at l1Confirmations 0. As a buyer the confirmation policy is the seller's choice, but the rate limits are yours"
        : "koios: no evidence hook, so a facilitator on it can only settle at l1Confirmations 0",
  );

  for (const [id, ap] of Object.entries(current?.agents ?? {})) {
    const where = `agent ${id}`;
    const anyPayee = ap.allowedPayees.includes("*");
    add(anyPayee ? "warn" : "ok", `${where}: payee allowlist`,
      anyPayee ? '["*"] accepts any payee' : `${ap.allowedPayees.length} payee(s)`);
    // `["*"]` is exactly as permissive as leaving it out, so reporting it as a configured
    // allowlist tells the operator they are covered when they are not.
    const anyResource = !ap.allowedResources || ap.allowedResources.includes("*");
    add(anyResource ? "warn" : "ok", `${where}: resource allowlist`,
      !ap.allowedResources
        ? "absent; this agent may buy from any URL it is pointed at"
        : ap.allowedResources.includes("*")
          ? '["*"] accepts any URL, which is the same as having no list'
          : `${ap.allowedResources.length} pattern(s)`);

    // An empty object is truthy and would have passed. So would a threshold covering one asset out
    // of several, silently leaving the rest with no gate at all.
    const thresholds = Object.entries(ap.approvalAbove ?? {});
    const ungated = Object.keys(ap.perTxMax).filter(a => !(a in (ap.approvalAbove ?? {})));
    add(thresholds.length === 0 ? "warn" : ungated.length ? "warn" : "ok", `${where}: human approval`,
      thresholds.length === 0
        ? "no threshold; nothing this agent does ever reaches a human"
        : ungated.length
          ? `${thresholds.map(([a, v]) => `${a} > ${v}`).join(", ")}; no threshold for ${ungated.join(", ")}`
          : thresholds.map(([a, v]) => `${a} > ${v}`).join(", "));
    const methods = ap.allowedAssetTransferMethods ?? ["default"];
    add(methods.includes("masumi") ? "warn" : "ok", `${where}: asset transfer methods`,
      methods.includes("masumi")
        ? `masumi enabled; its collateral sits outside these caps, bounded only by MASUMI_MAX_COLLATERAL_LOVELACE (${process.env.MASUMI_MAX_COLLATERAL_LOVELACE ?? "unset, so the SDK default"})`
        : methods.join(", "));
  }

  return {
    network: NETWORK,
    address,
    policyFile: resolvePath(POLICY_FILE),
    auditFile: resolvePath(AUDIT_FILE),
    ledgerEntries: ledger.length,
    auditRecordsOutsideWindow: replayedSkipped,
    pending: pending.size,
    checks,
    summary: {
      fail: checks.filter(c => c.level === "fail").length,
      warn: checks.filter(c => c.level === "warn").length,
      ok: checks.filter(c => c.level === "ok").length,
    },
  };
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

const server = createServer((req, res) =>
  handle(req, res).catch(e => {
    // A response already started cannot be replaced, and throwing here would be an unhandled
    // rejection — which in Node exits the daemon over one malformed request.
    console.error(`signerd: request failed: ${e instanceof Error ? e.message : e}`);
    try {
      if (res.headersSent) res.end();
      else json(res, 500, { error: String(e) });
    } catch {
      res.destroy();
    }
  }),
);

/**
 * Refuse new work, answer anyone waiting on an approval, let a signature in flight finish, flush.
 */
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`signerd: ${signal} received, shutting down`);
  server.close();
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    reserved.delete(p.id);
    audit("shutdown_denied", { id: p.id, agentId: p.agentId, reason: p.reason });
    p.resolve({ denied: "signerd shut down before this request was approved" });
  }
  pending.clear();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    fsyncSync(auditFd);
    closeSync(auditFd);
    process.exit(0);
  };
  // Let the verdicts just handed to waiting callers reach the wire, and any signature in progress
  // finish — neither allowed to hang the shutdown.
  server.close(() => void withWalletLock(async () => {}).then(finish));
  server.closeIdleConnections?.();
  setTimeout(finish, 10_000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, "127.0.0.1", () => {
  console.error(`signerd listening on 127.0.0.1:${PORT}  network=${NETWORK}  address=${address}`);
  console.error(`policy: ${resolvePath(POLICY_FILE)}`);
  console.error(`audit:  ${resolvePath(AUDIT_FILE)}  (chain at #${auditSeq}, ${replayedSkipped} records older than the window)`);
  console.error(`ledger: ${resolvePath(LEDGER_FILE)}  (${ledger.length} spends inside the 24h window)`);
  console.error(`agents: ${Object.keys(policy.agents).join(", ")}`);
  console.error(`key:    ${KEYSTORE_FILE ? "encrypted keystore" : "plaintext mnemonic"}`);
  for (const note of permissionNotes) console.error(`  ${note.level === "warn" ? "WARNING " : ""}${note.detail}`);
  console.error(`neither the policy nor the audit file may be writable by the agent's user`);
  console.error(`run "walletctl preflight" before pointing this at real money`);
});
