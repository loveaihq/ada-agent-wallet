/**
 * A ClientCardanoSigner that holds NO keys. It forwards every signing request to signerd,
 * which enforces the policy and signs. Drop-in for @x402/cardano's ExactCardanoScheme.
 */
import type { ClientCardanoSignInput, ClientCardanoSignResult, ClientCardanoSigner } from "@x402/cardano";

export interface GatedSignerConfig {
  signerdUrl: string; // http://127.0.0.1:7402
  token: string;
  agentId: string;
  /** Called per payment to supply the reason logged in the audit trail. */
  reason: () => string;
  /** The URL being paid for, for `allowedResources`. The reference client does not pass it on. */
  resource?: () => string | undefined;
  /**
   * The verdict, handed over before it is thrown: `@x402/fetch` rethrows as a plain Error with no
   * `cause`, so catching alone loses the rule, detail and pending id.
   */
  onDenied?: (denied: PolicyDenied) => void;
  /**
   * Called once signerd has signed. By then it has recorded the spend, so this is the moment the
   * budget is gone, whether or not the seller goes on to settle what it was handed.
   */
  onSigned?: () => void;
}

export class PolicyDenied extends Error {
  constructor(
    public readonly rule: string,
    public readonly detail: string,
    public readonly pendingId?: string,
    /** signerd's own word on whether asking again can help: `utxo_busy`, `channel_busy` and `wallet_tidying` say yes, `insufficient_funds` no. */
    public readonly retryable?: boolean,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`policy ${rule}: ${detail}`);
  }
}

/**
 * signerd's refusal as the agent will meet it. `rule` is the policy rule when there is one and
 * otherwise the error code, so a 409 `wallet_tidying` reaches the agent under that name, with the
 * sentence signerd wrote for it and the flag that says it is a wait and not an answer. Both proxies
 * build their denials here, so they cannot disagree about what a code means.
 */
export function denialOf(data: Record<string, unknown>): PolicyDenied {
  const after = data.retryAfterSeconds;
  return new PolicyDenied(
    String(data.rule ?? data.error ?? "error"),
    String(data.detail ?? ""),
    typeof data.id === "string" ? data.id : undefined,
    typeof data.retryable === "boolean" ? data.retryable : undefined,
    typeof after === "number" && Number.isFinite(after) && after > 0 ? after : undefined,
  );
}

/** What a tool tells the agent about a denial. `retryable` and `retryAfterSeconds` are there only when signerd said them. */
export function denialReport(d: PolicyDenied): Record<string, unknown> {
  return {
    denied: true,
    rule: d.rule,
    detail: d.detail,
    pendingId: d.pendingId,
    ...(d.retryable !== undefined ? { retryable: d.retryable } : {}),
    ...(d.retryAfterSeconds !== undefined ? { retryAfterSeconds: d.retryAfterSeconds } : {}),
  };
}

export async function createGatedSigner(cfg: GatedSignerConfig): Promise<ClientCardanoSigner> {
  const headers = { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" };
  const res = await fetch(`${cfg.signerdUrl}/status`, { headers }).catch(e => {
    throw new Error(`signerd is not answering at ${cfg.signerdUrl}: ${e instanceof Error ? e.message : e}`);
  });
  const status = (await res.json().catch(() => ({}))) as { address?: string; error?: string };
  // Without this, a 401 or a 503 left `address` undefined and every payment was built against it.
  if (!res.ok) throw new Error(`signerd refused /status (${res.status}${status.error ? `: ${status.error}` : ""})`);
  if (typeof status.address !== "string" || !status.address)
    throw new Error("signerd /status returned no wallet address");
  const address = status.address;
  return {
    getAddress: () => address,
    async buildAndSignPaymentTransaction(input: ClientCardanoSignInput): Promise<ClientCardanoSignResult> {
      const r = await fetch(`${cfg.signerdUrl}/sign`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: cfg.agentId, reason: cfg.reason(), resource: cfg.resource?.(), input }),
      }).catch(e => {
        // A queued payment holds this request open until a human answers, and Node's fetch stops
        // waiting for headers after 300s. signerd withdraws the request when the connection drops,
        // so nothing was signed — but "fetch failed" would not tell the agent that.
        const code = (e as { cause?: { code?: string } })?.cause?.code;
        if (code === "UND_ERR_HEADERS_TIMEOUT")
          throw new Error("signerd did not answer within the client's 300s wait; a payment queued for approval was withdrawn unsigned, so ask again once it can be approved promptly");
        throw new Error(`signerd is not answering at ${cfg.signerdUrl}: ${e instanceof Error ? e.message : e}`);
      });
      const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) {
        const denied = denialOf(data);
        cfg.onDenied?.(denied);
        throw denied;
      }
      if (typeof data.transaction !== "string" || typeof data.nonce !== "string")
        throw new Error(`signerd returned a 200 with no transaction: ${JSON.stringify(data).slice(0, 200)}`);
      cfg.onSigned?.();
      return { transaction: data.transaction, nonce: data.nonce };
    },
  };
}
