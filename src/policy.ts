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
   * Cardano asset transfer methods this agent may use. Defaults to ["default"].
   *
   * "masumi" is not in the default set because its cost is not only `amount`: the escrow also
   * locks buyer collateral, which no field here can see and which stays locked until the
   * contract's submit_result_time. Enabling it means accepting a lovelace charge on top of the
   * payment, bounded by signerd's MASUMI_MAX_COLLATERAL_LOVELACE rather than by this policy.
   */
  allowedAssetTransferMethods?: string[];
  /**
   * Resources this agent may buy from: exact URLs, prefixes ending in `/*`, or ["*"] for any.
   * Omitted means any.
   *
   * Unlike every other field here, this is checked against a URL the agent process reports rather
   * than against anything in the transaction, because the reference `@x402/cardano` client does
   * not pass the resource through to the signer. It therefore constrains an agent that is running
   * our code and being steered — the prompt-injection case — and not one whose process has been
   * replaced. `allowedPayees` is the control that binds the transaction itself; treat this as the
   * layer above it, not as a substitute.
   */
  allowedResources?: string[];
}

export interface Policy {
  /**
   * The x402 network these limits are written for, e.g. "cardano:preprod".
   *
   * signerd refuses to start when this disagrees with CARDANO_NETWORK, and refuses to run on
   * mainnet at all unless it is stated. Caps are bare numbers with no unit attached: a policy
   * tuned against 10,000 faucet tADA says exactly the same thing to a mainnet wallet, where it
   * means real money. Declaring the network makes reusing the wrong file an error rather than a
   * very expensive no-op.
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
    // Reject unknown keys rather than ignoring them. Every field here either forbids something or
    // bounds it, so a misspelled one does not degrade to a stricter policy — it degrades to no
    // policy at all: `approvalabove` is not a typo that trips an error, it is a threshold that
    // silently never fires.
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
 * Exact match, or a `/*` suffix matching that path prefix. No regex, and no partial-segment
 * matches: the prefix keeps its trailing slash, so `https://api.example.com/v1/*` does not match
 * `https://api.example.com/v1evil/x`.
 *
 * Both sides are normalized through `URL` first, because `https://api.example.com/v1/../admin`
 * begins with an allowed prefix as a string and does not as a request.
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
    // Fail closed: a caller that reports no resource cannot be checked against the allowlist,
    // and an unverifiable payment is the thing the allowlist exists to prevent.
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
 * Human-readable remaining budget, for wallet_status.
 *
 * `dailyRemaining` is clamped at zero because a negative budget is not a thing you can spend,
 * but the clamp must not be the only number reported: a cap that was exceeded and a cap that was
 * exactly consumed both read as zero, and those are very different facts for an operator. So
 * `dailySpent`, `dailyMax` and an explicit `overBudget` are reported alongside it.
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
