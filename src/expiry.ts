/**
 * Which signed payments can never land, and reading that from the chain. No keys and no files: the
 * only thing here that touches the world is the `fetch` it is given, so a test can hand it any
 * answer a provider might give.
 *
 * signerd counts a payment as spent when it signs it, and never hears whether the facilitator got
 * it on chain. What it can know is this: the `exact` signer always gives a transaction an upper
 * validity bound, so once the chain is past that slot a transaction that is not in a block never
 * will be. That is the whole basis for giving a budget back, and it rests on two things read from
 * the chain provider by signerd itself — where the chain is, and whether the transaction is in it —
 * never on anything the agent, which the budget constrains, says about its own payment.
 *
 * The rule for what counts as an answer is lopsided on purpose. Every way of being wrong about
 * "not on chain" gives budget back that was really spent, so only a definite "no" counts: an HTTP
 * error, a body that is not what was asked for, a timeout and a missing row are all "unknown",
 * and unknown does nothing.
 */
import type { SpendRecord } from "./policy.js";
import { isSlot, isTxHash } from "./replay.js";
import { blockfrostBaseUrl, koiosBaseUrl } from "./network.js";

/** A spend that can be looked up on chain: it has a transaction, and the slot after which that is final. */
export type Releasable = SpendRecord & { tx: string; ttlSlot: number };

const lookupable = (s: SpendRecord): s is Releasable => !s.voucher && isTxHash(s.tx) && isSlot(s.ttlSlot);

/**
 * `tx` and `ttlSlot` for a spend record, from a decoded transaction. The hash is kept whenever it
 * is well-formed; the slot only if it is a whole number a JSON number holds exactly, since a bound
 * that cannot be compared is a bound that cannot be relied on.
 */
export function landing(txHash: string, ttlSlot: bigint | undefined): { tx?: string; ttlSlot?: number } {
  const tx = txHash.toLowerCase();
  const slot = ttlSlot !== undefined && ttlSlot >= 0n && ttlSlot <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(ttlSlot) : undefined;
  return { ...(isTxHash(tx) ? { tx } : {}), ...(slot !== undefined ? { ttlSlot: slot } : {}) };
}

/**
 * The spends whose transaction the chain has moved past. `marginSlots` is on top of the TTL, for a
 * provider that lags the chain and for a rollback: on preprod, preview and mainnet a slot is one
 * second. `settled` are transactions already seen in a block, which no longer need asking about.
 */
export function releasable(
  spends: readonly SpendRecord[],
  tipSlot: number,
  marginSlots: number,
  settled: ReadonlySet<string>,
): Releasable[] {
  return spends.filter((s): s is Releasable => lookupable(s) && !settled.has(s.tx) && tipSlot > s.ttlSlot + marginSlots);
}

/** What a provider can be asked. Neither method is trusted further than the answer it gives. */
export interface ChainLookup {
  /** The slot of the latest block. Throws when the provider does not say. */
  tip(): Promise<number>;
  /**
   * Only definite answers: `true` is in a block, `false` is definitely not. A transaction the
   * provider could not answer for is absent from the map, and absent means unknown.
   */
  onChain(txs: string[]): Promise<Map<string, boolean>>;
}

export interface LookupOptions {
  network: string;
  /** With it, Blockfrost; without, Koios — the same choice `providerConfig()` makes for the signer. */
  blockfrostProjectId?: string;
  koiosToken?: string;
  /** Per request. A provider that hangs must not hold a reconcile tick open. */
  timeoutMs: number;
  fetch?: typeof fetch;
}

export function chainLookup(o: LookupOptions): ChainLookup {
  return o.blockfrostProjectId ? blockfrostLookup(o, o.blockfrostProjectId) : koiosLookup(o);
}

/** A slot as a provider spells it: a JSON number, or a decimal string. Anything else is not one. */
function slotOf(v: unknown): number | undefined {
  const n = typeof v === "string" && /^[0-9]+$/.test(v) ? Number(v) : v;
  return isSlot(n) ? n : undefined;
}

