/**
 * Fires several payments at once against a cap that fits one, and fails unless exactly one signs.
 * Without the agent lock all of them did, on one shared nonce.
 *
 * Spends nothing: `/sign` builds and signs, and only a facilitator broadcasts. Needs chain access
 * and a funded wallet, since signing reads the wallet's UTXOs.
 *
 * Env: SIGNERD_TOKEN, WALLET_MNEMONIC_FILE, SELLER_ADDRESS, CARDANO_NETWORK
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNERD = resolvePath(HERE, "../src/signerd.ts");
const PORT = Number(process.env.RACE_PORT ?? 7412);
const URL_ = `http://127.0.0.1:${PORT}`;
const CONCURRENCY = Number(process.env.RACE_CONCURRENCY ?? 4);
const AMOUNT = 1_500_000n;
const CAP = 2_000_000n; // fits exactly one payment

const TOKEN = process.env.SIGNERD_TOKEN;
const PAY_TO = process.env.SELLER_ADDRESS;
if (!TOKEN || !PAY_TO) {
  console.error("concurrency: SIGNERD_TOKEN and SELLER_ADDRESS are required (source .env.local)");
  process.exit(1);
}

const workdir = mkdtempSync(join(tmpdir(), "ada-wallet-race-"));
const policyFile = join(workdir, "policy.json");
const auditFile = join(workdir, "audit.jsonl");
// The ledger checkpoint has to be isolated too, not just the audit: leaving it at the default
// pointed this throwaway signerd at the real project checkpoint, whose chain position the temp
// audit does not contain — so it refused to start, correctly.
const ledgerFile = join(workdir, "ledger.json");
writeFileSync(
  policyFile,
  JSON.stringify({
    agents: {
      default: {
        perTxMax: { lovelace: AMOUNT.toString() },
        dailyMax: { lovelace: CAP.toString() },
        allowedPayees: ["*"],
        maxPerHour: 60,
      },
    },
  }),
);

// node directly rather than npx: Node refuses to spawn a .cmd shim without a shell on Windows,
// and going through the shim buys nothing here.
const child = spawn(process.execPath, ["--import", "tsx", SIGNERD], {
  env: { ...process.env, SIGNERD_PORT: String(PORT), POLICY_FILE: policyFile, AUDIT_FILE: auditFile, LEDGER_FILE: ledgerFile },
  stdio: ["ignore", "inherit", "inherit"],
});

const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

try {
  await waitForPort();
  console.log(`\ncap ${CAP} lovelace, ${CONCURRENCY} concurrent requests of ${AMOUNT} each`);
  console.log(`only one can legitimately be signed.\n`);

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_unused, i) =>
      fetch(`${URL_}/sign`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agentId: "default",
          reason: `concurrency regression probe ${i + 1}`,
          input: { network: process.env.CARDANO_NETWORK ?? "cardano:preprod", payTo: PAY_TO, asset: "lovelace", amount: AMOUNT.toString(), maxTimeoutSeconds: 180 },
        }),
      }).then(async r => ({ i: i + 1, status: r.status, data: (await r.json()) as Record<string, string> })),
    ),
  );

  for (const r of results.sort((a, b) => a.i - b.i)) {
    const outcome = r.status === 200 ? `SIGNED   nonce=${r.data.nonce}` : `rejected ${r.data.rule ?? r.data.error}`;
    console.log(`  request ${r.i}: HTTP ${r.status}  ${outcome}`);
  }

  const signed = results.filter(r => r.status === 200);
  const nonces = new Set(signed.map(r => r.data.nonce));
  const status = (await fetch(`${URL_}/status`, { headers }).then(r => r.json())) as {
    agents: Record<string, { assets: Record<string, { dailySpent: string; overBudget: boolean }> }>;
  };
  const lovelace = status.agents.default.assets.lovelace;

  console.log(`\nsigned ${signed.length}/${CONCURRENCY}, distinct nonces ${nonces.size}`);
  console.log(`dailySpent ${lovelace.dailySpent} of ${CAP}  overBudget=${lovelace.overBudget}`);

  const problems: string[] = [];
  if (signed.length !== 1) problems.push(`expected exactly 1 signed payment, got ${signed.length}`);
  if (nonces.size !== signed.length) problems.push(`two signed payments share a nonce`);
  if (BigInt(lovelace.dailySpent) > CAP) problems.push(`spent ${lovelace.dailySpent} against a cap of ${CAP}`);
  if (lovelace.overBudget) problems.push(`signerd reports the agent over budget`);

  if (problems.length) {
    for (const p of problems) console.error(`  FAIL: ${p}`);
    process.exitCode = 1;
    console.log("\nFAIL");
  } else {
    console.log("\nPASS — the cap held under concurrency");
  }
} finally {
  child.kill();
  rmSync(workdir, { recursive: true, force: true });
}

async function waitForPort() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${URL_}/status`, { headers });
      if (r.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`signerd did not come up on ${URL_}`);
}
