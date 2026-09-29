/**
 * `walletctl tidy` on preprod: a wallet whose ADA sits inside token-bearing UTxOs is put in the
 * layout channel steps need, and the result is read back from the chain provider, not taken from
 * signerd's word for it.
 *
 *   0. signerd starts on files of its own; an agent's token is refused, and so are malformed
 *      requests, before anything is read
 *   1. the wallet's UTxOs, as the provider lists them
 *   2. `tidy --dry-run`: says what it would do, and builds nothing
 *   3. `tidy`: one transaction spends every UTxO. A second request straight after is refused
 *      utxo_busy, because the first one's inputs are still listed and are committed
 *   4. wait, up to five minutes, until the provider lists the new outputs and none of the old
 *   5. the layout again: the tokens in one UTxO, exactly the same tokens as before, an ADA-only UTxO
 *      of exactly the collateral, and the wallet's ADA down by the fee and nothing else
 *   6. `tidy --dry-run` again says the wallet is already tidy
 *
 * Needs a wallet that is not tidy yet, one whose ADA is folded into UTxOs that carry tokens, which a
 * few `exact` payments of a token do. On a tidy wallet it says so and stops without a transaction.
 *
 * Moves real (test) ADA: the fee of one transaction, about 0.3 tADA, and nothing leaves the wallet.
 * Takes a minute or two on Blockfrost, longer on Koios, and gives up after five minutes of waiting.
 * Preprod only: channel steps, and so `/tidy`, run nowhere else.
 *
 * Env: SIGNERD_TOKEN, WALLET_MNEMONIC (or WALLET_MNEMONIC_FILE, or a keystore), BLOCKFROST_PROJECT_ID
 *      (else Koios), KOIOS_TOKEN, CARDANO_NETWORK (default preprod)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { blockfrostBaseUrl, koiosBaseUrl, networkName } from "../src/network.js";
import { describeLayout, formatAda, type Utxo } from "../src/tidy.js";
import { freePort } from "./port.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNERD = resolvePath(HERE, "../src/signerd.ts");
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
const WAIT_MS = 5 * 60_000;

const TOKEN = process.env.SIGNERD_TOKEN;
if (!TOKEN) {
  console.error("tidy: SIGNERD_TOKEN is required (source .env.local)");
  process.exit(1);
}
// This submits a transaction. Nothing here has any business on mainnet, and signerd has no channels,
// so no /tidy, anywhere but on preprod.
if (networkName(NETWORK) === "mainnet") {
  console.error("tidy: refusing to run on mainnet; it submits a real transaction");
  process.exit(1);
}
if (networkName(NETWORK) !== "preprod") {
  console.error(`tidy: /tidy needs batch-settlement, which runs on preprod only, and this is ${NETWORK}`);
  process.exit(1);
}
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const problems: string[] = [];
const check = (condition: boolean, description: string) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) problems.push(description);
};
const note = (text: string) => console.log(`        ${text}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const since = (from = t0) => `${Math.round((Date.now() - from) / 1000)}s`;

const dir = mkdtempSync(join(tmpdir(), "ada-tidy-"));
const auditFile = join(dir, "audit.jsonl");
writeFileSync(
  join(dir, "policy.json"),
  JSON.stringify({
    network: NETWORK,
    // Nothing here pays anyone; signerd needs an agent in its policy to start.
    agents: { default: { perTxMax: { lovelace: "1000000" }, dailyMax: { lovelace: "1000000" }, allowedPayees: ["*"] } },
  }),
);
// An agent's token, to show it cannot tidy: /tidy is the operator's, as /approve is.
const agentToken = randomBytes(16).toString("hex");
writeFileSync(join(dir, "agent-tokens.json"), JSON.stringify({ [agentToken]: "default" }));

const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const stderrLog = join(dir, "signerd.log");
let child: ChildProcess | undefined;

/** signerd, on files of its own. */
async function start() {
  const log = openSync(stderrLog, "a");
  child = spawn(process.execPath, ["--import", "tsx", SIGNERD], {
    env: {
      ...process.env,
      SIGNERD_PORT: String(port),
      POLICY_FILE: join(dir, "policy.json"),
      AUDIT_FILE: auditFile,
      LEDGER_FILE: join(dir, "ledger.json"),
      CHANNELS_DIR: join(dir, "channels"),
      AGENT_TOKENS_FILE: join(dir, "agent-tokens.json"),
    },
    stdio: ["ignore", "ignore", log],
  });
  closeSync(log); // the child has its own copy
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) throw new Error(`signerd exited ${child.exitCode}: ${tail()}`);
    try {
      if ((await fetch(`${url}/status`, { headers })).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error(`signerd did not come up: ${tail()}`);
}
async function stop() {
  if (!child) return;
  child.kill("SIGTERM");
  await sleep(2000);
  child.kill("SIGKILL");
  child = undefined;
}
const tail = () => (existsSync(stderrLog) ? readFileSync(stderrLog, "utf8").split("\n").slice(-8).join(" | ") : "no log");

const records = (): Array<Record<string, unknown>> =>
  existsSync(auditFile)
    ? readFileSync(auditFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return { event: "?" };
          }
        })
    : [];

