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
 *                  409 utxo_busy: the wallet's UTXO is committed to a payment that has not settled
 *                  yet, which on a single-UTXO wallet any second payment hits. Retryable.
 *                  409 insufficient_funds: the wallet does not hold the asset. Not retryable.
 *   GET  /pending                      -> approval queue
 *   POST /approve  {id}                -> signs the queued request, if the policy still allows it
 *   POST /deny     {id}
 *
 * None of POLICY_FILE, AUDIT_FILE or LEDGER_FILE may be writable by the agent's user: between them
 * they are the limits, the spending they are measured against, and the checkpoint the cap is
 * computed from. See README, "Before mainnet".
 *
 * Env:
 *   WALLET_KEYSTORE_FILE    passphrase-encrypted mnemonic (preferred; see scripts/keystore.ts)
 *   WALLET_PASSPHRASE_FILE  where to read its passphrase; otherwise prompted on a terminal
 *   WALLET_MNEMONIC_FILE    plaintext mnemonic on disk
 *   WALLET_MNEMONIC         plaintext mnemonic in the environment (worst of the three)
 *   MAX_HOT_BALANCE_LOVELACE  what this wallet should never exceed; preflight fails without it
 *   CARDANO_NETWORK   cardano:preprod | cardano:preview | cardano:mainnet   (default preprod)
 *   BLOCKFROST_PROJECT_ID   optional; without it the daemon uses Koios (free, no key)
 *   KOIOS_TOKEN             optional
 *   POLICY_FILE       default ./policy.json
 *   AUDIT_FILE        default ./audit.jsonl   (append-only log; chained)
 *   LEDGER_FILE       default ./ledger.json  (the spend state the cap is computed from)
 *   ALLOW_UNVERIFIED_AUDIT  set to 1 to start when the audit chain no longer covers the checkpoint
 *                           (a deliberate rotation). It waives the check, not the ledger: recorded
 *                           spends come from the checkpoint and survive.
 *   SIGNERD_PORT      default 7402
 *   SIGNERD_TOKEN     the operator's secret (required)
 *   AGENT_TOKENS_FILE JSON of {"<token>": "<agentId>"}. Without it `agentId` is whatever the
 *                     caller says it is, so the per-agent split is a convention rather than a
 *                     boundary; with it, a token is an identity and cannot claim another.
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
import { toClientCardanoSigner, decodeCardanoTransaction, type ClientCardanoSignInput, type ClientCardanoSigner } from "@x402/cardano";
import { decide, parsePolicy, remaining, type Policy, type SpendRecord } from "./policy.js";
import { createKeyedLock, createLock } from "./serialize.js";
import { replayAudit, sha256, type Checkpoint } from "./replay.js";
import { mismatch } from "./verifyTx.js";
import { decryptMnemonic, assertKeystore } from "./keystore.js";
import { blockfrostBaseUrl, koiosBaseUrl, networkName, sameNetwork } from "./network.js";

const PORT = Number(process.env.SIGNERD_PORT ?? 7402);
const TOKEN = process.env.SIGNERD_TOKEN;
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
const POLICY_FILE = process.env.POLICY_FILE ?? "./policy.json";
const AUDIT_FILE = process.env.AUDIT_FILE ?? "./audit.jsonl";
const LEDGER_FILE = process.env.LEDGER_FILE ?? "./ledger.json";
const ALLOW_UNVERIFIED_AUDIT = process.env.ALLOW_UNVERIFIED_AUDIT === "1";
const MNEMONIC_FILE = process.env.WALLET_MNEMONIC_FILE;
const AGENT_TOKENS_FILE = process.env.AGENT_TOKENS_FILE;
const KEYSTORE_FILE = process.env.WALLET_KEYSTORE_FILE;
const PASSPHRASE_FILE = process.env.WALLET_PASSPHRASE_FILE;
const MAX_HOT_BALANCE = process.env.MAX_HOT_BALANCE_LOVELACE ? BigInt(process.env.MAX_HOT_BALANCE_LOVELACE) : undefined;
const MAX_BODY_BYTES = 1 << 20;
/**
 * Caps on the free text a caller can put into the audit log.
 *
 * `reason` is written verbatim for every decision, including denied ones, and the log is replayed
 * and hash-chained at every start. Unbounded, a single refused request wrote half a megabyte of it
 * here, and refusal costs an agent nothing, so there was no limit on how much an agent could make
 * this file weigh. A reason is a sentence.
 */
