import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, decideDeposit, parsePolicy, remaining, type SpendRecord } from "../src/policy.ts";

const USDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d"; // USDM preprod
const PAYEE = "addr1q9payee";
const policy = parsePolicy({
  agents: {
    scanner: {
      perTxMax: { lovelace: "5000000", [USDM]: "2000000" },
      dailyMax: { lovelace: "12000000" },
      allowedPayees: [PAYEE],
      maxPerHour: 3,
      approvalAbove: { lovelace: "3000000" },
    },
    open: { perTxMax: { lovelace: "1000000" }, allowedPayees: ["*"] },
    escrow: {
      perTxMax: { lovelace: "5000000" },
      allowedPayees: ["*"],
      allowedAssetTransferMethods: ["default", "masumi"],
    },
  },
});
const T0 = 1_700_000_000_000;
const req = (over: Partial<Parameters<typeof decide>[2]> = {}) => ({
  agentId: "scanner", payTo: PAYEE, asset: "lovelace", amount: 1_000_000n, reason: "pay for data api", now: T0, ...over,
});

test("allow within all limits", () => assert.equal(decide(policy, [], req()).verdict, "allow"));
test("unknown agent denied", () => assert.equal(decide(policy, [], req({ agentId: "nope" })).rule, "unknown_agent"));
test("reason required", () => {
  assert.equal(decide(policy, [], req({ reason: "" })).rule, "reason");
  assert.equal(decide(policy, [], req({ reason: "  " })).rule, "reason");
  // A number or an object is what an untyped caller sends; `.trim` on it was a crash, not a denial.
  assert.equal(decide(policy, [], req({ reason: 42 as unknown as string })).rule, "reason");
  assert.equal(decide(policy, [], req({ reason: undefined as unknown as string })).rule, "reason");
});
test("asset not listed denied", () => assert.equal(decide(policy, [], req({ asset: "0".repeat(56) + ".00" })).rule, "asset"));
test("payee allowlist", () => {
  assert.equal(decide(policy, [], req({ payTo: "addr1other" })).rule, "payee");
  assert.equal(decide(policy, [], req({ agentId: "open", payTo: "addr1other" })).verdict, "allow");
});
test("per-tx max", () => assert.equal(decide(policy, [], req({ amount: 5_000_001n })).rule, "per_tx_max"));
test("daily max rolls over 24h", () => {
  const ledger: SpendRecord[] = [
    { ts: T0 - 2 * 3600e3, agentId: "scanner", asset: "lovelace", amount: 5_000_000n },
    { ts: T0 - 5 * 3600e3, agentId: "scanner", asset: "lovelace", amount: 5_000_000n },
  ];
  assert.equal(decide(policy, ledger, req({ amount: 2_000_001n })).rule, "daily_max");
  assert.equal(decide(policy, ledger, req({ amount: 2_000_000n })).verdict, "allow");
  const old = ledger.map(r => ({ ...r, ts: T0 - 25 * 3600e3 }));
  assert.equal(decide(policy, old, req({ amount: 2_000_001n })).verdict, "allow");
});
test("daily max defaults to perTxMax when unset", () => {
  const ledger: SpendRecord[] = [{ ts: T0 - 60e3, agentId: "scanner", asset: USDM, amount: 1_500_000n }];
  assert.equal(decide(policy, ledger, req({ asset: USDM, amount: 600_000n })).rule, "daily_max");
});
test("hourly rate limit", () => {
  const ledger: SpendRecord[] = [1, 2, 3].map(i => ({ ts: T0 - i * 60e3, agentId: "scanner", asset: "lovelace", amount: 1n }));
  assert.equal(decide(policy, ledger, req()).rule, "rate");
  const stale = ledger.map(r => ({ ...r, ts: T0 - 61 * 60e3 }));
  assert.equal(decide(policy, stale, req()).verdict, "allow");
});
test("approval threshold", () => {
  assert.equal(decide(policy, [], req({ amount: 3_000_001n })).verdict, "needs_approval");
  assert.equal(decide(policy, [], req({ amount: 3_000_000n })).verdict, "allow");
});
test("other agents' spend does not count", () => {
  const ledger: SpendRecord[] = [{ ts: T0, agentId: "open", asset: "lovelace", amount: 12_000_000n }];
  assert.equal(decide(policy, ledger, req()).verdict, "allow");
});
test("remaining budget", () => {
  const ledger: SpendRecord[] = [{ ts: T0 - 1000, agentId: "scanner", asset: "lovelace", amount: 4_000_000n }];
  const r = remaining(policy, ledger, "scanner", T0)!;
  assert.equal(r.assets.lovelace.dailyRemaining, "8000000");
  assert.equal(r.assets.lovelace.dailySpent, "4000000");
  assert.equal(r.assets.lovelace.dailyMax, "12000000");
  assert.equal(r.assets.lovelace.overBudget, false);
  assert.equal(r.paymentsLastHour, 1);
});
test("remaining budget does not hide an overspend behind a clamped zero", () => {
  const ledger: SpendRecord[] = [{ ts: T0 - 1000, agentId: "scanner", asset: "lovelace", amount: 15_000_000n }];
  const r = remaining(policy, ledger, "scanner", T0)!;
  assert.equal(r.assets.lovelace.dailyRemaining, "0"); // a negative budget is not spendable
  assert.equal(r.assets.lovelace.dailySpent, "15000000"); // but the breach is still legible
  assert.equal(r.assets.lovelace.overBudget, true);
});
test("masumi is denied unless the agent opts in", () => {
  // The escrow locks buyer collateral on top of `amount`, which no field in the policy can see.
  assert.equal(decide(policy, [], req({ assetTransferMethod: "masumi" })).rule, "asset_transfer_method");
  assert.equal(decide(policy, [], req({ assetTransferMethod: "script" })).rule, "asset_transfer_method");
  assert.equal(decide(policy, [], req({ assetTransferMethod: "default" })).verdict, "allow");
  assert.equal(decide(policy, [], req()).verdict, "allow"); // absent means "default"
});
test("masumi allowed for an agent that lists it", () => {
  const as_escrow = req({ agentId: "escrow", assetTransferMethod: "masumi" });
  assert.equal(decide(policy, [], as_escrow).verdict, "allow");
  assert.equal(decide(policy, [], req({ agentId: "escrow", assetTransferMethod: "script" })).rule, "asset_transfer_method");
});
test("parsePolicy rejects bad input", () => {
  assert.throws(() => parsePolicy({ agents: { a: { perTxMax: { lovelace: "1.5" }, allowedPayees: ["*"] } } }));
  assert.throws(() => parsePolicy({ agents: { a: { perTxMax: { lovelace: "1" }, allowedPayees: [] } } }));
  assert.throws(() => parsePolicy({ agents: { a: { perTxMax: { ADA: "1" }, allowedPayees: ["*"] } } }));
  assert.throws(() =>
    parsePolicy({ agents: { a: { perTxMax: { lovelace: "1" }, allowedPayees: ["*"], allowedAssetTransferMethods: ["masumi2"] } } }),
  );
  assert.throws(() =>
    parsePolicy({ agents: { a: { perTxMax: { lovelace: "1" }, allowedPayees: ["*"], allowedAssetTransferMethods: [] } } }),
  );
});
test("resource allowlist: exact, prefix, and fail closed when unreported", () => {
  const p = parsePolicy({
    agents: {
      a: {
        perTxMax: { lovelace: "5000000" },
        allowedPayees: ["*"],
        allowedResources: ["https://api.example.com/v1/*", "https://exact.example.com/one"],
      },
    },
  });
  const r = (over: Record<string, unknown>) => ({ agentId: "a", payTo: PAYEE, asset: "lovelace", amount: 1_000_000n, reason: "buy data", now: T0, ...over });
  assert.equal(decide(p, [], r({ resource: "https://api.example.com/v1/quote" })).verdict, "allow");
  assert.equal(decide(p, [], r({ resource: "https://exact.example.com/one" })).verdict, "allow");
  assert.equal(decide(p, [], r({ resource: "https://exact.example.com/two" })).rule, "resource");
  assert.equal(decide(p, [], r({ resource: "https://evil.example.com/v1/quote" })).rule, "resource");
  // the prefix keeps its slash, so a sibling path that merely starts with the same characters loses
  assert.equal(decide(p, [], r({ resource: "https://api.example.com/v1evil/quote" })).rule, "resource");
  // ".." begins with the prefix as a string but not as a request
  assert.equal(decide(p, [], r({ resource: "https://api.example.com/v1/../admin" })).rule, "resource");
  // a payment that names no resource cannot be checked, so it is refused
  assert.equal(decide(p, [], r({})).rule, "resource");
  assert.equal(decide(p, [], r({ resource: "not a url" })).rule, "resource");
});
test("resource allowlist is optional and [\"*\"] means any", () => {
  const any = parsePolicy({ agents: { a: { perTxMax: { lovelace: "5000000" }, allowedPayees: ["*"], allowedResources: ["*"] } } });
  const none = parsePolicy({ agents: { a: { perTxMax: { lovelace: "5000000" }, allowedPayees: ["*"] } } });
  const r = (over: Record<string, unknown>) => ({ agentId: "a", payTo: PAYEE, asset: "lovelace", amount: 1_000_000n, reason: "buy data", now: T0, ...over });
  assert.equal(decide(any, [], r({ resource: "https://anywhere.example.com/x" })).verdict, "allow");
  assert.equal(decide(none, [], r({})).verdict, "allow");
});
test("parsePolicy validates network and allowedResources", () => {
  assert.equal(parsePolicy({ network: "cardano:mainnet", agents: { a: { perTxMax: { lovelace: "1" }, allowedPayees: ["*"] } } }).network, "cardano:mainnet");
  assert.throws(() => parsePolicy({ network: "mainnet", agents: { a: { perTxMax: { lovelace: "1" }, allowedPayees: ["*"] } } }));
  assert.throws(() => parsePolicy({ agents: { a: { perTxMax: { lovelace: "1" }, allowedPayees: ["*"], allowedResources: [] } } }));
  assert.throws(() => parsePolicy({ agents: { a: { perTxMax: { lovelace: "1" }, allowedPayees: ["*"], allowedResources: ["ftp://x/y"] } } }));
});
test("parsePolicy rejects a misspelled field instead of ignoring it", () => {
  // `approvalabove` would otherwise parse as "this agent never needs approval".
  assert.throws(
    () => parsePolicy({ agents: { a: { perTxMax: { lovelace: "1" }, allowedPayees: ["*"], approvalabove: { lovelace: "1" } } } }),
    /unknown field "approvalabove"/,
  );
});
test("parsePolicy rejects a cap for an asset that is never allowed", () => {
  // A malformed asset id is already caught; this is the valid-but-absent one, which is what
  // copying a policy between networks leaves behind. The asset is denied outright, so a dailyMax
  // or threshold for it silently does nothing.
  const base = { perTxMax: { lovelace: "5000000" }, allowedPayees: ["*"] };
  assert.throws(
    () => parsePolicy({ agents: { a: { ...base, dailyMax: { [USDM]: "9" } } } }),
    /dailyMax for ".*", which is not in perTxMax/,
  );
  assert.throws(
    () => parsePolicy({ agents: { a: { ...base, approvalAbove: { [USDM]: "9" } } } }),
    /approvalAbove for ".*", which is not in perTxMax/,
  );
  assert.doesNotThrow(() => parsePolicy({ agents: { a: { ...base, dailyMax: { lovelace: "9" } } } }));
});
test("a zero amount is denied", () => {
  // signerd's wire validation allows "0" through, so this is the rule that stops it.
  assert.equal(decide(policy, [], req({ amount: 0n })).rule, "amount");
  assert.equal(decide(policy, [], req({ amount: -1n })).rule, "amount");
});

