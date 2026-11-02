/**
 * The real signerd, started for each case against a fake chain provider on 127.0.0.1, with a public
 * test mnemonic and a throwaway directory of its own. What these check is the wiring the unit tests
 * cannot: that the limits are read from the environment, applied between the build and the nonce,
 * recorded where the cap is computed from, and rebuilt after a restart.
 *
 * Nothing leaves the machine and nothing is submitted (see helpers/signerd.ts and localOnly.mjs).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decodeCardanoTransaction } from "@x402/cardano";
import { fakeKoios, HONEST, TUSDM } from "./helpers/fakeKoios.ts";
import { AGENT_TOKEN, PAYEE_MNEMONIC, addressOn, cleanUp, exitCode, signRequest, startSignerd, type Running } from "./helpers/signerd.ts";




const fakes: Array<Awaited<ReturnType<typeof fakeKoios>>> = [];
const fake = async (...a: Parameters<typeof fakeKoios>) => {
  const f = await fakeKoios(...a);
  fakes.push(f);
  return f;
};
after(async () => {
  await cleanUp();
  await Promise.all(fakes.map(f => f.close()));
});

/** 32 characters, the least mainnet accepts: what `openssl rand -hex 16` prints. */
const TOKEN_32 = "ab".repeat(16);
const MAINNET_AGENT = "cd".repeat(20);
const events = (s: Running, name: string) => s.audit().filter(e => e.event === name);
const lovelaceSpent = async (s: Running, agent: string, token?: string) =>
  BigInt((await s.call("/status", { token })).data.agents[agent].assets.lovelace.dailySpent);

const mainnetPolicy = {
  network: "cardano:mainnet",
  agents: {
    tokens: { perTxMax: { [TUSDM]: "10" }, allowedPayees: ["*"] },
    capped: {
      perTxMax: { [TUSDM]: "10", lovelace: "2000000" },
      dailyMax: { [TUSDM]: "100", lovelace: "10000000" },
      approvalAbove: { [TUSDM]: "1" },
      allowedPayees: ["*"],
    },
  },
};
const mainnetOpts = (koios: string) => ({
  network: "cardano:mainnet",
  koios,
  policy: mainnetPolicy,
  agentTokens: { [MAINNET_AGENT]: "capped", [AGENT_TOKEN]: "tokens" },
  operatorToken: TOKEN_32,
});


// ---- the preview wallet most of the payment tests share, started now so that its startup overlaps the others

const previewPolicy = {
  network: "cardano:preview",
  agents: {
    // Token payments with lovelace caps: 2 ADA a payment, 3 ADA a day.
    capped: { perTxMax: { [TUSDM]: "5", lovelace: "2000000" }, dailyMax: { lovelace: "3000000" }, allowedPayees: ["*"] },
    // Token payments with none.
    bare: { perTxMax: { [TUSDM]: "5" }, allowedPayees: ["*"] },
    // Lovelace payments.
    ada: { perTxMax: { lovelace: "5000000" }, dailyMax: { lovelace: "9000000" }, allowedPayees: ["*"] },
    scripted: { perTxMax: { [TUSDM]: "5", lovelace: "9000000" }, allowedPayees: ["*"], allowedAssetTransferMethods: ["default", "script"] },
    // A lovelace allowance smaller than what one token payment's fee and min-UTxO ADA come to.
    tight: { perTxMax: { [TUSDM]: "5", lovelace: "1000000" }, allowedPayees: ["*"] },
  },
};

const chain = await fake();
const payee = addressOn("cardano:preview", PAYEE_MNEMONIC);
const previewUp = startSignerd({ network: "cardano:preview", koios: chain.url, policy: previewPolicy });
previewUp.catch(() => {}); // reported where it is awaited
const pay = (s: Running, agentId: string, asset: string, amount: string, extra?: Record<string, unknown>) => {
  const body = signRequest({ network: "cardano:preview", payTo: payee, asset, amount, agentId });
  return s.call("/sign", { body: extra ? { ...body, input: { ...body.input, extra } } : body });
};
const decode = (tx: unknown) => decodeCardanoTransaction(tx as string);
const toPayee = (tx: ReturnType<typeof decode>) => tx.outputs.filter(o => o.address === payee).reduce((n, o) => n + o.coin, 0n);