interface Answer {
  status: number;
  data: {
    error?: string;
    detail?: string;
    dryRun?: boolean;
    alreadyTidy?: boolean;
    tidied?: boolean;
    why?: string;
    layout?: string;
    tx?: string;
    fee?: string;
    plan?: { inputs: number; tokens: Record<string, string>; collateralLovelace: string; tokenMinLovelace: string; totalLovelace: string };
  };
}
/** What `walletctl tidy` sends. */
async function tidy(body: Record<string, unknown>): Promise<Answer> {
  const r = await fetch(`${url}/tidy`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as Answer["data"] };
}

/** The wallet's UTxOs from the provider, as tidy.ts sees them. Nothing here asks signerd. */
async function listUtxos(address: string): Promise<Utxo[]> {
  const blockfrost = process.env.BLOCKFROST_PROJECT_ID;
  if (blockfrost) {
    const out: Utxo[] = [];
    for (let page = 1; ; page++) {
      const r = await fetch(`${blockfrostBaseUrl(NETWORK)}/addresses/${address}/utxos?count=100&page=${page}`, { headers: { project_id: blockfrost } });
      if (r.status === 404) return out; // an address that has never held anything
      if (!r.ok) throw new Error(`blockfrost answered ${r.status} for the wallet's UTxOs`);
      const rows = (await r.json()) as Array<{ tx_hash: string; output_index: number; amount: Array<{ unit: string; quantity: string }> }>;
      for (const row of rows) {
        const assets: Record<string, bigint> = {};
        let lovelace = 0n;
        for (const a of row.amount) {
          // Blockfrost's unit is the policy and the name run together.
          if (a.unit === "lovelace") lovelace = BigInt(a.quantity);
          else assets[`${a.unit.slice(0, 56)}.${a.unit.slice(56)}`] = BigInt(a.quantity);
        }
        out.push({ ref: `${row.tx_hash}#${row.output_index}`, lovelace, assets });
      }
      if (rows.length < 100) return out;
    }
  }
  const r = await fetch(`${koiosBaseUrl(NETWORK)}/address_utxos`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.KOIOS_TOKEN ? { authorization: `Bearer ${process.env.KOIOS_TOKEN}` } : {}) },
    // Without _extended, Koios leaves the tokens out.
    body: JSON.stringify({ _addresses: [address], _extended: true }),
  });
  if (!r.ok) throw new Error(`koios answered ${r.status} for the wallet's UTxOs`);
  const rows = (await r.json()) as Array<{ tx_hash: string; tx_index: number; value: string; asset_list?: Array<{ policy_id: string; asset_name: string | null; quantity: string }> | null }>;
  return rows.map(row => ({
    ref: `${row.tx_hash}#${row.tx_index}`,
    lovelace: BigInt(row.value),
    assets: Object.fromEntries((row.asset_list ?? []).map(a => [`${a.policy_id}.${a.asset_name ?? ""}`, BigInt(a.quantity)])),
  }));
}

const tokensOf = (utxos: Utxo[]) => {
  const total: Record<string, bigint> = {};
  for (const u of utxos) for (const [a, q] of Object.entries(u.assets)) if (q > 0n) total[a.toLowerCase()] = (total[a.toLowerCase()] ?? 0n) + q;
  return total;
};
const holdsTokens = (u: Utxo) => Object.values(u.assets).some(q => q > 0n);
const lovelaceOf = (utxos: Utxo[]) => utxos.reduce((s, u) => s + u.lovelace, 0n);
function show(utxos: Utxo[]) {
  note(describeLayout(utxos));
  const rows = [...utxos].sort((a, b) => (b.lovelace > a.lovelace ? 1 : b.lovelace < a.lovelace ? -1 : 0));
  for (const u of rows.slice(0, 12)) {
    const kinds = Object.keys(u.assets).length;
    note(`  ${u.ref.slice(0, 10)}…${u.ref.slice(64)}  ${formatAda(u.lovelace).padStart(16)}  ${holdsTokens(u) ? `${kinds} kind(s) of token` : "ADA-only"}`);
  }
  if (rows.length > 12) note(`  … and ${rows.length - 12} more`);
}

