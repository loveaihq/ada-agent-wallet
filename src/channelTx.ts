/**
 * Checking a batch-settlement channel transaction before it leaves signerd, as verifyTx.ts does
 * for `exact`, and for the same reason: the policy decided on a request, a builder made a
 * transaction from it, and until here nothing had looked at what came back.
 *
 * Two questions, answered apart. `stepProblem` asks whether the transaction is the channel step it
 * claims to be — the datum, the redeemer, the amount — with subbit-x402's own checks where it has
 * them; that is the seller's side of the question. `summaryProblem` is the buyer's side, which no
 * seller has a reason to ask: every output that is not the channel or the seller's refund comes
 * back to this wallet, the fee and the collateral stay small, and nothing else happens in it.
 * `summaryProblem` is pure logic over `TxSummary`, so it is tested without a chain.
 */
import { Address, Assets, Data, InlineDatum, KeyHash, type Transaction } from "@evolution-sdk/evolution";
import type { ClientChannel } from "subbit-x402/x402/client";
import { Redeemer, Step, parseDatum } from "subbit-x402/subbit";
import { isChannelOutput, type ChannelView } from "subbit-x402/x402/cardano";
import { checkDeposit, checkTopUp, decodeTx, sortedInputRefs, spendRedeemers, witnessKeyHashes } from "subbit-x402/x402/txcheck";

/** A channel step's fee is about 0.2 ADA; ten times that is a builder gone wrong, not a busy chain. */
export const FEE_MAX = 2_000_000n;
/** subbit-x402's client never asks for more than this (`collateralTarget`). */
export const COLLATERAL_MAX = 5_000_000n;

export type ChannelStep = "open" | "topUp" | "refund" | "close" | "end" | "elapse";

export interface TxSummary {
  fee: bigint;
  outputs: Array<{ address: string; lovelace: bigint; tokens: boolean; atValidator: boolean }>;
  /** Present when the transaction puts up collateral. */
  collateral?: { total?: bigint; returnTo?: string };
  /** Certificates, withdrawals, minting or governance: none of which a channel step needs. */
  extras: boolean;
}

export function summarize(tx: Transaction.Transaction, scriptHash: string): TxSummary {
  const b = tx.body;
  return {
    fee: b.fee,
    outputs: b.outputs.map(o => ({
      address: Address.toBech32(o.address),
      lovelace: Assets.lovelaceOf(o.assets),
      tokens: !Assets.hasOnlyLovelace(o.assets),
      atValidator: isChannelOutput(o.address, scriptHash),
    })),
    ...(b.collateralInputs?.length
      ? {
          collateral: {
            ...(b.totalCollateral !== undefined ? { total: b.totalCollateral } : {}),
            ...(b.collateralReturn ? { returnTo: Address.toBech32(b.collateralReturn.address) } : {}),
          },
        }
      : {}),
    extras: Boolean(b.certificates || b.withdrawals || b.mint || b.votingProcedures || b.proposalProcedures || b.donation || b.currentTreasuryValue),
  };
}

/**
 * Where the money in a channel step goes. Returns the reason it is wrong, or undefined.
 * `payTo` and `maxPayout` are a refund's: the seller's address and the most it may be paid.
 */
export function summaryProblem(step: ChannelStep, s: TxSummary, want: { wallet: string; payTo?: string; maxPayout?: bigint }): string | undefined {
  if (s.extras) return "it carries certificates, withdrawals, minting or governance actions";
  if (s.fee > FEE_MAX) return `its fee is ${s.fee} lovelace, more than the ${FEE_MAX} any channel step needs`;
  if (s.collateral) {
    if (step === "open") return "an opening runs no script, so it has no collateral to put up";
    // Without the total, what is at stake is the whole of every collateral input.
    if (s.collateral.total === undefined) return "it puts up collateral without stating how much";
    if (s.collateral.total > COLLATERAL_MAX) return `it puts up ${s.collateral.total} lovelace of collateral, more than ${COLLATERAL_MAX}`;
    if (s.collateral.returnTo !== undefined && s.collateral.returnTo !== want.wallet) return "its collateral return goes to another address";
  }
  const atValidator = s.outputs.filter(o => o.atValidator).length;
  const keepsChannel = step === "open" || step === "topUp" || step === "close";
  if (keepsChannel && atValidator !== 1) return `expected one output at the validator, found ${atValidator}`;
  if (!keepsChannel && atValidator !== 0) return `expected nothing left at the validator, found ${atValidator} output(s)`;

  let paid = 0n;
  const strangers = new Set<string>();
  for (const o of s.outputs) {
    if (o.atValidator || o.address === want.wallet) continue;
    if (step === "refund" && want.payTo !== undefined && o.address === want.payTo) {
      // A token channel's refund pays the seller nothing (it claims first), so any share is ADA.
      if (o.tokens) return "its payment to the seller carries tokens";
      paid += o.lovelace;
      continue;
    }
    strangers.add(o.address);
  }
  if (strangers.size) return `it pays ${strangers.size} address(es) that are neither the channel nor this wallet: ${[...strangers].join(", ")}`;
  const most = want.maxPayout ?? 0n;
  if (paid > most) return `it pays the seller ${paid}, more than the ${most} signed for and not yet redeemed`;
  return undefined;
}

