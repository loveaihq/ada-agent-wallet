/**
 * signerd's own record of each batch-settlement channel: whose it is, and the most signerd has
 * signed on it.
 *
 * subbit-x402's client keeps records too, but they move with what sellers answer, and those
 * answers reach signerd through the agent's process. Nothing here does. `signedMax` is what the
 * policy counts from — a voucher spends what it adds to it — and what a refund may pay the seller
 * up to; `anchor` is a position of the channel signerd signed or read from the chain itself, which
 * is where it follows the channel from, so a hint an agent passed on cannot make it look closed.
 *
 * One JSON file, owner-only, written whole or not at all: a torn write would lose `signedMax`, and
 * with it the count of what sellers may redeem.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface ChannelEntry {
  agentId: string;
  network: string;
  scriptHash: string;
  asset: string;
  /** The seller's `payTo`, as the 402 that opened or bound the channel named it; empty until then. */
  payTo: string;
  /** The channel's provider: the key that redeems. */
  providerKey: string;
  /** The highest cumulative amount signerd has signed on this channel, as a decimal string. */
  signedMax: string;
  /** `txHash#index`: where signerd follows the channel from. */
  anchor: string;
  /** What the opening locked, counted while the opening is not on chain yet. */
  deposit: string;
  /** A token channel's ADA reserve, likewise. */
  reserve: string;
  status: "open" | "closed";
  openedAt: number;
}

interface File {
  version: 1;
  channels: Record<string, ChannelEntry>;
}

const DEC = /^[0-9]+$/;
const REF = /^[0-9a-f]{64}#[0-9]+$/;

function readEntry(id: string, e: unknown): ChannelEntry {
  const bad = (what: string) => new Error(`channel ${id.slice(0, 16)}…: ${what}`);
  if (!/^[0-9a-f]{64}$/.test(id)) throw bad("the id is not a 32-byte tag");
  if (typeof e !== "object" || e === null) throw bad("not an object");
  const r = e as Record<string, unknown>;
  for (const k of ["agentId", "network", "scriptHash", "asset", "payTo", "providerKey"] as const)
    if (typeof r[k] !== "string") throw bad(`${k} is not a string`);
  for (const k of ["signedMax", "deposit", "reserve"] as const) if (typeof r[k] !== "string" || !DEC.test(r[k] as string)) throw bad(`${k} is not a decimal amount`);
  if (typeof r.anchor !== "string" || !REF.test(r.anchor)) throw bad("anchor is not an out-ref");
  if (r.status !== "open" && r.status !== "closed") throw bad("status is neither open nor closed");
  if (typeof r.openedAt !== "number") throw bad("openedAt is not a number");
  return r as unknown as ChannelEntry;
}

export class ChannelStore {
  private readonly channels: Map<string, ChannelEntry>;

  /** Throws when the file exists and does not read as a store: an unreadable one is not an empty one. */
  constructor(private readonly file: string) {
    this.channels = new Map();
    if (!existsSync(file)) return;
    const raw = JSON.parse(readFileSync(file, "utf8")) as File;
    if (raw?.version !== 1 || typeof raw.channels !== "object" || raw.channels === null) throw new Error("unrecognized channel store shape");
    for (const [id, e] of Object.entries(raw.channels)) this.channels.set(id, readEntry(id, e));
  }

  get(id: string): ChannelEntry | undefined {
    return this.channels.get(id);
  }

  entries(): Array<[string, ChannelEntry]> {
    return [...this.channels];
  }

  set(id: string, e: ChannelEntry): void {
    this.channels.set(id, readEntry(id, e));
    const body: File = { version: 1, channels: Object.fromEntries(this.channels) };
    writeFileSync(`${this.file}.tmp`, JSON.stringify(body, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
