/**
 * Spend policy for AI agents. Pure logic: no chain, no keys, no I/O.
 *
 * Amounts are bigint in the asset's smallest unit (lovelace, or USDM's 6-decimal unit),
 * keyed by the x402 canonical asset id: "lovelace" or "<policyId56hex>.<assetNameHex>".
 *
 * Decision flow for one payment request:
 *   1. agent must exist in policy
 *   2. the asset transfer method must be allowed (default: only "default")
 *   3. asset must be allowed
 *   4. payee must be allowed ("*" = any)
 *   5. amount <= perTxMax[asset]
 *   6. spent-today + amount <= dailyMax[asset]   (rolling 24h window)
 *   7. payments in the last hour < maxPerHour
 *   8. amount > approvalAbove[asset]  → "needs_approval" (a human must approve via walletctl)
 *   otherwise → "allow"
 *
 * `batch-settlement` pays by vouchers on a channel it has locked a deposit in. Each voucher goes
 * through the same flow for its increment — what it adds to the most already signed on that
 * channel — with two differences: the channel's provider key must be allowed (step 4), and the
 * hourly count is of vouchers, against maxVouchersPerHour (step 7). A deposit is locked rather
 * than spent, and `decideDeposit` bounds it instead.
 *
 * The ledger of past spends is injected so the same engine runs in the signer daemon
 * (authoritative) and, optionally, in the agent-side pre-check (advisory).
 */

export type AmountMap = Record<string, string>; // asset -> bigint as decimal string

export interface AgentPolicy {
  /** Max per single payment, per asset. Assets missing here are denied. */
  perTxMax: AmountMap;
  /** Max over any rolling 24h, per asset. Missing => same as perTxMax (one payment/day). */
  dailyMax?: AmountMap;
  /** bech32 addresses, or ["*"] for any. */
  allowedPayees: string[];
  /** Max number of payments in any rolling 60 minutes. Default 60. */
  maxPerHour?: number;
  /** Above this amount (per asset) a human must approve. Missing => never. */
  approvalAbove?: AmountMap;
  /**
   * Defaults to ["default"]. "masumi" is excluded because its cost is not only `amount` — the
   * escrow also locks collateral no field here can see, bounded only by signerd's
   * MASUMI_MAX_COLLATERAL_LOVELACE.
   */
  allowedAssetTransferMethods?: string[];
  /**
   * Exact URLs, prefixes ending in `/*`, or ["*"] for any; omitted means any.
   *
   * Checked against a URL the agent process reports, not against the transaction, so it constrains
   * a steered agent rather than a replaced one. `allowedPayees` is what binds the transaction.
   */
  allowedResources?: string[];
  /**
   * The x402 schemes this agent may pay with. Defaults to ["exact"]: "batch-settlement" locks a
   * deposit in a channel and pays by vouchers, and stays off until listed.
   */
  allowedSchemes?: string[];
  /**
   * For batch-settlement: the key hashes a channel may name as its provider, or ["*"]; missing
   * means none. The channel binds this key, not `payTo`: the key redeems, and the validator does
   * not restrict where a redemption pays, so an allowed `payTo` beside a key of the seller's own
   * choosing would pay whoever holds that key.
   */
  allowedProviderKeys?: string[];
  /** Per asset: the most one channel opening or top-up may lock. Assets missing here are not deposited. */
  channelDepositMax?: AmountMap;
  /**
   * Per asset: the most this agent's open channels may hold together. A token channel's ADA
   * reserve counts as lovelace, so token channels need a lovelace entry here too.
   */
  channelLockedMax?: AmountMap;
  /**
   * Seconds. The seller sets a channel's close period, and a unilateral exit keeps the money that
   * long; a channel asking for more is not opened. Default 86400; the binding allows 900 to 2592000.
   */
  maxWithdrawDelay?: number;
  /** Vouchers in any rolling 60 minutes. Default 600. `maxPerHour` counts transactions only. */
  maxVouchersPerHour?: number;
}

export interface Policy {
  /**
   * The network these limits are written for. signerd refuses to start on a mismatch, and refuses
   * mainnet unless it is stated: caps are bare numbers, and a preprod file reads identically.
   */
  network?: string;
  agents: Record<string, AgentPolicy>;
}

export interface SpendRecord {
  ts: number; // epoch ms
  agentId: string;
  asset: string;
  amount: bigint;
  /** A batch-settlement voucher's increment; absent for a transaction. The two have separate hourly limits. */
  voucher?: boolean;
}