let txHash: string | undefined;
let landedAfter: string | undefined;
let skipped = false;
try {
  await start();
  console.log(`signerd up on ${url}, ${process.env.BLOCKFROST_PROJECT_ID ? "Blockfrost" : "Koios"}`);
  const status = (await fetch(`${url}/status`, { headers }).then(r => r.json())) as { address: string; batch: { available: boolean; detail?: string } };
  note(`wallet ${status.address}`);
  check(status.batch.available, `batch-settlement is available here${status.batch.available ? "" : `: ${status.batch.detail}`}`);
  if (!status.batch.available) throw new Error("nothing to tidy for");

  // === 0. who may ask, and what may be asked ====================================================
  console.log("\n0. an agent's token cannot tidy, and requests that are not requests are refused before the wallet is read");
  const asAgent = await fetch(`${url}/tidy`, { method: "POST", headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ dryRun: true }) });
  check(asAgent.status === 403 && ((await asAgent.json()) as { error?: string }).error === "operator_only", `an agent's token is refused: operator_only (${asAgent.status})`);
  for (const [what, body] of [
    ["dryRun that is not a boolean", { dryRun: "yes" }],
    ["collateral that is not a decimal integer string", { collateralLovelace: 5_000_000 }],
    ["collateral under 2 ADA", { collateralLovelace: "1999999" }],
    ["collateral over 5 ADA", { collateralLovelace: "5000001" }],
  ] as const) {
    const r = await tidy(body);
    check(r.status === 400, `${what}: 400 (${r.status})`);
  }

  // === 1. the wallet ============================================================================
  console.log("\n1. the wallet, as the provider lists it");
  const before = await listUtxos(status.address);
  show(before);
  const tokensBefore = tokensOf(before);
  const lovelaceBefore = lovelaceOf(before);
  const oldRefs = new Set(before.map(u => u.ref));

  // === 2. dry run ===============================================================================
  console.log("\n2. `walletctl tidy --dry-run`");
  const dry = await tidy({ dryRun: true });
  check(dry.status === 200, `answered 200 (${dry.status}${dry.status === 200 ? "" : ` ${dry.data.error}: ${dry.data.detail}`})`);
  if (dry.status !== 200) throw new Error("the dry run did not answer");
  note(`signerd sees: ${dry.data.layout}`);
  if (dry.data.alreadyTidy) {
    skipped = true;
    note(`already tidy: ${dry.data.why}`);
    note("nothing to demonstrate: fund this wallet with a token and make a few `exact` payments of it, then run this again");
    throw new Error("__skip__");
  }
  const plan = dry.data.plan!;
  note(`needs tidying: ${dry.data.why}`);
  note(`would spend ${plan.inputs} UTxO(s): every token in one output at about ${formatAda(BigInt(plan.tokenMinLovelace))}, one ADA-only output of ${formatAda(BigInt(plan.collateralLovelace))}, the rest as change`);
  check(dry.data.tidied === false && dry.data.dryRun === true, "a dry run reports that it changed nothing");
  check(plan.inputs === before.length, `it would spend every UTxO the provider lists (${plan.inputs} of ${before.length})`);
  check(BigInt(plan.totalLovelace) === lovelaceBefore, `and counts the ADA the provider lists (${formatAda(BigInt(plan.totalLovelace))})`);
  check(!records().some(r => r.event === "tidied"), "nothing was audited as tidied, and no transaction was built");
  const expectedOutputs = (Object.keys(plan.tokens).length ? 1 : 0) + 2;

  // === 3. tidy ==================================================================================
  console.log("\n3. `walletctl tidy`");
  const done = await tidy({});
  check(done.status === 200 && done.data.tidied === true, `tidied (${done.status}${done.status === 200 ? "" : ` ${done.data.error}: ${done.data.detail}`})`);
  if (done.status !== 200 || !done.data.tx) throw new Error("the tidy did not go through");
  txHash = done.data.tx;
  const submittedAt = Date.now();
  const fee = BigInt(done.data.fee!);
  note(`tx ${txHash}, fee ${formatAda(fee)}`);
  check(/^[0-9a-f]{64}$/.test(txHash), "it names the transaction");
  const audited = records().filter(r => r.event === "tidied");
  check(
    audited.length === 1 && audited[0].tx === txHash && audited[0].inputs === before.length && audited[0].collateralLovelace === plan.collateralLovelace && audited[0].fee === fee.toString(),
    "the audit has one `tidied` record: the transaction, its fee, its inputs and the collateral",
  );
  const again = await tidy({});
  check(again.status === 409 && again.data.error === "utxo_busy", `a second tidy straight after is refused utxo_busy (${again.status} ${again.data.error})`);
  check(records().filter(r => r.event === "tidied").length === 1, "and builds nothing");

  // === 4. the chain =============================================================================
  console.log(`\n4. wait for the provider to list the new outputs (up to ${WAIT_MS / 60_000} minutes)`);
  let after: Utxo[] = [];
  for (let listedAt = 0; ; ) {
    after = await listUtxos(status.address);
    const fresh = after.filter(u => u.ref.startsWith(`${txHash}#`));
    if (fresh.length === expectedOutputs && !after.some(u => oldRefs.has(u.ref))) break;
    if (Date.now() - submittedAt > WAIT_MS) throw new Error(`the provider still lists ${fresh.length} of the ${expectedOutputs} new outputs and ${after.filter(u => oldRefs.has(u.ref)).length} old one(s) ${since(submittedAt)} after the submit`);
    if (Date.now() - listedAt > 30_000) {
      listedAt = Date.now();
      note(`${since(submittedAt)}: ${fresh.length} of ${expectedOutputs} new outputs listed, ${after.filter(u => oldRefs.has(u.ref)).length} old one(s) still there`);
    }
    if (child && child.exitCode !== null) throw new Error(`signerd exited ${child.exitCode} while waiting: ${tail()}`);
    await sleep(10_000);
  }
  landedAfter = since(submittedAt);
  note(`listed ${landedAfter} after the submit`);

  // === 5. the layout ============================================================================
  console.log("\n5. the layout now");
  show(after);
  const carrying = after.filter(holdsTokens);
  check(carrying.length === (Object.keys(tokensBefore).length ? 1 : 0), `the tokens are in ${Object.keys(tokensBefore).length ? "one UTxO" : "no UTxO, as there were none"} (${carrying.length})`);
  const tokensAfter = tokensOf(after);
  check(
    Object.keys(tokensBefore).length === Object.keys(tokensAfter).length && Object.entries(tokensBefore).every(([a, q]) => tokensAfter[a] === q),
    `every token, in the same amount: ${Object.entries(tokensBefore).map(([a, q]) => `${q} of ${a.slice(0, 8)}…`).join(", ") || "none"}`,
  );
  const collateral = BigInt(plan.collateralLovelace);
  check(after.some(u => !holdsTokens(u) && u.lovelace === collateral), `an ADA-only UTxO of exactly ${formatAda(collateral)}`);
  check(
    carrying.length === 0 || carrying[0].lovelace <= BigInt(plan.tokenMinLovelace) + 1_000_000n,
    `the token UTxO keeps its min-ADA and no more (${carrying[0] ? formatAda(carrying[0].lovelace) : "n/a"})`,
  );
  check(
    lovelaceOf(after) === lovelaceBefore - fee,
    `the wallet's ADA is down by the fee and nothing else (${formatAda(lovelaceBefore)} to ${formatAda(lovelaceOf(after))}, fee ${formatAda(fee)})`,
  );
  if (lovelaceOf(after) !== lovelaceBefore - fee) note("if the wallet took a deposit or made a payment meanwhile, this is that and not the tidy");

  // === 6. and it says so ========================================================================
  console.log("\n6. `walletctl tidy --dry-run` again");
  let last: Answer = await tidy({ dryRun: true });
  // signerd waits, for a while, for outputs of its own that its provider does not list yet.
  for (let i = 0; i < 12 && last.status === 409 && last.data.error === "utxo_busy"; i++) {
    note(`${last.data.detail}`);
    await sleep(10_000);
    last = await tidy({ dryRun: true });
  }
  check(last.status === 200 && last.data.alreadyTidy === true, `it says already tidy (${last.status}${last.data.why ? `: ${last.data.why}` : last.data.error ? ` ${last.data.error}: ${last.data.detail}` : ""})`);
} catch (e) {
  if (!(e instanceof Error && e.message === "__skip__")) {
    check(false, String(e instanceof Error ? e.message : e));
    note(`signerd log, last lines: ${tail()}`);
  }
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}

console.log("\n----");
console.log(`tx  ${txHash ?? "(none)"}${landedAfter ? `   listed ${landedAfter} after the submit` : ""}`);
if (skipped) console.log(`SKIP: the wallet was already tidy, so there was nothing to demonstrate (${since()})`);
else console.log(problems.length ? `FAIL: ${problems.length} check(s) failed, tx ${txHash ?? "(none)"} (${since()})` : `PASS: the wallet was tidied by ${txHash} and says so (${since()})`);
process.exit(problems.length ? 1 : 0);
