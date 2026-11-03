# Security Policy

This project holds a Cardano signing key and authorises payments with it. Treat anything that lets
an agent spend outside its policy, or that exposes the mnemonic, as a vulnerability.

## Reporting

Please do not open a public issue for a vulnerability.

Use GitHub's **Report a vulnerability** button under the Security tab if it is enabled on this
repository — it keeps the thread attached to the code. Otherwise email **loveaihqhq@gmail.com**.

Include enough to make the problem reproducible: the policy file, the request, and what signerd did
versus what you expected. A preprod transaction hash is worth more than a paragraph of description.

I am one person working on this in the open. I will acknowledge a report within a week. I cannot
promise a fix window, and I would rather say so here than imply an SLA I will miss.

## In scope

Anything that breaks one of these, because enforcing them is the whole reason the daemon exists:

- an agent spending above `perTxMax`, `dailyMax` or `maxPerHour`
- an agent spending as, or reading the budget of, another agent
- a payment reaching a payee outside `allowedPayees`, or a resource outside `allowedResources`
- the approval queue releasing a payment the policy would now refuse, or an agent's token reading
  the queue or approving from it
- an `exact` payment that costs more ADA than the policy and the bounds allow: a fee above
  `MAX_FEE_LOVELACE`, more than `MAX_RIDE_LOVELACE` riding to the payee, a certificate, withdrawal,
  mint, vote or donation in the transaction, or ADA that leaves with a token payment without being
  counted against the agent's lovelace caps
- a redirect making a payment go to a URL the agent did not ask for
- the mnemonic, or a decrypted keystore, leaving the signerd process
- the spend ledger being reset, rebuilt wrong, or made to under-count — including a spend given
  back on anything but signerd's own read of the chain provider, or while its transaction is still
  able to land
- signerd binding anything other than the loopback interface
- batch-settlement: a voucher signed for more than the policy counted, a channel whose provider
  key is outside `allowedProviderKeys`, a deposit past `channelDepositMax` or `channelLockedMax`,
  a refund paying the seller more than was signed and not yet redeemed, or an IOU key reaching
  anything but signerd's memory

## Already known — please do not report these as new

All of these are documented in the README under **What this still does not do** and **Known
behaviour worth expecting**. They are accepted limitations, not findings:

- signerd keeps the decrypted mnemonic in its own memory. There is no HSM or KMS path. The
  mitigation is `MAX_HOT_BALANCE_LOVELACE` — keep in the wallet only what you would accept losing.
- deleting `ledger.json` **and** `audit.jsonl` together resets the spend cap. No single deletion
  does. File permissions are what covers the pair.
- a signed payment counts against the budget when signed, and comes back only once signerd has read
  from its chain provider that the transaction can no longer land (past its TTL plus
  `RELEASE_MARGIN_SECONDS`, and not in a block). That trusts the provider's "not found": one that
  lied would give back spent budget, bounded by `MAX_HOT_BALANCE_LOVELACE`. A payment signed
  before this existed, a batch-settlement voucher, and a request waiting for approval are never
  given back this way.
- on Koios a facilitator can only settle at `l1Confirmations: 0`; depth needs Blockfrost.
- on Windows the file-mode check reports that it could not run, rather than passing.

## Known limitations

Also accepted for now, not findings:

- `walletctl approve <id>` asks for no confirmation, and prints the agent's `reason` raw. The
  reason is text the agent wrote, so it can carry terminal escape sequences that redraw what the
  operator reads. Take the amount and the payee from `walletctl pending` and from the audit log,
  not from the reason, and do not approve from a terminal you would not trust to show you the truth.
- parent-directory permissions are not checked. signerd checks the mode of each file it reads or
  writes, not of the directories above it, so a 0600 file inside a directory the agent's user can
  write or rename in is not protected: the agent can replace it.
- `@x402/cardano` is not pinned, and there is no `npm-shrinkwrap.json`. `package.json` declares
  `^2.26.0` ranges for the `@x402/*` packages, so an install from npm resolves the newest 2.x, not
  the version this was tested on; only a checkout is held to `package-lock.json`. The fee,
  payee-ride and balance-changing-operation checks read the transaction back after the builder
  has run, which is what limits a newer builder that behaves differently.
- the seller's `maxTimeoutSeconds` becomes the transaction's TTL unclamped. The approval window and
  the UTXO hold are clamped; the validity of the signed transaction is not, so a seller can ask for
  one that stays valid for as long as it likes, and the spend is only given back once the chain is
  past that TTL and the release margin.

## Status

`0.2.11`. Verified on preprod, including real on-chain round-trips. Exact payments may be used on
mainnet at your own risk; batch-settlement runs on preprod only. It has never run on mainnet, and
no part of it has had an external security review. If you are about to point it at real ADA, read
the **Disclaimer** and **Before mainnet** in the README and run `npm run walletctl -- preflight`
first.
