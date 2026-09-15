# ada-agent-wallet

Policy-gated Cardano wallet for AI agents. The agent gets an MCP tool that can pay x402 endpoints
on Cardano; the key sits in a separate daemon that enforces spend policy and writes an audit log.
Plugs into the official `@x402/cardano` client (merged into the x402 Foundation repo 2026-09-09)
via its `ClientCardanoSigner` interface — nothing forked.

```
agent (Claude / any MCP client)
   └── mcp.ts        wallet_status, x402_fetch(url, reason)      ← no keys here
         └── gatedSigner.ts  implements ClientCardanoSigner, forwards to ↓
signerd.ts   127.0.0.1 only, bearer token, holds the mnemonic
   ├── policy.ts    per-tx max · rolling-24h max · payee allowlist · asset allowlist · per-hour rate · approval threshold
   ├── audit.jsonl  every decision: signed / denied / pending / approved (+ agent's stated reason)
   └── @x402/cardano toClientCardanoSigner (Koios by default, Blockfrost optional)
walletctl.ts  status | pending | approve <id> | deny <id> | audit
```

What `@x402/core` already has: a per-payment USD cap and an asset allowlist, inside the agent process.
What this adds: key isolation, rolling daily/hourly limits, payee allowlist, human approval, audit trail —
enforced in the process that holds the key, so an agent cannot loosen its own limits.
Masumi's Payment Service (the other Cardano agent-payment stack) has none of these on the buying side.

## Run (preprod)
```
npm install
cp policy.example.json policy.json            # edit limits; amounts are lovelace / USDM 6-dec units
export SIGNERD_TOKEN=$(openssl rand -hex 16)
export WALLET_MNEMONIC_FILE=~/.ada-agent-wallet/mnemonic   # 24 words, chmod 600
export CARDANO_NETWORK=cardano:preprod                     # Koios, no API key needed
npm run signerd                                            # prints the address → fund it from the preprod faucet
```
`@x402/fetch` rethrows a signer error as a plain `Error` with no `cause`, so `gatedSigner` hands the
verdict to `mcp.ts` through an `onDenied` callback; catching alone would lose the rule and pending id.

**Where the policy and audit files live is part of the security model.** The daily cap is enforced
from a ledger rebuilt by replaying `audit.jsonl`, and the limits themselves are re-read from
`policy.json` on every decision. An agent that can write either file raises its own budget without
going near the key: deleting the audit file alone resets the day's spend to zero. Put both where
the agent's user cannot write, and run signerd as a different user. signerd prints both absolute
paths at startup so this is checkable rather than assumed.

Two defaults in `policy.example.json` are deliberately conservative and worth a look before you
widen them: `allowedPayees: ["*"]` accepts any payee, which is only reasonable while the agent is
talking to endpoints you chose; and `allowedAssetTransferMethods: ["default"]` refuses masumi
escrow, whose cost is not only `amount` — it also locks buyer collateral that no field in the
policy can see, up to the SDK's 15 ADA ceiling, and not released until the contract's
`submit_result_time`. Enabling masumi means accepting that charge; bound it with
`MASUMI_MAX_COLLATERAL_LOVELACE`.
MCP registration (Claude Desktop / Code / Cowork):
```json
{ "mcpServers": { "ada-wallet": { "command": "npx", "args": ["tsx", "/path/ada-agent-wallet/src/mcp.ts"],
  "env": { "SIGNERD_TOKEN": "<same token>", "AGENT_ID": "default" } } } }
```
Human approval: `npm run walletctl -- pending` → `npm run walletctl -- approve <id>`.

## Dev stack (a whole 402 round-trip, locally)
`dev/` runs the seller side so the loop can be closed without an external endpoint. Three shells:

```
npm run dev:facilitator   # 127.0.0.1:7403  verifies + broadcasts. No key, no funds: the buyer's
                          #                 transaction is already signed and pays its own fee.
npm run dev:resource      # 127.0.0.1:7401  the paid endpoint, settles via the facilitator
npm run signerd           # 127.0.0.1:7402  the key + policy
```
Then drive it with a real MCP client — `dev/roundtrip.ts` spawns `src/mcp.ts` over stdio and calls
`x402_fetch`, so the path is exactly the agent's:

```
npm run roundtrip           # GET /quote    1.5 tADA, under approvalAbove -> signs unattended
npm run roundtrip approve   # GET /report   4 tADA, queues -> npm run walletctl -- approve <id>
npm run roundtrip deny      # GET /premium  6 tADA, over perTxMax -> denied, nothing signed
npm run balance             # BUYER_ADDRESS / SELLER_ADDRESS balances, to see the faucet land
npm run concurrency         # regression check for the spend-cap race (spends nothing)
```

