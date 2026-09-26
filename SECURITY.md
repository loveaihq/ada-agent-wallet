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
- the approval queue releasing a payment the policy would now refuse
- the mnemonic, or a decrypted keystore, leaving the signerd process
- the spend ledger being reset, rebuilt wrong, or made to under-count
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
- a signed payment counts against the budget even if settlement then fails.
- on Koios a facilitator can only settle at `l1Confirmations: 0`; depth needs Blockfrost.
- on Windows the file-mode check reports that it could not run, rather than passing.

## Status

`0.2.4`. Verified on preprod, including real on-chain round-trips. It has never run on mainnet, and
no part of it has had an external security review. If you are about to point it at real ADA, read
**Before mainnet** in the README and run `npm run walletctl -- preflight` first.
