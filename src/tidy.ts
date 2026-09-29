/**
 * The layout of the wallet's UTxOs that batch-settlement needs, and the one transaction that puts
 * it right. Pure logic: no chain, no keys, no I/O.
 *
 * Two builders spend this wallet's UTxOs and neither knows what the other needs. An `exact`
 * payment (@x402/cardano) spends the oldest UTxO as its nonce, lets the SDK add more largest-first,
 * and merges every token and the leftover ADA into one change output. A batch-settlement channel
 * transaction (subbit-x402) puts up collateral from an ADA-only UTxO and refuses to build when that
 * would leave the wallet none. So a few `exact` payments can fold all of the wallet's ADA into
 * UTxOs that carry tokens, and a channel step then fails `insufficient_funds` while the wallet
 * holds plenty.
 *
 * `tidyPlan` decides whether the wallet needs fixing and how: spend everything, put every token in
 * one output with only its min-ADA, one ADA-only output of the collateral size, and the rest as
 * ADA-only change. `tidyProblem` is the check on the built transaction before it is submitted, as
 * verifyTx.ts and channelTx.ts are for a payment and a channel step: the plan decided what should
 * happen, a builder made a transaction from it, and until here nothing looked at what came back.
 *
 * The ledger's min-ADA for an output depends on the protocol parameters and on the size of the
 * output as serialized, which this module cannot know, so `tidyPlan` is given a function for it
 * rather than a guess.
 */

/** A UTxO as this module sees it. `assets` is `<policy56hex>.<nameHex>` to quantity, as @x402/cardano decodes them. */
export interface Utxo {
  /** `txHash#index` */
  ref: string;
  lovelace: bigint;
  assets: Record<string, bigint>;
}

/** What an ADA-only UTxO must hold, at least, to be worth a channel step's collateral. */
export const DEFAULT_COLLATERAL = 5_000_000n;
/**
 * subbit-x402's `collateralTarget` asks for 5 ADA at most, so a larger UTxO buys nothing, and
 * keeps at least 1 ADA back as change, so under 2 ADA leaves the collateral too thin to trust.
 */
export const COLLATERAL_FLOOR = 2_000_000n;
export const COLLATERAL_CEILING = 5_000_000n;
export const DEFAULT_MAX_INPUTS = 60;
/** A tidy transaction of 60 inputs costs about 0.3 ADA; three times that is a builder gone wrong. */
export const TIDY_FEE_MAX = 1_000_000n;
/**
 * How much more than its tokens' min-ADA the UTxO that holds them may carry and still be tidy.
 * ADA beyond that is ADA a channel step cannot use as collateral.
 */
export const TOKEN_SLACK = 1_000_000n;
/** An ADA-only output's min-UTxO is about 0.97 ADA, so change of less than this cannot be paid. */
const CHANGE_MIN = 1_000_000n;

export interface TidyOptions {
  /** Default 5 ADA; between 2 and 5. */
  collateralLovelace?: bigint;
  /** Default 60. */
  maxInputs?: number;
  /** The least ADA an output at the wallet's address may hold with exactly these tokens in it. */
  minAda: (tokens: Readonly<Record<string, bigint>>) => bigint;
}

/** What tidying would do. Everything the transaction has to be checked against is in it. */
export interface TidyWork {
  tidy: false;
  /** Every UTxO the wallet holds: all of them are spent. */
  inputs: string[];
  /** Every token the wallet holds, and so what the one token output must hold. */
  tokens: Record<string, bigint>;
  collateralLovelace: bigint;
  /** The min-ADA of the token output, as `minAda` gave it; zero when there are no tokens. */
  tokenMinAda: bigint;
  /** What the inputs hold together. */
  totalLovelace: bigint;
  /** What is wrong with the layout now. */
  why: string;
}
export type TidyPlan = { tidy: true; why: string } | { tidy: false; refused: string } | TidyWork;

export function collateralProblem(collateral: bigint): string | undefined {
  if (collateral < COLLATERAL_FLOOR) return `collateral of ${formatAda(collateral)} is under the ${formatAda(COLLATERAL_FLOOR)} a channel step needs`;
  if (collateral > COLLATERAL_CEILING) return `collateral of ${formatAda(collateral)} is more than the ${formatAda(COLLATERAL_CEILING)} a channel step ever puts up, so a larger UTxO buys nothing`;
  return undefined;
}

const key = (asset: string) => asset.toLowerCase();
/** Zero is not a token: a quantity of nothing takes no space in an output and holds none. */
const tokensOf = (assets: Record<string, bigint> | undefined): Array<[string, bigint]> =>
  Object.entries(assets ?? {}).flatMap(([a, q]) => (q > 0n ? [[key(a), q] as [string, bigint]] : []));