export interface PaymentRequest {
  agentId: string;
  payTo: string;
  asset: string;
  amount: bigint;
  reason: string;
  /** From the 402's `extra.assetTransferMethod`; absent means the "default" address-to-address flow. */
  assetTransferMethod?: string;
  /** The URL the agent reports it is paying for; see AgentPolicy.allowedResources. */
  resource?: string;
  /** Absent means "exact". For "batch-settlement", `amount` is the voucher's increment. */
  scheme?: string;
  /** For batch-settlement: the channel's provider key (the 402's `receiverAuthorizer`). */
  providerKey?: string;
  now?: number;
}

/** One channel opening or top-up, for `decideDeposit`. */
export interface DepositRequest {
  agentId: string;
  asset: string;
  /** What it locks of the asset; an ADA channel's reserve is part of it. */
  amount: bigint;
  /** A new token channel's ADA reserve, locked beside its tokens; otherwise 0. */
  reserveLovelace: bigint;
  /** What the agent's open channels hold now, by asset; token channels' reserves under lovelace. */
  locked: Readonly<Record<string, bigint>>;
  /** The close period the seller set, in seconds. */
  withdrawDelay: number;
}

export type Decision =
  | { verdict: "allow"; rule?: undefined; detail?: undefined }
  | { verdict: "needs_approval"; rule: string; detail: string }
  | { verdict: "deny"; rule: string; detail: string };

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const TRANSFER_METHODS = ["default", "masumi", "script"];
export const BATCH = "batch-settlement";
const SCHEMES = ["exact", BATCH];
const AGENT_POLICY_KEYS = [
  "perTxMax",
  "dailyMax",
  "allowedPayees",
  "maxPerHour",
  "approvalAbove",
  "allowedAssetTransferMethods",
  "allowedResources",
  "allowedSchemes",
  "allowedProviderKeys",
  "channelDepositMax",
  "channelLockedMax",
  "maxWithdrawDelay",
  "maxVouchersPerHour",
];
const DEFAULT_TRANSFER_METHODS = ["default"];
const DEFAULT_SCHEMES = ["exact"];
const DEFAULT_MAX_WITHDRAW_DELAY = 86_400;
const DEFAULT_MAX_VOUCHERS_PER_HOUR = 600;
/** The binding's bounds on a close period, in seconds. */
const WITHDRAW_DELAY_RANGE = [900, 2_592_000] as const;

