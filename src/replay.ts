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
  spends: Array<{ ts: number; agentId: string; asset: string; amount: string }>;
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

const TERMINAL_EVENTS = new Set([
  "approved",
  "approval_denied",
  "approval_timeout",
  "shutdown_denied",
  "approval_sign_error",
  "pending_abandoned",
]);

export async function replayAudit(
  lines: AsyncIterable<string> | Iterable<string>,
  opts: { checkpoint?: Checkpoint; windowMs: number; now?: number },
): Promise<Replay> {
  const { checkpoint, windowMs } = opts;
  const cutoff = (opts.now ?? Date.now()) - windowMs;

  const afterCheckpoint: SpendRecord[] = [];
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
    } else if (event === "signed" && typeof e.ts === "number") {
      if (e.ts < cutoff) out.skipped++;
      // Only what the checkpoint cannot already hold. No seq means it predates the chain, so it is
      // older than the checkpoint by construction; counting it again inflated spend on every
      // restart, without bound.
      else if (checkpoint === undefined || (seq !== undefined && seq > checkpoint.seq))
        afterCheckpoint.push({ ts: e.ts, agentId: String(e.agentId), asset: String(e.asset), amount: BigInt(String(e.amount)) });
    }
  }

  if (checkpoint) {
    for (const s of checkpoint.spends) {
      if (s.ts >= cutoff) out.spends.push({ ts: s.ts, agentId: s.agentId, asset: s.asset, amount: BigInt(s.amount) });
    }
    out.lastSeq = Math.max(out.lastSeq, checkpoint.seq);
  }
  out.spends.push(...afterCheckpoint);
  out.spends.sort((a, b) => a.ts - b.ts);
  for (const [id, entry] of pendingSeen) if (!terminated.has(id)) out.openApprovals.push(entry);
  return out;
}