// ---- 3. the agent must not hold the operator's token ----------------------------------------------

test("mainnet refuses to start in single-token mode, naming the file that fixes it", async () => {
  const f = await fake();
  const s = await startSignerd({ network: "cardano:mainnet", koios: f.url, policy: mainnetPolicy, operatorToken: TOKEN_32, wait: false });
  assert.equal(await exitCode(s), 1);
  assert.match(s.stderr(), /refusing to run on cardano:mainnet: AGENT_TOKENS_FILE is unset/);
  assert.match(s.stderr(), /approve them/);
  assert.deepEqual(s.audit(), [], "it stopped before it wrote anything");
});

test("preprod-like networks still start in single-token mode, with a warning that says what it costs", async () => {
  const f = await fake();
  const s = await startSignerd({ network: "cardano:preview", koios: f.url, policy: { network: "cardano:preview", agents: { a: { perTxMax: { lovelace: "5000000" }, allowedPayees: ["*"] } } } });
  assert.match(s.stderr(), /WARNING AGENT_TOKENS_FILE is unset.*approve them/);
  const checks = (await s.call("/preflight")).data.checks as Array<{ level: string; check: string; detail: string }>;
  const identity = checks.find(c => c.check === "agent identity")!;
  assert.equal(identity.level, "warn", "one agent is no longer enough to pass: the agent would still hold the operator's token");
  assert.match(identity.detail, /approve them/);
  await s.stop();
});

test("with agent tokens, the agent's token cannot read the queue or approve; the operator's can", async () => {
  const f = await fake();
  const s = await startSignerd(mainnetOpts(f.url));
  const payee = addressOn("cardano:mainnet", PAYEE_MNEMONIC);
  f.setUtxo(10);
  // Over approvalAbove (1), so it waits for a human; the agent's request stays open meanwhile.
  const queued = s.call("/sign", { token: MAINNET_AGENT, body: signRequest({ network: "cardano:mainnet", payTo: payee, asset: TUSDM, amount: "2" }) });
  let id: string | undefined;
  for (let i = 0; i < 120 && !id; i++) {
    id = ((await s.call("/pending")).data as unknown as Array<{ id: string }>)[0]?.id;
    if (!id) await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(id, "the payment is waiting on a human");

  const peek = await s.call("/pending", { token: MAINNET_AGENT });
  assert.equal(peek.status, 403);
  assert.equal(peek.data.error, "operator_only");
  const approve = await s.call("/approve", { token: MAINNET_AGENT, body: { id } });
  assert.equal(approve.status, 403);
  assert.equal(approve.data.error, "operator_only");
  assert.equal(((await s.call("/pending")).data as unknown as unknown[]).length, 1, "and it is still waiting");

  assert.equal((await s.call("/approve", { body: { id } })).status, 200);
  const done = await queued;
  assert.equal(done.status, 200);
  assert.ok(done.data.transaction);
  // The operator's token does not sign at all once there are agent tokens.
  const refused = await s.call("/sign", { body: signRequest({ network: "cardano:mainnet", payTo: payee, asset: TUSDM, amount: "1", agentId: "capped" }) });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.error, "operator_cannot_sign");
  // The approved payment is on the ledger once, not twice: its reservation became its spend.
  const tx = decodeCardanoTransaction(done.data.transaction as string);
  const status = (await s.call("/status")).data.agents.capped.assets;
  assert.equal(status[TUSDM].dailySpent, "2");
  assert.equal(BigInt(status.lovelace.dailySpent), tx.fee + tx.outputs.filter(o => o.address === payee).reduce((n, o) => n + o.coin, 0n));
});