// ---- batch-settlement ----------------------------------------------------------------------

const KEY = "cd8bede8affbab812d2b81a6739f69bdf53fa2a297efb10147243385";
const OTHER_KEY = "ab".repeat(28);
const batchPolicy = parsePolicy({
  agents: {
    micro: {
      perTxMax: { lovelace: "5000000", [USDM]: "10000" },
      dailyMax: { [USDM]: "20000" },
      approvalAbove: { [USDM]: "5000" },
      allowedPayees: [PAYEE],
      maxPerHour: 2,
      allowedSchemes: ["exact", "batch-settlement"],
      allowedProviderKeys: [KEY],
      channelDepositMax: { [USDM]: "1000000", lovelace: "5000000" },
      channelLockedMax: { [USDM]: "2000000", lovelace: "6000000" },
      maxWithdrawDelay: 3600,
      maxVouchersPerHour: 3,
    },
  },
});
const voucher = (over: Partial<Parameters<typeof decide>[2]> = {}) => ({
  agentId: "micro", payTo: PAYEE, asset: USDM, amount: 1_000n, reason: "one datum", scheme: "batch-settlement", providerKey: KEY, now: T0, ...over,
});

test("batch-settlement is off unless listed", () => {
  // scanner lists no schemes: exact only, as before this existed.
  assert.equal(decide(policy, [], req({ scheme: "batch-settlement", providerKey: KEY })).rule, "scheme");
  assert.equal(decide(batchPolicy, [], voucher()).verdict, "allow");
});
test("a voucher's channel must name an allowed provider key, whatever payTo says", () => {
  // The key redeems and the validator does not say where to: an allowed payTo beside a seller's
  // own key would pay whoever holds that key.
  assert.equal(decide(batchPolicy, [], voucher({ providerKey: OTHER_KEY })).rule, "provider_key");
  assert.equal(decide(batchPolicy, [], voucher({ providerKey: undefined })).rule, "provider_key");
  assert.equal(decide(batchPolicy, [], voucher({ payTo: "addr1other" })).rule, "payee");
  const any = parsePolicy({ agents: { a: { perTxMax: { [USDM]: "10000" }, allowedPayees: ["*"], allowedSchemes: ["batch-settlement"], allowedProviderKeys: ["*"] } } });
  assert.equal(decide(any, [], voucher({ agentId: "a", providerKey: OTHER_KEY })).verdict, "allow");
});
test("a voucher's increment counts against perTxMax, dailyMax and approvalAbove like any payment", () => {
  assert.equal(decide(batchPolicy, [], voucher({ amount: 10_001n })).rule, "per_tx_max");
  assert.equal(decide(batchPolicy, [], voucher({ amount: 5_001n })).verdict, "needs_approval");
  const spent: SpendRecord[] = [{ ts: T0 - 60e3, agentId: "micro", asset: USDM, amount: 19_500n, voucher: true }];
  assert.equal(decide(batchPolicy, spent, voucher({ amount: 1_000n })).rule, "daily_max");
  assert.equal(decide(batchPolicy, spent, voucher({ amount: 500n })).verdict, "allow");
});
test("vouchers and transactions have separate hourly limits", () => {
  const vouchers: SpendRecord[] = [1, 2, 3].map(i => ({ ts: T0 - i * 60e3, agentId: "micro", asset: USDM, amount: 1n, voucher: true }));
  const exact = { scheme: undefined, providerKey: undefined, asset: "lovelace", amount: 1_000_000n };
  assert.equal(decide(batchPolicy, vouchers, voucher()).rule, "rate");
  // Three vouchers leave the transaction limit (2) untouched...
  assert.equal(decide(batchPolicy, vouchers, voucher(exact)).verdict, "allow");
  // ...and two transactions leave the voucher limit untouched.
  const txs: SpendRecord[] = [1, 2].map(i => ({ ts: T0 - i * 60e3, agentId: "micro", asset: "lovelace", amount: 1n }));
  assert.equal(decide(batchPolicy, txs, voucher()).verdict, "allow");
  assert.equal(decide(batchPolicy, txs, voucher(exact)).rule, "rate");
  const r = remaining(batchPolicy, [...vouchers, ...txs], "micro", T0)!;
  assert.equal(r.paymentsLastHour, 2);
  assert.equal(r.vouchersLastHour, 3);
  assert.equal(r.maxVouchersPerHour, 3);
  assert.deepEqual(r.allowedSchemes, ["exact", "batch-settlement"]);
});
test("a deposit is bounded by its own limits, not the daily cap", () => {
  const dep = (over: Partial<Parameters<typeof decideDeposit>[1]> = {}) => ({
    agentId: "micro", asset: USDM, amount: 100_000n, reserveLovelace: 2_000_000n, locked: {}, withdrawDelay: 900, ...over,
  });
  // 100,000 is five times dailyMax: it is locked, not spent.
  assert.equal(decideDeposit(batchPolicy, dep()).verdict, "allow");
  assert.equal(decideDeposit(batchPolicy, dep({ amount: 1_000_001n })).rule, "channel_deposit_max");
  assert.equal(decideDeposit(batchPolicy, dep({ locked: { [USDM]: 1_950_000n } })).rule, "channel_locked_max");
  // A token channel's ADA reserve is locked ADA.
  assert.equal(decideDeposit(batchPolicy, dep({ locked: { lovelace: 4_500_000n } })).rule, "channel_locked_max");
  assert.equal(decideDeposit(batchPolicy, dep({ reserveLovelace: 0n, locked: { lovelace: 5_999_999n } })).verdict, "allow");
  assert.equal(decideDeposit(batchPolicy, dep({ withdrawDelay: 3601 })).rule, "withdraw_delay");
  assert.equal(decideDeposit(policy, dep({ agentId: "scanner" })).rule, "scheme");
  const noDeposits = parsePolicy({ agents: { a: { perTxMax: { [USDM]: "10000" }, allowedPayees: ["*"], allowedSchemes: ["batch-settlement"] } } });
  assert.equal(decideDeposit(noDeposits, dep({ agentId: "a" })).rule, "channel_deposit_max");
});
test("the close period defaults to a day at most", () => {
  const p = parsePolicy({
    agents: { a: { perTxMax: { lovelace: "1" }, allowedPayees: ["*"], allowedSchemes: ["batch-settlement"], channelDepositMax: { lovelace: "9" }, channelLockedMax: { lovelace: "9" } } },
  });
  const dep = { agentId: "a", asset: "lovelace", amount: 1n, reserveLovelace: 0n, locked: {}, withdrawDelay: 86_400 };
  assert.equal(decideDeposit(p, dep).verdict, "allow");
  assert.equal(decideDeposit(p, { ...dep, withdrawDelay: 86_401 }).rule, "withdraw_delay");
});
test("parsePolicy checks the batch-settlement fields", () => {
  const base = { perTxMax: { lovelace: "5000000", [USDM]: "1" }, allowedPayees: ["*"] };
  const parse = (over: Record<string, unknown>) => parsePolicy({ agents: { a: { ...base, ...over } } });
  assert.throws(() => parse({ allowedSchemes: ["upto"] }), /unknown scheme "upto"/);
  assert.throws(() => parse({ allowedSchemes: [] }), /non-empty/);
  assert.throws(() => parse({ allowedProviderKeys: ["addr_test1xyz"] }), /key hash/);
  assert.throws(() => parse({ allowedProviderKeys: [KEY.toUpperCase()] }), /key hash/);
  assert.throws(() => parse({ maxWithdrawDelay: 899 }), /900 to 2592000/);
  assert.throws(() => parse({ maxWithdrawDelay: 2_592_001 }), /900 to 2592000/);
  assert.throws(() => parse({ maxVouchersPerHour: 0 }), /positive integer/);
  assert.throws(() => parse({ channelDepositMax: { lovelace: "1.5" } }), /decimal integer/);
  // Limits for an asset the agent can never pay in are typos, as for dailyMax...
  const OTHER = "ff".repeat(28) + ".00";
  assert.throws(() => parse({ channelDepositMax: { [OTHER]: "9" } }), /channelDepositMax for ".*", which is not in perTxMax/);
  assert.throws(() => parse({ channelLockedMax: { [OTHER]: "9" } }), /channelLockedMax for ".*", which is not in perTxMax/);
  // ...except lovelace in channelLockedMax: a token channel locks its ADA reserve regardless.
  const tokenOnly = { perTxMax: { [USDM]: "1" }, allowedPayees: ["*"], channelLockedMax: { lovelace: "9", [USDM]: "9" } };
  assert.doesNotThrow(() => parsePolicy({ agents: { a: tokenOnly } }));
  assert.doesNotThrow(() => parse({ allowedSchemes: ["batch-settlement"], allowedProviderKeys: ["*", KEY], maxWithdrawDelay: 900 }));
});