const MAX_REASON = 1000;
const MAX_RESOURCE = 2048;
const MAX_AGENT_ID = 64;
// Also audited verbatim, and with `allowedPayees: ["*"]` nothing else bounds them. A bech32
// Cardano address is about 103 characters; a canonical asset id is at most 121.
const MAX_PAY_TO = 200;
const MAX_ASSET = 130;
/**
 * The longest a queued `/sign` is held open. The caller's HTTP client sets the real ceiling: Node's
 * fetch gives up waiting for response headers after 300s, and when a caller goes away the request
 * is withdrawn from the queue rather than signed into the void (see `closePending`).
 */
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
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail(`SIGNERD_PORT must be a port number, got "${process.env.SIGNERD_PORT}"`);
// Resolved once, so "is this mainnet" is a fact about a known chain and not a suffix match that
// would read `cardano:preview` as mainnet's opposite and point it at mainnet's providers.
const IS_MAINNET = (() => {
  try {
    return networkName(NETWORK) === "mainnet";
  } catch (e) {
    return fail(`CARDANO_NETWORK: ${e instanceof Error ? e.message : e}`);
  }
})();

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

/** token -> agentId. Empty unless AGENT_TOKENS_FILE is set. */
const agentTokens = new Map<string, string>();
if (AGENT_TOKENS_FILE) {
  try {
    const raw = JSON.parse(readFileSync(AGENT_TOKENS_FILE, "utf8")) as Record<string, string>;
    for (const [token, agentId] of Object.entries(raw)) {
      if (typeof token !== "string" || token.length < 16) throw new Error(`a token shorter than 16 characters is not one`);
      if (typeof agentId !== "string" || !agentId) throw new Error(`token for "${agentId}" names no agent`);
      if (token === TOKEN) throw new Error(`the operator token cannot also be an agent's`);
      agentTokens.set(token, agentId);
    }
    if (agentTokens.size === 0) throw new Error("no tokens in it");
  } catch (e) {
    fail(`agent tokens ${resolvePath(AGENT_TOKENS_FILE)}: ${e instanceof Error ? e.message : e}`);
  }
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
if (AGENT_TOKENS_FILE) checkFileMode("agent tokens", AGENT_TOKENS_FILE);
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
/** Everything except one request's own reservation, for judging that request again. */
const ledgerExcluding = (id: string): readonly SpendRecord[] => [
  ...ledger,
  ...[...reserved].filter(([held]) => held !== id).map(([, spend]) => spend),
];

const auditFd = openSync(AUDIT_FILE, "a");
/** Every record passes through here, so it is also where they are counted for /metrics. */
const eventCounts = new Map<string, number>();
let unauthorizedRequests = 0;
/** Requests refused before they were worth auditing; nothing else would show them. */
let badRequests = 0;

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
// After the write, so a first start has a file to check. The cap is computed from this checkpoint,
// and an agent that can rewrite it rewrites its own spend.
checkFileMode("ledger", LEDGER_FILE);

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
  if (process.env.BLOCKFROST_PROJECT_ID) {
    return { blockfrost: { baseUrl: blockfrostBaseUrl(NETWORK), projectId: process.env.BLOCKFROST_PROJECT_ID } };
  }
  return { koios: { baseUrl: koiosBaseUrl(NETWORK), token: process.env.KOIOS_TOKEN } };
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
    let lovelace: bigint;
    if (process.env.BLOCKFROST_PROJECT_ID) {
      const r = await fetch(`${blockfrostBaseUrl(NETWORK)}/addresses/${address}`, {
        headers: { project_id: process.env.BLOCKFROST_PROJECT_ID },
      });
      if (!r.ok) throw new Error(`blockfrost ${r.status}`);
      const body = (await r.json()) as { amount?: Array<{ unit: string; quantity: string }> };
      lovelace = BigInt(body.amount?.find(a => a.unit === "lovelace")?.quantity ?? "0");
    } else {
      const r = await fetch(`${koiosBaseUrl(NETWORK)}/address_info`, {
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

/**
 * `maxTimeoutSeconds` comes from the seller's 402: unclamped, zero times out every approval, and
 * a non-number would make the timer NaN — which fires at once — and the nonce hold NaN, which
 * never expires.
 */
const approvalWindow = (input: ClientCardanoSignInput) => {
  const asked = typeof input.maxTimeoutSeconds === "number" && Number.isFinite(input.maxTimeoutSeconds) ? input.maxTimeoutSeconds : 300;
  return Math.max(30, Math.min(asked, MAX_APPROVAL_SECONDS));
};

/** A failure that has already written its own audit record, so `sign_error` need not repeat it. */
class AuditedError extends Error {}

/**
 * Not a failure: the wallet's UTXO is committed to a payment that has not settled yet, and the
 * same request will work once it does. Worth its own type so the caller is told to retry rather
 * than handed a 500 that reads as "something is broken".
 */
class UtxoBusy extends AuditedError {}

/**
 * The wallet does not hold enough of the asset to build this payment. Also not a failure of the
 * daemon: an x402 endpoint priced in an asset this wallet has never held reaches here, and
 * "something broke" is the wrong thing to tell an agent that needs to stop asking.
 *
 * Matched on the builder's message because the SDK gives it no code of its own. If that message
 * ever changes the condition falls back to a plain 500, which is what it was before.
 */
class InsufficientFunds extends AuditedError {}
const isCoinSelectionFailure = (e: unknown) =>
  e instanceof Error && /coin selection failed/i.test(`${e.message} ${String((e as { cause?: unknown }).cause ?? "")}`);

async function sign(agentId: string, reason: string, input: ClientCardanoSignInput) {
  return withWalletLock(async () => {
    let res: Awaited<ReturnType<typeof signer.buildAndSignPaymentTransaction>>;
    try {
      res = await signer.buildAndSignPaymentTransaction(input);
    } catch (e) {
      if (!isCoinSelectionFailure(e)) throw e;
      audit("insufficient_funds", { agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount });
      throw new InsufficientFunds(`the wallet cannot fund ${input.amount} of ${input.asset}`);
    }
    // Read back what was actually signed before anything commits to it. The policy decided on the
    // request; up to here nothing had looked at the transaction built from it, and the only other
    // party who checks is the facilitator, which is the seller's and has no reason to care whether
    // this wallet also paid someone else.
    let wrong: string | undefined;
    try {
      wrong = mismatch(decodeCardanoTransaction(res.transaction), {
        payTo: input.payTo,
        asset: input.asset,
        amount: input.amount,
        changeTo: address,
        nonce: res.nonce,
        assetTransferMethod: typeof input.extra?.assetTransferMethod === "string" ? input.extra.assetTransferMethod : undefined,
      });
    } catch (e) {
      wrong = `it could not be decoded: ${e instanceof Error ? e.message : e}`;
    }
    if (wrong) {
      audit("transaction_mismatch", { agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, detail: wrong });
      throw new AuditedError(`refusing to hand over a transaction that does not match what was authorised: ${wrong}`);
    }

    if (!claimNonce(res.nonce, Math.min(approvalWindow(input), NONCE_HOLD_SECONDS))) {
      audit("nonce_collision", { agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, nonce: res.nonce });
      throw new UtxoBusy(`utxo ${res.nonce} is already committed to an unsettled payment; retry once it settles`);
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
  /** Kept so the policy can be re-applied at approval time, `allowedResources` included. */
  resource?: string;
  input: ClientCardanoSignInput;
  /** Cleared when the request resolves, so a settled approval stops holding the event loop open. */
  timer: NodeJS.Timeout;
  resolve: (v: { transaction: string; nonce: string } | { denied: string }) => void;
}
const pending = new Map<string, Pending>();

/**
 * Takes a request out of the queue and gives its budget back. Every exit goes through here, so no
 * exit can forget the reservation, the timer, or the caller still waiting on the answer.
 */
function closePending(p: Pending, event: string, verdict: string, extra: Record<string, unknown> = {}) {
  if (!pending.delete(p.id)) return false;
  clearTimeout(p.timer);
  reserved.delete(p.id);
  audit(event, { id: p.id, agentId: p.agentId, reason: p.reason, ...extra });
  p.resolve({ denied: verdict });
  return true;
}

type Settled = { transaction: string; nonce: string } | { denied: string };
type SignOutcome =
  | { kind: "deny"; rule: string; detail: string }
  | { kind: "signed"; out: { transaction: string; nonce: string } }
  | { kind: "error"; error: unknown }
  | { kind: "queued"; id: string; settled: Promise<Settled> };

let shuttingDown = false;

class BadRequest extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** The JSON object a POST carries, or a 4xx: a body that does not parse is the caller's fault. */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequest(400, "body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BadRequest(400, "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const caller = identify(req.headers.authorization);
  if (!caller) {
    unauthorizedRequests++;
    return json(res, 401, { error: "unauthorized" });
  }
  // An agent's token signs and reads its own budget; everything else is the operator's.
  const operatorOnly = caller.kind === "operator";
  if (shuttingDown) return json(res, 503, { error: "shutting_down" });
  const url = new URL(req.url ?? "/", "http://localhost");
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      body = await readJsonObject(req);
    } catch (e) {
      badRequests++;
      if (e instanceof BadRequest) return json(res, e.status, { error: "bad_request", detail: e.message });
      throw e;
    }
  }

  if (req.method === "GET" && url.pathname === "/status") {
    let current: Policy;
    try {
      current = refreshPolicy();
    } catch (e) {
      return json(res, 503, { error: "policy_unreadable", detail: String(e instanceof Error ? e.message : e) });
    }
    // An agent sees its own budget. What the others have spent is not its business, and was in the
    // response until now.
    const visible = operatorOnly ? Object.keys(current.agents) : [caller.agentId];
    const agents: Record<string, unknown> = {};
    for (const id of visible) agents[id] = remaining(current, effectiveLedger(), id);
    return json(res, 200, { address, network: NETWORK, agents, pending: operatorOnly ? pending.size : undefined });
  }

  if (!operatorOnly && url.pathname !== "/sign" && url.pathname !== "/status")
    return json(res, 403, { error: "operator_only", detail: `an agent token cannot call ${url.pathname}` });

  if (req.method === "GET" && url.pathname === "/preflight") return json(res, 200, preflight());

  if (req.method === "GET" && url.pathname === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    return res.end(metrics());
  }

  if (req.method === "POST" && url.pathname === "/sign") {
    const { reason, resource, input } = body as {
      reason: string;
      resource?: string;
      input: ClientCardanoSignInput;
    };
    // Where identity comes from: the token if there is one that means something, the body only
    // when there is not.
    const claimed = (body as { agentId?: string }).agentId;
    // Once tokens mean something, the operator's does not mean "any agent". Operating and paying
    // are different authorities, and the operator already has the policy and the approval queue.
    if (agentTokens.size > 0 && caller.kind === "operator")
      return json(res, 403, { error: "operator_cannot_sign", detail: "signing needs an agent token; the operator token operates" });
    const agentId = caller.kind === "agent" ? caller.agentId : claimed;
    if (caller.kind === "agent" && claimed !== undefined && claimed !== agentId)
      return json(res, 403, { error: "agent_mismatch", detail: `this token signs for ${agentId}, not ${claimed}` });
    if (!agentId || typeof input !== "object" || input === null || !input.payTo || !input.asset || !input.amount)
      return json(res, 400, { error: "agentId, reason, input{payTo,asset,amount} required" });
    // Otherwise BigInt() turns the caller's mistake into a 500.
    if (typeof input.amount !== "string" || !/^[0-9]+$/.test(input.amount))
      return json(res, 400, { error: "input.amount must be a decimal integer string" });
    if (typeof input.payTo !== "string" || typeof input.asset !== "string")
      return json(res, 400, { error: "input.payTo and input.asset must be strings" });
    // The policy reads `reason` as text; anything else would fail inside the lock, as a 500.
    if (reason !== undefined && typeof reason !== "string") return json(res, 400, { error: "reason must be a string" });
    if (input.maxTimeoutSeconds !== undefined && (typeof input.maxTimeoutSeconds !== "number" || !Number.isFinite(input.maxTimeoutSeconds)))
      return json(res, 400, { error: "input.maxTimeoutSeconds must be a number" });
    // The SDK refuses to sign for another chain, but only after the decision has been made and
    // audited as a `sign_error`; a 402 for the wrong network is not an incident, it is a 400.
    if (typeof input.network !== "string" || !sameNetwork(input.network, NETWORK))
      return json(res, 400, { error: "network_mismatch", detail: `this wallet signs for ${NETWORK}, not "${String(input.network)}"` });
    // Refused before anything is written, because writing is the cost being bounded.
    const tooLong =
      (typeof reason === "string" && reason.length > MAX_REASON && `reason (${reason.length} > ${MAX_REASON})`) ||
      (typeof resource === "string" && resource.length > MAX_RESOURCE && `resource (${resource.length} > ${MAX_RESOURCE})`) ||
      (typeof agentId === "string" && agentId.length > MAX_AGENT_ID && `agentId (${agentId.length} > ${MAX_AGENT_ID})`) ||
      (input.payTo.length > MAX_PAY_TO && `input.payTo (${input.payTo.length} > ${MAX_PAY_TO})`) ||
      (input.asset.length > MAX_ASSET && `input.asset (${input.asset.length} > ${MAX_ASSET})`);
    if (tooLong) {
      badRequests++;
      return json(res, 400, { error: "too_long", detail: `${tooLong} — it goes verbatim into an append-only log` });
    }

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
          const entry: Pending = {
            id,
            createdAt: Date.now(),
            agentId,
            reason,
            resource: typeof resource === "string" ? resource : undefined,
            input,
            timer: setTimeout(() => closePending(entry, "approval_timeout", "approval timed out", { asset: input.asset, amount: input.amount }), approvalWindow(input) * 1000),
            resolve,
          };
          pending.set(id, entry);
          // The answer has one recipient: the request that is still open. Node's fetch stops waiting
          // for headers after 300s, and an approval signed after the caller has gone records a spend
          // for a transaction nobody will ever broadcast — so a caller that leaves takes its request
          // with it, and its budget comes back.
          res.on("close", () => {
            if (!res.writableFinished) closePending(entry, "pending_abandoned", "the caller stopped waiting", { detail: "connection closed while queued" });
          });
        });
        return { kind: "queued", id, settled };
      }

      try {
        return { kind: "signed", out: await sign(agentId, reason, input) };
      } catch (e) {
        if (!(e instanceof AuditedError)) audit("sign_error", { agentId, reason, error: String(e) });
        return { kind: "error", error: e };
      }
    });

    if (outcome.kind === "deny") return json(res, 403, { error: "policy_denied", rule: outcome.rule, detail: outcome.detail });
    if (outcome.kind === "error") {
      const e = outcome.error;
      const detail = String(e instanceof Error ? e.message : e);
      // Two of these are states, not faults, and an agent can act on the difference: wait, or stop.
      if (e instanceof UtxoBusy) return json(res, 409, { error: "utxo_busy", detail, retryable: true });
      if (e instanceof InsufficientFunds)
        return json(res, 409, { error: "insufficient_funds", detail, retryable: false, asset: input.asset, amount: input.amount });
      return json(res, 500, { error: "sign_failed", detail });
    }
    if (outcome.kind === "signed") return json(res, 200, outcome.out);

    const verdict = await outcome.settled; // waited for outside the lock
    if (res.destroyed || res.socket?.destroyed) return; // the caller left; the queue entry went with it
    if ("denied" in verdict) return json(res, 403, { error: "approval_denied", detail: verdict.denied, id: outcome.id });
    return json(res, 200, verdict);
  }

  if (req.method === "GET" && url.pathname === "/pending") {
    return json(res, 200, [...pending.values()].map(p => ({ id: p.id, createdAt: p.createdAt, agentId: p.agentId, reason: p.reason, payTo: p.input.payTo, asset: p.input.asset, amount: p.input.amount })));
  }
  if (req.method === "POST" && (url.pathname === "/approve" || url.pathname === "/deny")) {
    const p = typeof body.id === "string" ? pending.get(body.id) : undefined;
    if (!p) return json(res, 404, { error: "no such pending id" });
    if (url.pathname === "/deny") {
      closePending(p, "approval_denied", "denied by operator");
      return json(res, 200, { ok: true });
    }
    // Under the agent's lock, like any other decision: the re-check and the signature it admits
    // must see one ledger, or a payment for the same agent could land between them.
    const outcome = await withAgentLock(p.agentId, async () => {
      // A caller that left while this was on its way to the lock has already been closed out.
      if (!pending.has(p.id)) return { kind: "gone" as const };
      // The policy that governs is the one in force now, not the one in force when the request was
      // queued. Without this, tightening a limit while something waits in the queue leaves a way to
      // sign past it: approval is a gate inside the policy, not a way around it. An operator who
      // means to allow it can raise the limit, which is a decision that leaves a trace.
      let verdict: ReturnType<typeof decide>;
      try {
        verdict = decide(refreshPolicy(), ledgerExcluding(p.id), {
          agentId: p.agentId,
          payTo: p.input.payTo,
          asset: p.input.asset,
          amount: BigInt(p.input.amount),
          reason: p.reason,
          assetTransferMethod: typeof p.input.extra?.assetTransferMethod === "string" ? p.input.extra.assetTransferMethod : undefined,
          resource: p.resource,
        });
      } catch (e) {
        verdict = { verdict: "deny", rule: "policy_unreadable", detail: String(e instanceof Error ? e.message : e) };
      }
      if (verdict.verdict === "deny") {
        closePending(p, "approval_stale", `the policy no longer allows this: ${verdict.rule}`, { rule: verdict.rule, detail: verdict.detail });
        return { kind: "stale" as const, verdict };
      }
      // Off the queue before signing, so a second approve of the same id finds nothing; the
      // reservation stays until the signature has recorded the real spend, then goes.
      pending.delete(p.id);
      clearTimeout(p.timer);
      try {
        const out = await sign(p.agentId, p.reason, p.input);
        reserved.delete(p.id);
        audit("approved", { id: p.id, agentId: p.agentId });
        p.resolve(out);
        return { kind: "signed" as const, out };
      } catch (e) {
        reserved.delete(p.id);
        audit("approval_sign_error", { id: p.id, agentId: p.agentId, error: String(e) });
        p.resolve({ denied: `sign failed: ${String(e)}` });
        return { kind: "error" as const, error: e };
      }
    });
    if (outcome.kind === "gone") return json(res, 404, { error: "no such pending id", detail: "the caller stopped waiting before it was approved" });
    if (outcome.kind === "stale")
      return json(res, 409, {
        error: "policy_changed",
        rule: outcome.verdict.rule,
        detail: `${outcome.verdict.detail}. The policy changed while this was queued; raise the limit if you mean to allow it.`,
      });
    if (outcome.kind === "error") return json(res, 500, { error: String(outcome.error) });
    return json(res, 200, { ok: true, nonce: outcome.out.nonce });
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
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

  one("ada_wallet_up", "1 when signerd is serving.", "gauge", 1);
  series("ada_wallet_audit_events_total", "Audit records written since this process started, by event.", "counter",
    [...eventCounts].map(([event, n]): Sample => [`event="${esc(event)}"`, n]));
  one("ada_wallet_unauthorized_requests_total", "Requests rejected for a bad or missing bearer token.", "counter", unauthorizedRequests);
  one("ada_wallet_bad_requests_total", "Requests refused as malformed, before anything was audited.", "counter", badRequests);
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

  const agentCount = Object.keys(current?.agents ?? {}).length;
  add(
    agentTokens.size > 0 ? "ok" : agentCount > 1 ? "warn" : "ok",
    "agent identity",
    agentTokens.size > 0
      ? `${agentTokens.size} token(s), each fixed to one agent`
      : agentCount > 1
        ? `AGENT_TOKENS_FILE is unset and there are ${agentCount} agents, so any holder of the operator token can spend any of their budgets by naming it`
        : "one agent, so there is no other budget to claim",
  );

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

/**
 * Who is calling.
 *
 * With AGENT_TOKENS_FILE, a token *is* an agent: `agentId` stops being something the caller
 * asserts, which it was, and which meant any process holding the shared token could spend any
 * agent's budget by naming it. Without the file the old behaviour stands, and preflight says so
 * when there is more than one agent for it to matter to.
 */
type Caller = { kind: "operator" } | { kind: "agent"; agentId: string };

function sameToken(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? "");
  // timingSafeEqual throws on unequal lengths, and a bearer token's length is not the secret.
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function identify(header: string | undefined): Caller | undefined {
  if (sameToken(header, TOKEN!)) return { kind: "operator" };
  for (const [token, agentId] of agentTokens) if (sameToken(header, token)) return { kind: "agent", agentId };
  return undefined;
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
        // Not destroyed here: the 413 has to reach the caller, and the socket closes with it.
        req.removeAllListeners("data");
        req.resume();
        reject(new BadRequest(413, `request body exceeds ${MAX_BODY_BYTES} bytes`));
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
  for (const p of [...pending.values()]) closePending(p, "shutdown_denied", "signerd shut down before this request was approved");
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
  server.closeIdleConnections();
  setTimeout(finish, 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const LOOPBACK = ["127.0.0.1", "::1"];
server.listen(PORT, "127.0.0.1", () => {
  // The key lives in this process. The listen address is one token in one line, and getting it
  // wrong publishes the wallet to whatever the host is reachable on, so it is worth asking the
  // socket what it actually bound rather than trusting the line above it.
  const bound = server.address();
  if (typeof bound !== "object" || bound === null || !LOOPBACK.includes(bound.address))
    fail(`refusing to serve on ${typeof bound === "object" && bound ? bound.address : String(bound)}: signerd holds the key and belongs on the loopback`);
  console.error(`signerd listening on 127.0.0.1:${PORT}  network=${NETWORK}  address=${address}`);
  console.error(`policy: ${resolvePath(POLICY_FILE)}`);
  console.error(`audit:  ${resolvePath(AUDIT_FILE)}  (chain at #${auditSeq}, ${replayedSkipped} records older than the window)`);
  console.error(`ledger: ${resolvePath(LEDGER_FILE)}  (${ledger.length} spends inside the 24h window)`);
  console.error(`agents: ${Object.keys(policy.agents).join(", ")}`);
  console.error(`key:    ${KEYSTORE_FILE ? "encrypted keystore" : "plaintext mnemonic"}`);
  for (const note of permissionNotes) console.error(`  ${note.level === "warn" ? "WARNING " : ""}${note.detail}`);
  console.error(`none of the policy, audit or ledger files may be writable by the agent's user`);
  console.error(`run "walletctl preflight" before pointing this at real money`);
});