// ---- 6. the operator token's length -------------------------------------------------------------

test("mainnet refuses an operator token shorter than 32 characters, and accepts exactly 32", async () => {
  const f = await fake();
  const short = await startSignerd({ ...mainnetOpts(f.url), operatorToken: "ab".repeat(15) + "c", wait: false });
  assert.equal(await exitCode(short), 1);
  assert.match(short.stderr(), /refusing to run on cardano:mainnet: SIGNERD_TOKEN is 31 characters; at least 32 are required/);
  // The token is not echoed.
  assert.ok(!short.stderr().includes("ab".repeat(15)));

  const exactly = await startSignerd(mainnetOpts(f.url));
  const checks = (await exactly.call("/preflight")).data.checks as Array<{ level: string; check: string; detail: string }>;
  assert.equal(checks.find(c => c.check === "operator token")?.level, "ok");
  assert.equal(checks.find(c => c.check === "agent identity")?.level, "ok");
  await exactly.stop();
});

test("a short operator token on preview starts, with a warning on stderr and in preflight", async () => {
  const f = await fake();
  const s = await startSignerd({
    network: "cardano:preview",
    koios: f.url,
    policy: { network: "cardano:preview", agents: { a: { perTxMax: { lovelace: "5000000" }, allowedPayees: ["*"] } } },
    operatorToken: "short-token-20-chars",
  });
  assert.match(s.stderr(), /WARNING SIGNERD_TOKEN is 20 characters; at least 32 are required/);
  const op = ((await s.call("/preflight")).data.checks as Array<{ level: string; check: string; detail: string }>).find(c => c.check === "operator token")!;
  assert.equal(op.level, "warn");
  await s.stop();
});

// ---- 5. secret files must be 0600 -------------------------------------------------------------

test("mainnet refuses an agent-tokens file others can read", async () => {
  const f = await fake();
  const s = await startSignerd({ ...mainnetOpts(f.url), tokensMode: 0o644, wait: false });
  assert.equal(await exitCode(s), 1);
  assert.match(s.stderr(), /refusing to run on cardano:mainnet: agent tokens .* is accessible to group or other \(mode 644\); a secret must be 0600/);
});

test("mainnet refuses a plaintext mnemonic file others can read, even read-only", async () => {
  const f = await fake();
  const s = await startSignerd({ ...mainnetOpts(f.url), mnemonicFileMode: 0o640, wait: false });
  assert.equal(await exitCode(s), 1);
  assert.match(s.stderr(), /refusing to run on cardano:mainnet: mnemonic .* is accessible to group or other \(mode 640\)/);
});

test("mainnet refuses a keystore and a passphrase file that others can read", async () => {
  const f = await fake();
  // The mode is checked before either is read, so what is in them does not matter here.
  const keystore = await startSignerd({
    ...mainnetOpts(f.url),
    files: [{ env: "WALLET_KEYSTORE_FILE", name: "keystore.json", content: "{}", mode: 0o644 }],
    wait: false,
  });
  assert.equal(await exitCode(keystore), 1);
  assert.match(keystore.stderr(), /keystore .* is accessible to group or other \(mode 644\)/);
  const passphrase = await startSignerd({
    ...mainnetOpts(f.url),
    files: [
      { env: "WALLET_KEYSTORE_FILE", name: "keystore.json", content: "{}", mode: 0o600 },
      { env: "WALLET_PASSPHRASE_FILE", name: "passphrase", content: "x", mode: 0o604 },
    ],
    wait: false,
  });
  assert.equal(await exitCode(passphrase), 1);
  assert.match(passphrase.stderr(), /passphrase .* is accessible to group or other \(mode 604\)/);
});

