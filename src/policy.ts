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
  now?: number;
}

export type Decision =
  | { verdict: "allow" }
  | { verdict: "needs_approval"; rule: string; detail: string }
  | { verdict: "deny"; rule: string; detail: string };

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const TRANSFER_METHODS = ["default", "masumi", "script"];
const AGENT_POLICY_KEYS = [
  "perTxMax",
  "dailyMax",
  "allowedPayees",
  "maxPerHour",
  "approvalAbove",
  "allowedAssetTransferMethods",
  "allowedResources",
];
const DEFAULT_TRANSFER_METHODS = ["default"];

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
    for (const m of [p.perTxMax, p.dailyMax, p.approvalAbove]) {
      if (!m) continue;
      for (const [asset, v] of Object.entries(m)) {
        if (!/^(lovelace|[0-9a-f]{56}\.[0-9a-f]{0,64})$/.test(asset))
          throw new Error(`policy: agent ${id} bad asset id "${asset}"`);
        if (!/^[0-9]+$/.test(v)) throw new Error(`policy: agent ${id} amount for ${asset} must be a decimal integer string`);
      }
    }
    // An asset absent from perTxMax is denied outright, so a cap or threshold for one is a typo
    // that quietly does nothing.
    for (const [label, m] of [
      ["dailyMax", p.dailyMax],
      ["approvalAbove", p.approvalAbove],
    ] as const) {
      for (const asset of Object.keys(m ?? {})) {
        if (!(asset in p.perTxMax))
          throw new Error(`policy: agent ${id} has ${label} for "${asset}", which is not in perTxMax and so is never allowed`);
      }
    }
    if (p.maxPerHour !== undefined && (!Number.isInteger(p.maxPerHour) || p.maxPerHour < 1))
      throw new Error(`policy: agent ${id} maxPerHour must be a positive integer`);
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
  if (!req.reason || req.reason.trim().length < 3)
    return { verdict: "deny", rule: "reason", detail: "a reason is required for the audit log" };

  const method = req.assetTransferMethod ?? "default";
  const allowedMethods = ap.allowedAssetTransferMethods ?? DEFAULT_TRANSFER_METHODS;
  if (!allowedMethods.includes(method))
    return {
      verdict: "deny",
      rule: "asset_transfer_method",
      detail: `assetTransferMethod "${method}" not allowed for ${req.agentId} (allowed: ${allowedMethods.join(", ")})`,
    };

  const perTx = ap.perTxMax[req.asset];
  if (perTx === undefined)
    return { verdict: "deny", rule: "asset", detail: `asset ${req.asset} not allowed for ${req.agentId}` };

  if (!ap.allowedPayees.includes("*") && !ap.allowedPayees.includes(req.payTo))
    return { verdict: "deny", rule: "payee", detail: `payee ${req.payTo} not in allowlist` };

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

  const perHour = ap.maxPerHour ?? 60;
  const lastHour = ledger.filter(r => r.agentId === req.agentId && now - r.ts < HOUR).length;
  if (lastHour >= perHour)
    return { verdict: "deny", rule: "rate", detail: `${lastHour} payments in the last hour >= maxPerHour ${perHour}` };

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
  const lastHour = ledger.filter(r => r.agentId === agentId && now - r.ts < HOUR).length;
  return {
    assets: out,
    paymentsLastHour: lastHour,
    maxPerHour: ap.maxPerHour ?? 60,
    allowedAssetTransferMethods: ap.allowedAssetTransferMethods ?? DEFAULT_TRANSFER_METHODS,
  };
}
