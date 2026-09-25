#!/usr/bin/env node
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
 * batch-settlement (preprod, with BLOCKFROST_PROJECT_ID; see DESIGN-batch-settlement.md):
 *   POST /batch/payload   {agentId, reason, resource?, x402Version, requirements} -> {x402Version, payload}
 *                         a voucher, or a channel opening or top-up with one; 403, 409 and the
 *                         approval queue as for /sign
 *   POST /batch/response  {paymentPayload, requirements, settleResponse?, paymentRequired?} -> {recovered}
 *                         the seller's answer, for the channel's count
 *   GET  /channels                                  -> every channel, whose, and what was signed on it
 *   POST /channels/refund         {channelId, paymentRequired}           -> {paymentPayload}
 *   POST /channels/refund/result  {channelId, paymentPayload, settleResponse}
 *   POST /channels/close | /channels/end | /channels/elapse  {channelId}  -> {transaction}
 *   POST /channels/recover        {agentId}                              -> channels found on chain
 *   The first two take an agent's token; the rest are the operator's.
 *
 * None of POLICY_FILE, AUDIT_FILE or LEDGER_FILE may be writable by the agent's user: between them
 * they are the limits, the spending they are measured against, and the checkpoint the cap is
 * computed from. Nor may CHANNELS_DIR, which holds what was signed on each channel. See README,
 * "Before mainnet".
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
 *   CHANNELS_DIR            default ./channels (batch-settlement's records; like the ledger, not
 *                           writable by the agent's user)
 *   BATCH_DEPOSIT_REQUESTS  how many requests at the asked price a channel deposit is sized for,
 *                           within channelDepositMax (default 100)
 */
import { AsyncLocalStorage } from "node:async_hooks";
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
  mkdirSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { resolve as resolvePath, dirname, join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { toClientCardanoSigner, decodeCardanoTransaction, type ClientCardanoSignInput, type ClientCardanoSigner } from "@x402/cardano";
import type { PaymentPayload, PaymentPayloadResult, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { Address, Client, KeyHash, preprod } from "@evolution-sdk/evolution";
import { SUBBIT_HASH } from "subbit-x402/subbit";
import { BlockfrostChain } from "subbit-x402/x402/chain";
import { currencyOf, subbedOf, txHashOf, type ChannelView } from "subbit-x402/x402/cardano";
import { channelOutputIndex, decodeTx } from "subbit-x402/x402/txcheck";
import { parseExtra } from "subbit-x402/x402/types";
import {
  BatchSettlementCardanoClient,
  FileClientStorage,
  PENDING_MS,
  derivedIouSigner,
  iouRootOf,
  type Authorization,
  type ClientChannel,
} from "subbit-x402/x402/client";
import { BATCH, decide, decideDeposit, parsePolicy, remaining, type Decision, type Policy, type SpendRecord } from "./policy.js";
import { ChannelStore, type ChannelEntry } from "./channelStore.js";
import { stepProblem, summarize, summaryProblem, type ChannelStep } from "./channelTx.js";
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
const MAX_HOT_BALANCE = lovelaceEnv("MAX_HOT_BALANCE_LOVELACE");
const MASUMI_MAX_COLLATERAL = lovelaceEnv("MASUMI_MAX_COLLATERAL_LOVELACE");
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
/**
 * What bounds a build. The SDK's default is 10s, which the README names as a trap on the
 * facilitator side and `dev/provider.ts` already overrides — but signerd was left on it, and
 * signerd is the side that signs. Koios is a free public service with no SLA, and a loaded host
 * adds its own delay on top: a lookup that answered 200 in a second from `curl` still overran 10s
 * from inside a busy process. The cost was a `sign_error` and a 500, which an agent reads as a
 * broken daemon rather than as something slow it could retry.
 *
 * It is not only the individual lookups. The SDK wraps `buildTransaction` in this same budget, and
 * that one covers coin selection and the CPU it takes as well as the round trips — on a quiet host
 * a build measures 1.3-3.2s, and on a busy single core the same build overran 30s. So the number
 * has to cover the whole of the slowest build, not one request. 60s, well inside the caller's 300s;
 * the SDK's ceiling is 120s.
 */
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS ?? 60_000);
// The longest window any rule looks at. Nothing older can change a decision, so nothing older is
// kept: the ledger stays bounded however long the process runs and however large the audit grows.
const LEDGER_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS_DIR = process.env.CHANNELS_DIR ?? "./channels";
const BATCH_DEPOSIT_REQUESTS = Number(process.env.BATCH_DEPOSIT_REQUESTS ?? 100);

function fail(msg: string): never {
  console.error(`signerd: ${msg}`);
  process.exit(1);
}

/**
 * A lovelace ceiling from the environment. `BigInt("10 ADA")` throws where it is read, which is
 * before any of these checks run, so the operator got a stack trace out of the module loader
 * instead of the line that says which variable they got wrong.
 */
function lovelaceEnv(name: string): bigint | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  if (!/^[0-9]+$/.test(raw)) fail(`${name} must be a decimal integer of lovelace, got "${raw}"`);
  return BigInt(raw);
}

if (!TOKEN) fail("SIGNERD_TOKEN is required");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail(`SIGNERD_PORT must be a port number, got "${process.env.SIGNERD_PORT}"`);
// Not a number is NaN, and `NaN <= Date.now()` is false — so a nonce claimed under it would never
// expire, and the first payment would leave the wallet answering utxo_busy for as long as it runs.
if (!Number.isInteger(NONCE_HOLD_SECONDS) || NONCE_HOLD_SECONDS < 1)
  fail(`NONCE_HOLD_SECONDS must be a positive whole number of seconds, got "${process.env.NONCE_HOLD_SECONDS}"`);
// 120_000 is what the SDK accepts; above it the setting is silently not the one in force.
if (!Number.isInteger(PROVIDER_TIMEOUT_MS) || PROVIDER_TIMEOUT_MS < 1 || PROVIDER_TIMEOUT_MS > 120_000)
  fail(`PROVIDER_TIMEOUT_MS must be a whole number of milliseconds from 1 to 120000, got "${process.env.PROVIDER_TIMEOUT_MS}"`);
if (!Number.isInteger(BATCH_DEPOSIT_REQUESTS) || BATCH_DEPOSIT_REQUESTS < 10)
  fail(`BATCH_DEPOSIT_REQUESTS must be a whole number of at least 10 (the client's own floor), got "${process.env.BATCH_DEPOSIT_REQUESTS}"`);
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
    spends: ledger.map(r => ({ ts: r.ts, agentId: r.agentId, asset: r.asset, amount: r.amount.toString(), ...(r.voucher ? { voucher: true } : {}) })),
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

// 0o600 on creation. The default is 0o666, so under a umask of 002 signerd created the log
// group-writable — a mode it then refuses to run on, having written the file itself.
const auditFd = openSync(AUDIT_FILE, "a", 0o600);
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

// Before the write, not after. The cap is computed from this checkpoint and an agent that can
// rewrite it rewrites its own spend — but `writeCheckpoint` renames a fresh 0600 file over it, so
// checking afterwards checked this daemon's own output and reported `mode 600` whatever the
// operator had left there. A first start has no file to check, and the one it is about to write is
// 0600 by construction.
checkFileMode("ledger", LEDGER_FILE);
// Now, not at the next payment: an idle wallet would otherwise sit with no checkpoint at all, and
// so with nothing protecting the cap.
writeCheckpoint();

const signer: ClientCardanoSigner = toClientCardanoSigner({
  mnemonic,
  network: NETWORK,
  provider: providerConfig(),
  // Masumi collateral scales with datum size, and the datum carries the seller's own bytes: with
  // no ceiling, the seller chooses how much this wallet locks.
  ...(MASUMI_MAX_COLLATERAL !== undefined ? { masumiMaxCollateralLovelace: MASUMI_MAX_COLLATERAL } : {}),
});
function providerConfig() {
  if (process.env.BLOCKFROST_PROJECT_ID) {
    return {
      blockfrost: { baseUrl: blockfrostBaseUrl(NETWORK), projectId: process.env.BLOCKFROST_PROJECT_ID },
      requestTimeoutMs: PROVIDER_TIMEOUT_MS,
    };
  }
  return { koios: { baseUrl: koiosBaseUrl(NETWORK), token: process.env.KOIOS_TOKEN }, requestTimeoutMs: PROVIDER_TIMEOUT_MS };
}
const address = signer.getAddress();

/**
 * batch-settlement: x402 over Subbit payment channels (DESIGN-batch-settlement.md). subbit-x402's
 * client runs here, with this wallet, because a voucher is money to whoever holds it and costs
 * nothing to sign: whatever signs vouchers has to be where the policy is. The agent's process gets
 * a proxy that forwards the 402 here and the payload back.
 *
 * Preprod only, and only on Blockfrost: the client's one chain reader is Blockfrost's, written for
 * preprod, and Subbit's validator is alpha.
 */
const BATCH_UNAVAILABLE =
  networkName(NETWORK) !== "preprod"
    ? `batch-settlement runs on preprod only, and this wallet is on ${NETWORK}`
    : !process.env.BLOCKFROST_PROJECT_ID
      ? "batch-settlement needs BLOCKFROST_PROJECT_ID: the channel client reads the chain through Blockfrost"
      : undefined;
const channels = BATCH_UNAVAILABLE ? undefined : await openChannels();

async function openChannels() {
  const baseUrl = blockfrostBaseUrl(NETWORK);
  const projectId = process.env.BLOCKFROST_PROJECT_ID!;
  // The `exact` signer's key: the same mnemonic, normalised as @x402/cardano does, and account 0.
  // Two builders that disagreed on the address would each see half a wallet.
  const wallet = Client.make(preprod)
    .withBlockfrost({ baseUrl, projectId })
    .withSeed({ mnemonic: mnemonic.trim().replace(/\s+/g, " ").toLowerCase(), accountIndex: 0 });
  const own = await wallet.address();
  if (Address.toBech32(own) !== address) fail(`batch-settlement: the channel wallet is ${Address.toBech32(own)}, the exact signer's ${address}`);
  mkdirSync(CHANNELS_DIR, { recursive: true, mode: 0o700 });
  const index = join(CHANNELS_DIR, "index.json");
  checkFileMode("channel index", index);
  let store: ChannelStore;
  try {
    store = new ChannelStore(index);
  } catch (e) {
    fail(`channel index ${resolvePath(index)} is unreadable: ${e instanceof Error ? e.message : e}`);
  }
  return {
    chain: new BlockfrostChain("cardano:preprod", baseUrl, projectId),
    wallet,
    store,
    /** This wallet's payment key hash: every channel's consumer. */
    consumer: KeyHash.toHex(own.paymentCredential as KeyHash.KeyHash),
    /** Every channel's IOU key derives from this, so an opening's key is checked against signerd's own derivation. */
    iouRoot: await iouRootOf(wallet),
    /** One client per agent: its own records, so its channels, deposits and counts are its own. */
    clients: new Map<string, { client: BatchSettlementCardanoClient; storage: FileClientStorage }>(),
  };
}

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
 * Every input of every transaction handed out, `exact` or channel, and when. The two builders are
 * blind to each other: the `exact` one spends the wallet's first UTXO and lets the SDK add any
 * others, and a channel opening picks its own. subbit-x402's client leaves these out of its coin
 * selection (it is this map, as `spentInputs`), and an `exact` transaction that spends one is
 * refused as utxo_busy — otherwise two transactions could go out spending one UTXO, and one of
 * them would never land. The client drops an entry once the wallet stops listing it, or after
 * PENDING_MS.
 */
const inFlight = new Map<string, number>();
function inputBusy(inputs: readonly string[]): string | undefined {
  const now = Date.now();
  return inputs.find(i => {
    const at = inFlight.get(i);
    return at !== undefined && now - at < PENDING_MS;
  });
}

/**
 * `maxTimeoutSeconds` comes from the seller's 402: unclamped, zero times out every approval, and
 * a non-number would make the timer NaN — which fires at once — and the nonce hold NaN, which
 * never expires.
 */
const approvalWindow = (input: { maxTimeoutSeconds?: unknown }) => {
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
    let inputs: string[] = [];
    try {
      const decoded = decodeCardanoTransaction(res.transaction);
      inputs = decoded.inputs;
      wrong = mismatch(decoded, {
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

    const hold = Math.min(approvalWindow(input), NONCE_HOLD_SECONDS);
    // Checked before the nonce is claimed: a refusal must not leave it claimed.
    const held = inputBusy(inputs);
    if (held !== undefined || !claimNonce(res.nonce, hold)) {
      const other = held !== undefined && held !== res.nonce;
      audit(other ? "input_in_flight" : "nonce_collision", { agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, nonce: res.nonce, ...(other ? { input: held } : {}) });
      throw new UtxoBusy(`utxo ${held ?? res.nonce} is already committed to an unsettled payment; retry once it settles`);
    }
    // Held no longer than the nonce: the ledger is what bounds spending, and a settlement that
    // failed must not keep the channel client off these UTXOs for the client's full PENDING_MS.
    for (const i of inputs) inFlight.set(i, Date.now() - PENDING_MS + hold * 1000);
    ledger.push({ ts: Date.now(), agentId, asset: input.asset, amount: BigInt(input.amount) });
    pruneLedger();
    audit("signed", { agentId, reason, payTo: input.payTo, asset: input.asset, amount: input.amount, nonce: res.nonce, network: input.network });
    writeCheckpoint(); // after the audit record, so the checkpoint names it
    return res;
  });
}

/** What an approval signs: an `exact` payment, or a batch-settlement voucher and the step it rides on. */
type PendingWork =
  | { scheme: "exact"; input: ClientCardanoSignInput }
  | { scheme: typeof BATCH; x402Version: number; requirements: PaymentRequirements; increment: bigint };

interface Pending {
  id: string;
  createdAt: number;
  agentId: string;
  reason: string;
  /** Kept so the policy can be re-applied at approval time, `allowedResources` included. */
  resource?: string;
  /** What the queue shows and holds budget for: a voucher's is its increment. */
  payTo: string;
  asset: string;
  amount: string;
  work: PendingWork;
  /** Cleared when the request resolves, so a settled approval stops holding the event loop open. */
  timer: NodeJS.Timeout;
  resolve: (v: Settled) => void;
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

type Settled = { transaction: string; nonce: string } | { payload: PaymentPayloadResult } | { denied: string };
type Outcome<T> =
  | { kind: "deny"; rule: string; detail: string }
  | { kind: "signed"; out: T }
  | { kind: "error"; error: unknown }
  | { kind: "queued"; id: string; settled: Promise<Settled> };
type SignOutcome = Outcome<{ transaction: string; nonce: string }>;

/**
 * Puts a request in the approval queue and holds its budget; the caller releases its locks and
 * waits on `settled` outside them. Budget held by a queued request counts as spent until it
 * resolves, so queuing two requests is not a way to promise the same budget twice.
 */
function enqueue(
  res: ServerResponse,
  q: { agentId: string; reason: string; resource?: string; payTo: string; asset: string; amount: string; detail: string; work: PendingWork; windowSeconds: number },
): { id: string; settled: Promise<Settled> } {
  const id = randomUUID().slice(0, 8);
  const voucher = q.work.scheme === BATCH;
  reserved.set(id, { ts: Date.now(), agentId: q.agentId, asset: q.asset, amount: BigInt(q.amount), ...(voucher ? { voucher: true } : {}) });
  audit("pending", { id, agentId: q.agentId, reason: q.reason, resource: q.resource, payTo: q.payTo, asset: q.asset, amount: q.amount, detail: q.detail, ...(voucher ? { scheme: BATCH } : {}) });
  const settled = new Promise<Settled>(resolve => {
    const entry: Pending = {
      id,
      createdAt: Date.now(),
      agentId: q.agentId,
      reason: q.reason,
      resource: q.resource,
      payTo: q.payTo,
      asset: q.asset,
      amount: q.amount,
      work: q.work,
      timer: setTimeout(() => closePending(entry, "approval_timeout", "approval timed out", { asset: q.asset, amount: q.amount }), q.windowSeconds * 1000),
      resolve,
    };
    pending.set(id, entry);
    // The answer has one recipient: the request that is still open. Node's fetch stops waiting
    // for headers after 300s, and an approval signed after the caller has gone records a spend
    // for a transaction nobody will ever broadcast — so a caller that leaves takes its request
    // with it, and its budget comes back.
    const withdraw = () => {
      if (!res.writableFinished) closePending(entry, "pending_abandoned", "the caller stopped waiting", { detail: "connection closed while queued" });
    };
    res.on("close", withdraw);
    // The wait for the agent lock above is as long as a payment ahead of this one takes to
    // sign, and a caller can leave during it. A listener attached after `close` has fired is
    // a listener that never runs, which left the request in the queue with its budget held,
    // for a human to approve into the void — the one thing the listener is here to prevent.
    if (res.destroyed || res.socket?.destroyed) withdraw();
  });
  return { id, settled };
}

/**
 * Which agent a paying request is for: the token's, when tokens mean something, else the body's.
 * Once tokens mean something, the operator's does not mean "any agent": operating and paying are
 * different authorities, and the operator already has the policy and the approval queue.
 */
function payingAgent(caller: Caller, body: Record<string, unknown>): { agentId: string } | { status: number; body: Record<string, unknown> } {
  const claimed = body.agentId;
  if (agentTokens.size > 0 && caller.kind === "operator")
    return { status: 403, body: { error: "operator_cannot_sign", detail: "signing needs an agent token; the operator token operates" } };
  if (caller.kind === "agent" && claimed !== undefined && claimed !== caller.agentId)
    return { status: 403, body: { error: "agent_mismatch", detail: `this token signs for ${caller.agentId}, not ${String(claimed)}` } };
  const agentId = caller.kind === "agent" ? caller.agentId : claimed;
  if (typeof agentId !== "string" || !agentId) return { status: 400, body: { error: "agentId required" } };
  if (agentId.length > MAX_AGENT_ID) return { status: 400, body: { error: "too_long", detail: `agentId (${agentId.length} > ${MAX_AGENT_ID})` } };
  return { agentId };
}

// ---- batch-settlement: what the channel client may hand out ---------------------------------

/** Per request: why the agent is paying, and whether a human has approved this voucher already. */
interface BatchCall {
  reason: string;
  resource?: string;
  /** Set on the second run of a queued voucher: what the human approving it was shown. */
  approved?: { id: string; increment: bigint; payTo: string; asset: string };
  /** A refund or an exit the operator asked for: no agent's budget moves. */
  operator?: boolean;
}
const batchCall = new AsyncLocalStorage<BatchCall>();

/** A policy verdict against a channel step, audited where it was made. */
class BatchDenied extends AuditedError {
  constructor(public readonly rule: string, public readonly detail: string) {
    super(`${rule}: ${detail}`);
  }
}

/** A voucher over approvalAbove: it is queued, and made again once a human has approved it. */
class NeedsApproval extends Error {
  constructor(public readonly increment: bigint, public readonly payTo: string, public readonly asset: string, public readonly detail: string) {
    super(detail);
  }
}

const short = (id: string) => `${id.slice(0, 16)}…`;

function batchClient(agentId: string): { client: BatchSettlementCardanoClient; storage: FileClientStorage } {
  const c = channels!;
  const have = c.clients.get(agentId);
  if (have) return have;
  // Named for the agent's id, hashed: an id is free text, and a directory name is a path.
  const storage = new FileClientStorage(join(CHANNELS_DIR, `agent-${sha256(agentId).slice(0, 16)}`));
  const client = new BatchSettlementCardanoClient({
    wallet: c.wallet,
    storage,
    chain: c.chain,
    capacity: req => BigInt(req.amount) * BigInt(BATCH_DEPOSIT_REQUESTS),
    // A clamp, so that a deposit is cut to fit rather than refused; `authorize` is the check.
    maxDeposit: req => {
      const cap = policy.agents[agentId]?.channelDepositMax?.[req.asset];
      return cap === undefined ? undefined : BigInt(cap);
    },
    spentInputs: inFlight,
    iouKeys: "derived",
    authorize: a => authorizeChannel(agentId, a),
  });
  const made = { client, storage };
  c.clients.set(agentId, made);
  return made;
}

/** The client's run for a 402, under the wallet lock: it builds and signs with this wallet's UTXOs. */
function batchPayload(agentId: string, call: BatchCall, x402Version: number, requirements: PaymentRequirements): Promise<PaymentPayloadResult> {
  return withWalletLock(() => batchCall.run(call, () => batchClient(agentId).client.createPaymentPayload(x402Version, requirements)));
}

function refuse(call: BatchCall, agentId: string, rule: string, detail: string, what: Record<string, unknown> = {}): BatchDenied {
  // On an approval's second run the queue records the outcome, as approval_stale.
  if (!call.approved) audit("denied", { agentId, reason: call.reason, resource: call.resource, scheme: BATCH, ...what, rule, detail });
  return new BatchDenied(rule, detail);
}

/**
 * Everything the channel client hands out comes here first: the policy for a voucher's increment
 * and for any deposit, and the checks for any transaction. Throwing refuses it, and the client
 * records nothing.
 */
async function authorizeChannel(agentId: string, a: Authorization): Promise<void> {
  const call = batchCall.getStore();
  if (!call) throw new Error("a channel step outside a signerd request");
  const c = channels!;
  const ch = a.channel;
  const entry = c.store.get(ch.channelId);
  if (entry && entry.agentId !== agentId) throw refuse(call, agentId, "channel_owner", `channel ${short(ch.channelId)} is another agent's`);
  const unknown = () => refuse(call, agentId, "channel_unknown", `signerd has no record of channel ${short(ch.channelId)}; the operator can run: walletctl recover ${agentId}`);

  switch (a.kind) {
    case "voucher":
      if (!entry) throw unknown();
      return commitVoucher(agentId, call, ch, a.amount, a.requirements, entry);

    case "open": {
      const req = a.requirements;
      const extra = parseExtra(req);
      const k = ch.channelConfig;
      // A new channel's terms: this wallet, the seller the 402 names, and an IOU key signerd derives itself.
      const iouKey = derivedIouSigner(c.iouRoot, req.network, ch.channelId).publicKey;
      if (
        k.payer !== c.consumer ||
        k.payerAuthorizer !== iouKey ||
        k.receiver !== req.payTo ||
        k.receiverAuthorizer !== extra.receiverAuthorizer ||
        k.token !== req.asset ||
        k.withdrawDelay !== extra.withdrawDelay
      )
        throw refuse(call, agentId, "channel_terms", "the opening does not name this wallet, its own IOU key, and the 402's seller and terms");
      checkChannelTx(agentId, "open", a.transaction, { channel: ch, amount: a.deposit }, await c.chain.coinsPerUtxoByte());
      const token = currencyOf(req.asset).kind !== "ada";
      await depositAllowed(call, agentId, req.asset, a.deposit, token ? a.reserve : 0n, extra.withdrawDelay);
      const opened: ChannelEntry = {
        agentId,
        network: req.network,
        scriptHash: extra.scriptHash,
        asset: req.asset,
        payTo: req.payTo,
        providerKey: extra.receiverAuthorizer,
        signedMax: "0",
        anchor: `${txHashOf(a.transaction)}#${channelOutputIndex(decodeTx(a.transaction, "open"), extra.scriptHash)}`,
        deposit: a.deposit.toString(),
        reserve: token ? a.reserve.toString() : "0",
        status: "open",
        openedAt: Date.now(),
      };
      return commitVoucher(agentId, call, ch, a.amount, req, opened, { event: "channel_opened", deposit: a.deposit, transaction: a.transaction });
    }

    case "topUp": {
      if (!entry) throw unknown();
      checkChannelTx(agentId, "topUp", a.transaction, { channel: ch, view: a.view, amount: a.deposit }, await c.chain.coinsPerUtxoByte());
      await depositAllowed(call, agentId, a.requirements.asset, a.deposit, 0n, parseExtra(a.requirements).withdrawDelay);
      return commitVoucher(agentId, call, ch, a.amount, a.requirements, entry, { event: "channel_topped_up", deposit: a.deposit, transaction: a.transaction });
    }

    case "refund": {
      if (!call.operator) throw new Error("a refund is the operator's to ask for");
      if (!entry) throw unknown();
      // The refund's voucher is the seller's count, which a forged receipt could have pushed past
      // what was ever signed; a refund buys nothing, so it signs nothing new.
      const signed = BigInt(entry.signedMax);
      if (a.amount > signed) throw refuse(call, agentId, "refund_above_signed", `the refund would sign for ${a.amount}, above the ${signed} signed so far`);
      const redeemed = subbedOf(a.view.datum.stage);
      checkChannelTx(agentId, "refund", a.transaction, { channel: ch, view: a.view }, 0n, { payTo: a.requirements.payTo, maxPayout: signed > redeemed ? signed - redeemed : 0n });
      audit("refund_signed", { agentId, channelId: ch.channelId, payout: a.payout.toString(), transaction: txHashOf(a.transaction) });
      return;
    }

    default: {
      if (!call.operator) throw new Error(`a ${a.kind} is the operator's to ask for`);
      checkChannelTx(agentId, a.kind, a.transaction, { channel: ch, view: a.view }, 0n);
      audit(`${a.kind}_signed`, { agentId, channelId: ch.channelId, transaction: txHashOf(a.transaction) });
      return;
    }
  }
}

function checkChannelTx(agentId: string, step: ChannelStep, hex: string, on: { channel: ClientChannel; view?: ChannelView; amount?: bigint }, coinsPerUtxoByte: bigint, refund?: { payTo: string; maxPayout: bigint }) {
  const c = channels!;
  let wrong: string | undefined;
  try {
    wrong =
      stepProblem(step, hex, { network: on.channel.network ?? "cardano:preprod", scriptHash: SUBBIT_HASH, consumer: c.consumer, coinsPerUtxoByte }, on) ??
      summaryProblem(step, summarize(decodeTx(hex, step), SUBBIT_HASH), { wallet: address, ...(refund ?? {}) });
  } catch (e) {
    wrong = `it could not be read: ${e instanceof Error ? e.message : e}`;
  }
  if (wrong) {
    audit("transaction_mismatch", { agentId, step, channelId: on.channel.channelId, detail: wrong });
    throw new AuditedError(`refusing to hand over a channel ${step} that does not match what was authorised: ${wrong}`);
  }
}

async function depositAllowed(call: BatchCall, agentId: string, asset: string, amount: bigint, reserveLovelace: bigint, withdrawDelay: number) {
  const d = decideDeposit(policy, { agentId, asset, amount, reserveLovelace, locked: await lockedBy(agentId), withdrawDelay });
  if (d.verdict !== "allow") throw refuse(call, agentId, d.rule, d.detail, { asset, deposit: amount.toString() });
}

/** Lovelace the channels held when last read, per agent, for the hot-balance check. */
const lockedLovelace = new Map<string, { lovelace: bigint; at: number }>();

/**
 * What an agent's open channels hold now, read from the chain from signerd's own anchors — never
 * from a position a seller's answer named. An opening not on chain yet counts what it will lock;
 * a channel the chain shows closed out is marked closed and counts nothing.
 */
async function lockedBy(agentId: string): Promise<Record<string, bigint>> {
  const c = channels!;
  const out: Record<string, bigint> = {};
  const add = (asset: string, n: bigint) => {
    out[asset] = (out[asset] ?? 0n) + n;
  };
  for (const [id, e] of c.store.entries()) {
    if (e.agentId !== agentId || e.status !== "open") continue;
    const view = await c.chain.followChannel(e.anchor, e.scriptHash, id);
    if (view) {
      add(e.asset, view.amount);
      if (view.datum.constants.currency.kind !== "ada") add("lovelace", view.lovelace);
      if (view.ref !== e.anchor) c.store.set(id, { ...e, anchor: view.ref });
    } else if ((await c.chain.spentBy(e.anchor)) === undefined) {
      // Not on chain yet, or never to be: the client gives an opening up only once one of its
      // inputs has gone to another transaction.
      if ((await batchClient(agentId).storage.get(id))?.status === "failed") c.store.set(id, { ...e, status: "closed" });
      else {
        add(e.asset, BigInt(e.deposit));
        if (BigInt(e.reserve) > 0n) add("lovelace", BigInt(e.reserve));
      }
    } else {
      c.store.set(id, { ...e, status: "closed" });
    }
  }
  lockedLovelace.set(agentId, { lovelace: out.lovelace ?? 0n, at: Date.now() });
  return out;
}

/**
 * A voucher spends what it adds to the most already signed on its channel; at or below that it
 * spends nothing (a retry, or the re-sign after a corrective 402). The increment goes through
 * `decide` like an `exact` payment, and is recorded — the channel index first — before the voucher
 * can leave: a crash in between counts a spend that did not happen, never the reverse.
 */
function commitVoucher(
  agentId: string,
  call: BatchCall,
  ch: ClientChannel,
  cumulative: bigint,
  req: PaymentRequirements,
  entry: ChannelEntry,
  step?: { event: string; deposit: bigint; transaction: string },
) {
  if (call.operator) throw new Error("the operator does not pay");
  const signed = BigInt(entry.signedMax);
  const increment = cumulative > signed ? cumulative - signed : 0n;
  const providerKey = parseExtra(req).receiverAuthorizer;
  if (increment === 0n) {
    audit("voucher_resigned", { agentId, channelId: ch.channelId, cumulative: cumulative.toString() });
    return;
  }
  const d = decide(policy, call.approved ? ledgerExcluding(call.approved.id) : effectiveLedger(), {
    agentId,
    payTo: req.payTo,
    asset: req.asset,
    amount: increment,
    reason: call.reason,
    resource: call.resource,
    scheme: BATCH,
    providerKey,
  });
  if (d.verdict === "deny") throw refuse(call, agentId, d.rule, d.detail, { payTo: req.payTo, asset: req.asset, amount: increment.toString() });
  if (d.verdict === "needs_approval") {
    const a = call.approved;
    if (!a || a.increment !== increment || a.payTo !== req.payTo || a.asset !== req.asset) throw new NeedsApproval(increment, req.payTo, req.asset, d.detail);
  }
  channels!.store.set(ch.channelId, { ...entry, signedMax: cumulative.toString(), payTo: entry.payTo || req.payTo });
  ledger.push({ ts: Date.now(), agentId, asset: req.asset, amount: increment, voucher: true });
  pruneLedger();
  if (step)
    audit(step.event, { agentId, channelId: ch.channelId, payTo: req.payTo, providerKey, asset: req.asset, deposit: step.deposit.toString(), transaction: txHashOf(step.transaction) });
  audit("voucher_signed", {
    agentId,
    reason: call.reason,
    resource: call.resource,
    payTo: req.payTo,
    providerKey,
    asset: req.asset,
    amount: increment.toString(),
    cumulative: cumulative.toString(),
    channelId: ch.channelId,
    network: req.network,
  });
  writeCheckpoint();
}

/**
 * After the client adopted a count from a corrective 402 — which it does only when the seller
 * shows a voucher this wallet's key signed for at least that much — the index learns it too, so a
 * channel recovered from the chain can be refunded up to what it provably signed.
 */
async function liftSignedMax(agentId: string, pr: PaymentRequired | undefined) {
  const id = (pr?.accepts.find(x => x.scheme === BATCH)?.extra?.channelState as { channelId?: unknown } | undefined)?.channelId;
  if (typeof id !== "string") return;
  const e = channels!.store.get(id);
  const rec = await batchClient(agentId).storage.get(id);
  if (!e || e.agentId !== agentId || !rec) return;
  if (BigInt(rec.chargedCumulativeAmount) > BigInt(e.signedMax)) channels!.store.set(id, { ...e, signedMax: rec.chargedCumulativeAmount });
}

async function channelList(only?: string) {
  const out: Array<Record<string, unknown>> = [];
  for (const [id, e] of channels!.store.entries()) {
    if (only !== undefined && e.agentId !== only) continue;
    const rec = await batchClient(e.agentId).storage.get(id);
    out.push({
      channelId: id,
      agentId: e.agentId,
      payTo: e.payTo,
      providerKey: e.providerKey,
      asset: e.asset,
      signed: e.signedMax,
      status: e.status,
      ...(rec
        ? { client: { status: rec.status, charged: rec.chargedCumulativeAmount, capacity: rec.balance, deposited: rec.deposit, ...(rec.elapseAt ? { elapseAt: rec.elapseAt } : {}) } }
        : {}),
    });
  }
  return out;
}

/** What an agent's token may call: paying, and reading its own budget. Everything else is the operator's. */
const AGENT_PATHS = new Set(["/sign", "/status", "/batch/payload", "/batch/response"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The channel client's own refusals when the wallet cannot fund a step. */
const isShortOfFunds = (e: unknown) => isCoinSelectionFailure(e) || (e instanceof Error && /the wallet holds \d+ of the currency|no UTxO to open/.test(e.message));

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
    const batch = channels
      ? { available: true, channels: await channelList(operatorOnly ? undefined : caller.agentId) }
      : { available: false, detail: BATCH_UNAVAILABLE };
    return json(res, 200, { address, network: NETWORK, agents, batch, pending: operatorOnly ? pending.size : undefined });
  }

  if (!operatorOnly && !AGENT_PATHS.has(url.pathname))
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
    // Required, not optional: the builder sets the transaction's TTL from it, and `BigInt(undefined)`
    // there is a 500 and a `sign_error` for what is the caller's omission. Defaulting it here would
    // be inventing a validity window the seller never quoted, which is a chain-level fact about the
    // transaction rather than a local one about how long to wait.
    if (typeof input.maxTimeoutSeconds !== "number" || !Number.isFinite(input.maxTimeoutSeconds))
      return json(res, 400, { error: "input.maxTimeoutSeconds is required and must be a number; it becomes the transaction's TTL" });
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
        // Hold the budget, release the lock: a human may take minutes.
        const { id, settled } = enqueue(res, {
          agentId,
          reason,
          resource: typeof resource === "string" ? resource : undefined,
          payTo: input.payTo,
          asset: input.asset,
          amount: input.amount,
          detail: d.detail,
          work: { scheme: "exact", input },
          windowSeconds: approvalWindow(input),
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
    if (outcome.kind === "signed") {
      if (gone(res)) return undelivered(agentId, reason, outcome.out.nonce);
      return json(res, 200, outcome.out);
    }

    const verdict = await outcome.settled; // waited for outside the lock
    if (gone(res)) {
      // Usually the queue entry left with its caller and `pending_abandoned` already says so. The
      // exception is a signature that finished while this connection was closing: the spend is
      // recorded, and the signed transaction has exactly one recipient, which is gone.
      if (!("denied" in verdict)) return undelivered(agentId, reason, "nonce" in verdict ? verdict.nonce : "", outcome.id);
      return;
    }
    if ("denied" in verdict) return json(res, 403, { error: "approval_denied", detail: verdict.denied, id: outcome.id });
    return json(res, 200, verdict);
  }

  if (req.method === "POST" && url.pathname === "/batch/payload") {
    if (!channels) return json(res, 503, { error: "batch_unavailable", detail: BATCH_UNAVAILABLE });
    const who = payingAgent(caller, body);
    if ("status" in who) return json(res, who.status, who.body);
    const { agentId } = who;
    const { reason, resource, x402Version, requirements } = body as { reason?: unknown; resource?: unknown; x402Version?: unknown; requirements?: unknown };
    // What reaches the client and the audit log is checked here, as for /sign: a malformed 402 is
    // the caller's 400, not the daemon's 500.
    if (typeof reason !== "string") return json(res, 400, { error: "reason must be a string" });
    if (resource !== undefined && typeof resource !== "string") return json(res, 400, { error: "resource must be a string" });
    if (!Number.isInteger(x402Version)) return json(res, 400, { error: "x402Version must be an integer" });
    if (!isObject(requirements) || requirements.scheme !== BATCH) return json(res, 400, { error: `requirements for ${BATCH} required` });
    const r = requirements as unknown as PaymentRequirements;
    if (typeof r.network !== "string" || !sameNetwork(r.network, NETWORK))
      return json(res, 400, { error: "network_mismatch", detail: `this wallet signs for ${NETWORK}, not "${String(r.network)}"` });
    if (typeof r.amount !== "string" || !/^[1-9][0-9]*$/.test(r.amount)) return json(res, 400, { error: "requirements.amount must be a positive decimal integer string" });
    if (typeof r.payTo !== "string" || typeof r.asset !== "string") return json(res, 400, { error: "requirements.payTo and requirements.asset must be strings" });
    if (typeof r.maxTimeoutSeconds !== "number" || !Number.isFinite(r.maxTimeoutSeconds)) return json(res, 400, { error: "requirements.maxTimeoutSeconds must be a number" });
    try {
      parseExtra(r);
    } catch (e) {
      return json(res, 400, { error: "bad_requirements", detail: e instanceof Error ? e.message : String(e) });
    }
    const tooLong =
      (reason.length > MAX_REASON && `reason (${reason.length} > ${MAX_REASON})`) ||
      (typeof resource === "string" && resource.length > MAX_RESOURCE && `resource (${resource.length} > ${MAX_RESOURCE})`) ||
      (r.payTo.length > MAX_PAY_TO && `requirements.payTo (${r.payTo.length} > ${MAX_PAY_TO})`) ||
      (r.asset.length > MAX_ASSET && `requirements.asset (${r.asset.length} > ${MAX_ASSET})`);
    if (tooLong) {
      badRequests++;
      return json(res, 400, { error: "too_long", detail: `${tooLong} — it goes verbatim into an append-only log` });
    }

    const outcome = await withAgentLock(agentId, async (): Promise<Outcome<PaymentPayloadResult>> => {
      try {
        refreshPolicy();
      } catch (e) {
        const detail = String(e instanceof Error ? e.message : e);
        audit("policy_error", { agentId, reason, detail });
        return { kind: "deny", rule: "policy_unreadable", detail };
      }
      const call: BatchCall = { reason, ...(typeof resource === "string" ? { resource } : {}) };
      try {
        return { kind: "signed", out: await batchPayload(agentId, call, x402Version as number, r) };
      } catch (e) {
        if (e instanceof BatchDenied) return { kind: "deny", rule: e.rule, detail: e.detail };
        if (e instanceof NeedsApproval) {
          // Nothing was handed out or recorded: the voucher is made again once a human approves it.
          const { id, settled } = enqueue(res, {
            agentId,
            reason,
            ...(call.resource ? { resource: call.resource } : {}),
            payTo: e.payTo,
            asset: e.asset,
            amount: e.increment.toString(),
            detail: e.detail,
            work: { scheme: BATCH, x402Version: x402Version as number, requirements: r, increment: e.increment },
            windowSeconds: approvalWindow(r),
          });
          return { kind: "queued", id, settled };
        }
        if (isShortOfFunds(e)) {
          audit("insufficient_funds", { agentId, reason, payTo: r.payTo, asset: r.asset, amount: r.amount, scheme: BATCH });
          return { kind: "error", error: new InsufficientFunds(`the wallet cannot fund a channel for ${r.amount} of ${r.asset}: ${e instanceof Error ? e.message : e}`) };
        }
        if (!(e instanceof AuditedError)) audit("batch_error", { agentId, reason, error: String(e) });
        return { kind: "error", error: e };
      }
    });

    if (outcome.kind === "deny") return json(res, 403, { error: "policy_denied", rule: outcome.rule, detail: outcome.detail });
    if (outcome.kind === "error") {
      const e = outcome.error;
      const detail = String(e instanceof Error ? e.message : e);
      if (e instanceof InsufficientFunds) return json(res, 409, { error: "insufficient_funds", detail, retryable: false, asset: r.asset });
      return json(res, 500, { error: "batch_failed", detail });
    }
    if (outcome.kind === "signed") {
      // Recorded, and handed to nobody: the same record as an undelivered transaction.
      if (gone(res)) return void audit("signed_undelivered", { agentId, reason, scheme: BATCH });
      return json(res, 200, outcome.out);
    }
    const verdict = await outcome.settled; // waited for outside the lock
    if (gone(res)) {
      if (!("denied" in verdict)) audit("signed_undelivered", { id: outcome.id, agentId, reason, scheme: BATCH });
      return;
    }
    if ("denied" in verdict) return json(res, 403, { error: "approval_denied", detail: verdict.denied, id: outcome.id });
    return json(res, 200, "payload" in verdict ? verdict.payload : verdict);
  }

  if (req.method === "POST" && url.pathname === "/batch/response") {
    if (!channels) return json(res, 503, { error: "batch_unavailable", detail: BATCH_UNAVAILABLE });
    const who = payingAgent(caller, body);
    if ("status" in who) return json(res, who.status, who.body);
    const { agentId } = who;
    const { paymentPayload, requirements, settleResponse, paymentRequired } = body;
    if (!isObject(paymentPayload) || !isObject(requirements)) return json(res, 400, { error: "paymentPayload and requirements required" });
    if ((settleResponse !== undefined && !isObject(settleResponse)) || (paymentRequired !== undefined && !isObject(paymentRequired)))
      return json(res, 400, { error: "settleResponse and paymentRequired must be objects when given" });
    // It moves the client's count, which sets the next voucher's amount — but never signerd's
    // record of what was signed, which is what the policy counts from.
    const out = await withAgentLock(agentId, async () => {
      try {
        const r = await batchClient(agentId).client.schemeHooks.onPaymentResponse!({
          paymentPayload: paymentPayload as unknown as PaymentPayload,
          requirements: requirements as unknown as PaymentRequirements,
          ...(settleResponse ? { settleResponse: settleResponse as unknown as SettleResponse } : {}),
          ...(paymentRequired ? { paymentRequired: paymentRequired as unknown as PaymentRequired } : {}),
        });
        if (r?.recovered) await liftSignedMax(agentId, paymentRequired as unknown as PaymentRequired);
        return { recovered: Boolean(r?.recovered) };
      } catch (e) {
        const detail = String(e instanceof Error ? e.message : e);
        audit("response_refused", { agentId, detail });
        return { refused: detail };
      }
    });
    return "refused" in out ? json(res, 422, { error: "response_refused", detail: out.refused }) : json(res, 200, out);
  }

  if (url.pathname === "/channels" || url.pathname.startsWith("/channels/")) {
    if (!channels) return json(res, 503, { error: "batch_unavailable", detail: BATCH_UNAVAILABLE });
    return channelRequest(req.method ?? "GET", url.pathname, body, res);
  }

  if (req.method === "GET" && url.pathname === "/pending") {
    return json(res, 200, [...pending.values()].map(p => ({ id: p.id, createdAt: p.createdAt, agentId: p.agentId, reason: p.reason, payTo: p.payTo, asset: p.asset, amount: p.amount, ...(p.work.scheme === BATCH ? { scheme: BATCH } : {}) })));
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
    const outcome = await withAgentLock(p.agentId, async (): Promise<
      { kind: "gone" } | { kind: "stale"; verdict: Decision } | { kind: "signed"; out: { transaction: string; nonce: string } | { payload: PaymentPayloadResult } } | { kind: "error"; error: unknown }
    > => {
      // A caller that left while this was on its way to the lock has already been closed out.
      if (!pending.has(p.id)) return { kind: "gone" as const };
      if (p.work.scheme === BATCH) return approveVoucher(p, p.work);
      const input = p.work.input;
      // The policy that governs is the one in force now, not the one in force when the request was
      // queued. Without this, tightening a limit while something waits in the queue leaves a way to
      // sign past it: approval is a gate inside the policy, not a way around it. An operator who
      // means to allow it can raise the limit, which is a decision that leaves a trace.
      let verdict: ReturnType<typeof decide>;
      try {
        verdict = decide(refreshPolicy(), ledgerExcluding(p.id), {
          agentId: p.agentId,
          payTo: input.payTo,
          asset: input.asset,
          amount: BigInt(input.amount),
          reason: p.reason,
          assetTransferMethod: typeof input.extra?.assetTransferMethod === "string" ? input.extra.assetTransferMethod : undefined,
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
        const out = await sign(p.agentId, p.reason, input);
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
    return json(res, 200, { ok: true, ...("nonce" in outcome.out ? { nonce: outcome.out.nonce } : { scheme: BATCH }) });
  }
  json(res, 404, { error: "not found" });
}

/**
 * An approved voucher, made again: the client runs for the same 402 with the approval in hand, and
 * `commitVoucher` takes it only for the increment, payee and asset the human was shown, judged
 * against the policy in force now. Anything else — a different amount, a tightened limit — is
 * stale, as a changed policy is for an `exact` payment.
 */
async function approveVoucher(p: Pending, work: Extract<PendingWork, { scheme: typeof BATCH }>) {
  // Off the queue first, so a second approve finds nothing; the reservation stays until the
  // voucher's own spend is recorded, and is left out of the decision on it meanwhile.
  pending.delete(p.id);
  clearTimeout(p.timer);
  try {
    // An unreadable policy is not a permissive one: the same verdict an `exact` approval gets.
    try {
      refreshPolicy();
    } catch (e) {
      throw new BatchDenied("policy_unreadable", String(e instanceof Error ? e.message : e));
    }
    const approved = { id: p.id, increment: work.increment, payTo: p.payTo, asset: p.asset };
    const payload = await batchPayload(p.agentId, { reason: p.reason, ...(p.resource ? { resource: p.resource } : {}), approved }, work.x402Version, work.requirements);
    reserved.delete(p.id);
    audit("approved", { id: p.id, agentId: p.agentId, scheme: BATCH });
    p.resolve({ payload });
    return { kind: "signed" as const, out: { payload } };
  } catch (e) {
    reserved.delete(p.id);
    if (e instanceof BatchDenied || e instanceof NeedsApproval) {
      const rule = e instanceof BatchDenied ? e.rule : "approval_changed";
      const detail = e instanceof BatchDenied ? e.detail : `the voucher would now be for ${e.increment}, not the ${work.increment} approved`;
      audit("approval_stale", { id: p.id, agentId: p.agentId, reason: p.reason, rule, detail });
      p.resolve({ denied: `the policy no longer allows this: ${rule}` });
      return { kind: "stale" as const, verdict: { verdict: "deny" as const, rule, detail } };
    }
    audit("approval_sign_error", { id: p.id, agentId: p.agentId, error: String(e) });
    p.resolve({ denied: `sign failed: ${String(e)}` });
    return { kind: "error" as const, error: e };
  }
}

/** The operator's channel endpoints: listing, and the steps that return a channel's money. */
async function channelRequest(method: string, path: string, body: Record<string, unknown>, res: ServerResponse) {
  const c = channels!;
  if (method === "GET" && path === "/channels") return json(res, 200, { channels: await channelList() });
  if (method !== "POST") return json(res, 404, { error: "not found" });

  if (path === "/channels/recover") {
    const agentId = body.agentId;
    if (typeof agentId !== "string" || !(agentId in policy.agents)) return json(res, 400, { error: "agentId of an agent in the policy required" });
    // Reads the chain and writes records, signs nothing: the agent's lock, not the wallet's.
    const out = await withAgentLock(agentId, async () => {
      const { client, storage } = batchClient(agentId);
      const found = await client.recover("cardano:preprod", SUBBIT_HASH);
      let indexed = 0;
      for (const r of await storage.list()) {
        const owner = c.store.get(r.channelId)?.agentId;
        if (owner === agentId) continue;
        // Every agent's channels share this wallet's key, so the chain shows them all to each; a
        // channel the index gives to another agent is closed in this agent's records for good.
        if (owner !== undefined) {
          await storage.set({ ...r, status: "closed" });
          continue;
        }
        if (!r.channelRef || (r.status !== "open" && r.status !== "closing")) continue;
        const view = await c.chain.followChannel(r.channelRef, r.scriptHash ?? SUBBIT_HASH, r.channelId);
        if (!view) continue;
        c.store.set(r.channelId, {
          agentId,
          network: r.network ?? "cardano:preprod",
          scriptHash: r.scriptHash ?? SUBBIT_HASH,
          asset: r.channelConfig.token,
          payTo: r.channelConfig.receiver,
          providerKey: r.channelConfig.receiverAuthorizer,
          // The chain's lower bound; a corrective 402 lifts it to what the seller shows was signed.
          signedMax: subbedOf(view.datum.stage).toString(),
          anchor: view.ref,
          deposit: "0",
          reserve: "0",
          status: "open",
          openedAt: r.openedAt || Date.now(),
        });
        indexed++;
      }
      audit("channels_recovered", { agentId, found: found.length, indexed });
      return { found: found.map(f => ({ channelId: f.channelId, status: f.status, exitOnly: Boolean(f.exitOnly) })), indexed };
    });
    return json(res, 200, out);
  }

  const channelId = body.channelId;
  const entry = typeof channelId === "string" ? c.store.get(channelId) : undefined;
  if (!entry || typeof channelId !== "string") return json(res, 404, { error: "no such channel" });
  const { client } = batchClient(entry.agentId);
  // The steps that move a channel's money run under the wallet lock like any signature, and an exit
  // waits for its block inside it: payments pause for as long as that takes.
  const run = <T>(what: string, f: () => Promise<T>) =>
    withAgentLock(entry.agentId, () => withWalletLock(() => batchCall.run({ reason: `operator: ${what}`, operator: true }, f)));
  try {
    switch (path) {
      case "/channels/refund": {
        const pr = body.paymentRequired;
        if (!isObject(pr) || !Array.isArray(pr.accepts)) return json(res, 400, { error: "paymentRequired (the seller's 402) required" });
        const paymentPayload = await run("refund", () => client.refundPayload(pr as unknown as PaymentRequired, channelId));
        return json(res, 200, { paymentPayload });
      }
      case "/channels/refund/result": {
        const { paymentPayload, settleResponse } = body;
        if (!isObject(paymentPayload) || !isObject(settleResponse) || !isObject(paymentPayload.accepted)) return json(res, 400, { error: "paymentPayload and settleResponse required" });
        await withAgentLock(entry.agentId, () =>
          client.schemeHooks.onPaymentResponse!({
            paymentPayload: paymentPayload as unknown as PaymentPayload,
            requirements: paymentPayload.accepted as unknown as PaymentRequirements,
            settleResponse: settleResponse as unknown as SettleResponse,
          }),
        );
        const s = settleResponse as unknown as SettleResponse;
        audit(s.success ? "refund_settled" : "refund_failed", { agentId: entry.agentId, channelId, transaction: s.transaction, reason: s.errorReason });
        return json(res, 200, { settled: s.success, transaction: s.transaction });
      }
      case "/channels/close": {
        const out = await run("close", () => client.close(channelId));
        return json(res, 200, { transaction: out.transaction, elapseAt: out.elapseAt.toString() });
      }
      case "/channels/end":
        return json(res, 200, { transaction: await run("end", () => client.end(channelId)) });
      case "/channels/elapse": {
        // The client waits for the chain to reach elapse_at, inside the wallet lock; that is a
        // wait worth refusing rather than making every payment share. Read from the chain, not the
        // record: a close whose confirmation was missed leaves the record saying open.
        const stage = (await client.openView(channelId)).view.datum.stage;
        if (stage.kind === "closed" && stage.elapseAt > BigInt(Date.now()))
          return json(res, 409, { error: "not_yet", detail: `elapse_at is ${new Date(Number(stage.elapseAt)).toISOString()}` });
        return json(res, 200, { transaction: await run("elapse", () => client.elapse(channelId)) });
      }
    }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e);
    if (e instanceof BatchDenied) return json(res, 403, { error: "policy_denied", rule: e.rule, detail: e.detail });
    if (!(e instanceof AuditedError)) audit("channel_error", { agentId: entry.agentId, channelId, step: path, error: detail });
    return json(res, e instanceof AuditedError ? 409 : 500, { error: "channel_step_failed", detail });
  }
  return json(res, 404, { error: "not found" });
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
  if (channels)
    one("ada_wallet_channels_open", "batch-settlement channels signerd counts as open.", "gauge", channels.store.entries().filter(([, e]) => e.status === "open").length);
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

  // Channels hold this wallet's money too, and a stolen key takes it back as surely, only later.
  const locked = [...lockedLovelace.values()].reduce((s, v) => s + v.lovelace, 0n);
  const lockedNote = channels
    ? lockedLovelace.size
      ? `, and ${locked} locked in channels when last read (${Math.round((Date.now() - Math.min(...[...lockedLovelace.values()].map(v => v.at))) / 1000)}s ago)`
      : ", and whatever channels hold: not read since start (the first deposit reads them)"
    : "";
  if (MAX_HOT_BALANCE === undefined) {
    add(IS_MAINNET ? "fail" : "warn", "hot wallet ceiling",
      "MAX_HOT_BALANCE_LOVELACE is unset. The daily cap bounds an agent; nothing here bounds what someone with the key can take, except how much is in the wallet");
  } else if (hotBalance === undefined) {
    add("warn", "hot wallet ceiling", `ceiling ${MAX_HOT_BALANCE} lovelace, but the balance could not be read${hotBalanceError ? ` (${hotBalanceError})` : ""}`);
  } else {
    add(hotBalance + locked > MAX_HOT_BALANCE ? (IS_MAINNET ? "fail" : "warn") : "ok", "hot wallet ceiling",
      `holding ${hotBalance}${lockedNote}, of a ${MAX_HOT_BALANCE} lovelace ceiling`);
  }
  add("ok", "batch-settlement", channels ? `available: channel records in ${resolvePath(CHANNELS_DIR)}` : `unavailable: ${BATCH_UNAVAILABLE}`);

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
    if ((ap.allowedSchemes ?? ["exact"]).includes(BATCH)) {
      const keys = ap.allowedProviderKeys ?? [];
      add(keys.includes("*") ? "warn" : keys.length ? "ok" : "warn", `${where}: channel provider keys`,
        keys.includes("*")
          ? '["*"]: a channel may name any key as provider, so allowedPayees binds nothing for batch-settlement'
          : keys.length
            ? `${keys.length} key(s)`
            : "none listed, so every batch-settlement payment is denied");
      const deposits = Object.entries(ap.channelDepositMax ?? {});
      add(deposits.length && ap.channelLockedMax ? "ok" : "warn", `${where}: channel deposits`,
        deposits.length && ap.channelLockedMax
          ? `${deposits.map(([a, v]) => `${a} ≤ ${v} a deposit`).join(", ")}; locked at most ${Object.entries(ap.channelLockedMax).map(([a, v]) => `${a} ${v}`).join(", ")}`
          : "channelDepositMax or channelLockedMax missing, so no channel is opened");
      if (!channels) add("warn", `${where}: batch-settlement`, `allowed by the policy, unavailable here: ${BATCH_UNAVAILABLE}`);
    }
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

/** Whether the request a verdict belongs to is still there to receive it. */
function gone(res: ServerResponse): boolean {
  return res.destroyed || res.socket?.destroyed === true;
}

/**
 * A signature that reached nobody. The transaction is handed to one request and no other, so when
 * that request has closed there is no second way to deliver it and nothing will broadcast it.
 *
 * The spend stays on the ledger: a transaction is not unsigned by nobody having read it, its UTXO
 * is claimed either way, and a copy that did leak could still be submitted. So this is a record
 * rather than a refund — and the only thing that ever says the payment the cap is counting did not
 * happen. Alert on it.
 */
function undelivered(agentId: string, reason: string, nonce: string, id?: string) {
  audit("signed_undelivered", { id, agentId, reason, nonce });
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
  console.error(`batch:  ${channels ? `batch-settlement available, channels in ${resolvePath(CHANNELS_DIR)}` : `batch-settlement unavailable (${BATCH_UNAVAILABLE})`}`);
  for (const note of permissionNotes) console.error(`  ${note.level === "warn" ? "WARNING " : ""}${note.detail}`);
  console.error(`none of the policy, audit or ledger files, nor the channels directory, may be writable by the agent's user`);
  console.error(`run "walletctl preflight" before pointing this at real money`);
});