test("on preview the same files are a warning, and preflight carries it", async () => {
  const f = await fake();
  const s = await startSignerd({
    network: "cardano:preview",
    koios: f.url,
    policy: { network: "cardano:preview", agents: { a: { perTxMax: { lovelace: "5000000" }, allowedPayees: ["*"] } } },
    agentTokens: { [AGENT_TOKEN]: "a" },
    tokensMode: 0o644,
  });
  assert.match(s.stderr(), /WARNING agent tokens .* is accessible to group or other \(mode 644\)/);
  const perms = ((await s.call("/preflight")).data.checks as Array<{ level: string; check: string; detail: string }>).filter(c => c.check === "file permissions");
  assert.ok(perms.some(c => c.level === "warn" && /agent tokens .* \(mode 644\)/.test(c.detail)));
  await s.stop();
});

test("policy, audit and ledger keep the write-bit check: readable by others is fine, writable is not", async () => {
  const f = await fake();
  const readable = await startSignerd({ ...mainnetOpts(f.url), policyMode: 0o644 });
  assert.equal((await readable.call("/status")).status, 200, "a world-readable policy is allowed on mainnet");
  await readable.stop();
  const writable = await startSignerd({ ...mainnetOpts(f.url), policyMode: 0o664, wait: false });
  assert.equal(await exitCode(writable), 1);
  assert.match(writable.stderr(), /refusing to run on cardano:mainnet: policy .* is writable by group or other \(mode 664\)/);
});

// ---- 1 and 2. what a payment costs beyond its amount -----------------------------------------------


test("a provider that inflates min_fee_a gets no signature: the 34 ADA fee is refused before anything is claimed", async () => {
  const s = await previewUp;
  chain.setParameters({ minFeeA: HONEST.minFeeA * 2000, coinsPerUtxoByte: HONEST.coinsPerUtxoByte });
  const r = await pay(s, "capped", TUSDM, "1");
  assert.equal(r.status, 500);
  assert.match(String(r.data.detail), /refusing to hand over a transaction that does not match what was authorised: its fee is \d{8} lovelace, above the 1000000 allowed \(MAX_FEE_LOVELACE\)/);
  assert.equal(events(s, "signed").length, 0);
  const mismatch = events(s, "transaction_mismatch");
  assert.equal(mismatch.length, 1);
  assert.match(String(mismatch[0].fee), /^\d{8}$/);
  assert.equal(await lovelaceSpent(s, "capped"), 0n, "nothing was recorded");
});

test("a provider that inflates coins_per_utxo_size gets no signature: the 347 ADA to the payee is refused", async () => {
  const s = await previewUp;
  chain.setParameters({ minFeeA: HONEST.minFeeA, coinsPerUtxoByte: HONEST.coinsPerUtxoByte * 300 });
  const r = await pay(s, "capped", TUSDM, "1");
  assert.equal(r.status, 500);
  assert.match(String(r.data.detail), /it sends addr_test1\w+ 3\d{8} lovelace on top of the payment itself, above the 2000000 allowed \(MAX_RIDE_LOVELACE\)/);
  assert.equal(events(s, "signed").length, 0);
  assert.equal(events(s, "transaction_mismatch").length, 2);
  assert.equal(await lovelaceSpent(s, "capped"), 0n);
});

test("on honest parameters the same request signs, with the same UTxO: a refusal claims no nonce", async () => {
  const s = await previewUp;
  chain.setParameters(HONEST);
  const r = await pay(s, "capped", TUSDM, "1");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const tx = decode(r.data.transaction);
  assert.equal(tx.fee, 172_453n);
  assert.equal(toPayee(tx), 1_159_390n);
  // The ADA that left with a one-unit token payment: the fee and the min-UTxO ADA beside it.
  const overhead = tx.fee + toPayee(tx);
  assert.equal(await lovelaceSpent(s, "capped"), overhead);
  const signed = events(s, "signed");
  assert.equal(signed.length, 1);
  assert.equal(signed[0].overheadLovelace, overhead.toString());
  assert.equal(signed[0].fee, tx.fee.toString());
  // And it is one payment as far as the hourly rate goes.
  const status = (await s.call("/status")).data.agents.capped;
  assert.equal(status.paymentsLastHour, 1);
  assert.equal(status.assets[TUSDM].dailySpent, "1");
});

