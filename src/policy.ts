/**
 * Spend policy for AI agents. Pure logic: no chain, no keys, no I/O.
 *
 * Amounts are bigint in the asset's smallest unit (lovelace, or USDM's 6-decimal unit),
 * keyed by the x402 canonical asset id: "lovelace" or "<policyId56hex>.<assetNameHex>".
 *
 * Decision flow for one payment request:
 *   1. agent must exist in policy
 *   2. asset must be allowed
 *   3. payee must be allowed ("*" = any)
 *   4. amount <= perTxMax[asset]
 *   5. spent-today + amount <= dailyMax[asset]   (rolling 24h window)
 *   6. payments in the last hour < maxPerHour
 *   7. amount > approvalAbove[asset]  → "needs_approval" (a human must approve via walletctl)
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
}

export interface Policy {
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
  now?: number;
}

export type Decision =
  | { verdict: "allow" }
  | { verdict: "needs_approval"; rule: string; detail: string }
  | { verdict: "deny"; rule: string; detail: string };

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export function parsePolicy(raw: unknown): Policy {
  if (typeof raw !== "object" || raw === null || typeof (raw as Policy).agents !== "object") {
    throw new Error("policy: expected { agents: { <id>: {...} } }");
  }
  const agents = (raw as Policy).agents;
  for (const [id, p] of Object.entries(agents)) {
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
  }
  return raw as Policy;
}

export function decide(policy: Policy, ledger: readonly SpendRecord[], req: PaymentRequest): Decision {
  const now = req.now ?? Date.now();
  const ap = policy.agents[req.agentId];
  if (!ap) return { verdict: "deny", rule: "unknown_agent", detail: `no policy for agent "${req.agentId}"` };
  if (req.amount <= 0n) return { verdict: "deny", rule: "amount", detail: "amount must be positive" };
  if (!req.reason || req.reason.trim().length < 3)
    return { verdict: "deny", rule: "reason", detail: "a reason is required for the audit log" };

  const perTx = ap.perTxMax[req.asset];
  if (perTx === undefined)
    return { verdict: "deny", rule: "asset", detail: `asset ${req.asset} not allowed for ${req.agentId}` };

  if (!ap.allowedPayees.includes("*") && !ap.allowedPayees.includes(req.payTo))
    return { verdict: "deny", rule: "payee", detail: `payee ${req.payTo} not in allowlist` };

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

/** Human-readable remaining budget, for wallet_status. */
export function remaining(policy: Policy, ledger: readonly SpendRecord[], agentId: string, now = Date.now()) {
  const ap = policy.agents[agentId];
  if (!ap) return null;
  const out: Record<string, { perTxMax: string; dailyRemaining: string }> = {};
  for (const [asset, perTx] of Object.entries(ap.perTxMax)) {
    const cap = BigInt(ap.dailyMax?.[asset] ?? perTx);
    const spent = ledger
      .filter(r => r.agentId === agentId && r.asset === asset && now - r.ts < DAY)
      .reduce((s, r) => s + r.amount, 0n);
    out[asset] = { perTxMax: perTx, dailyRemaining: (cap - spent < 0n ? 0n : cap - spent).toString() };
  }
  const lastHour = ledger.filter(r => r.agentId === agentId && now - r.ts < HOUR).length;
  return { assets: out, paymentsLastHour: lastHour, maxPerHour: ap.maxPerHour ?? 60 };
}
