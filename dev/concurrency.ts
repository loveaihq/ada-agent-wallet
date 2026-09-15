/**
 * What happens when payments overlap.
 *
 *   1. One agent, several requests at once, against a cap that fits one. Without the agent lock all
 *      of them signed, on one shared nonce.
 *   2. Two agents with separate budgets and one wallet — the case the wallet lock exists for, and
 *      the premise of a per-agent policy. Both are entitled to pay; only one can spend the UTXO.
 *
 * Spends nothing: `/sign` builds and signs, and only a facilitator broadcasts. Needs chain access
 * and a funded wallet, since signing reads the wallet's UTXOs.
 *
 * Env: SIGNERD_TOKEN, WALLET_MNEMONIC_FILE, SELLER_ADDRESS, CARDANO_NETWORK
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./port.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNERD = resolvePath(HERE, "../src/signerd.ts");
const PORT = Number(process.env.RACE_PORT) || (await freePort());
const URL_ = `http://127.0.0.1:${PORT}`;
const CONCURRENCY = Number(process.env.RACE_CONCURRENCY ?? 4);
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
const AMOUNT = 1_500_000n;
const CAP = 2_000_000n; // fits exactly one payment

const TOKEN = process.env.SIGNERD_TOKEN;
const PAY_TO = process.env.SELLER_ADDRESS;
if (!TOKEN || !PAY_TO) {
  console.error("concurrency: SIGNERD_TOKEN and SELLER_ADDRESS are required (source .env.local)");
  process.exit(1);
}
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const problems: string[] = [];
const check = (condition: boolean, description: string) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) problems.push(description);
};

const agent = (overrides: Record<string, unknown> = {}) => ({
  perTxMax: { lovelace: AMOUNT.toString() },
  dailyMax: { lovelace: CAP.toString() },
  allowedPayees: ["*"],
  maxPerHour: 60,
  ...overrides,
});

await withSignerd({ network: NETWORK, agents: { default: agent() } }, async () => {
  console.log(`\n1. one agent, ${CONCURRENCY} requests at once, against a cap that fits one`);
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_u, i) => sign("default", `concurrency regression probe ${i + 1}`)),
  );
  for (const r of results) console.log(`   ${describe(r)}`);

  const signed = results.filter(r => r.status === 200);
  const spent = await dailySpent("default");
  check(signed.length === 1, `exactly one signed (got ${signed.length})`);
  check(new Set(signed.map(r => r.data.nonce)).size === signed.length, "no two signed payments share a nonce");
  check(BigInt(spent) <= CAP, `dailySpent ${spent} stays inside the ${CAP} cap`);
});

await withSignerd({ network: NETWORK, agents: { alpha: agent(), beta: agent() } }, async () => {
  console.log(`\n2. two agents with separate budgets, one wallet`);
  const results = await Promise.all([sign("alpha", "two-agent probe"), sign("beta", "two-agent probe")]);
  for (const r of results) console.log(`   ${describe(r)}`);

  const signed = results.filter(r => r.status === 200);
  // Both are within their own cap, so policy lets both through; the wallet is what they contend
  // for. One gets the UTXO and the other is told to come back, rather than being handed a
  // transaction that can never settle.
  check(signed.length === 1, `one of the two signed (got ${signed.length})`);
  check(
    results.every(r => r.status === 200 || r.data.error === "utxo_busy"),
    "the other was refused as retryable, not as a server error",
  );
  for (const id of ["alpha", "beta"]) {
    const expected = signed.some(r => r.agentId === id) ? AMOUNT.toString() : "0";
    const spent = await dailySpent(id);
    check(spent === expected, `${id} was charged ${spent}, expected ${expected}`);
  }
});

console.log(problems.length ? `\nFAIL — ${problems.length} check(s) failed` : "\nPASS — overlapping payments stay inside their caps and off each other's UTXOs");
process.exitCode = problems.length ? 1 : 0;

function describe(r: { agentId: string; status: number; data: Record<string, string> }) {
  const what = r.status === 200 ? `SIGNED nonce=${r.data.nonce?.slice(0, 20)}…` : `${r.data.error ?? ""} ${r.data.rule ?? ""} ${(r.data.detail ?? "").slice(0, 60)}`;
  return `${r.agentId.padEnd(8)} HTTP ${r.status}  ${what}`;
}

function sign(agentId: string, reason: string) {
  return fetch(`${URL_}/sign`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agentId,
      reason,
      input: { network: NETWORK, payTo: PAY_TO, asset: "lovelace", amount: AMOUNT.toString(), maxTimeoutSeconds: 180 },
    }),
  }).then(async r => ({ agentId, status: r.status, data: (await r.json()) as Record<string, string> }));
}

async function dailySpent(agentId: string): Promise<string> {
  const s = (await fetch(`${URL_}/status`, { headers }).then(r => r.json())) as {
    agents: Record<string, { assets: Record<string, { dailySpent: string }> }>;
  };
  return s.agents[agentId].assets.lovelace.dailySpent;
}

/** Each phase gets its own signerd and its own files, so neither can see the other's spending. */
async function withSignerd(policy: unknown, body: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ada-wallet-race-"));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  // node directly rather than npx: Node refuses to spawn a .cmd shim without a shell on Windows.
  // The ledger file has to be isolated too, or this throwaway points at the real checkpoint, whose
  // chain position the temp audit does not contain — and it refuses to start, correctly.
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
    let last: unknown;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${URL_}/status`, { headers })).ok) break;
      } catch (e) {
        // Keep it: swallowing this reports a timeout for an error thrown on the first try.
        last = e;
      }
      await new Promise(r => setTimeout(r, 1000));
      if (i === 59) throw new Error(`signerd did not come up on ${URL_}: ${last instanceof Error ? last.message : last}`);
    }
    await body();
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 1500));
    rmSync(dir, { recursive: true, force: true });
  }
}
