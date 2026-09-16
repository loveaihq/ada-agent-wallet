# ada-agent-wallet

Out-of-process spend control for AI agents that pay with x402. The agent gets MCP tools that can
pay — for an HTTP endpoint, or for a paid tool on another MCP server — and never holds the key.
That sits in a separate daemon, which enforces the spend policy, queues what needs a human, and
writes a hash-chained audit log the agent cannot rewrite to hand itself more budget.

Why a separate process: `@x402/core`'s spend controls and `@x402/mcp`'s `onPaymentRequested` hook —
the two places the official stack puts a limit — both run *inside* the agent. An agent that has
been steered can be steered through them. These limits live where the key lives.

Settles on Cardano, through the official `@x402/cardano` and `@x402/mcp` clients — nothing forked.

```
agent (Claude / any MCP client)
   └── mcp.ts        wallet_status · x402_fetch(url) · x402_mcp_tools/call(server, tool)  ← no keys
         └── gatedSigner.ts  implements ClientCardanoSigner, forwards to ↓
signerd.ts   127.0.0.1 only, bearer token, holds the mnemonic
   ├── policy.ts    per-tx max · rolling-24h max · payee, resource, asset and transfer-method
   │                allowlists · per-hour rate · approval threshold
   ├── replay.ts    rebuilds the 24h spend window at startup, and checks what it rebuilds from
   ├── serialize.ts one lock per agent for the cap, one per wallet for signing
   ├── keystore.ts  scrypt + AES-256-GCM, so the mnemonic is not plaintext at rest
   ├── verifyTx.ts  reads back the signed transaction: does it pay who was authorised, only them
   ├── ledger.json  the spend state the cap is computed from, rewritten after every signature
   ├── audit.jsonl  every decision, hash-chained, the checkpoint pointing into it
   ├── tokens.json  optional: a token per agent, so `agentId` is not self-reported
   └── @x402/cardano toClientCardanoSigner (Koios by default, Blockfrost optional)
walletctl.ts  status | preflight | pending | approve <id> | deny <id> | audit
```

`ledger.json` and `audit.jsonl` are deliberately two files: the cap is state, the log is a log, and
conflating them meant `rm audit.jsonl` handed a spent agent its budget back.

What `@x402/core` already has: a per-payment USD cap and an asset allowlist, inside the agent
process — and `@x402/mcp` puts its `onPaymentRequested` approval hook in the same place.
What this adds: key isolation, rolling daily/hourly limits, payee allowlist, human approval, audit trail —
enforced in the process that holds the key, so an agent cannot loosen its own limits.
Masumi's Payment Service (the other Cardano agent-payment stack) has none of these on the buying side.

## Run (preprod)
```
npm install
cp policy.example.json policy.json            # edit the limits; amounts are in the asset's smallest unit
export SIGNERD_TOKEN=$(openssl rand -hex 16)
export WALLET_MNEMONIC_FILE=~/.ada-agent-wallet/mnemonic   # 24 words, chmod 600
export CARDANO_NETWORK=cardano:preprod                     # or cardano:preview; Koios, no API key needed
npm run signerd                                            # prints the address → fund it from the preprod faucet
```
The policy file declares the network it was written for, and signerd refuses to start on a mismatch.
A plaintext mnemonic is fine for a faucet wallet; for anything else see "The key" below.

Koios is enough to run signerd and every check in `dev/` except one. It is **not** enough to close a
402 round-trip: the facilitator's verify step cannot read most UTXOs through it, for reasons that
are not yours to fix and that the error does not explain. Set `BLOCKFROST_PROJECT_ID` before
`npm run roundtrip` — see "Known behaviour worth expecting".

**Where the policy, audit and ledger files live is part of the security model.** The daily cap is
computed from `ledger.json`, rebuilt where needed by replaying `audit.jsonl`, and the limits
themselves are re-read from `policy.json` on every decision. An agent that can write any of the
three raises its own budget without going near the key. Put all of them where the agent's user
cannot write, and run signerd as a different user. signerd prints the absolute paths at startup so
this is checkable rather than assumed.