export function parsePolicy(raw: unknown): Policy {
  if (typeof raw !== "object" || raw === null || typeof (raw as Policy).agents !== "object") {
    throw new Error("policy: expected { agents: { <id>: {...} } }");
  }
  const net = (raw as Policy).network;
  if (net !== undefined && (typeof net !== "string" || !/^[a-z0-9]+:[a-z0-9-]+$/.test(net)))
    throw new Error(`policy: network must be a CAIP-2 style id such as "cardano:mainnet"`);
  const agents = (raw as Policy).agents;
  for (const [id, p] of Object.entries(agents)) {
    // Every field here forbids or bounds something, so a misspelling does not degrade to a
    // stricter policy but to none: `approvalabove` is a threshold that silently never fires.
    for (const key of Object.keys(p)) {
      if (!AGENT_POLICY_KEYS.includes(key))
        throw new Error(`policy: agent ${id} has unknown field "${key}" (known: ${AGENT_POLICY_KEYS.join(", ")})`);
    }
    if (!p.perTxMax || typeof p.perTxMax !== "object") throw new Error(`policy: agent ${id} needs perTxMax`);
    if (!Array.isArray(p.allowedPayees) || p.allowedPayees.length === 0)
      throw new Error(`policy: agent ${id} needs allowedPayees (use ["*"] for any)`);
    for (const m of [p.perTxMax, p.dailyMax, p.approvalAbove, p.channelDepositMax, p.channelLockedMax]) {
      if (!m) continue;
      if (typeof m !== "object" || Array.isArray(m)) throw new Error(`policy: agent ${id} has an amount map that is not an object`);
      for (const [asset, v] of Object.entries(m)) {
        if (!/^(lovelace|[0-9a-f]{56}\.[0-9a-f]{0,64})$/.test(asset))
          throw new Error(`policy: agent ${id} bad asset id "${asset}"`);
        if (!/^[0-9]+$/.test(v)) throw new Error(`policy: agent ${id} amount for ${asset} must be a decimal integer string`);
      }
    }
    // An asset absent from perTxMax is denied outright, so a cap or threshold for one is a typo
    // that quietly does nothing. Lovelace is the exception for channelLockedMax: a token channel's
    // ADA reserve is locked whether or not this agent may pay in ADA.
    for (const [label, m] of [
      ["dailyMax", p.dailyMax],
      ["approvalAbove", p.approvalAbove],
      ["channelDepositMax", p.channelDepositMax],
      ["channelLockedMax", p.channelLockedMax],
    ] as const) {
      for (const asset of Object.keys(m ?? {})) {
        if (!(asset in p.perTxMax) && !(label === "channelLockedMax" && asset === "lovelace"))
          throw new Error(`policy: agent ${id} has ${label} for "${asset}", which is not in perTxMax and so is never allowed`);
      }
    }
    if (p.maxPerHour !== undefined && (!Number.isInteger(p.maxPerHour) || p.maxPerHour < 1))
      throw new Error(`policy: agent ${id} maxPerHour must be a positive integer`);
    if (p.maxVouchersPerHour !== undefined && (!Number.isInteger(p.maxVouchersPerHour) || p.maxVouchersPerHour < 1))
      throw new Error(`policy: agent ${id} maxVouchersPerHour must be a positive integer`);
    if (p.allowedSchemes !== undefined) {
      if (!Array.isArray(p.allowedSchemes) || p.allowedSchemes.length === 0)
        throw new Error(`policy: agent ${id} allowedSchemes must be a non-empty array`);
      for (const s of p.allowedSchemes) {
        if (!SCHEMES.includes(s)) throw new Error(`policy: agent ${id} unknown scheme "${s}" (known: ${SCHEMES.join(", ")})`);
      }
    }
    if (p.allowedProviderKeys !== undefined) {
      if (!Array.isArray(p.allowedProviderKeys) || p.allowedProviderKeys.length === 0)
        throw new Error(`policy: agent ${id} allowedProviderKeys must be a non-empty array (use ["*"] for any)`);
      for (const k of p.allowedProviderKeys) {
        if (k !== "*" && (typeof k !== "string" || !/^[0-9a-f]{56}$/.test(k)))
          throw new Error(`policy: agent ${id} allowedProviderKeys entry "${String(k)}" must be a key hash (56 lowercase hex characters) or "*"`);
      }
    }
    if (
      p.maxWithdrawDelay !== undefined &&
      (!Number.isInteger(p.maxWithdrawDelay) || p.maxWithdrawDelay < WITHDRAW_DELAY_RANGE[0] || p.maxWithdrawDelay > WITHDRAW_DELAY_RANGE[1])
    )
      throw new Error(`policy: agent ${id} maxWithdrawDelay must be whole seconds from ${WITHDRAW_DELAY_RANGE[0]} to ${WITHDRAW_DELAY_RANGE[1]}, the range the binding allows`);
    if (p.allowedResources !== undefined) {
      if (!Array.isArray(p.allowedResources) || p.allowedResources.length === 0)
        throw new Error(`policy: agent ${id} allowedResources must be a non-empty array (use ["*"] for any)`);
      for (const r of p.allowedResources) {
        if (typeof r !== "string" || r.length === 0)
          throw new Error(`policy: agent ${id} allowedResources entries must be non-empty strings`);
        if (r === "*") continue;
        const bare = r.endsWith("/*") ? r.slice(0, -2) : r;
        if (!/^https?:\/\/[^\s]+$/.test(bare))
          throw new Error(`policy: agent ${id} allowedResources entry "${r}" must be an http(s) URL, optionally ending in /*`);
      }
    }
    if (p.allowedAssetTransferMethods !== undefined) {
      if (!Array.isArray(p.allowedAssetTransferMethods) || p.allowedAssetTransferMethods.length === 0)
        throw new Error(`policy: agent ${id} allowedAssetTransferMethods must be a non-empty array`);
      for (const m of p.allowedAssetTransferMethods) {
        if (!TRANSFER_METHODS.includes(m))
          throw new Error(`policy: agent ${id} unknown assetTransferMethod "${m}" (known: ${TRANSFER_METHODS.join(", ")})`);
      }
    }
  }
  return raw as Policy;
}

/**
 * Exact match, or a `/*` suffix matching that path prefix. The prefix keeps its trailing slash so
 * `/v1/*` does not match `/v1evil/x`, and both sides go through `URL` first so `/v1/../admin` does
 * not match either.
 */
function resourceMatches(pattern: string, resource: string): boolean {
  const target = normalizeUrl(resource);
  if (target === undefined) return false;
  if (pattern.endsWith("/*")) {
    const prefix = normalizeUrl(pattern.slice(0, -1)); // keep the trailing slash
    return prefix !== undefined && target.startsWith(prefix);
  }
  return normalizeUrl(pattern) === target;
}
function normalizeUrl(value: string): string | undefined {
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
}

