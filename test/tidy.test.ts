import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_TIDY_OFF,
  COLLATERAL_CEILING,
  COLLATERAL_FLOOR,
  DEFAULT_COLLATERAL,
  TIDY_FEE_MAX,
  TOKEN_SLACK,
  adaOnlyLovelace,
  adaOnlyLovelaceAfter,
  autoTidyDecision,
  describeLayout,
  formatAda,
  formatDuration,
  parseAda,
  tidyPlan,
  tidyProblem,
  type AutoTidyInput,
  type DecodedTx,
  type TidyWork,
  type Utxo,
} from "../src/tidy.ts";

const ADA = 1_000_000n;
const WALLET = "addr_test1wallet";
const STRANGER = "addr_test1stranger";
const USDM = `${"e6".repeat(28)}.0014df10745553444d`;
const OTHER = `${"ab".repeat(28)}.`;
/** A stand-in for the ledger's rule: 1 ADA and 0.2 ADA a distinct token. The real one needs the protocol parameters. */
const minAda = (tokens: Readonly<Record<string, bigint>>) => ADA + (ADA / 5n) * BigInt(Object.keys(tokens).length);

let n = 0;
const utxo = (lovelace: bigint, assets: Record<string, bigint> = {}): Utxo => ({ ref: `${(++n).toString(16).padStart(64, "0")}#0`, lovelace, assets });
const opts = { minAda };
const work = (p: ReturnType<typeof tidyPlan>): TidyWork => {
  assert.ok("inputs" in p, `expected a plan, got ${JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  return p;
};

// ---- tidyPlan -----------------------------------------------------------------------------------

test("tokens in one UTxO at about their min-ADA, and an ADA-only UTxO for collateral, is already tidy", () => {
  const p = tidyPlan([utxo(1_400_000n, { [USDM]: 50n }), utxo(8n * ADA), utxo(2n * ADA)], opts);
  assert.equal(p.tidy, true);
  assert.match((p as { why: string }).why, /ADA-only UTxO of 8 ADA/);
});

test("a wallet with no tokens needs only its collateral UTxO", () => {
  assert.equal(tidyPlan([utxo(5n * ADA)], opts).tidy, true);
  assert.equal(tidyPlan([utxo(4_999_999n), utxo(4_999_999n)], opts).tidy, false);
});

test("a token UTxO is tidy up to its min-ADA and the slack, and not a lovelace over", () => {
  // One distinct token: the stand-in's min-ADA is 1.2 ADA.
  const at = (lovelace: bigint) => tidyPlan([utxo(lovelace, { [USDM]: 1n }), utxo(9n * ADA)], opts).tidy;
  assert.equal(at(1_200_000n + TOKEN_SLACK), true);
  assert.equal(at(1_200_000n + TOKEN_SLACK + 1n), false);
});

test("tokens spread over several UTxOs are gathered, and every UTxO is spent", () => {
  const a = utxo(3n * ADA, { [USDM]: 40n });
  const b = utxo(2n * ADA, { [USDM]: 2n, [OTHER]: 7n });
  const c = utxo(30n * ADA);
  const d = utxo(1_500_000n, { [OTHER]: 1n });
  const p = work(tidyPlan([a, b, c, d], opts));
  assert.deepEqual(p.inputs, [a, b, c, d].map(u => u.ref));
  assert.deepEqual(p.tokens, { [USDM]: 42n, [OTHER]: 8n });
  assert.equal(p.collateralLovelace, DEFAULT_COLLATERAL);
  assert.equal(p.tokenMinAda, minAda(p.tokens));
  assert.equal(p.totalLovelace, 36_500_000n);
  assert.match(p.why, /spread over 3 UTxOs/);
});

test("all the ADA inside the one token UTxO is the case this exists for", () => {
  const only = utxo(44n * ADA, { [USDM]: 1_000_000n });
  const p = work(tidyPlan([only], opts));
  assert.deepEqual(p.inputs, [only.ref]);
  assert.match(p.why, /holds 44 ADA, more than the 1.2 ADA they need/);
  assert.match(p.why, /no UTxO is ADA-only/);
});

test("an ADA-only UTxO too small for the collateral is not enough, however many there are", () => {
  const p = work(tidyPlan([utxo(1_400_000n, { [USDM]: 1n }), utxo(4n * ADA), utxo(4n * ADA), utxo(3n * ADA)], opts));
  assert.equal(p.inputs.length, 4);
  assert.match(p.why, /largest ADA-only UTxO holds 4 ADA, under the 5 ADA of collateral/);
  // The token UTxO was fine; it is spent anyway, because one transaction that spends everything is simpler to check.
  assert.doesNotMatch(p.why, /tokens/);
});

test("the collateral is the operator's to choose, within what a channel step uses", () => {
  const wallet = [utxo(1_400_000n, { [USDM]: 1n }), utxo(3n * ADA)];
  assert.equal(tidyPlan(wallet, opts).tidy, false);
  assert.equal(tidyPlan(wallet, { ...opts, collateralLovelace: 3n * ADA }).tidy, true);
  // The floor: a 2 ADA UTxO is all the collateral asks for, and 5 ADA is not there to be had.
  assert.equal(tidyPlan([utxo(2n * ADA)], { ...opts, collateralLovelace: COLLATERAL_FLOOR }).tidy, true);
  assert.equal(tidyPlan([utxo(2n * ADA)], opts).tidy, false);
});

test("a collateral outside 2 to 5 ADA is refused", () => {
  const wallet = [utxo(30n * ADA, { [USDM]: 1n })];
  assert.match((tidyPlan(wallet, { ...opts, collateralLovelace: COLLATERAL_FLOOR - 1n }) as { refused: string }).refused, /under the 2 ADA/);
  assert.match((tidyPlan(wallet, { ...opts, collateralLovelace: COLLATERAL_CEILING + 1n }) as { refused: string }).refused, /more than the 5 ADA/);
  assert.equal(work(tidyPlan(wallet, { ...opts, collateralLovelace: COLLATERAL_CEILING })).collateralLovelace, COLLATERAL_CEILING);
});

test("more UTxOs than one transaction will spend is refused, and only when there is something to fix", () => {
  const many = (count: number) => Array.from({ length: count }, () => utxo(ADA / 2n));
  const wallet = [...many(60), utxo(1_400_000n, { [USDM]: 1n })];
  const p = tidyPlan(wallet, opts);
  assert.equal(p.tidy, false);
  assert.match((p as { refused: string }).refused, /61 UTxOs, more than the 60/);
  // Sixty is the limit, and a lower one is honoured.
  assert.ok("inputs" in tidyPlan([...many(58), utxo(20n * ADA, { [USDM]: 1n }), utxo(ADA)], opts));
  assert.match((tidyPlan(many(5), { ...opts, maxInputs: 4 }) as { refused: string }).refused, /5 UTxOs, more than the 4/);
  // 100 UTxOs of which one is a fine collateral UTxO and the tokens are in order: nothing to do, so no refusal.
  assert.equal(tidyPlan([...many(99), utxo(6n * ADA)], opts).tidy, true);
});

test("a wallet without the ADA for the layout is refused, with the sum", () => {
  // 5 collateral + 1.2 tokens + 1 fee + 1 change = 8.2 ADA.
  const p = tidyPlan([utxo(2n * ADA, { [USDM]: 1n }), utxo(2n * ADA), utxo(4n * ADA)], opts);
  assert.equal(p.tidy, false);
  assert.match((p as { refused: string }).refused, /holds 8 ADA in all, and the layout needs at least 8.2 ADA/);
  assert.ok("inputs" in tidyPlan([utxo(2n * ADA, { [USDM]: 1n }), utxo(2n * ADA), utxo(4_200_000n)], opts));
  // Without tokens there are none of their min-ADA to find.
  assert.match((tidyPlan([utxo(3n * ADA), utxo(3n * ADA)], opts) as { refused: string }).refused, /needs at least 7 ADA/);
  assert.equal(tidyPlan([], opts).tidy, false);
  assert.match((tidyPlan([], opts) as { refused: string }).refused, /no UTxOs/);
});

test("a quantity of nothing is not a token", () => {
  assert.equal(tidyPlan([utxo(9n * ADA, { [USDM]: 0n }), utxo(2n * ADA, { [OTHER]: 0n })], opts).tidy, true);
});

test("asset ids are compared without regard to case", () => {
  const p = work(tidyPlan([utxo(9n * ADA, { [USDM.toUpperCase()]: 1n }), utxo(9n * ADA, { [USDM]: 2n })], opts));
  assert.deepEqual(p.tokens, { [USDM]: 3n });
});

// ---- tidyProblem --------------------------------------------------------------------------------

const plan = (): TidyWork => {
  const a = utxo(3n * ADA, { [USDM]: 40n });
  const b = utxo(2n * ADA, { [USDM]: 2n });
  const c = utxo(30n * ADA);
  return work(tidyPlan([a, b, c], opts));
};
/** The transaction the plan asks for: tokens with their min-ADA, the collateral, the rest as change. */
const built = (p: TidyWork, over: Partial<DecodedTx> = {}): DecodedTx => {
  const fee = 250_000n;
  const tokenOut = p.tokenMinAda;
  return {
    inputs: [...p.inputs].reverse(), // a transaction lists its inputs in its own order
    outputs: [
      { address: WALLET, coin: tokenOut, assets: p.tokens },
      { address: WALLET, coin: p.collateralLovelace, assets: {} },
      { address: WALLET, coin: p.totalLovelace - tokenOut - p.collateralLovelace - fee, assets: {} },
    ],
    fee,
    balanceChangingOperations: [],
    redeemerCount: 0,
    scriptWitnessCount: 0,
    ...over,
  };
};

test("the transaction the plan asks for passes", () => {
  const p = plan();
  assert.equal(tidyProblem(built(p), p, WALLET), undefined);
});

test("a wallet with no tokens gets no token output, and passes without one", () => {
  const p = work(tidyPlan([utxo(2n * ADA), utxo(3n * ADA), utxo(4n * ADA)], opts));
  const fee = 200_000n;
  const t: DecodedTx = {
    inputs: p.inputs,
    outputs: [{ address: WALLET, coin: p.collateralLovelace }, { address: WALLET, coin: p.totalLovelace - p.collateralLovelace - fee }],
    fee,
    balanceChangingOperations: [],
    redeemerCount: 0,
    scriptWitnessCount: 0,
  };
  assert.equal(tidyProblem(t, p, WALLET), undefined);
  // A token appearing from nowhere is not one of the plan's.
  assert.match(tidyProblem({ ...t, outputs: [{ address: WALLET, coin: p.collateralLovelace, assets: { [USDM]: 1n } }, t.outputs[1]] }, p, WALLET)!, /outputs hold 1 of e6e6.*and the inputs hold 0/);
});

test("spending a UTxO the plan does not, or leaving one out, is caught", () => {
  const p = plan();
  const t = built(p);
  assert.match(tidyProblem({ ...t, inputs: [...t.inputs, `${"ff".repeat(32)}#2`] }, p, WALLET)!, /spends 1 UTxO\(s\) the plan does not: f{64}#2/);
  assert.match(tidyProblem({ ...t, inputs: t.inputs.slice(1) }, p, WALLET)!, /leaves 1 of the plan's 3 UTxOs unspent/);
  assert.match(tidyProblem({ ...t, inputs: [...t.inputs, t.inputs[0]] }, p, WALLET)!, /same input twice/);
});

test("minting, withdrawals and the like are caught", () => {
  const p = plan();
  assert.match(tidyProblem(built(p, { balanceChangingOperations: ["mint"] }), p, WALLET)!, /carries mint/);
  assert.match(tidyProblem(built(p, { balanceChangingOperations: ["withdrawals", "donation"] }), p, WALLET)!, /withdrawals, donation/);
});

test("a script has no place in a tidy", () => {
  const p = plan();
  assert.match(tidyProblem(built(p, { redeemerCount: 1 }), p, WALLET)!, /runs a script/);
  assert.match(tidyProblem(built(p, { scriptWitnessCount: 1 }), p, WALLET)!, /runs a script/);
});

test("an output to anybody else is caught, however small", () => {
  const p = plan();
  const t = built(p);
  const paid = { ...t, outputs: [...t.outputs.slice(0, 2), { address: STRANGER, coin: 1n }, { address: WALLET, coin: t.outputs[2].coin - 1n }] };
  assert.match(tidyProblem(paid, p, WALLET)!, /1 address\(es\) that are not this wallet: addr_test1stranger/);
});

test("a fee over 1 ADA is caught, and 1 ADA is not", () => {
  const p = plan();
  const withFee = (fee: bigint): DecodedTx => {
    const t = built(p);
    return { ...t, fee, outputs: [t.outputs[0], t.outputs[1], { ...t.outputs[2], coin: p.totalLovelace - p.tokenMinAda - p.collateralLovelace - fee }] };
  };
  assert.equal(tidyProblem(withFee(TIDY_FEE_MAX), p, WALLET), undefined);
  assert.match(tidyProblem(withFee(TIDY_FEE_MAX + 1n), p, WALLET)!, /fee is 1000001 lovelace, more than the 1000000/);
});

test("every token that went in must come out", () => {
  const p = plan();
  const t = built(p);
  const short = { ...t, outputs: [{ ...t.outputs[0], assets: { [USDM]: 41n } }, ...t.outputs.slice(1)] };
  assert.match(tidyProblem(short, p, WALLET)!, /outputs hold 41 of e6e6.*and the inputs hold 42/);
  const dropped = { ...t, outputs: [{ ...t.outputs[0], assets: {} }, ...t.outputs.slice(1)] };
  assert.match(tidyProblem(dropped, p, WALLET)!, /outputs hold 0 of e6e6.*and the inputs hold 42/);
  const extra = { ...t, outputs: [{ ...t.outputs[0], assets: { ...t.outputs[0].assets, [OTHER]: 1n } }, ...t.outputs.slice(1)] };
  assert.match(tidyProblem(extra, p, WALLET)!, /outputs hold 1 of abab.*and the inputs hold 0/);
});

test("the tokens must be in exactly one output, and that output must not keep the ADA", () => {
  const p = plan();
  const t = built(p);
  // Split in two: every amount is right, and the wallet is untidy again.
  const split = {
    ...t,
    outputs: [
      { address: WALLET, coin: p.tokenMinAda, assets: { [USDM]: 40n } },
      { address: WALLET, coin: p.tokenMinAda, assets: { [USDM]: 2n } },
      ...t.outputs.slice(1, 2),
      { ...t.outputs[2], coin: t.outputs[2].coin - p.tokenMinAda },
    ],
  };
  assert.match(tidyProblem(split, p, WALLET)!, /expected 1 output\(s\) with tokens, found 2/);
  // All the ADA back in the token output: the result would not pass tidyPlan.
  const fat = { ...t, outputs: [{ ...t.outputs[0], coin: p.tokenMinAda + TOKEN_SLACK + 1n }, t.outputs[1], { ...t.outputs[2], coin: t.outputs[2].coin - TOKEN_SLACK - 1n }] };
  assert.match(tidyProblem(fat, p, WALLET)!, /token output holds 2.200001 ADA, more than the 1.2 ADA the tokens need/);
  const edge = { ...fat, outputs: [{ ...fat.outputs[0], coin: p.tokenMinAda + TOKEN_SLACK }, fat.outputs[1], { ...fat.outputs[2], coin: fat.outputs[2].coin + 1n }] };
  assert.equal(tidyProblem(edge, p, WALLET), undefined);
});

test("an ADA-only output of exactly the collateral must exist", () => {
  const p = plan();
  const t = built(p);
  const off = (by: bigint) => ({ ...t, outputs: [t.outputs[0], { ...t.outputs[1], coin: t.outputs[1].coin + by }, { ...t.outputs[2], coin: t.outputs[2].coin - by }] });
  assert.match(tidyProblem(off(1n), p, WALLET)!, /no ADA-only output of exactly 5 ADA/);
  assert.match(tidyProblem(off(-1n), p, WALLET)!, /no ADA-only output of exactly 5 ADA/);
  // Which of the two ADA-only outputs is 5 ADA does not matter; that one is, does.
  const swapped = { ...t, outputs: [t.outputs[0], { ...t.outputs[2] }, { ...t.outputs[1] }] };
  assert.equal(tidyProblem(swapped, p, WALLET), undefined);
  const neither = { ...t, outputs: [t.outputs[0], { ...t.outputs[1], coin: 4n * ADA }, { ...t.outputs[2], coin: t.outputs[2].coin + ADA }] };
  assert.match(tidyProblem(neither, p, WALLET)!, /no ADA-only output of exactly 5 ADA/);
});

test("the outputs and the fee must add up to what the inputs hold", () => {
  const p = plan();
  const t = built(p);
  const skim = { ...t, outputs: [t.outputs[0], t.outputs[1], { ...t.outputs[2], coin: t.outputs[2].coin - 1n }] };
  assert.match(tidyProblem(skim, p, WALLET)!, /add up to 34999999 lovelace, and the UTxOs it spends held 35000000/);
});

// ---- ADA ----------------------------------------------------------------------------------------

test("ADA is written without trailing zeros and read back", () => {
  assert.equal(formatAda(5_000_000n), "5 ADA");
  assert.equal(formatAda(969_750n), "0.96975 ADA");
  assert.equal(formatAda(1_000_001n), "1.000001 ADA");
  assert.equal(formatAda(0n), "0 ADA");
  assert.equal(parseAda("5"), 5_000_000n);
  assert.equal(parseAda("2.5"), 2_500_000n);
  assert.equal(parseAda("0.000001"), 1n);
  for (const bad of ["", "-1", "1e3", "1.1234567", ".5", "5.", "5 ADA", "0x10"]) assert.equal(parseAda(bad), undefined, bad);
});

test("the layout is one line", () => {
  assert.equal(describeLayout([]), "no UTxOs");
  assert.equal(
    describeLayout([utxo(3n * ADA, { [USDM]: 1n }), utxo(40n * ADA, { [USDM]: 1n }), utxo(2n * ADA), utxo(4n * ADA)]),
    "4 UTxOs holding 49 ADA: 2 with tokens (43 ADA between them), 2 ADA-only (largest 4 ADA)",
  );
  assert.equal(describeLayout([utxo(ADA)]), "1 UTxO holding 1 ADA: none with tokens, 1 ADA-only (largest 1 ADA)");
  assert.equal(describeLayout([utxo(ADA, { [USDM]: 1n })]), "1 UTxO holding 1 ADA: 1 with tokens (1 ADA between them), none ADA-only");
});

// ---- the ADA-only ADA, and whether a tidy would add to it -----------------------------------------

test("the ADA-only ADA now is what the UTxOs without tokens hold, and a quantity of nothing is not a token", () => {
  assert.equal(adaOnlyLovelace([]), 0n);
  assert.equal(adaOnlyLovelace([utxo(44n * ADA, { [USDM]: 1n }), utxo(3n * ADA), utxo(2n * ADA, { [OTHER]: 0n })]), 5n * ADA);
  assert.equal(adaOnlyLovelace([utxo(9n * ADA, { [USDM]: 1n })]), 0n);
});

test("the ADA-only ADA after is everything less the tokens' min-ADA and the fee at its ceiling", () => {
  const folded = work(tidyPlan([utxo(44n * ADA, { [USDM]: 1n }), utxo(1_500_000n)], opts));
  // 45.5 in all, 1.2 for the tokens, 1 for the fee.
  assert.equal(adaOnlyLovelaceAfter(folded), 45_500_000n - 1_200_000n - TIDY_FEE_MAX);
  // No tokens, no min-ADA to keep back.
  const plain = work(tidyPlan([utxo(3n * ADA), utxo(3n * ADA), utxo(3n * ADA)], opts));
  assert.equal(adaOnlyLovelaceAfter(plain), 9n * ADA - TIDY_FEE_MAX);
});

// ---- autoTidyDecision -----------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const TEN_MINUTES = 600_000;
/** A wallet that decides on its own listing: the plan is made from the same UTxOs it is given. */
const decide = (utxos: Utxo[], over: Partial<AutoTidyInput> = {}) =>
  autoTidyDecision({ enabled: true, tidyInFlight: false, now: NOW, lastAutoTidyAt: undefined, minIntervalMs: TEN_MINUTES, plan: tidyPlan(utxos, opts), utxos, ...over });
/** Every ADA in the one token UTxO, which is what a run of `exact` payments leaves. */
const folded = () => [utxo(44n * ADA, { [USDM]: 1n }), utxo(1_500_000n)];

test("a wallet whose ADA is folded into its tokens is worth a tidy, and the reason has the numbers", () => {
  const d = decide(folded());
  assert.equal(d.tidy, true);
  assert.match(d.why, /ADA-only UTxOs hold 1.5 ADA now and would hold 43.3 ADA after a tidy, its fee counted at 1 ADA/);
  assert.match(d.why, /holds 44 ADA, more than the 1.2 ADA they need/);
});

test("switched off, it says so, whatever else is true", () => {
  assert.deepEqual(decide(folded(), { enabled: false }), { tidy: false, why: AUTO_TIDY_OFF });
  assert.match(AUTO_TIDY_OFF, /AUTO_TIDY=0/);
  // The switch is the first thing asked: a tidy in flight and a recent one do not change the answer.
  assert.deepEqual(decide(folded(), { enabled: false, tidyInFlight: true, lastAutoTidyAt: NOW }), { tidy: false, why: AUTO_TIDY_OFF });
});

test("one already running is not started twice", () => {
  const d = decide(folded(), { tidyInFlight: true });
  assert.deepEqual(d, { tidy: false, why: "an automatic tidy is already running" });
  // ...and that is said before the interval is.
  assert.match(decide(folded(), { tidyInFlight: true, lastAutoTidyAt: NOW - 1000 }).why, /already running/);
});

test("not more than one in the interval, and the interval's own edge is the first moment it may", () => {
  const at = (ago: number, minIntervalMs = TEN_MINUTES) => decide(folded(), { lastAutoTidyAt: NOW - ago, minIntervalMs });
  assert.equal(at(0).tidy, false);
  const blocked = at(TEN_MINUTES - 1);
  assert.equal(blocked.tidy, false);
  assert.equal(blocked.why, "tidied 9 minutes ago; at most one automatic tidy every 10 minutes");
  assert.equal(at(TEN_MINUTES).tidy, true);
  assert.equal(at(TEN_MINUTES + 1).tidy, true);
  // The shortest interval signerd accepts is a minute, and the same edge holds there.
  assert.equal(at(59_999, 60_000).why, "tidied 59 seconds ago; at most one automatic tidy every 60 seconds");
  assert.equal(at(60_000, 60_000).tidy, true);
  assert.equal(decide(folded(), { lastAutoTidyAt: undefined }).tidy, true);
});

test("a last tidy dated in the future is a clock that went back, and does not block", () => {
  assert.equal(decide(folded(), { lastAutoTidyAt: NOW + 5 * TEN_MINUTES }).tidy, true);
});

test("a wallet whose UTxOs are not settled is not tidied from a listing that cannot be trusted", () => {
  const d = decide(folded(), { unsettled: "utxo abc#0 is committed to a payment or a channel step that has not settled" });
  assert.equal(d.tidy, false);
  assert.match(d.why, /not settled yet.*utxo abc#0 is committed/);
  // The interval is asked before it, and the plan after.
  assert.match(decide(folded(), { unsettled: "x", lastAutoTidyAt: NOW - 1 }).why, /^tidied 0 seconds ago/);
});

test("a tidy the wallet cannot afford is not tried, and the refusal is the reason", () => {
  // 2 + 3 ADA: the layout needs 5 collateral, 1.2 for the tokens, a fee and change.
  const d = decide([utxo(2n * ADA, { [USDM]: 1n }), utxo(3n * ADA)]);
  assert.equal(d.tidy, false);
  assert.match(d.why, /^a tidy is not possible: the wallet holds 5 ADA in all, and the layout needs at least 8.2 ADA/);
  assert.match(decide([]).why, /a tidy is not possible: the wallet holds no UTxOs/);
});

test("a wallet already in shape has nothing a tidy would fix, so the shortage is real", () => {
  const d = decide([utxo(1_400_000n, { [USDM]: 1n }), utxo(8n * ADA)]);
  assert.equal(d.tidy, false);
  assert.match(d.why, /^the wallet is already tidy: /);
  assert.match(d.why, /ADA-only UTxO of 8 ADA/);
});

test("ADA-only UTxOs that are merely small gain nothing from a tidy, which only pays a fee", () => {
  const d = decide([utxo(4n * ADA), utxo(4n * ADA), utxo(4n * ADA), utxo(4n * ADA)]);
  assert.equal(d.tidy, false);
  assert.match(d.why, /would free no ADA for channel steps: the ADA-only UTxOs hold 16 ADA now and would hold 15 ADA after a tidy/);
});

test("it is worth a tidy only when the ADA-only ADA would be larger after it, to the lovelace", () => {
  // Tokens in two UTxOs: gathering them frees what they hold beyond the 1.2 ADA one output needs, and the
  // fee ceiling is 1 ADA, so the two must hold more than 2.2 ADA together for the tidy to add anything.
  const wallet = (held: bigint) => [utxo(1_200_000n, { [USDM]: 1n }), utxo(held - 1_200_000n, { [USDM]: 1n }), utxo(9n * ADA)];
  const even = decide(wallet(2_200_000n));
  assert.equal(even.tidy, false);
  assert.match(even.why, /hold 9 ADA now and would hold 9 ADA after/);
  const better = decide(wallet(2_200_001n));
  assert.equal(better.tidy, true);
  assert.match(better.why, /hold 9 ADA now and would hold 9.000001 ADA after/);
  assert.equal(decide(wallet(2_199_999n)).tidy, false);
});

test("a duration is said in the unit that reads best", () => {
  assert.equal(formatDuration(0), "0 seconds");
  assert.equal(formatDuration(1000), "1 second");
  assert.equal(formatDuration(119_999), "119 seconds");
  assert.equal(formatDuration(120_000), "2 minutes");
  assert.equal(formatDuration(TEN_MINUTES), "10 minutes");
  assert.equal(formatDuration(7_199_999), "119 minutes");
  assert.equal(formatDuration(7_200_000), "2 hours");
});
