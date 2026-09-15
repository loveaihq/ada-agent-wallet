/**
 * Per-asset accounting, end to end through signerd.
 *
 * Caps, the rolling 24h window and the remaining budget are all per asset; the hourly rate
 * deliberately is not. Every other check in dev/ uses lovelace and only lovelace, so none of that
 * separation had ever been exercised outside the unit tests.
 *
 * The USDM spend is seeded into the audit log rather than made: the wallet holds no USDM, and the
 * ledger is rebuilt from that log on startup, so this is the same state a restart produces. What
 * it therefore does not cover is an actual native-asset settlement on chain — that needs a wallet
 * holding the asset, which needs minting, which is a different project.
 *
 * Signs nothing and spends nothing.
 *
 * Env: SIGNERD_TOKEN, SELLER_ADDRESS, WALLET_MNEMONIC_FILE, CARDANO_NETWORK
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./port.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNERD = resolvePath(HERE, "../src/signerd.ts");
const PORT = Number(process.env.ASSETS_PORT) || (await freePort());
const URL_ = `http://127.0.0.1:${PORT}`;
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
/** Real, and live on preprod: 15.1M supply across 38 mints at the time of writing. */
const USDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";

const TOKEN = process.env.SIGNERD_TOKEN;
const PAY_TO = process.env.SELLER_ADDRESS;
if (!TOKEN || !PAY_TO) {
  console.error("assets: SIGNERD_TOKEN and SELLER_ADDRESS are required (source .env.local)");
  process.exit(1);
}
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const problems: string[] = [];
const check = (condition: boolean, description: string) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) problems.push(description);
};

const dir = mkdtempSync(join(tmpdir(), "ada-wallet-assets-"));
writeFileSync(
  join(dir, "policy.json"),
  JSON.stringify({
    network: NETWORK,
    agents: {
      // Generous rate, so what stops a payment is only ever its own asset's cap.
      wide: {
        perTxMax: { lovelace: "5000000", [USDM]: "2000000" },
        dailyMax: { lovelace: "10000000", [USDM]: "3000000" },
        allowedPayees: ["*"],
        maxPerHour: 60,
      },
      // One payment an hour, of anything: the rate is the one limit that is not per asset.
      rated: {
        perTxMax: { lovelace: "5000000", [USDM]: "2000000" },
        allowedPayees: ["*"],
        maxPerHour: 1,
      },
    },
  }),
);
// A restart's worth of history: 2 USDM already spent by each agent, and no lovelace.
const now = Date.now();
writeFileSync(
  join(dir, "audit.jsonl"),
  ["wide", "rated"]
    .map(agentId => JSON.stringify({ ts: now - 60_000, event: "signed", agentId, asset: USDM, amount: "2000000" }))
    .join("\n") + "\n",
);

const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", SIGNERD], {
  env: {
    ...process.env,
    SIGNERD_PORT: String(PORT),
    POLICY_FILE: join(dir, "policy.json"),
    AUDIT_FILE: join(dir, "audit.jsonl"),
    LEDGER_FILE: join(dir, "ledger.json"),
  },
  stdio: ["ignore", "ignore", "ignore"],
});

try {
  await waitForPort();

  console.log("\n1. the two assets are accounted for separately");
  const wide = await assets("wide");
  check(wide[USDM]?.dailySpent === "2000000", `USDM records the seeded spend (${wide[USDM]?.dailySpent})`);
  check(wide.lovelace?.dailySpent === "0", `lovelace is untouched by it (${wide.lovelace?.dailySpent})`);
  check(wide.lovelace?.dailyRemaining === "10000000", `lovelace keeps its whole budget (${wide.lovelace?.dailyRemaining})`);
  check(wide[USDM]?.dailyRemaining === "1000000", `USDM has 3000000 - 2000000 left (${wide[USDM]?.dailyRemaining})`);

  console.log("\n2. each asset's cap binds only itself");
  const overUsdm = await sign("wide", USDM, "1500000"); // 2000000 already spent, cap 3000000
  check(overUsdm.data.rule === "daily_max", `a USDM payment past the USDM cap is denied (${overUsdm.data.rule})`);
  const sameSizeInAda = await sign("wide", "lovelace", "1500000");
  check(
    sameSizeInAda.status === 200 || sameSizeInAda.data.error === "utxo_busy",
    `the same amount in lovelace is not blocked by USDM's cap (${sameSizeInAda.data.rule ?? sameSizeInAda.data.error ?? sameSizeInAda.status})`,
  );

  console.log("\n3. the hourly rate is shared across assets, by design");
  const rated = await sign("rated", "lovelace", "1000000");
  check(
    rated.data.rule === "rate",
    `one USDM payment in the last hour blocks a lovelace one at maxPerHour 1 (${rated.data.rule ?? rated.data.error})`,
  );

  console.log("\n4. an asset the wallet does not hold");
  // Within every cap, so the policy lets it through and the wallet is what cannot do it.
  const noFunds = await sign("wide", USDM, "500000");
  check(noFunds.status === 409, `refused with 409, not a 500 (got ${noFunds.status})`);
  check(noFunds.data.error === "insufficient_funds", `named as insufficient_funds (${noFunds.data.error})`);
  check(noFunds.data.retryable === false, "and marked not retryable, since waiting will not help");

  console.log("\n5. metrics carry a series per asset");
  const text = await fetch(`${URL_}/metrics`, { headers }).then(r => r.text());
  for (const asset of ["lovelace", USDM]) {
    check(text.includes(`asset="${asset}"`), `ada_wallet_daily_spent has a sample for ${asset.slice(0, 20)}`);
  }

  console.log(problems.length ? `\nFAIL — ${problems.length} check(s) failed` : "\nPASS — assets are capped apart and rated together");
  process.exitCode = problems.length ? 1 : 0;
} finally {
  child.kill();
  await new Promise(r => setTimeout(r, 1500));
  rmSync(dir, { recursive: true, force: true });
}

function sign(agentId: string, asset: string, amount: string) {
  return fetch(`${URL_}/sign`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agentId,
      reason: `multi-asset check: ${amount} of ${asset.slice(0, 12)}`,
      input: { network: NETWORK, payTo: PAY_TO, asset, amount, maxTimeoutSeconds: 180 },
    }),
  }).then(async r => ({ status: r.status, data: (await r.json()) as Record<string, string | boolean> }));
}

async function assets(agentId: string): Promise<Record<string, { dailySpent: string; dailyRemaining: string }>> {
  const s = (await fetch(`${URL_}/status`, { headers }).then(r => r.json())) as {
    agents: Record<string, { assets: Record<string, { dailySpent: string; dailyRemaining: string }> }>;
  };
  return s.agents[agentId].assets;
}

async function waitForPort() {
  let last: unknown;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${URL_}/status`, { headers })).ok) return;
    } catch (e) {
      // Keep it: swallowing this reports a timeout for an error thrown on the first try.
      last = e;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`signerd did not come up on ${URL_}: ${last instanceof Error ? last.message : last}`);
}