export function decide(policy: Policy, ledger: readonly SpendRecord[], req: PaymentRequest): Decision {
  const now = req.now ?? Date.now();
  const ap = policy.agents[req.agentId];
  if (!ap) return { verdict: "deny", rule: "unknown_agent", detail: `no policy for agent "${req.agentId}"` };
  if (req.amount <= 0n) return { verdict: "deny", rule: "amount", detail: "amount must be positive" };
  if (typeof req.reason !== "string" || req.reason.trim().length < 3)
    return { verdict: "deny", rule: "reason", detail: "a reason is required for the audit log" };

  const scheme = req.scheme ?? "exact";
  const schemes = ap.allowedSchemes ?? DEFAULT_SCHEMES;
  if (!schemes.includes(scheme))
    return { verdict: "deny", rule: "scheme", detail: `scheme "${scheme}" not allowed for ${req.agentId} (allowed: ${schemes.join(", ")})` };
  const batch = scheme === BATCH;

  // How an `exact` payment moves the asset; a voucher moves nothing until the seller redeems it.
  if (!batch) {
    const method = req.assetTransferMethod ?? "default";
    const allowedMethods = ap.allowedAssetTransferMethods ?? DEFAULT_TRANSFER_METHODS;
    if (!allowedMethods.includes(method))
      return {
        verdict: "deny",
        rule: "asset_transfer_method",
        detail: `assetTransferMethod "${method}" not allowed for ${req.agentId} (allowed: ${allowedMethods.join(", ")})`,
      };
  }

  const perTx = ap.perTxMax[req.asset];
  if (perTx === undefined)
    return { verdict: "deny", rule: "asset", detail: `asset ${req.asset} not allowed for ${req.agentId}` };

  if (!ap.allowedPayees.includes("*") && !ap.allowedPayees.includes(req.payTo))
    return { verdict: "deny", rule: "payee", detail: `payee ${req.payTo} not in allowlist` };

  if (batch) {
    const keys = ap.allowedProviderKeys ?? [];
    if (!keys.includes("*") && !(req.providerKey !== undefined && keys.includes(req.providerKey)))
      return {
        verdict: "deny",
        rule: "provider_key",
        detail: `the channel's provider key ${req.providerKey ?? "(none given)"} is not in allowedProviderKeys; it, not the payee address, is who redeems`,
      };
  }

  if (ap.allowedResources && !ap.allowedResources.includes("*")) {
    // Fail closed: an unreported resource cannot be checked, which is what the list exists for.
    if (!req.resource)
      return { verdict: "deny", rule: "resource", detail: `agent ${req.agentId} has allowedResources but the payment named no resource` };
    if (!ap.allowedResources.some(pattern => resourceMatches(pattern, req.resource!)))
      return { verdict: "deny", rule: "resource", detail: `resource ${req.resource} not in allowlist` };
  }

  if (req.amount > BigInt(perTx))
    return { verdict: "deny", rule: "per_tx_max", detail: `${req.amount} > perTxMax ${perTx} (${req.asset})` };

  const dailyCap = BigInt(ap.dailyMax?.[req.asset] ?? perTx);
  const spentToday = ledger
    .filter(r => r.agentId === req.agentId && r.asset === req.asset && now - r.ts < DAY)
    .reduce((s, r) => s + r.amount, 0n);
  if (spentToday + req.amount > dailyCap)
    return {
      verdict: "deny",
      rule: "daily_max",
      detail: `spent ${spentToday} + ${req.amount} > dailyMax ${dailyCap} (${req.asset}, rolling 24h)`,
    };

  // Vouchers and transactions are counted apart: a channel exists to pay many small amounts, and
  // a rate that suits one would starve or unbound the other.
  const perHour = batch ? (ap.maxVouchersPerHour ?? DEFAULT_MAX_VOUCHERS_PER_HOUR) : (ap.maxPerHour ?? 60);
  const lastHour = ledger.filter(r => r.agentId === req.agentId && Boolean(r.voucher) === batch && now - r.ts < HOUR).length;
  if (lastHour >= perHour)
    return {
      verdict: "deny",
      rule: "rate",
      detail: batch
        ? `${lastHour} vouchers in the last hour >= maxVouchersPerHour ${perHour}`
        : `${lastHour} payments in the last hour >= maxPerHour ${perHour}`,
    };

  const threshold = ap.approvalAbove?.[req.asset];
  if (threshold !== undefined && req.amount > BigInt(threshold))
    return {
      verdict: "needs_approval",
      rule: "approval_above",
      detail: `${req.amount} > approvalAbove ${threshold} (${req.asset}); run: walletctl approve <id>`,
    };

  return { verdict: "allow" };
}