const carriesTokens = (u: Utxo) => tokensOf(u.assets).length > 0;
const sum = (xs: Iterable<bigint>) => [...xs].reduce((t, x) => t + x, 0n);

/**
 * Whether the wallet needs tidying, and if so what to do. Tidy means all of: at most one UTxO
 * holds tokens, it holds no more than its tokens' min-ADA and 1 ADA, and one ADA-only UTxO holds
 * at least the collateral. Otherwise every UTxO is spent into the layout described above.
 * Refuses, with the reason, what one transaction cannot do.
 */
export function tidyPlan(utxos: readonly Utxo[], o: TidyOptions): TidyPlan {
  const collateral = o.collateralLovelace ?? DEFAULT_COLLATERAL;
  const maxInputs = o.maxInputs ?? DEFAULT_MAX_INPUTS;
  const bad = collateralProblem(collateral);
  if (bad) return { tidy: false, refused: bad };
  if (!Number.isInteger(maxInputs) || maxInputs < 1) return { tidy: false, refused: `maxInputs must be a positive whole number, got ${maxInputs}` };
  if (utxos.length === 0) return { tidy: false, refused: "the wallet holds no UTxOs" };

  const carrying = utxos.filter(carriesTokens);
  const adaOnly = utxos.filter(u => !carriesTokens(u));
  const tokens: Record<string, bigint> = {};
  for (const u of carrying) for (const [a, q] of tokensOf(u.assets)) tokens[a] = (tokens[a] ?? 0n) + q;
  const tokenMin = carrying.length > 0 ? o.minAda(tokens) : 0n;
  const total = sum(utxos.map(u => u.lovelace));
  const largest = adaOnly.reduce<bigint | undefined>((m, u) => (m === undefined || u.lovelace > m ? u.lovelace : m), undefined);

  const problems: string[] = [];
  if (carrying.length > 1) {
    problems.push(`the tokens are spread over ${carrying.length} UTxOs`);
  } else if (carrying.length === 1 && carrying[0].lovelace > tokenMin + TOKEN_SLACK) {
    // With one carrying UTxO its tokens are all of them, so `tokenMin` is its min-ADA.
    problems.push(`the UTxO with the tokens holds ${formatAda(carrying[0].lovelace)}, more than the ${formatAda(tokenMin)} they need and ${formatAda(TOKEN_SLACK)} to spare`);
  }
  if (largest === undefined) problems.push("no UTxO is ADA-only");
  else if (largest < collateral) problems.push(`the largest ADA-only UTxO holds ${formatAda(largest)}, under the ${formatAda(collateral)} of collateral`);

  if (problems.length === 0)
    return {
      tidy: true,
      why: carrying.length === 0
        ? `no UTxO carries tokens, and an ADA-only UTxO of ${formatAda(largest!)} can put up the ${formatAda(collateral)} of collateral`
        : `the tokens are in one UTxO of ${formatAda(carrying[0].lovelace)} (its min-ADA is about ${formatAda(tokenMin)}), and an ADA-only UTxO of ${formatAda(largest!)} can put up the ${formatAda(collateral)} of collateral`,
    };

  if (utxos.length > maxInputs)
    return { tidy: false, refused: `the wallet holds ${utxos.length} UTxOs, more than the ${maxInputs} one transaction will spend; spend some of the small ones by hand first (${problems.join("; ")})` };
  const need = collateral + tokenMin + TIDY_FEE_MAX + CHANGE_MIN;
  if (total < need)
    return {
      tidy: false,
      refused:
        `the wallet holds ${formatAda(total)} in all, and the layout needs at least ${formatAda(need)}: ${formatAda(collateral)} of collateral, ` +
        `${tokenMin > 0n ? `${formatAda(tokenMin)} for the tokens, ` : ""}up to ${formatAda(TIDY_FEE_MAX)} of fee and ${formatAda(CHANGE_MIN)} of change (${problems.join("; ")})`,
    };

  return {
    tidy: false,
    inputs: utxos.map(u => u.ref),
    tokens,
    collateralLovelace: collateral,
    tokenMinAda: tokenMin,
    totalLovelace: total,
    why: problems.join("; "),
  };
}

/** The shape of `decodeCardanoTransaction`'s answer that the check reads, so this module need not import the SDK. */
export interface DecodedTx {
  inputs: string[];
  outputs: Array<{ address: string; coin: bigint; assets?: Record<string, bigint> }>;
  fee: bigint;
  balanceChangingOperations: string[];
  redeemerCount: number;
  scriptWitnessCount: number;
}