test("the overhead of later payments is spent against the daily lovelace cap, and the third is refused", async () => {
  const s = await previewUp;
  chain.setUtxo(2);
  const second = await pay(s, "capped", TUSDM, "1");
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(await lovelaceSpent(s, "capped"), 2n * 1_331_843n);

  chain.setUtxo(3);
  const third = await pay(s, "capped", TUSDM, "1"); // 2.66M spent + 1.33M > the 3M cap
  assert.equal(third.status, 403);
  assert.equal(third.data.error, "policy_denied");
  assert.equal(third.data.rule, "overhead_daily_max");
  assert.match(String(third.data.detail), /spent 2663686 \+ 1331843 \(1331843 of fee and min-UTxO ADA\) > dailyMax 3000000/);
  const denied = events(s, "denied").at(-1)!;
  assert.equal(denied.rule, "overhead_daily_max");
  assert.equal(denied.stage, "built");
  assert.equal(events(s, "signed").length, 2, "no third signature");
  assert.equal(await lovelaceSpent(s, "capped"), 2n * 1_331_843n, "and nothing recorded for it");
  // The token side of the budget is untouched by the refusal.
  assert.equal((await s.call("/status")).data.agents.capped.assets[TUSDM].dailySpent, "2");
});

test("a per-transaction lovelace cap smaller than the overhead refuses the payment", async () => {
  const s = await previewUp;
  chain.setUtxo(4);
  const r = await pay(s, "tight", TUSDM, "1");
  assert.equal(r.status, 403);
  assert.equal(r.data.rule, "overhead_per_tx_max");
  assert.match(String(r.data.detail), /1331843 lovelace leaves with this transaction \(1331843 of fee and min-UTxO ADA\) > perTxMax 1000000/);
  assert.equal(events(s, "signed").filter(e => e.agentId === "tight").length, 0);
});

test("on a network that is not mainnet, an agent with no lovelace caps pays in tokens as before, and the overhead is recorded", async () => {
  const s = await previewUp;
  chain.setUtxo(5);
  const r = await pay(s, "bare", TUSDM, "1");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const tx = decode(r.data.transaction);
  const signed = events(s, "signed").at(-1)!;
  assert.equal(signed.agentId, "bare");
  assert.equal(signed.overheadLovelace, (tx.fee + toPayee(tx)).toString());
  // It has no lovelace caps, so there is nothing in its budget for the ADA to show against.
  const assets = (await s.call("/status")).data.agents.bare.assets;
  assert.deepEqual(Object.keys(assets), [TUSDM]);
});

test("a lovelace payment is judged with its fee: a payment that fits the cap alone does not once the fee is added", async () => {
  const s = await previewUp;
  chain.setUtxo(6);
  const ok = await pay(s, "ada", "lovelace", "3000000");
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const tx = decode(ok.data.transaction);
  assert.equal(await lovelaceSpent(s, "ada"), 3_000_000n + tx.fee, "the payment and, beside it, its fee");

  chain.setUtxo(7);
  // 5 ADA is exactly perTxMax, which the policy let through; with the fee it is more than the cap.
  const over = await pay(s, "ada", "lovelace", "5000000");
  assert.equal(over.status, 403);
  assert.equal(over.data.rule, "overhead_per_tx_max");
  assert.match(String(over.data.detail), /5000000 payment \+ \d+ fee and min-UTxO ADA\) > perTxMax 5000000/);
});

