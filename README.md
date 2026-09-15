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
MCP registration (Claude Desktop / Code / Cowork):
```json
{ "mcpServers": { "ada-wallet": { "command": "npx", "args": ["tsx", "/path/ada-agent-wallet/src/mcp.ts"],
  "env": { "SIGNERD_TOKEN": "<same token>", "AGENT_ID": "default" } } } }
```
Human approval: `npm run walletctl -- pending` → `npm run walletctl -- approve <id>`.

## Verified
- policy engine: 13/13 unit tests (`npm test`)
- signerd: status, per-tx deny, unknown-agent deny, unauthorized, approval queue → CLI deny → agent receives the verdict, audit replay
- mcp: tool listing and `wallet_status` through a real MCP client
- allow path reaches `@x402/cardano`'s signer — the sandbox has no chain access, so the first real
  signature must be run on preprod with a faucet-funded address. Do that before mainnet.

## Not yet
- direct `send` (non-x402 transfer) — needs our own submit path; v1 is x402 only
- Masumi escrow flows (`assetTransferMethod: masumi`) pass through untouched; policy still applies to the amount
- policy is per-agent, not per-resource; add `allowedResources` if needed

`vendor/` holds `@x402/cardano` built from the Foundation repo, because it is not on npm yet
(the publish workflow exists but hasn't run). Swap to the npm package when it lands.