export function blockfrostLookup(o: LookupOptions, projectId: string): ChainLookup {
  const base = blockfrostBaseUrl(o.network);
  const get = (path: string) => (o.fetch ?? fetch)(`${base}${path}`, { headers: { project_id: projectId }, signal: AbortSignal.timeout(o.timeoutMs) });
  return {
    async tip() {
      const r = await get("/blocks/latest");
      if (!r.ok) throw new Error(`blockfrost /blocks/latest answered ${r.status}`);
      const slot = slotOf(((await r.json()) as { slot?: unknown } | null)?.slot);
      if (slot === undefined) throw new Error("blockfrost /blocks/latest named no slot");
      return slot;
    },
    async onChain(txs) {
      const out = new Map<string, boolean>();
      await Promise.all(
        txs.map(async tx => {
          try {
            // 404 is Blockfrost's answer for a hash it does not have. A wrong path would answer it
            // for every hash, and the only guard against that is that `reconcile` has just read
            // the tip from this same base URL.
            const r = await get(`/txs/${tx}`);
            if (r.status === 200) out.set(tx, true);
            else if (r.status === 404) out.set(tx, false);
          } catch {
            /* unknown */
          }
        }),
      );
      return out;
    },
  };
}

export function koiosLookup(o: LookupOptions): ChainLookup {
  const base = koiosBaseUrl(o.network);
  const headers: Record<string, string> = { accept: "application/json", ...(o.koiosToken ? { authorization: `Bearer ${o.koiosToken}` } : {}) };
  const call = (path: string, init?: RequestInit) =>
    (o.fetch ?? fetch)(`${base}${path}`, { ...init, headers: { ...headers, ...init?.headers }, signal: AbortSignal.timeout(o.timeoutMs) });
  return {
    async tip() {
      const r = await call("/tip");
      if (!r.ok) throw new Error(`koios /tip answered ${r.status}`);
      const rows = (await r.json()) as Array<{ abs_slot?: unknown }> | null;
      const slot = slotOf(Array.isArray(rows) ? rows[0]?.abs_slot : undefined);
      if (slot === undefined) throw new Error("koios /tip named no slot");
      return slot;
    },
    async onChain(txs) {
      const out = new Map<string, boolean>();
      if (txs.length === 0) return out;
      try {
        const r = await call("/tx_status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ _tx_hashes: txs }) });
        if (!r.ok) return out;
        const rows = await r.json();
        if (!Array.isArray(rows)) return out;
        for (const row of rows as Array<{ tx_hash?: unknown; num_confirmations?: unknown } | null>) {
          const hash = typeof row?.tx_hash === "string" ? row.tx_hash.toLowerCase() : undefined;
          // Asked for, or ignored: a row for a transaction nobody asked about says nothing about one that was.
          if (hash === undefined || !txs.includes(hash)) continue;
          const n = row!.num_confirmations;
          // If a provider ever repeated a hash with two answers, the one that keeps the budget spent wins.
          if (typeof n === "number" && n >= 1) out.set(hash, true);
          else if (n === null && out.get(hash) !== true) out.set(hash, false);
        }
      } catch {
        /* unknown */
      }
      return out;
    },
  };
}

export interface Reconciled {
  /** Seen in a block: nothing to release, and worth not asking about again. */
  onChain: string[];
  /** Past the chain's reach and definitely not in it: their budget can go back. */
  absent: Releasable[];
}

/**
 * One pass: read the tip, take the spends it has moved past, ask about at most `max` of them, and
 * sort what came back. Nothing is changed here; the caller owns the ledger.
 *
 * `round` rotates which `max` are asked about when there are more than that, so spends the
 * provider keeps answering "unknown" for cannot crowd every other out of the same twenty places.
 * Throws when the tip cannot be read, which means nothing is released this time.
 */
export async function reconcile(
  spends: readonly SpendRecord[],
  chain: ChainLookup,
  o: { marginSlots: number; settled: ReadonlySet<string>; max: number; round: number },
): Promise<Reconciled> {
  const open = spends.filter((s): s is Releasable => lookupable(s) && !o.settled.has(s.tx));
  // Not even the tip is asked for when nothing could be released: an idle wallet makes no requests.
  if (open.length === 0) return { onChain: [], absent: [] };
  const due = releasable(open, await chain.tip(), o.marginSlots, o.settled);
  const start = due.length > o.max ? (o.round * o.max) % due.length : 0;
  const asked = due.length > o.max ? [...due.slice(start), ...due.slice(0, start)].slice(0, o.max) : due;
  if (asked.length === 0) return { onChain: [], absent: [] };
  const answers = await chain.onChain(asked.map(s => s.tx));
  return {
    onChain: asked.filter(s => answers.get(s.tx) === true).map(s => s.tx),
    absent: asked.filter(s => answers.get(s.tx) === false),
  };
}