test("a script payment's datum makes its output bigger than a plain token output, and is refused at the default limit", async () => {
  const s = await previewUp;
  chain.setUtxo(8);
  const datum = "9f" + "00".repeat(1000) + "ff"; // 1000 bytes of the seller's choosing
  const r = await pay(s, "scripted", TUSDM, "1", { assetTransferMethod: "script", datum });
  assert.equal(r.status, 500);
  assert.match(String(r.data.detail), /5\d{6} lovelace on top of the payment itself, above the 2000000 allowed \(MAX_RIDE_LOVELACE\)/);
});

test("preflight says what each new rule found", async () => {
  const s = await previewUp;
  const checks = (await s.call("/preflight")).data.checks as Array<{ level: string; check: string; detail: string }>;
  const by = (name: string) => checks.find(c => c.check === name);
  assert.equal(by("agent capped: lovelace caps for token payments")?.level, "ok");
  assert.equal(by("agent bare: lovelace caps for token payments")?.level, "warn", "preview is not mainnet");
  assert.match(by("agent bare: lovelace caps for token payments")!.detail, /declare lovelace caps/);
  assert.equal(by("agent ada: lovelace caps for token payments"), undefined, "an agent that pays no token has nothing to say");
  assert.equal(by("agent scripted: asset transfer methods")?.level, "warn");
  assert.match(by("agent scripted: asset transfer methods")!.detail, /script enabled.*MAX_RIDE_LOVELACE/);
  assert.equal(by("agent capped: asset transfer methods")?.level, "ok");
  assert.match(by("fee and ride bounds")!.detail, /1000000 lovelace of fee .*2000000 lovelace rides/);
});

test("the overhead is rebuilt from the audit log: a restart without the checkpoint counts the same ADA", async () => {
  const s = await previewUp;
  const before = { capped: await lovelaceSpent(s, "capped"), ada: await lovelaceSpent(s, "ada"), bare: (await s.call("/status")).data.agents.bare.assets };
  assert.ok(before.capped > 0n);
  await s.stop();
  // The cap is computed from the checkpoint, rebuilt from the log when it is gone.
  rmSync(join(s.dir, "ledger.json"));
  assert.ok(!existsSync(join(s.dir, "ledger.json")));
  const again = await startSignerd({ network: "cardano:preview", koios: chain.url, policy: previewPolicy, reuse: s.dir });
  assert.match(again.stderr(), /no ledger checkpoint yet; rebuilding the 24h window from the audit log/);
  assert.equal(await lovelaceSpent(again, "capped"), before.capped);
  assert.equal(await lovelaceSpent(again, "ada"), before.ada);
  assert.equal((await again.call("/status")).data.agents.capped.paymentsLastHour, 2, "two payments, not four records");
  // And a third token payment is still refused by the cap it was rebuilt into.
  chain.setUtxo(9);
  assert.equal((await pay(again, "capped", TUSDM, "1")).status, 403);
  await again.stop();
});

test("MAX_RIDE_LOVELACE and MAX_FEE_LOVELACE move the limits", async () => {
  const f = await fake();
  const s = await startSignerd({
    network: "cardano:preview",
    koios: f.url,
    policy: previewPolicy,
    env: { MAX_RIDE_LOVELACE: "6000000", MAX_FEE_LOVELACE: "300000" },
  });
  const datum = "9f" + "00".repeat(1000) + "ff";
  const r = await pay(s, "scripted", TUSDM, "1", { assetTransferMethod: "script", datum });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(toPayee(decode(r.data.transaction)) > 5_000_000n);
  // And the fee limit is the one in the environment, not the default.
  f.setParameters({ minFeeA: HONEST.minFeeA * 10, coinsPerUtxoByte: HONEST.coinsPerUtxoByte });
  f.setUtxo(2);
  const dear = await pay(s, "capped", TUSDM, "1");
  assert.equal(dear.status, 500);
  assert.match(String(dear.data.detail), /above the 300000 allowed \(MAX_FEE_LOVELACE\)/);
  await s.stop();
});