The example policy's `allowedResources` names the two local dev sellers — `http://127.0.0.1:7401/*` for
HTTP, `http://127.0.0.1:7404/*` for MCP — alongside a placeholder, so the round-trips below work from
a fresh copy; drop both dev entries before the file governs anything real. The list applies to MCP
tool calls too: the resource checked is the MCP server's URL.

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

A queued payment holds the agent's `/sign` request open while the human decides, and that request
is the only place the signed transaction can go. Node's `fetch` stops waiting for a response after
five minutes; when the caller's connection drops, signerd withdraws the request from the queue,
gives the budget back and logs `pending_abandoned`, so an approval that comes after that signs
nothing rather than recording a spend for a transaction nobody will broadcast. Approve within five
minutes, or expect the agent to have to ask again.

## Dev stack (a whole 402 round-trip, locally)
`dev/` runs the seller side so the loop can be closed without an external endpoint. Three shells:

```
npm run dev:facilitator   # 127.0.0.1:7403  verifies + broadcasts. No key, no funds: the buyer's
                          #                 transaction is already signed and pays its own fee.
npm run dev:resource      # 127.0.0.1:7401  the paid endpoint, settles via the facilitator
npm run dev:mcpresource   # 127.0.0.1:7404  the same three prices as paid MCP tools, through
                          #                 @x402/mcp's own createPaymentWrapper
npm run signerd           # 127.0.0.1:7402  the key + policy
```
Then drive it with a real MCP client — `dev/roundtrip.ts` spawns `src/mcp.ts` over stdio and calls
`x402_fetch`, so the path is exactly the agent's:

