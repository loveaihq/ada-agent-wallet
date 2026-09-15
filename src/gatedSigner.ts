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
}

export class PolicyDenied extends Error {
  constructor(public readonly rule: string, public readonly detail: string, public readonly pendingId?: string) {
    super(`policy ${rule}: ${detail}`);
  }
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
      const data = (await r.json().catch(() => ({}))) as Record<string, string>;
      if (!r.ok) {
        const denied = new PolicyDenied(data.rule ?? data.error ?? "error", data.detail ?? "", data.id);
        cfg.onDenied?.(denied);
        throw denied;
      }
      if (typeof data.transaction !== "string" || typeof data.nonce !== "string")
        throw new Error(`signerd returned a 200 with no transaction: ${JSON.stringify(data).slice(0, 200)}`);
      return { transaction: data.transaction, nonce: data.nonce };
    },
  };
}