/**
 * Whether the built, signed transaction is the plan and nothing else. The plan is the operator's
 * request and this wallet's own listing of its UTxOs; what came out of the builder is neither, and
 * every output that is not to this wallet is money gone. Returns the reason it is not, or undefined.
 */
export function tidyProblem(tx: DecodedTx, plan: TidyWork, ownAddress: string): string | undefined {
  const planned = new Set(plan.inputs);
  const spent = new Set(tx.inputs);
  const extra = tx.inputs.filter(i => !planned.has(i));
  if (extra.length) return `it spends ${extra.length} UTxO(s) the plan does not: ${extra.slice(0, 3).join(", ")}`;
  const missing = plan.inputs.filter(i => !spent.has(i));
  if (missing.length) return `it leaves ${missing.length} of the plan's ${plan.inputs.length} UTxOs unspent`;
  if (tx.inputs.length !== spent.size) return "it names the same input twice";

  if (tx.balanceChangingOperations.length) return `it carries ${tx.balanceChangingOperations.join(", ")}, which a tidy has no use for`;
  if (tx.redeemerCount !== 0 || tx.scriptWitnessCount !== 0) return "it runs a script";
  const strangers = [...new Set(tx.outputs.filter(o => o.address !== ownAddress).map(o => o.address))];
  if (strangers.length) return `it pays ${strangers.length} address(es) that are not this wallet: ${strangers.join(", ")}`;
  if (tx.fee > TIDY_FEE_MAX) return `its fee is ${tx.fee} lovelace, more than the ${TIDY_FEE_MAX} a tidy needs`;

  // Every token that went in comes out, no more and no less.
  const out: Record<string, bigint> = {};
  for (const o of tx.outputs) for (const [a, q] of tokensOf(o.assets)) out[a] = (out[a] ?? 0n) + q;
  const want: Record<string, bigint> = {};
  for (const [a, q] of tokensOf(plan.tokens)) want[a] = q;
  for (const a of new Set([...Object.keys(want), ...Object.keys(out)])) {
    if ((want[a] ?? 0n) !== (out[a] ?? 0n)) return `its outputs hold ${out[a] ?? 0n} of ${a}, and the inputs hold ${want[a] ?? 0n}`;
  }

  // One output holds them all, and only its min-ADA: that is what makes the rest of the ADA usable.
  const holders = tx.outputs.filter(o => tokensOf(o.assets).length > 0);
  const expected = Object.keys(want).length > 0 ? 1 : 0;
  if (holders.length !== expected) return `expected ${expected} output(s) with tokens, found ${holders.length}`;
  if (holders.length === 1 && holders[0].coin > plan.tokenMinAda + TOKEN_SLACK)
    return `its token output holds ${formatAda(holders[0].coin)}, more than the ${formatAda(plan.tokenMinAda)} the tokens need and ${formatAda(TOKEN_SLACK)} to spare`;
  if (!tx.outputs.some(o => tokensOf(o.assets).length === 0 && o.coin === plan.collateralLovelace))
    return `it has no ADA-only output of exactly ${formatAda(plan.collateralLovelace)}`;

  // The ledger enforces this too; a transaction that breaks it was built from something other than
  // the UTxOs the plan counted.
  const paid = sum(tx.outputs.map(o => o.coin)) + tx.fee;
  if (paid !== plan.totalLovelace) return `its outputs and fee add up to ${paid} lovelace, and the UTxOs it spends held ${plan.totalLovelace}`;
  return undefined;
}

/** `1.5 ADA`, `5 ADA`, `0.969750 ADA` without the trailing zeros. */
export function formatAda(lovelace: bigint): string {
  const frac = (lovelace % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${lovelace / 1_000_000n}${frac ? `.${frac}` : ""} ADA`;
}

/** ADA as an operator types it, `5` or `2.5`, in lovelace; undefined for anything else. */
export function parseAda(text: string): bigint | undefined {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  return m ? BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0")) : undefined;
}

/** One line on what the wallet holds and where, for the operator deciding whether to tidy. */
export function describeLayout(utxos: readonly Utxo[]): string {
  if (utxos.length === 0) return "no UTxOs";
  const carrying = utxos.filter(carriesTokens);
  const adaOnly = utxos.filter(u => !carriesTokens(u));
  const largest = adaOnly.reduce((m, u) => (u.lovelace > m ? u.lovelace : m), 0n);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    `${plural(utxos.length, "UTxO", "UTxOs")} holding ${formatAda(sum(utxos.map(u => u.lovelace)))}: ` +
    (carrying.length ? `${carrying.length} with tokens (${formatAda(sum(carrying.map(u => u.lovelace)))} between them)` : "none with tokens") +
    (adaOnly.length ? `, ${adaOnly.length} ADA-only (largest ${formatAda(largest)})` : ", none ADA-only")
  );
}
