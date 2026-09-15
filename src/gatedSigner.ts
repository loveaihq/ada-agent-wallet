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
  /**
   * Called per payment for the URL being paid for, which signerd checks against
   * `allowedResources`. The reference `@x402/cardano` client does not pass the resource through to
   * the signer, so it has to come from the caller that knows it.
   */
  resource?: () => string | undefined;
  /**
   * Called with the verdict before it is thrown. `@x402/fetch` rethrows whatever the signer
   * throws as a plain `new Error(message)` with no `cause`, so a caller that only catches
   * cannot recover the rule, detail or pending id — it has to be handed them here.
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
  const status = await fetch(`${cfg.signerdUrl}/status`, { headers }).then(r => r.json() as Promise<{ address: string }>);
  const address = status.address;
  return {
    getAddress: () => address,
    async buildAndSignPaymentTransaction(input: ClientCardanoSignInput): Promise<ClientCardanoSignResult> {
      const r = await fetch(`${cfg.signerdUrl}/sign`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: cfg.agentId, reason: cfg.reason(), resource: cfg.resource?.(), input }),
      });
      const data = (await r.json()) as Record<string, string>;
      if (!r.ok) {
        const denied = new PolicyDenied(data.rule ?? data.error ?? "error", data.detail ?? "", data.id);
        cfg.onDenied?.(denied);
        throw denied;
      }
      return { transaction: data.transaction, nonce: data.nonce };
    },
  };
}