```
npm run roundtrip           # GET /quote    1.5 tADA, under approvalAbove -> signs unattended
npm run roundtrip approve   # GET /report   4 tADA, queues -> npm run walletctl -- approve <id>
npm run roundtrip deny      # GET /premium  6 tADA, over perTxMax -> denied, nothing signed
npm run roundtrip auto mcp  # the same three modes, bought as MCP tools through x402_mcp_call
npm run balance             # BUYER_ADDRESS / SELLER_ADDRESS balances, to see the faucet land
npm run concurrency         # regression check for the spend-cap race (spends nothing)
npm run walletctl -- preflight   # deployment checks; see "Before mainnet"
npm run verify:vendor            # sha256 of vendor/; runs automatically before npm test
npm run integrity                # proves no single deletion resets the spend cap
npm run approvals                # every way out of the approval queue gives the budget back
npm run assets                   # per-asset caps and windows, and the rate they share
npm run identity                 # whether an agent can spend a budget that is not its own
npm run queue                    # every exit from the approval queue that does not sign — no chain,
                                 # no wallet, so this one runs wherever the unit tests do
npm run posix                    # mode bits and signals; Linux only, since Windows can check neither
npm run delivery                 # a caller that leaves while a signature is in flight
npm run context                  # two tool calls at once keep their own reasons in the audit
npm run keystore -- create ...   # encrypt the mnemonic at rest
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
- `npm test`: 66 unit tests over the policy engine, the startup replay, the locks, the keystore, the
  network table and the signed-transaction check, plus the vendor checksums, which gate the rest.
  None needs a chain. `npm run typecheck` covers `dev/`, `test/` and `scripts/` too, which `tsx`
  runs without checking.
- the modules that say "no chain, no keys, no I/O" are checked to import nothing that would make
  that false, and to still say it — the first run of that check found one that had stopped
- signerd asks the socket what address it bound and refuses anything but the loopback, so the one
  line that decides whether the wallet is on the network is not taken on trust
- every signature is read back before it is handed over: an output pays the authorised payee at
  least the authorised amount, the nonce is spent, and nothing else is paid at all
- `npm run integrity`: no single deletion resets the spend cap, and restarting does not re-count
  what the checkpoint already holds
- `npm run concurrency`: the cap holds under simultaneous requests, and two agents sharing one
  wallet contend for its UTXO without either being handed a transaction that cannot settle
- `npm run approvals`: approved, denied and timed out all give the held budget back, two queued
  payments cannot promise the same budget twice, and a limit tightened while one waits is applied
  to it rather than bypassed by the approval
- `npm run assets`: caps and 24h windows are per asset, the hourly rate is shared across them, and
  an asset the wallet does not hold is refused as `insufficient_funds` rather than as a fault.
  Not covered: an actual native-asset settlement, which needs a wallet holding one.
- `npm run identity`: with `AGENT_TOKENS_FILE`, an agent cannot sign as another or read another's
  budget, and the operator token cannot sign at all. Without it, the same check demonstrates that
  it can.
- `npm run queue`: every exit from the approval queue that does not sign — denied, timed out, the
  caller leaving, the policy tightening underneath it, and a SIGKILL'd run's orphan closed at the
  next start — each giving the held budget back. No chain and no wallet, so it runs in CI
- `npm run posix`: on Linux, where the mode-bit checks and the shutdown signal can actually run.
  SIGTERM drains the queue and answers whoever was waiting; a group-writable policy warns on
  preprod and refuses to start on mainnet; malformed, oversize and wrong-chain requests are 4xx
  without writing to the log; a torn append is repaired and an edited record refuses to start
- `npm run delivery`: a caller that leaves while a payment ahead of it is signing takes its request
  with it, and a signature that lands after its one recipient has gone is recorded as
  `signed_undelivered` rather than counted silently
- `npm run context`: two `x402_fetch` calls in flight at once each keep their own reason all the
  way into the audit, which is what the `AsyncLocalStorage` in mcp.ts exists for
- mcp: tool listing and `wallet_status` through a real MCP client
- `npm run mcptools`: the MCP-side tools register, and the payment client really survives being
  handed from the vendored `@x402/core` to `@x402/mcp`, which is built against a different copy of
  it. TypeScript is made to accept that with a cast, so running it is the only thing that shows it.
- `npm run roundtrip deny mcp`: a paid MCP tool over perTxMax, bought through `x402_mcp_call` from a
  seller built on `@x402/mcp`'s own `createPaymentWrapper`, comes back `per_tx_max` in 0.1s with
  nothing signed. The seller's resource server is the vendored core crossing into `@x402/mcp`, so
  this is also that hand-off, the other way round, run.
- **both tools used to report a payment that did not settle as paid.** `x402_fetch` read "paid" off
  whether a `PAYMENT-RESPONSE` header existed, and core sends one with `success: false` on every
  settle failure; `x402_mcp_call` read it off `paymentMade`, which means sent. Both now read the
  settlement itself (`src/receipt.ts`, tested against core's real header encoding), carry the
  transaction as a receipt, and say `unsettled` when signerd signed something that did not settle —
  checked on preprod against a real facilitator rejection on both transports.
- **a paid MCP tool call, settled on preprod, 2026-09-16** — `x402_mcp_call` bought `quote` from
  `dev/mcpresource.ts` and came back `paid: true` with its transaction in 33s. Facilitator
  `verify isValid:true`, then `settle success:true status:"confirmed" confirmations:1`, transaction
  `15f100abe211a43f711371c4854cc43aed18978d0ffed8630c6c17daeae9642b` in block 5183279. Not taken on
  the facilitator's word: read back from Blockfrost, it pays the seller exactly 1.5 tADA, returns
  the change to the buyer, pays nobody else, and spends only the buyer's inputs. `signed` in
  `audit.jsonl` with the reason tagged `[mcp tool quote]`, and the chain replays clean through
  `replayAudit`. The seller is `@x402/mcp`'s own `createPaymentWrapper`, so this is the wallet
  against the official stack on both sides of the call.
- the same run bought `/quote` over HTTP after the receipt change: `status 200, paid: true`,
  transaction `ba269ae6f25b2ba505d3da251bbed9904f10466db05ed87c163edec66145eb3e` in block 5183281,
  checked the same way. The fix that stopped failures reading as paid did not stop successes.
- one MCP payment before that settled on Koios at `confirmations:0` (`37120eda…`, block 5183270),
  between runs where Koios verify failed on the same wallet. Koios is intermittent for this, not
  unusable; Blockfrost is what gets past it every time, and the only way to ask for depth.
- deny path, end to end: MCP `x402_fetch` → 402 → gated signer → signerd → `per_tx_max` →
  structured verdict back at the tool, `denied` in `audit.jsonl`
- **a whole 402 round-trip on preprod, 2026-09-15** — `x402_fetch GET /quote` returned
  `status 200, paid true` with the real body in 72s. Facilitator `verify isValid:true`, then
  `settle success:true status:"confirmed"`, transaction
  `6d94fdc0617a8e58ca23402826f36767bab9a00a77dfe02de851d5828428e7e0` on preprod; `signed` in
  `audit.jsonl` with the agent's stated reason and the UTXO it spent as nonce; 1.5 tADA landed at
  the seller address. The first real signature and the facilitator settlement are no longer unrun.
- **the same round-trip with a human in it, 2026-09-16** — `x402_fetch GET /report` at 4 tADA is
  over `approvalAbove`, so it parked in the queue and held the agent's request open while
  `walletctl approve 4df1a492` was run from another shell; `status 200, paid true` came back 179s
  later, the audit reading `pending` → `signed` → `approved`. Over the same session the buyer went
  from 169.638625 to 163.780519 tADA and the seller from nothing to 5.5 in two UTXOs, which is the
  1.5 and the 4 arriving. On Blockfrost: this cannot be done on Koios, see below.
- **approve → sign, on chain** — a 4 tADA route parked in the queue as `pending` with the agent's
  reason and the threshold that caught it, `walletctl approve` released it, and the same call
  returned `200 paid true` in 48.7s. Transaction
  `020af86ddcd581e3379305d832b5da957b877fb0edca97dab1ab3457ce93a72b`; `pending` → `signed` →
  `approved` all in `audit.jsonl`.
- ledger accounting against the real chain: three payments (1.5 + 1.5 + 4 tADA) left
  `dailyRemaining 13000000` of a 20 tADA cap and `paymentsLastHour 3`, and 7 tADA arrived at the
  seller address in three UTXOs.
- the spend cap holds under concurrency: four simultaneous requests against a cap that fits one
  produce one `signed` and three `daily_max` denials. Before the agent lock the same probe signed
  every one of them, on one shared nonce.

## Before mainnet
```
npm run walletctl -- preflight     # fails on anything that must be fixed, warns on every decision
```
`ALLOW_UNVERIFIED_AUDIT=1` is the way past a refused startup when the audit log was rotated on
purpose; it waives the check, not the ledger. `LEDGER_FILE` and `AUDIT_FILE` say where both live.

`preflight` refuses to pass until the policy declares `"network": "cardano:mainnet"`, and signerd
refuses to start on mainnet without it: caps here are bare integers with no unit, so a file tuned
against 10,000 faucet tADA says exactly the same thing to a wallet holding real ADA. It also warns
on each choice that is yours rather than a bug — a payee allowlist of `["*"]`, a missing resource
allowlist, no approval threshold, masumi enabled, Koios as the provider.

On mainnet signerd additionally refuses to start when the policy, audit or ledger file is group- or
world-writable, because "the agent cannot raise its own limits" stops being true the moment the
agent's user can write any of them. On Windows the mode bits do not carry that meaning, so the
check reports that it could not run rather than passing: verify the ACL yourself.

`allowedResources` bounds which URLs an agent may buy from. It is checked against a URL the agent
process reports, because the reference `@x402/cardano` client does not pass the resource through to
the signer — so it constrains an agent that is running this code and being steered, which is the
prompt-injection case, and not one whose process has been replaced. `allowedPayees` is the control
that binds the transaction itself; treat the resource list as the layer above it.

### The key
```
npm run keystore -- create --mnemonic-file ~/.ada-agent-wallet/mnemonic --out ~/.ada-agent-wallet/keystore.json
```
scrypt and AES-256-GCM, asked for the passphrase twice, proved to round-trip before anything is
written. Point signerd at it with `WALLET_KEYSTORE_FILE`, then delete the plaintext mnemonic — once
you are certain the passphrase is recoverable, because at that point the keystore is the wallet.

The passphrase comes from `WALLET_PASSPHRASE_FILE`, or a terminal prompt when there is one.
Deliberately not an environment variable: the point of a keystore is that reading one thing is not
enough, and an env var is readable by anything that can read the process. And if the passphrase
file lives next to the keystore, preflight says so — encryption with the key taped to the box is
worth about what it sounds like.

What this buys: reading a file is no longer enough. A stolen backup, a disk image, a stray copy in
a repository, a directory whose permissions were wrong for a week — all of those now yield
ciphertext. What it does not buy: anything at all against a compromised signerd, which holds the
decrypted mnemonic in memory for as long as it runs. That is what a hot wallet is.

Which is why `MAX_HOT_BALANCE_LOVELACE` exists and why preflight fails on mainnet without it. The
daily cap bounds an agent. Nothing bounds someone who has the key, except how much is in the
wallet, so decide that number deliberately and alert on `ada_wallet_balance_over_ceiling`.

### Who an agent is
By default there is one token, and `agentId` arrives in the request body. With a single agent that
is fine. With several it means the split between them is a convention: any process holding that
token can spend any agent's budget by naming it, which is the opposite of what a per-agent policy
is for. Preflight says so when the policy has more than one agent.

`AGENT_TOKENS_FILE` is a JSON map of `{"<token>": "<agentId>"}`. With it, a token *is* an identity:
`/sign` takes the agent from the token and refuses a body that names another, `/status` returns only
that agent's budget, the approval queue and everything else is the operator's alone, and the
operator token stops signing at all. Operating and paying become different authorities, which they
were not.

### Monitoring
`GET /metrics` is Prometheus exposition behind the same bearer token — it reports what this wallet
has spent, which is not public. Counters restart with the process, as is conventional; the gauges
carry the live state counters cannot.

Alert on: any increase in `ada_wallet_audit_events_total{event="denied"}`, `{event="policy_error"}`
or `{event="nonce_collision"}`; `ada_wallet_over_budget` reaching 1; `ada_wallet_pending_approvals`
staying above zero longer than a human should take; `ada_wallet_policy_readable` reaching 0. A
denial is not by itself an incident — an agent hitting its cap is the system working — but a change
in the rate of them is the first sign that something upstream is steering it somewhere new.

`{event="signed_undelivered"}` is the one that means the ledger and the world have come apart: a
transaction was signed and its spend recorded, and the single request it could have been handed to
had closed. Nothing will broadcast it, and the budget stays spent — a transaction is not unsigned
by nobody having read it. It takes a caller leaving during the seconds a signature is in flight, so
it should be rare; each one is a payment the agent will have to ask for again.

### What this still does not do
Naming these is the point; none is fixed by more policy code.
- **There is no hardware-wallet or KMS path.** The keystore means a file read is no longer enough,
  but signerd still decrypts the mnemonic into its own memory and keeps it there. A key that never
  leaves a device is a different architecture, not a setting — and the honest mitigation for this
  one is the balance ceiling: keep in the wallet only what you would accept losing outright.
- **`vendor/` is unreviewed code, now at least a known quantity.** Both tarballs are pinned by
  sha256 (`npm test` checks them) and traced to upstream `fdeda56`, verified by recovering their
  TypeScript from the shipped source maps and diffing it against that commit — see
  [vendor/PROVENANCE.md](vendor/PROVENANCE.md). Note what the version number is not: upstream's
  released `2.25.0` contains no Cardano package at all, and the vendored `@x402/core` differs from
  the published `@x402/core@2.25.0` in 25 files. Pinning is not review; this is unpublished code
  signing real transactions, so someone should still read it or wait for a real release.
- **Nothing scrapes `/metrics` for you.** The signals are exposed and the alerts worth writing are
  listed above, but wiring them to something that pages a human is deployment work, not code here.
- **Deleting both `ledger.json` and `audit.jsonl` together still resets the cap.** No single
  deletion does — see `npm run integrity` — but two coordinated ones against files the agent is not
  supposed to be able to write is the residual risk, and file permissions are what covers it.
- **On mainnet you want more than zero confirmations**, which needs Blockfrost: Koios exposes no
  transaction-evidence hook, so a facilitator on it can only settle at `l1Confirmations: 0`. As a
  buyer you do not choose this — the seller's 402 does — but it governs any facilitator you run.

## Known behaviour worth expecting
- **A signed payment counts against the budget even if settlement then fails.** signerd records the
  spend when it signs, and never hears whether the facilitator got the transaction on chain, so a
  transient submit failure costs budget without moving funds. This is the conservative direction and
  deliberately so — refunding it would mean deciding "this will never land", which is exactly the
  question the facilitator cannot answer either. Observed once here: `dailySpent` of 16.5 tADA
  against 12.5 tADA actually delivered. The tools say so when it happens: `paid: false` with an
  `unsettled` note, and the transaction if one was broadcast, since a settlement reported failed can
  still confirm.
- **A 402 round-trip cannot complete on Koios at all.** The facilitator's `verify` resolves each
  input the buyer's transaction spends, and `@evolution-sdk`'s Koios provider fails that lookup for
  almost all of them. Over one wallet's 19 UTXOs, asked three ways: the Koios provider resolved 3,
  the Blockfrost provider resolved 19, and plain HTTP to the same Koios endpoint returned all 19.
  So the data is there and Koios is serving it; the provider cannot read it. The failures are
  deterministic, ~1.4s on an idle box, and grouped by the transaction that created the UTXO — not a
  timeout, not rate limiting, not native assets, not a UTXO that is missing or spent. All you are
  told is `Koios getUtxosByOutRef failed`, with the cause discarded. There is no steering around it
  either, because the SDK always takes `utxos[0]` as the payment nonce: if the wallet's first UTXO
  is one it cannot read, nothing that wallet does can pay. `BLOCKFROST_PROJECT_ID` is the answer and
  the free tier covers it. Everything short of settlement — policy, signing, the approval queue, the
  audit — works on Koios exactly as documented.
- **Koios can refuse a submit moments after confirming the transaction it chains from.** A payment
  spending the change of a just-confirmed transaction was rejected with `Koios submitTx failed`,
  and the identical payment succeeded on retry: its query view had the new UTXO before its submit
  node had the block. Retry rather than treat it as fatal — and note this is why the in-flight UTXO
  hold is short, since an over-long one makes that retry impossible.
- The in-flight hold is not what keeps an agent inside its cap; the ledger is. `NONCE_HOLD_SECONDS`
  (120s) only avoids handing back a transaction some other unsettled one has already doomed.

## Not yet
- `roundtrip approve mcp` has not been run. The queue is signerd's and the same for both
  transports, and the wait it adds happens inside signing — before `@x402/mcp` sends the paid
  request, so outside its request timeout — which is why nothing about MCP should change it. But
  "should" is the word this list exists to stop taking on trust
- direct `send` (non-x402 transfer) — needs our own submit path; v1 is x402 only
- Masumi escrow flows (`assetTransferMethod: masumi`) pass through untouched; policy still applies to the amount
- policy is per-agent, not per-resource; add `allowedResources` if needed

`vendor/` holds `@x402/cardano` built from the Foundation repo, because it is not on npm yet
(the publish workflow exists but hasn't run). Swap to the npm package when it lands.

## License

Apache-2.0 — see [LICENSE](LICENSE).

`vendor/` is third-party code under the same licence: `@x402/cardano` and `@x402/core`, built from
the x402 Foundation repository and pinned by sha256 to upstream `fdeda56`. See
[vendor/PROVENANCE.md](vendor/PROVENANCE.md) for how that was verified, and what it does not prove.
