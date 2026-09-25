# Paying x402 `batch-settlement` from ada-agent-wallet

Status: built as below and run end to end on preprod (2026-09-25; README, "Verified"). The binding
is [loveaihq/subbit-x402](https://github.com/loveaihq/subbit-x402), proposed upstream in
x402-foundation/x402#3579 (issue) and #3580 (spec).

## Why

With `exact`, every payment is its own Cardano transaction, and its output to the seller must hold
roughly 0.97 ADA (about $0.23), plus a fee of about 0.17 ADA. In a sample of 3,400 resources from
Coinbase's x402 discovery index (2026-09-24) the median price was $0.01 and 95% were under $0.27,
so `exact` on Cardano cannot price where most of x402 sells. With `batch-settlement` the wallet
locks funds in a channel once and pays each request with a signed cumulative voucher that stays
off chain; subbit-x402 ran requests priced at 0.001 test USDM on preprod.

## The rule that shapes the design

A voucher is money: the seller can redeem up to the highest amount signed for its channel, and
signing one costs nothing and touches no chain. So vouchers are signed where the policy is
enforced, as transactions are: in signerd. With the IOU key in the MCP process, a steered agent
could sign a seller a voucher for everything in the channel, and no cap would see it.

## Architecture

```
agent ── mcp.ts (no keys)
           x402Client: ExactCardanoScheme(gatedSigner)     existing
                       BatchSchemeProxy                    new: forwards to signerd
         signerd (keys, policy, ledger, audit)
           BatchSettlementCardanoClient (subbit-x402), one per agent
             authorize(): policy and transaction checks before anything leaves
```

- **signerd runs subbit-x402's client**, one instance per agent, each with its own records
  directory; they share the wallet and one set of inputs in flight. The client's wallet is the
  same mnemonic and account as the `exact` signer, and signerd checks at start that both give the
  same address.
- **IOU keys never exist outside signerd's memory.** They derive from the wallet's signature of a
  fixed message (subbit-x402's default). Channel records keep no key: signerd derives it again for
  each voucher, so the records on disk cannot sign anything.
- **One hook, `authorize`,** which the client calls with what it is about to hand out — a voucher,
  and for a deposit its signed transaction — before it records anything. signerd runs the policy
  and the transaction checks there; if either refuses, nothing leaves and nothing is recorded.
- **mcp.ts gets `BatchSchemeProxy`**, a scheme with no keys and no state. Its
  `createPaymentPayload` posts the requirements, the reason and the resource to
  `POST /batch/payload` and returns what signerd made; its `onPaymentResponse` hook posts the
  seller's answer to `POST /batch/response`, where the client applies a receipt or a corrective
  402. The MCP prefers `batch-settlement` when a 402 offers it and signerd says this agent may use
  it.
- **signerd talks to no seller.** A refund is a message to the seller too: signerd builds it,
  walletctl sends it and brings the answer back.
- **Exits without the seller** (close, end, elapse) and `recover` are operator endpoints, used
  through walletctl. An agent token cannot call them, as it cannot call `/approve` today.

## Spend accounting

- signerd records, per channel, the highest amount it has signed. **A voucher spends its increment
  over that record:** the increment goes through `decide()` like an `exact` payment (payee,
  resource, asset, `perTxMax`, rolling `dailyMax`, `approvalAbove`) and into the ledger and the
  audit log.
- **A voucher at or below the record spends nothing:** the retry after a lost response, the
  re-sign after a corrective 402.
- **The record is signerd's own.** Receipts and corrective 402s pass through the agent's process
  and move the client's count, which sets the next voucher's amount, but never the record, so every
  amount the seller can redeem has been counted, whatever they say.
- **A deposit is locked, not spent:** what the vouchers do not give the seller comes back through a
  refund or the exit. Deposits have their own limits instead of `dailyMax`, which counts the
  vouchers, so no money is counted twice.
- Fees are not counted, as for `exact` today.

## The payee is a key

The 402 names a `payTo` and a `receiverAuthorizer`. The channel binds only the second: the
validator lets that key redeem and does not restrict where a redemption pays. An allowlist of
addresses binds nothing here, since a seller can name an allowed address beside a key of its own.
A `batch-settlement` payment needs its `payTo` in `allowedPayees` and its `receiverAuthorizer` in
`allowedProviderKeys`.

## Policy

New per-agent fields, all optional; `batch-settlement` is off until listed:

| Field | Meaning | Default |
|---|---|---|
| `allowedSchemes` | `["exact"]` or `["exact", "batch-settlement"]` | `["exact"]` |
| `allowedProviderKeys` | key hashes a channel may name as provider, or `["*"]` | none |
| `channelDepositMax` | per asset: the most one opening or top-up may lock | none, so denied |
| `channelLockedMax` | per asset: the most this agent's open channels may hold together | none, so denied |
| `maxWithdrawDelay` | seconds: the longest close period a seller may set, which is how long a unilateral exit keeps the money | 86,400 |
| `maxVouchersPerHour` | vouchers in any rolling hour; `maxPerHour` keeps counting transactions | 600 |

- The seller sets the close period, anywhere from 900 s to 30 days under the binding.
- A token channel's ADA reserve counts as locked ADA.
- `MAX_HOT_BALANCE_LOVELACE` counts what the channels hold too: a stolen key gets that back as
  well, only later.

## What signerd checks in every channel transaction

As `verifyTx.ts` does for `exact`, and for the same reason — a builder that is wrong must not get
its transaction out:

- **Opening:** exactly one output at the Subbit validator, with the datum this request authorised
  (`consumer` this wallet, `provider` the allowed key, `iouKey` signerd's key for the channel's
  tag, the asset, the close period, `Opened(0)`) and exactly the authorised deposit; every other
  output to this wallet.
- **Top-up:** the channel's current output spent and put back at the validator with the same datum
  and exactly the authorised amount more; every other output to this wallet.
- **Refund:** the seller's `payTo` paid at most the highest amount signed less what the channel has
  redeemed; everything else to this wallet.
- **Close:** the channel put back unchanged but for its stage. **End, elapse:** the channel's funds
  to this wallet.
- In all of them, a fee of at most 2 ADA and collateral of at most 5 ADA.

## One wallet, two builders

The `exact` signer spends the wallet's first UTxO as its nonce and lets the SDK add any others; the
channel client leaves out the inputs it holds as in flight. signerd keeps one set of every input it
has handed out, `exact` or channel, until the chain shows it spent or a hold expires. The channel
client leaves those out, and an `exact` transaction that spends one is refused as `utxo_busy`, the
same answer a reused nonce gets today.

## Changes to subbit-x402

- The `authorize` hook.
- Derived IOU keys kept out of the records, derived again when needed.
- The refund split in two, building it and applying the answer, so the wallet can carry the
  messages.
- `capacity` and `maxDeposit` given per 402, and a deposit cut to fit `maxDeposit` rather than
  refused: signerd sizes deposits at `BATCH_DEPOSIT_REQUESTS` (default 100) times the price, within
  `channelDepositMax`.
- Installable: a build to `dist/` (TypeScript rewrites the `.ts` imports), type declarations, an
  `exports` map and a `prepare` script. The wallet pins a commit on GitHub; subbit-x402 goes to npm
  before the wallet's next npm release, since a published package should not pull from git.

## Scope

- **Preprod only.** The channel client's only chain reader is Blockfrost's, written for preprod,
  and Subbit's validator is alpha. signerd refuses `batch-settlement` on any other network and
  without `BLOCKFROST_PROJECT_ID`; `exact` keeps Koios as its default.
- **`x402_fetch` first.** @x402/mcp runs the same hooks, but `batch-settlement` over paid MCP tools
  has not been tried.
- **What the agent sees:** `x402_fetch` pays either way, and `wallet_status` lists each channel with
  what it locks and what has been signed.

## Tests

- Chain-free: the increment accounting (first voucher, retry, corrective re-sign, a jump past the
  cap), each new policy field, the provider-key check, and the transaction checks, each with a
  transaction that must be refused; the shared in-flight set, both ways.
- Preprod, `dev/batch.ts`: signerd (abandon mnemonic, account 0) paying a subbit-x402 resource
  server (account 1) through the proxy: an opening, a run of vouchers, one refused by `dailyMax`,
  a retry that spends nothing, a top-up, a refund through walletctl; the ledger, the audit log and
  the chain reconciled to the lovelace.
- Preprod, `dev/batchexit.ts`: the way out without the seller — `walletctl close`, signerd losing
  its channel records, `walletctl recover` finding the channel again, `walletctl elapse` once the
  close period has run — reconciled on chain.
