import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, parsePolicy, remaining, type SpendRecord } from "../src/policy.ts";

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
test("reason required", () => assert.equal(decide(policy, [], req({ reason: "" })).rule, "reason"));
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
test("parsePolicy rejects a misspelled field instead of ignoring it", () => {
  // `approvalabove` would otherwise parse as "this agent never needs approval".
  assert.throws(
    () => parsePolicy({ agents: { a: { perTxMax: { lovelace: "1" }, allowedPayees: ["*"], approvalabove: { lovelace: "1" } } } }),
    /unknown field "approvalabove"/,
  );
});