`npm run concurrency` starts a throwaway signerd with a cap that fits one payment, fires several
requests at once, and fails unless exactly one is signed. It needs a funded wallet because signing
reads its UTXOs, but nothing it signs is ever handed to a facilitator, so no funds move.

Routes pin `confirmationPolicy: { l1Confirmations: 0 }`. Depth above canonical inclusion needs an
evidence hook that only the Blockfrost provider supplies, so a Koios facilitator advertises
`l1Confirmations 0..0` and the default of 1 would make the 402 unserviceable. Zero still means the
transaction is on chain — `submitTransaction` awaits confirmation — just without extra depth. Set
`BLOCKFROST_PROJECT_ID` (or `L1_CONFIRMATIONS`) to ask for more.

The trap that goes with it: without an evidence hook the settle verdict *is* whether
`submitTransaction`'s `awaitTx` returned in time, and the SDK's provider timeout defaults to 10s —
under preprod's ~20s block. A default-configured Koios facilitator therefore reports `mempool` on
payments that confirm seconds later, and the buyer gets a 402 for a transaction that settled: funds
gone, no goods. `dev/facilitator.ts` gives `awaitTx` 100s and `dev/resource.ts` gives the
facilitator client 115s so the wait is not cut off one level up. Anything talking to mainnet needs
the same budget chain, or Blockfrost.

## Verified
- policy engine: 13/13 unit tests (`npm test`)
- signerd: status, per-tx deny, unknown-agent deny, unauthorized, approval queue → CLI deny → agent receives the verdict, audit replay
- mcp: tool listing and `wallet_status` through a real MCP client
- deny path, end to end: MCP `x402_fetch` → 402 → gated signer → signerd → `per_tx_max` →
  structured verdict back at the tool, `denied` in `audit.jsonl`
- **a whole 402 round-trip on preprod, 2026-09-15** — `x402_fetch GET /quote` returned
  `status 200, paid true` with the real body in 72s. Facilitator `verify isValid:true`, then
  `settle success:true status:"confirmed"`, transaction
  `6d94fdc0617a8e58ca23402826f36767bab9a00a77dfe02de851d5828428e7e0` on preprod; `signed` in
  `audit.jsonl` with the agent's stated reason and the UTXO it spent as nonce; 1.5 tADA landed at
  the seller address. The first real signature and the facilitator settlement are no longer unrun.
- **approve → sign, on chain** — a 4 tADA route parked in the queue as `pending` with the agent's
  reason and the threshold that caught it, `walletctl approve` released it, and the same call
  returned `200 paid true` in 48.7s. Transaction
  `020af86ddcd581e3379305d832b5da957b877fb0edca97dab1ab3457ce93a72b`; `pending` → `signed` →
  `approved` all in `audit.jsonl`.
- ledger accounting against the real chain: three payments (1.5 + 1.5 + 4 tADA) left
  `dailyRemaining 13000000` of a 20 tADA cap and `paymentsLastHour 3`, and 7 tADA arrived at the
  seller address in three UTXOs.
- the spend cap holds under concurrency (`npm run concurrency`): four simultaneous requests against
  a cap that fits one produce one `signed` and three `daily_max` denials. Before the agent lock the
  same probe signed every one of them, on one shared nonce.

## Known behaviour worth expecting
- **A signed payment counts against the budget even if settlement then fails.** signerd records the
  spend when it signs, and never hears whether the facilitator got the transaction on chain, so a
  transient submit failure costs budget without moving funds. This is the conservative direction and
  deliberately so — refunding it would mean deciding "this will never land", which is exactly the
  question the facilitator cannot answer either. Observed once here: `dailySpent` of 16.5 tADA
  against 12.5 tADA actually delivered.
- **Koios can refuse a submit moments after confirming the transaction it chains from.** A payment
  spending the change of a just-confirmed transaction was rejected with `Koios submitTx failed`,
  and the identical payment succeeded on retry: its query view had the new UTXO before its submit
  node had the block. Retry rather than treat it as fatal — and note this is why the in-flight UTXO
  hold is short, since an over-long one makes that retry impossible.
- The in-flight hold is not what keeps an agent inside its cap; the ledger is. `NONCE_HOLD_SECONDS`
  (120s) only avoids handing back a transaction some other unsettled one has already doomed.

## Not yet
- direct `send` (non-x402 transfer) — needs our own submit path; v1 is x402 only
- Masumi escrow flows (`assetTransferMethod: masumi`) pass through untouched; policy still applies to the amount
- policy is per-agent, not per-resource; add `allowedResources` if needed

`vendor/` holds `@x402/cardano` built from the Foundation repo, because it is not on npm yet
(the publish workflow exists but hasn't run). Swap to the npm package when it lands.