export interface StepContext {
  network: string;
  scriptHash: string;
  /** This wallet's payment key hash: the channel's consumer. */
  consumer: string;
  coinsPerUtxoByte: bigint;
}

/**
 * Whether `hex` is the channel step it is said to be. `amount` is what an opening puts in the
 * channel output, or what a top-up adds. Returns the reason it is not, or undefined.
 */
export function stepProblem(
  step: ChannelStep,
  hex: string,
  c: StepContext,
  on: { channel: ClientChannel; view?: ChannelView; amount?: bigint },
): string | undefined {
  const ch = on.channel;
  try {
    switch (step) {
      case "open":
        checkDeposit(hex, c.network, ch.channelConfig, ch.channelId, c.scriptHash, on.amount!, c.coinsPerUtxoByte);
        return undefined;
      case "topUp":
        checkTopUp(hex, c.network, on.view!, on.amount!, c.coinsPerUtxoByte);
        return undefined;
    }
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }

  const view = on.view!;
  const tx = decodeTx(hex, "channel");
  const inputs = sortedInputRefs(tx);
  const at = inputs.indexOf(view.ref);
  if (at < 0) return "it does not spend the channel where it stands";
  const redeemers = spendRedeemers(tx);
  if (redeemers.size !== 1 || !redeemers.has(at)) return "it redeems something besides the channel";
  const want = { refund: Redeemer.mutual(), close: Redeemer.main([Step.close()]), end: Redeemer.main([Step.end()]), elapse: Redeemer.main([Step.elapse()]) }[step];
  if (Data.toCBORHex(redeemers.get(at)!) !== Data.toCBORHex(want)) return `the channel is not spent as a ${step}`;
  if (!witnessKeyHashes(tx).has(c.consumer)) return "this wallet's key has not signed it";

  if (step === "refund") {
    // Mutual needs both keys, and nothing but the channel may ride on the provider's signature.
    if (inputs.length !== 1) return "a refund spends the channel and nothing else";
    const signers = (tx.body.requiredSigners ?? []).map(k => KeyHash.toHex(k)).sort();
    const both = [c.consumer, view.datum.constants.provider].sort();
    if (signers.length !== 2 || signers[0] !== both[0] || signers[1] !== both[1]) return "a refund's required signers are this wallet and the provider, exactly";
    return undefined;
  }
  if (step !== "close") return undefined;

  // A close puts the channel back unchanged but for its stage.
  const outs = tx.body.outputs.filter(o => isChannelOutput(o.address, c.scriptHash));
  if (outs.length !== 1) return `expected one output at the validator, found ${outs.length}`;
  const o = outs[0]!;
  if (Address.toBech32(o.address) !== Address.toBech32(view.address)) return "the channel does not keep its address";
  const units = (a: Assets.Assets) => JSON.stringify(Assets.getUnits(a).sort().map(u => [u, Assets.getByUnit(a, u).toString()]));
  if (units(o.assets) !== units(view.utxo.assets)) return "the channel's value changes";
  if (!(o.datumOption instanceof InlineDatum.InlineDatum)) return "the channel's datum is not inline";
  let d;
  try {
    d = parseDatum(o.datumOption.data);
  } catch (e) {
    return `the channel's datum: ${e instanceof Error ? e.message : e}`;
  }
  const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
  if (JSON.stringify(d.constants, big) !== JSON.stringify(view.datum.constants, big) || d.ownHash !== view.datum.ownHash) return "the channel's terms change";
  if (d.stage.kind !== "closed" || view.datum.stage.kind !== "opened" || d.stage.subbed !== view.datum.stage.subbed) return "a close moves the channel from open to closed and nothing else";
  return undefined;
}
