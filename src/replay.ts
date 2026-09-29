/**
 * Rebuilding the spend window from the audit log. Pure logic: no files, no chain, no I/O.
 *
 * This is the most failure-prone code in the daemon and the least visible when it goes wrong — a
 * ledger that is quietly too high denies payments, one that is quietly too low allows them — so it
 * lives here, where it can be tested without a chain or a funded wallet.
 */
import { createHash } from "node:crypto";
import type { SpendRecord } from "./policy.js";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface Checkpoint {
  version: 1;
  seq: number;
  hash: string;
  updatedAt: number;
  /** `tx` and `ttlSlot` are optional so a checkpoint written before they existed, or read by an older signerd, is still one. */
  spends: Array<{ ts: number; agentId: string; asset: string; amount: string; voucher?: boolean; tx?: string; ttlSlot?: number }>;
}

export interface OpenApproval {
  id: string;
  agentId: string;
  reason?: string;
}

export interface Replay {
  /** The window, time-ordered: the checkpoint's spends plus whatever was logged after it. */
  spends: SpendRecord[];
  /** Approvals a previous run left unanswered. */
  openApprovals: OpenApproval[];
  lastSeq: number;
  lastHash: string;
  /** Signed records older than the window. */
  skipped: number;
  hasRecords: boolean;
  /** 1-based line whose `prev` did not match the record before it. */
  chainBrokenAt?: number;
  /** 1-based line that did not parse. */
  malformedAt?: number;
  /** The checkpoint's own record was found in the chain, or there was none to find. */
  sawCheckpoint: boolean;
}

/** A transaction hash as this daemon writes it: lowercase hex, 32 bytes. */
export const isTxHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
/** A slot number a JSON number can hold exactly. */
export const isSlot = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * A spend is only a spend if every field it needs is there and readable. `BigInt("1.5")` throws,
 * and `String(undefined)` is "undefined" — an amount that takes down startup with no line number,
 * and an agent id that matches no policy and so quietly costs nothing.
 *
 * `tx` and `ttlSlot` are different: they only ever give budget back, so one that cannot be read is
 * dropped and the spend stays, counted and never releasable. Reporting it as malformed would stop
 * the daemon over a field whose loss is already the safe direction. A voucher carries neither: it
 * lands in no transaction of its own, so there is nothing for a release to name.
 */
function readSpend(e: Record<string, unknown>): { agentId: string; asset: string; amount: bigint; voucher?: boolean; tx?: string; ttlSlot?: number } | undefined {
  const { agentId, asset, amount } = e;
  if (typeof agentId !== "string" || !agentId) return undefined;
  if (typeof asset !== "string" || !asset) return undefined;
  if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) return undefined;
  const voucher = e.voucher === true;
  return {
    agentId,
    asset,
    amount: BigInt(amount),
    ...(voucher ? { voucher: true } : {}),
    ...(!voucher && isTxHash(e.tx) ? { tx: e.tx } : {}),
    ...(!voucher && isSlot(e.ttlSlot) ? { ttlSlot: e.ttlSlot } : {}),
  };
}

/**
 * The records that spend: a signed transaction, and a voucher's increment — what it added to the
 * most already signed on its channel. A voucher re-signed at or below that is `voucher_resigned`,
 * which spends nothing and is not read here.
 */
const SPEND_EVENTS: Record<string, { voucher?: true }> = { signed: {}, voucher_signed: { voucher: true } };

/**
 * Written by signerd when it has read from the chain that a signed transaction can no longer land,
 * and has taken its spend back off the ledger. It names the transaction; replay removes that one.
 */
const RELEASE_EVENT = "spend_released";

const TERMINAL_EVENTS = new Set([
  "approved",
  "approval_denied",
  "approval_timeout",
  "shutdown_denied",
  "approval_sign_error",
  "approval_stale",
  "pending_abandoned",
]);

