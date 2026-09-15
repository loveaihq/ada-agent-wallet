/**
 * Whether `agentId` is something a caller asserts or something it is.
 *
 * The policy is per agent, which only means anything if an agent cannot claim another's budget.
 * With a single shared token it could: name the other agent in the request body and its caps
 * applied instead. AGENT_TOKENS_FILE ties a token to an agent so identity stops being self-reported.
 *
 * Signs at most one payment and broadcasts nothing. Needs chain access and a funded wallet.
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
const PORT = Number(process.env.IDENTITY_PORT) || (await freePort());
const URL_ = `http://127.0.0.1:${PORT}`;
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
const SCANNER_TOKEN = "scanner-token-0123456789abcdef";
const TREASURY_TOKEN = "treasury-token-0123456789abcdef";

const TOKEN = process.env.SIGNERD_TOKEN;
const PAY_TO = process.env.SELLER_ADDRESS;
if (!TOKEN || !PAY_TO) {
  console.error("identity: SIGNERD_TOKEN and SELLER_ADDRESS are required (source .env.local)");
  process.exit(1);
}

const problems: string[] = [];
const check = (condition: boolean, description: string) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) problems.push(description);
};

const dir = mkdtempSync(join(tmpdir(), "ada-identity-"));
writeFileSync(
  join(dir, "policy.json"),
  JSON.stringify({
    network: NETWORK,
    agents: {
      scanner: { perTxMax: { lovelace: "1000000" }, dailyMax: { lovelace: "1000000" }, allowedPayees: ["*"] },
      treasury: { perTxMax: { lovelace: "5000000" }, dailyMax: { lovelace: "5000000" }, allowedPayees: ["*"] },
    },
  }),
);
writeFileSync(join(dir, "tokens.json"), JSON.stringify({ [SCANNER_TOKEN]: "scanner", [TREASURY_TOKEN]: "treasury" }));

try {
  await withSignerd({}, async () => {
    console.log("\n1. one shared token, which is the default");
    const asOther = await sign(TOKEN, "treasury", "4000000");
    check(asOther.status === 200, `the operator token signs 4000000 as treasury (HTTP ${asOther.status})`);
    const flagged = await preflightHas(/any holder of the operator token/);
    check(flagged, "preflight warns that identity is self-reported here");
  });

  await withSignerd({ AGENT_TOKENS_FILE: join(dir, "tokens.json") }, async () => {
    console.log("\n2. a token per agent");
    const own = await sign(SCANNER_TOKEN, undefined, "900000");
    check(own.status === 200, `scanner's token signs within scanner's cap (HTTP ${own.status})`);
    // "the agent never sees a key" is a claim about this response and nothing else. A signed
    // transaction carries a signature and a public key, which are meant to leave; anything else
    // appearing here would be something nobody decided to send.
    check(
      Object.keys(own.data).sort().join() === "nonce,transaction",
      `a signed payment comes back as exactly {transaction, nonce} (${Object.keys(own.data).sort().join(", ")})`,
    );

    const overOwnCap = await sign(SCANNER_TOKEN, undefined, "4000000");
    check(overOwnCap.data.rule === "per_tx_max", `and is held to scanner's cap (${overOwnCap.data.rule})`);

    const claiming = await sign(SCANNER_TOKEN, "treasury", "4000000");
    check(claiming.status === 403 && claiming.data.error === "agent_mismatch", `naming another agent is refused (${claiming.data.error})`);

    const byOperator = await sign(TOKEN, "treasury", "4000000");
    check(
      byOperator.status === 403 && byOperator.data.error === "operator_cannot_sign",
      `the operator token no longer signs at all (${byOperator.data.error})`,
    );

    console.log("\n3. an agent sees its own budget and no one else's");
    const seen = (await get("/status", SCANNER_TOKEN)) as { agents: Record<string, unknown> };
    check(Object.keys(seen.agents).join() === "scanner", `status returns only scanner (${Object.keys(seen.agents).join(", ")})`);
    const operatorSees = (await get("/status", TOKEN)) as { agents: Record<string, unknown> };
    check(Object.keys(operatorSees.agents).sort().join() === "scanner,treasury", "the operator still sees both");

    const queue = await fetch(`${URL_}/pending`, { headers: bearer(SCANNER_TOKEN) });
    check(queue.status === 403, `an agent token cannot read the approval queue (HTTP ${queue.status})`);

    check(await preflightHas(/each fixed to one agent/), "preflight reports identity as bound");
  });

  console.log(problems.length ? `\nFAIL — ${problems.length} check(s) failed` : "\nPASS — with a token per agent, agentId stops being a claim");
  process.exitCode = problems.length ? 1 : 0;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// A declaration, not a const: the checks above run at the top level, where a const arrow down here
// would still be in its temporal dead zone.
function bearer(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function sign(token: string, agentId: string | undefined, amount: string) {
  return fetch(`${URL_}/sign`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({
      ...(agentId ? { agentId } : {}),
      reason: `identity check, ${amount}`,
      input: { network: NETWORK, payTo: PAY_TO, asset: "lovelace", amount, maxTimeoutSeconds: 180 },
    }),
  }).then(async r => ({ status: r.status, data: (await r.json()) as Record<string, string> }));
}

function get(path: string, token: string) {
  return fetch(URL_ + path, { headers: bearer(token) }).then(r => r.json());
}

async function preflightHas(pattern: RegExp): Promise<boolean> {
  const p = (await get("/preflight", TOKEN!)) as { checks: Array<{ detail: string }> };
  return p.checks.some(c => pattern.test(c.detail));
}

async function withSignerd(extra: Record<string, string>, body: () => Promise<void>) {
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", SIGNERD], {
    env: {
      ...process.env,
      SIGNERD_PORT: String(PORT),
      POLICY_FILE: join(dir, "policy.json"),
      AUDIT_FILE: join(dir, `audit-${Object.keys(extra).length}.jsonl`),
      LEDGER_FILE: join(dir, `ledger-${Object.keys(extra).length}.json`),
      ...extra,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    let last: unknown;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${URL_}/status`, { headers: bearer(TOKEN!) })).ok) break;
      } catch (e) {
        // Keep it. Swallowing this turned a programming error into a sixty-second timeout that
        // said only that signerd never came up, which was not what happened.
        last = e;
      }
      await new Promise(r => setTimeout(r, 1000));
      if (i === 59) throw new Error(`signerd did not come up on ${URL_}: ${last instanceof Error ? last.message : last}`);
    }
    await body();
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 1500));
  }
}
