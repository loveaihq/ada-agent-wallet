# An agent that pays x402 APIs on Cardano with only a stablecoin

*Draft. A walkthrough on Cardano's preprod testnet; nothing here has run on mainnet or been
audited.*

x402 lets an HTTP API charge per request: the server answers `402 Payment Required`, the client
pays and retries. On Cardano, paying used to need ADA twice over: every payment output must hold
about 1 ADA of min-UTxO, and the buyer pays the fee. An agent funded with a stablecoin could not
pay at all until it bought ADA.

This walkthrough puts three published pieces together so that it can:

- **[subbit-x402](https://www.npmjs.com/package/subbit-x402)**: x402's `batch-settlement` scheme on
  Cardano, over [Subbit](https://github.com/kompact-io/subbit-xyz) payment channels. The buyer
  opens a channel once. Each request is then paid with a signed voucher, off chain, in
  milliseconds. The seller redeems many vouchers in one transaction.
- **Seller-sponsored channels** (subbit-x402 0.2, `SPONSORSHIP.md`): the seller's `402` offers one
  of its own ADA-only UTxOs. That offer pays the channel's ADA reserve, every fee, and the refund's
  collateral. The buyer's ADA only passes through.
- **[ada-agent-wallet](https://www.npmjs.com/package/ada-agent-wallet)**: the agent's wallet. A
  separate daemon, `signerd`, holds the key and enforces spending limits. The agent talks to it
  through MCP and never sees the key.

At the end the agent will have made 25 paid requests in tUSDM, Moneta's USDM on preprod.
The seller will have claimed its tUSDM and refunded the channel, and the wallet will hold exactly
the ADA it started with.

## 1. The seller

The quickest seller is the example in the ada-agent-wallet repository. It runs a resource server,
a facilitator and a claim endpoint on your machine:

```bash
git clone https://github.com/loveaihq/ada-agent-wallet && cd ada-agent-wallet && npm install
WALLET_MNEMONIC="<the seller's 24 words>" BATCH_SELLER_SPONSOR_ACCOUNT=9 npm run batchseller
```

- Account 1 of the mnemonic is the channels' provider. It needs an ADA-only UTxO of a few ADA,
  for the fees and collateral of its claims.
- Account 9 (any account but 1) is the sponsor key. The pool offers its ADA-only UTxOs of 3.5 to
  6 ADA; send it a few.
- `GET http://127.0.0.1:7411/token` costs 0.001 tUSDM. Once it is up, the seller prints a JSON
  line with its `payTo`, its provider key and its sponsor's address. The policy below needs the
  first two.
- It reads the chain through Koios, or through Blockfrost if `BLOCKFROST_PROJECT_ID` is set.

In your own server, sponsorship is one option on subbit-x402's scheme:

```ts
import { SUBBIT_HASH } from "subbit-x402/subbit";
import { BatchSettlementCardanoServer, walletProviderSigner } from "subbit-x402/x402/server";
import { SponsorPool } from "subbit-x402/x402/sponsor";

const server = new BatchSettlementCardanoServer({
  payTo, receiverAuthorizer: providerKeyHash, scriptHash: SUBBIT_HASH, storage, chain,
  signAsProvider: walletProviderSigner(providerWallet),
  // A wallet at a key of its own: not the provider's, not payTo's.
  sponsor: { pool: new SponsorPool({ wallet: sponsorWallet }) },
});
```

Its facilitator must merge the seller's witnesses. subbit-x402's `BatchSettlementCardanoFacilitator`
does, and it says so in `/supported` as `acceptsSponsorWitnesses: true`. The server only offers
through a facilitator that says so.

## 2. The wallet

```bash
npm i -g ada-agent-wallet
```

Give it a wallet that holds tUSDM and nothing else: one UTxO of tUSDM and the min-ada it came
with, about 1.18 tADA, and no ADA-only UTxO. Any 24-word preprod mnemonic will do. Keep it in a
file readable only by the user signerd runs as; for anything beyond a faucet wallet, use
`ada-keystore` (see the README, "The key").

The policy allows `batch-settlement` in tUSDM, names the seller's provider key, and caps what one
channel may lock. It has **no lovelace entry at all**: a sponsored channel's reserve is the
seller's, so it locks none of the wallet's ADA.

```json
{
  "network": "cardano:preprod",
  "agents": {
    "default": {
      "perTxMax": { "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d": "10000" },
      "dailyMax": { "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d": "1000000" },
      "allowedPayees": ["<the seller's payTo>"],
      "allowedSchemes": ["exact", "batch-settlement"],
      "allowedProviderKeys": ["<the seller's provider key>"],
      "channelDepositMax": { "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d": "1000000" },
      "channelLockedMax": { "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d": "1000000" }
    }
  }
}
```

Start signerd. Without `BLOCKFROST_PROJECT_ID` it reads the chain through Koios, which needs no
key. `BATCH_DEPOSIT_REQUESTS=10` sizes each deposit for ten requests, so the run below also tops
the channel up twice:

```bash
export SIGNERD_TOKEN=$(openssl rand -hex 16)
WALLET_MNEMONIC_FILE=~/.ada-agent-wallet/mnemonic POLICY_FILE=./policy.json \
  CARDANO_NETWORK=cardano:preprod BATCH_DEPOSIT_REQUESTS=10 ada-signerd
```

signerd stays in the foreground. Run `ada-walletctl` from another shell, with the same
`SIGNERD_TOKEN` exported.

## 3. The agent

Register the MCP server with your agent (Claude Desktop, Claude Code, or any MCP client):

```json
{ "mcpServers": { "ada-wallet": { "command": "npx", "args": ["-y", "ada-agent-wallet"],
  "env": { "SIGNERD_TOKEN": "<the same token>", "AGENT_ID": "default" } } } }
```

Here the agent and `ada-walletctl` share one token, which is enough for a walkthrough. To make
paying and operating separate authorities, give the agent its own token with `AGENT_TOKENS_FILE`
(the README, "Who an agent is").

Then ask it to fetch `http://127.0.0.1:7411/token` 25 times, with a reason each time. The agent
calls `x402_fetch`. What happens underneath:

1. **The first request opens a channel.** The `402` carries the seller's offer. The client reads
   the offered UTxO from the chain itself. It uses the offer only if the UTxO is there as offered,
   ADA-only, and not the wallet's own. It then builds an opening that deposits 0.01 tUSDM. The
   offer pays the channel's ADA reserve (about 2.13 tADA) and the fee, and the rest of it goes to
   the seller. signerd checks the transaction before signing: the wallet's own ADA must come back
   to it in full. It then records the channel's reserve as the seller's. About 30 to 45 seconds,
   one block.
2. **Requests 2 to 10 are vouchers**: signed off chain, each spending 0.001 tUSDM against the
   policy, answered in tens of milliseconds.
3. **Requests 11 and 21 top the channel up**, each on another offer, which is also the top-up's
   only collateral.

Watch it with `ada-walletctl channels`: one open channel, `signed` 25000, and
`reserveFrom: "seller"`.

## 4. Claim and refund

The seller redeems the vouchers in one transaction:

```bash
curl -X POST http://127.0.0.1:7415/claim
```

The refund is the operator's call, not the agent's. The seller co-signs it, its offer is the
collateral, and the channel's ADA goes back to the seller. The channel's id is in
`ada-walletctl channels`:

```bash
ada-walletctl refund <channelId> http://127.0.0.1:7411/token
```

The refunded tUSDM joins the wallet's own UTxO. Over the whole run, the opening, two top-ups, the
claim and the refund, the wallet's ADA does not move: 0.000000 tADA, to the lovelace. Its tUSDM
goes down exactly the 0.025 the vouchers signed. The seller's ADA goes down exactly the five fees,
about 1.24 tADA.

To see all of this without an agent, ada-agent-wallet's `npm run batchsponsored` drives signerd
through the same MCP tool against the seller above, and checks every number against the chain.
Its header lists what it needs: signerd's URL and tokens, the audit file, a Blockfrost key for its
own checks, and the sponsor's address. The README's "Verified" section lists its runs and their
transactions.

## If the wallet loses its records

The channel lives on chain. `ada-walletctl recover default` finds it again, and reads the channel's
opening to see that its reserve was the seller's, so the refund is sponsored as before. This has
been run with signerd reading the chain through Koios.

## Limits

- Preprod only. Subbit's validator is alpha software; neither it nor this code has been audited.
- Leaving a channel without the seller (`close`, then `end` or `elapse`) is a script transaction
  the wallet pays for, so it needs some ADA of its own.
- The seller's exposure per sponsored channel is one reserve: a buyer that leaves alone keeps it.
- For one-off payments rather than channels, the same offer works for x402's `exact` scheme:
  [cardano-x402-sponsor](https://github.com/loveaihq/cardano-x402-sponsor).