export async function replayAudit(
  lines: AsyncIterable<string> | Iterable<string>,
  opts: { checkpoint?: Checkpoint; windowMs: number; now?: number },
): Promise<Replay> {
  const { checkpoint, windowMs } = opts;
  const cutoff = (opts.now ?? Date.now()) - windowMs;

  const afterCheckpoint: SpendRecord[] = [];
  const released: string[] = [];
  const pendingSeen = new Map<string, OpenApproval>();
  const terminated = new Set<string>();
  const out: Replay = {
    spends: [],
    openApprovals: [],
    lastSeq: 0,
    lastHash: "",
    skipped: 0,
    hasRecords: false,
    sawCheckpoint: checkpoint === undefined || checkpoint.seq === 0,
  };

  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      out.malformedAt ??= lineNo;
      continue;
    }
    out.hasRecords = true;

    // Records predating the chain carry no seq and no prev, so they are simply not verified.
    const seq = typeof e.seq === "number" ? e.seq : undefined;
    if (seq !== undefined) {
      if (out.chainBrokenAt === undefined && typeof e.prev === "string" && e.prev !== out.lastHash) out.chainBrokenAt = lineNo;
      out.lastSeq = seq;
    }
    out.lastHash = sha256(line);
    if (checkpoint && seq === checkpoint.seq && out.lastHash === checkpoint.hash) out.sawCheckpoint = true;

    // Only approvals inside the window: one cannot outlive the approval timeout, so anything older
    // is settled whatever the log says, and tracking every id ever seen would grow without bound.
    const recent = typeof e.ts === "number" && e.ts >= cutoff;
    const event = e.event;
    if (event === "pending") {
      if (recent) pendingSeen.set(String(e.id), { id: String(e.id), agentId: String(e.agentId), reason: e.reason as string });
    } else if (typeof event === "string" && TERMINAL_EVENTS.has(event)) {
      if (recent) terminated.add(String(e.id));
    } else if (typeof event === "string" && Object.hasOwn(SPEND_EVENTS, event) && typeof e.ts === "number") {
      if (e.ts < cutoff) out.skipped++;
      // Only what the checkpoint cannot already hold. No seq means it predates the chain, so it is
      // older than the checkpoint by construction; counting it again inflated spend on every
      // restart, without bound.
      else if (checkpoint === undefined || (seq !== undefined && seq > checkpoint.seq)) {
        // The kind comes from the event, not from a field a record could carry either way.
        const spend = readSpend({ ...e, voucher: SPEND_EVENTS[event]!.voucher === true });
        // A spend that cannot be read is reported, not skipped: skipping it would hand the agent
        // back its budget.
        if (spend === undefined) out.malformedAt ??= lineNo;
        else afterCheckpoint.push({ ts: e.ts, ...spend });
      }
    } else if (event === RELEASE_EVENT) {
      // The opposite of a spend, so the opposite rule for what is unreadable: a release with no
      // usable transaction is ignored, because ignoring one keeps the budget spent. The same two
      // gates as a spend. Older than the window, it can only name a spend that is already gone;
      // and one the checkpoint was written after is already in the checkpoint's spends.
      const unseen = checkpoint === undefined || (seq !== undefined && seq > checkpoint.seq);
      if (recent && unseen && isTxHash(e.tx)) released.push(e.tx);
    }
  }

  if (checkpoint) {
    for (const s of checkpoint.spends) {
      const spend = readSpend(s as unknown as Record<string, unknown>);
      if (spend === undefined || typeof s.ts !== "number")
        throw new Error(`checkpoint holds an unreadable spend: ${JSON.stringify(s)}`);
      if (s.ts >= cutoff) out.spends.push({ ts: s.ts, ...spend });
    }
    out.lastSeq = Math.max(out.lastSeq, checkpoint.seq);
  }
  out.spends.push(...afterCheckpoint);
  // After both sources are in, so a release finds its spend wherever it came from. One release
  // takes one spend: two records with a transaction's hash would be a bug elsewhere, and a
  // release must never be the thing that hides it by taking both.
  for (const tx of released) {
    const i = out.spends.findIndex(s => s.tx === tx && !s.voucher);
    if (i !== -1) out.spends.splice(i, 1);
  }
  out.spends.sort((a, b) => a.ts - b.ts);
  for (const [id, entry] of pendingSeen) if (!terminated.has(id)) out.openApprovals.push(entry);
  return out;
}