test("a limit that is not a number is refused at startup with a message, and a fee limit of nothing is not a limit", async () => {
  const f = await fake();
  const bad = await startSignerd({ ...mainnetOpts(f.url), env: { MAX_RIDE_LOVELACE: "2 ADA" }, wait: false });
  assert.equal(await exitCode(bad), 1);
  assert.match(bad.stderr(), /signerd: MAX_RIDE_LOVELACE must be a decimal integer of lovelace, got "2 ADA"/);
  const zero = await startSignerd({ ...mainnetOpts(f.url), env: { MAX_FEE_LOVELACE: "0" }, wait: false });
  assert.equal(await exitCode(zero), 1);
  assert.match(zero.stderr(), /signerd: MAX_FEE_LOVELACE must be at least 1/);
});

// ---- 2 on mainnet --------------------------------------------------------------------------------

test("mainnet refuses a token payment from an agent with no lovelace caps, with the reason, and accepts it with them", async () => {
  const f = await fake();
  const s = await startSignerd(mainnetOpts(f.url));
  const to = addressOn("cardano:mainnet", PAYEE_MNEMONIC);

  // AGENT_TOKEN is the `tokens` agent: token caps, no lovelace.
  const no = await s.call("/sign", { token: AGENT_TOKEN, body: signRequest({ network: "cardano:mainnet", payTo: to, asset: TUSDM, amount: "1" }) });
  assert.equal(no.status, 403);
  assert.equal(no.data.error, "policy_denied");
  assert.equal(no.data.rule, "lovelace_caps");
  assert.match(String(no.data.detail), /token payments also spend ADA \(fee \+ min-UTxO\); declare lovelace caps/);
  assert.equal(events(s, "signed").length, 0);
  assert.equal(events(s, "denied").length, 1);

  const yes = await s.call("/sign", { token: MAINNET_AGENT, body: signRequest({ network: "cardano:mainnet", payTo: to, asset: TUSDM, amount: "1" }) });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  const tx = decode(yes.data.transaction);
  assert.equal(await lovelaceSpent(s, "capped"), tx.fee + tx.outputs.filter(o => o.address === to).reduce((n, o) => n + o.coin, 0n));

  const checks = (await s.call("/preflight")).data.checks as Array<{ level: string; check: string; detail: string }>;
  const caps = (agent: string) => checks.find(c => c.check === `agent ${agent}: lovelace caps for token payments`)!;
  assert.equal(caps("tokens").level, "fail", "mainnet fails preflight for it");
  assert.match(caps("tokens").detail, /mainnet refuses its token payments until it does/);
  assert.equal(caps("capped").level, "ok");
  await s.stop();
});

test("a tool outside allowedResources is refused before anything is signed, and the refusal is in audit.jsonl", async () => {
  const f = await fake();
  const server = "http://127.0.0.1:7404/mcp";
  const s = await startSignerd({
    network: "cardano:preview",
    koios: f.url,
    policy: {
      network: "cardano:preview",
      agents: { default: { perTxMax: { lovelace: "5000000" }, allowedPayees: ["*"], allowedResources: [`${server}#quote`] } },
    },
  });
  const ask = (tool: string) =>
    s.call("/sign", { body: signRequest({ network: "cardano:preview", payTo: payee, asset: "lovelace", amount: "1000000", agentId: "default", resource: `${server}#${tool}` }) });

  const no = await ask("premium");
  assert.equal(no.status, 403);
  assert.equal(no.data.error, "policy_denied");
  assert.equal(no.data.rule, "resource");
  assert.equal(events(s, "signed").length, 0);
  const denied = events(s, "denied");
  assert.equal(denied.length, 1);
  assert.equal(denied[0]!.rule, "resource");
  assert.equal(denied[0]!.resource, `${server}#premium`);

  const yes = await ask("quote");
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  assert.equal(events(s, "signed").length, 1);
});