/**
 * Whether one channel opening or top-up may lock what it asks. Its voucher is judged by `decide`
 * like any other; this bounds what is locked, which comes back less what the vouchers let the
 * seller take, and so is not counted as spent. Allow or deny: nothing here queues for approval.
 */
export function decideDeposit(policy: Policy, req: DepositRequest): Decision {
  const ap = policy.agents[req.agentId];
  if (!ap) return { verdict: "deny", rule: "unknown_agent", detail: `no policy for agent "${req.agentId}"` };
  if (!(ap.allowedSchemes ?? DEFAULT_SCHEMES).includes(BATCH))
    return { verdict: "deny", rule: "scheme", detail: `scheme "${BATCH}" not allowed for ${req.agentId}` };

  const maxDelay = ap.maxWithdrawDelay ?? DEFAULT_MAX_WITHDRAW_DELAY;
  if (req.withdrawDelay > maxDelay)
    return {
      verdict: "deny",
      rule: "withdraw_delay",
      detail: `the seller's close period is ${req.withdrawDelay}s, above maxWithdrawDelay ${maxDelay}s: leaving without the seller would keep the deposit that long`,
    };

  const perDeposit = ap.channelDepositMax?.[req.asset];
  if (perDeposit === undefined)
    return { verdict: "deny", rule: "channel_deposit_max", detail: `no channelDepositMax for ${req.asset}, so ${req.agentId} locks none of it` };
  if (req.amount > BigInt(perDeposit))
    return { verdict: "deny", rule: "channel_deposit_max", detail: `${req.amount} > channelDepositMax ${perDeposit} (${req.asset})` };

  const within = (asset: string, add: bigint): Decision | undefined => {
    const cap = ap.channelLockedMax?.[asset];
    const held = req.locked[asset] ?? 0n;
    if (cap === undefined)
      return { verdict: "deny", rule: "channel_locked_max", detail: `no channelLockedMax for ${asset}, so ${req.agentId} locks none of it` };
    if (held + add > BigInt(cap))
      return { verdict: "deny", rule: "channel_locked_max", detail: `${held} locked + ${add} > channelLockedMax ${cap} (${asset})` };
    return undefined;
  };
  return within(req.asset, req.amount) ?? (req.reserveLovelace > 0n ? within("lovelace", req.reserveLovelace) : undefined) ?? { verdict: "allow" };
}

/**
 * Remaining budget, for wallet_status. `dailyRemaining` is clamped at zero, so `dailySpent`,
 * `dailyMax` and `overBudget` are reported too — an exceeded cap and an exactly spent one both
 * clamp to the same number, and they are not the same fact.
 */
export function remaining(policy: Policy, ledger: readonly SpendRecord[], agentId: string, now = Date.now()) {
  const ap = policy.agents[agentId];
  if (!ap) return null;
  const out: Record<
    string,
    { perTxMax: string; dailyMax: string; dailySpent: string; dailyRemaining: string; overBudget: boolean }
  > = {};
  for (const [asset, perTx] of Object.entries(ap.perTxMax)) {
    const cap = BigInt(ap.dailyMax?.[asset] ?? perTx);
    const spent = ledger
      .filter(r => r.agentId === agentId && r.asset === asset && now - r.ts < DAY)
      .reduce((s, r) => s + r.amount, 0n);
    out[asset] = {
      perTxMax: perTx,
      dailyMax: cap.toString(),
      dailySpent: spent.toString(),
      dailyRemaining: (cap - spent < 0n ? 0n : cap - spent).toString(),
      overBudget: spent > cap,
    };
  }
  const lastHour = (voucher: boolean) => ledger.filter(r => r.agentId === agentId && Boolean(r.voucher) === voucher && now - r.ts < HOUR).length;
  const schemes = ap.allowedSchemes ?? DEFAULT_SCHEMES;
  return {
    assets: out,
    paymentsLastHour: lastHour(false),
    maxPerHour: ap.maxPerHour ?? 60,
    allowedAssetTransferMethods: ap.allowedAssetTransferMethods ?? DEFAULT_TRANSFER_METHODS,
    allowedSchemes: schemes,
    ...(schemes.includes(BATCH)
      ? { vouchersLastHour: lastHour(true), maxVouchersPerHour: ap.maxVouchersPerHour ?? DEFAULT_MAX_VOUCHERS_PER_HOUR }
      : {}),
  };
}
