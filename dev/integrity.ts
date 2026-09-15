/**
 * Regression check for the one thing the spend cap rests on: that it cannot be reset by deleting
 * a file.
 *
 * The cap used to be a replay of `audit.jsonl`, so `rm audit.jsonl` restored a spent agent to a
 * full daily budget, and log rotation did the same by accident. The ledger is now its own
 * checkpoint, and the audit is a hash-chained log that the checkpoint points into:
 *
 *   A. deleting the checkpoint changes nothing — it is rebuilt from the log
 *   B. deleting the log the checkpoint points into is refused at startup
 *   C. ALLOW_UNVERIFIED_AUDIT=1 is the way past B for a rotation you made on purpose, and it
 *      waives the check without discarding the ledger
 *   D. deleting both together does reset the budget — the residual risk that file permissions and
 *      the deployment contract exist to cover, stated here rather than left to be discovered
 *   E. restarting over a pre-chain audit log does not re-count what the checkpoint already holds
 *
 * Nothing here is broadcast: `/sign` builds and signs, and the facilitator is what publishes. It
 * does need chain access and a funded wallet, because signing reads the wallet's UTXOs.
 *
 * Env: SIGNERD_TOKEN, WALLET_MNEMONIC_FILE, SELLER_ADDRESS, CARDANO_NETWORK
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNERD = resolvePath(HERE, "../src/signerd.ts");
const PORT = Number(process.env.INTEGRITY_PORT ?? 7415);
const URL_ = `http://127.0.0.1:${PORT}`;
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
const AMOUNT = "1500000";

const TOKEN = process.env.SIGNERD_TOKEN;
const PAY_TO = process.env.SELLER_ADDRESS;
if (!TOKEN || !PAY_TO) {
  console.error("integrity: SIGNERD_TOKEN and SELLER_ADDRESS are required (source .env.local)");
  process.exit(1);
}
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const workdir = mkdtempSync(join(tmpdir(), "ada-wallet-integrity-"));
const policyFile = join(workdir, "policy.json");
const auditFile = join(workdir, "audit.jsonl");
const ledgerFile = join(workdir, "ledger.json");
writeFileSync(
  policyFile,
  JSON.stringify({
    network: NETWORK,
    agents: { default: { perTxMax: { lovelace: "5000000" }, dailyMax: { lovelace: "20000000" }, allowedPayees: ["*"] } },
  }),
);

const problems: string[] = [];
const check = (condition: boolean, description: string) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) problems.push(description);
};

try {
  // --- a payment, so there is a spend and a checkpoint worth protecting -----------------------
  let child = await start();
  const signed = await post("/sign", {
    agentId: "default",
    reason: "integrity probe: establish a spend",
    input: { network: NETWORK, payTo: PAY_TO, asset: "lovelace", amount: AMOUNT, maxTimeoutSeconds: 180 },
  });
  check(signed.status === 200, `a payment signs (HTTP ${signed.status})`);
  const spent = await dailySpent();
  check(spent === AMOUNT, `the spend is recorded (dailySpent ${spent})`);
  check(existsSync(ledgerFile), "a ledger checkpoint is written");
  const checkpoint = JSON.parse(readFileSync(ledgerFile, "utf8"));
  check(
    checkpoint.seq > 0 && typeof checkpoint.hash === "string" && checkpoint.hash.length === 64,
    `the checkpoint names a chain position (seq ${checkpoint.seq})`,
  );
  await stop(child);

  // --- A ---------------------------------------------------------------------------------------
  console.log("\nA. delete the ledger checkpoint");
  rmSync(ledgerFile);
  child = await start();
  const afterCheckpointGone = await dailySpent();
  check(afterCheckpointGone === spent, `the spend survives (dailySpent ${afterCheckpointGone}, rebuilt from the audit log)`);
  check(existsSync(ledgerFile), "and the checkpoint is re-established immediately, not at the next payment");
  await stop(child);

  // --- B ---------------------------------------------------------------------------------------
  console.log("\nB. delete the audit log the checkpoint points into");
  writeFileSync(auditFile, "");
  const refused = await startExpectingExit();
  check(refused.exited, "signerd refuses to start");
  check(/no longer contains record/.test(refused.output), "and names the record that went missing");
  if (!/no longer contains record/.test(refused.output)) console.log(`        got: ${refused.output.trim().slice(0, 200)}`);

  // --- C ---------------------------------------------------------------------------------------
  console.log("\nC. the same, with ALLOW_UNVERIFIED_AUDIT=1");
  child = await start({ ALLOW_UNVERIFIED_AUDIT: "1" });
  const afterOverride = await dailySpent();
  check(
    afterOverride === spent,
    `starts, and the spend still stands (dailySpent ${afterOverride}) — the override waives the check, not the ledger`,
  );
  await stop(child);

  // --- D ---------------------------------------------------------------------------------------
  console.log("\nD. delete both the checkpoint and the log");
  rmSync(ledgerFile);
  writeFileSync(auditFile, "");
  child = await start();
  const afterBoth = await dailySpent();
  check(
    afterBoth === "0",
    `the budget does reset (dailySpent ${afterBoth}) — two coordinated deletions, which is what the file permissions are for`,
  );
  await stop(child);

  // --- E: restarting must not invent spending ---------------------------------------------------
  // Audit records written before the chain existed carry no sequence number. The first version of
  // this replay read "no seq" as "the checkpoint cannot have seen this" and added them again on
  // every start, so recorded spend grew without bound across restarts until nothing could be paid
  // at all. It only shows up on a log that predates the checkpoint, which is what this seeds.
  console.log("\nE. restart repeatedly over a pre-chain audit log");
  const legacyDir = mkdtempSync(join(tmpdir(), "ada-wallet-legacy-"));
  const legacyPolicy = join(legacyDir, "policy.json");
  const legacyAudit = join(legacyDir, "audit.jsonl");
  const legacyLedger = join(legacyDir, "ledger.json");
  writeFileSync(legacyPolicy, readFileSync(policyFile, "utf8"));
  writeFileSync(
    legacyAudit,
    JSON.stringify({ ts: Date.now(), event: "signed", agentId: "default", asset: "lovelace", amount: "1000000" }) + "\n",
  );
  const overrides = { POLICY_FILE: legacyPolicy, AUDIT_FILE: legacyAudit, LEDGER_FILE: legacyLedger };
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const c = await start(overrides);
    seen.push(await dailySpent());
    await stop(c);
  }
  check(seen.every(v => v === "1000000"), `one 1000000 spend stays one across three restarts (saw ${seen.join(", ")})`);
  rmSync(legacyDir, { recursive: true, force: true });

  console.log(problems.length ? `\nFAIL — ${problems.length} check(s) failed` : "\nPASS — no single deletion resets the cap");
  process.exitCode = problems.length ? 1 : 0;
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

function env(extra: Record<string, string> = {}) {
  return { ...process.env, SIGNERD_PORT: String(PORT), POLICY_FILE: policyFile, AUDIT_FILE: auditFile, LEDGER_FILE: ledgerFile, ...extra };
}

async function start(extra: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", SIGNERD], { env: env(extra), stdio: ["ignore", "ignore", "ignore"] });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${URL_}/status`, { headers })).ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  child.kill();
  throw new Error(`signerd did not come up on ${URL_}`);
}

/** Starts signerd expecting it to refuse; reports whether it exited and what it said. */
function startExpectingExit(extra: Record<string, string> = {}): Promise<{ exited: boolean; output: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--import", "tsx", SIGNERD], { env: env(extra), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", c => (output += c));
    child.stderr.on("data", c => (output += c));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ exited: false, output });
    }, 90_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve({ exited: true, output });
    });
  });
}

async function stop(child: ChildProcess) {
  child.kill();
  await new Promise(r => setTimeout(r, 1500));
}

async function post(path: string, body: unknown) {
  const r = await fetch(URL_ + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, data: (await r.json()) as Record<string, unknown> };
}

async function dailySpent(): Promise<string> {
  const s = (await fetch(`${URL_}/status`, { headers }).then(r => r.json())) as {
    agents: Record<string, { assets: Record<string, { dailySpent: string }> }>;
  };
  return s.agents.default.assets.lovelace.dailySpent;
}
