/**
 * The agent's side of batch-settlement: a scheme with no keys and no state. signerd runs the
 * channel client, with the wallet and its IOU keys, under the policy; this forwards a 402's
 * requirements there and the payload back, and hands the seller's answer over so the channel's
 * count stays in step. A drop-in scheme for any x402Client, as the gated signer is for `exact`.
 */
import type { PaymentPayloadResult, PaymentRequirements, SchemeClientHooks, SchemeNetworkClient } from "@x402/core/types";
import { PolicyDenied } from "./gatedSigner.js";

export const BATCH = "batch-settlement";

export interface BatchProxyConfig {
  signerdUrl: string;
  token: string;
  agentId: string;
  /** Called per payment to supply the reason logged in the audit trail. */
  reason: () => string;
  /** The URL being paid for, for `allowedResources`. */
  resource?: () => string | undefined;
  /** As for the gated signer: the verdict, before it is thrown and flattened by @x402/fetch. */
  onDenied?: (denied: PolicyDenied) => void;
  /** Called once signerd has signed: the voucher's increment is on the ledger from here. */
  onSigned?: () => void;
}

export function createBatchProxy(cfg: BatchProxyConfig): SchemeNetworkClient {
  const headers = { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${cfg.signerdUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) }).catch(e => {
      // As for the gated signer: a queued voucher holds the request open, and Node's fetch stops
      // waiting for headers after 300s. signerd withdraws it unsigned when the connection drops.
      const code = (e as { cause?: { code?: string } })?.cause?.code;
      if (code === "UND_ERR_HEADERS_TIMEOUT")
        throw new Error("signerd did not answer within the client's 300s wait; a voucher queued for approval was withdrawn unsigned, so ask again once it can be approved promptly");
      throw new Error(`signerd is not answering at ${cfg.signerdUrl}: ${e instanceof Error ? e.message : e}`);
    });
    return { r, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };

  const schemeHooks: SchemeClientHooks = {
    onPaymentResponse: async ctx => {
      // A transport error carries no answer to apply.
      if (!ctx.settleResponse && !ctx.paymentRequired) return;
      const { r, data } = await post("/batch/response", {
        agentId: cfg.agentId,
        paymentPayload: ctx.paymentPayload,
        requirements: ctx.requirements,
        ...(ctx.settleResponse ? { settleResponse: ctx.settleResponse } : {}),
        ...(ctx.paymentRequired ? { paymentRequired: ctx.paymentRequired } : {}),
      });
      if (!r.ok) throw new Error(`signerd refused the seller's answer (${r.status}): ${String(data.detail ?? data.error ?? "")}`);
      // Recovered: the count was corrected, and @x402/fetch retries once with a fresh voucher.
      return data.recovered === true ? { recovered: true as const } : undefined;
    },
  };

  return {
    scheme: BATCH,
    schemeHooks,
    async createPaymentPayload(x402Version: number, requirements: PaymentRequirements): Promise<PaymentPayloadResult> {
      const { r, data } = await post("/batch/payload", { agentId: cfg.agentId, reason: cfg.reason(), resource: cfg.resource?.(), x402Version, requirements });
      if (!r.ok) {
        const denied = new PolicyDenied(String(data.rule ?? data.error ?? "error"), String(data.detail ?? ""), typeof data.id === "string" ? data.id : undefined);
        cfg.onDenied?.(denied);
        throw denied;
      }
      if (typeof data.payload !== "object" || data.payload === null || typeof data.x402Version !== "number")
        throw new Error(`signerd returned a 200 with no payload: ${JSON.stringify(data).slice(0, 200)}`);
      cfg.onSigned?.();
      return data as unknown as PaymentPayloadResult;
    },
  };
}

/**
 * An x402Client policy: `batch-settlement` first when a 402 offers it and this agent may use it —
 * it is what makes a price below Cardano's min-UTxO payable at all — and last otherwise. Ordering
 * rather than filtering: a 402 that offers nothing else still reaches signerd, whose denial says
 * why, where an empty list would only say that nothing was left.
 */
export function preferBatch(allowed: () => boolean) {
  return (_version: number, reqs: PaymentRequirements[]): PaymentRequirements[] => {
    const batch = reqs.filter(r => r.scheme === BATCH);
    const rest = reqs.filter(r => r.scheme !== BATCH);
    return allowed() ? [...batch, ...rest] : [...rest, ...batch];
  };
}
