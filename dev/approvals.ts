/**
 * The approval gate's state machine, and the budget it holds while a human decides.
 *
 * A queued payment reserves its amount so two of them cannot promise the same budget twice, and
 * every way out has to give that reservation back: approved turns it into a real spend, denied and
 * timed out drop it. A leak is invisible — nothing errors, the agent simply never gets the budget
 * again — and only `approved` had ever actually run.
 *
 * Signs at most one payment and broadcasts nothing. Needs chain access and a funded wallet.
 *
 * Env: SIGNERD_TOKEN, WALLET_MNEMONIC_FILE, SELLER_ADDRESS, CARDANO_NETWORK
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNERD = resolvePath(HERE, "../src/signerd.ts");
const PORT = Number(process.env.APPROVALS_PORT ?? 7422);
const URL_ = `http://127.0.0.1:${PORT}`;
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
const AMOUNT = "1500000";

const TOKEN = process.env.SIGNERD_TOKEN;
const PAY_TO = process.env.SELLER_ADDRESS;
if (!TOKEN || !PAY_TO) {
  console.error("approvals: SIGNERD_TOKEN and SELLER_ADDRESS are required (source .env.local)");
  process.exit(1);
}
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const problems: string[] = [];
const check = (condition: boolean, description: string) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) problems.push(description);
};

const dir = mkdtempSync(join(tmpdir(), "ada-wallet-approvals-"));
const auditFile = join(dir, "audit.jsonl");
writeFileSync(
  join(dir, "policy.json"),
  JSON.stringify({
    network: NETWORK,
    agents: {
      default: {
        perTxMax: { lovelace: "5000000" },
        dailyMax: { lovelace: "10000000" },
        allowedPayees: ["*"],
        approvalAbove: { lovelace: "1000000" }, // anything worth testing needs a human
        maxPerHour: 60,
      },
    },
  }),
);

const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", SIGNERD], {
  env: {
    ...process.env,
    SIGNERD_PORT: String(PORT),
    POLICY_FILE: join(dir, "policy.json"),
    AUDIT_FILE: auditFile,
    LEDGER_FILE: join(dir, "ledger.json"),
  },
  stdio: ["ignore", "ignore", "ignore"],
});

try {
  await waitForPort();

  // --- two at once: both reserve, neither spends -------------------------------------------------
  console.log("\n1. two payments queue at the same time");
  const first = sign("first payment, awaiting a human");
  const second = sign("second payment, awaiting a human");
  await settle(() => pending().then(p => p.length === 2), "two queued");
  check((await pending()).length === 2, "both are waiting on a human");
  check(await spentIs("3000000"), `both reservations are held (dailySpent ${await dailySpent()}, expected 3000000)`);

  // --- denied: the reservation goes back ---------------------------------------------------------
  console.log("\n2. deny one");
  const queue = await pending();
  const denied = queue[0];
  const denyResponse = await post("/deny", { id: denied.id });
  check(denyResponse.status === 200, `deny accepted (HTTP ${denyResponse.status})`);
  const deniedCaller = await first.then(r => r, () => undefined);
  check(deniedCaller?.status === 403 && deniedCaller.data.error === "approval_denied", "the waiting caller was told, and told why");
  check(await spentIs("1500000"), `only the other reservation is still held (dailySpent ${await dailySpent()}, expected 1500000)`);

  // --- approved: the reservation becomes a real spend, not both ----------------------------------
  console.log("\n3. approve the other");
  const approved = (await pending())[0];
  const approveResponse = await post("/approve", { id: approved.id });
  check(approveResponse.status === 200, `approve accepted (HTTP ${approveResponse.status})`);
  check((await second).status === 200, "the waiting caller got its transaction");
  check(await spentIs("1500000"), `the reservation became the spend rather than doubling it (dailySpent ${await dailySpent()}, expected 1500000)`);
  check((await pending()).length === 0, "the queue is empty");

  // --- timed out: the reservation goes back too --------------------------------------------------
  // The approval window has a 30s floor, so this is the slow one.
  console.log("\n4. let one time out (30s floor on the approval window)");
  const abandoned = sign("nobody is going to answer this", 1);
  await settle(() => pending().then(p => p.length === 1), "queued");
  check(await spentIs("3000000"), `held while waiting (dailySpent ${await dailySpent()}, expected 3000000)`);
  const timedOut = await abandoned;
  check(timedOut.status === 403 && /timed out/.test(String(timedOut.data.detail)), "the caller was told it timed out");
  check(await spentIs("1500000"), `the reservation was released (dailySpent ${await dailySpent()}, expected 1500000)`);

  const events = auditEvents();
  for (const e of ["pending", "approval_denied", "approved", "approval_timeout"]) {
    check(events.includes(e), `the audit records ${e}`);
  }

  console.log(problems.length ? `\nFAIL — ${problems.length} check(s) failed` : "\nPASS — every way out of the queue gives the budget back");
  process.exitCode = problems.length ? 1 : 0;
} finally {
  child.kill();
  await new Promise(r => setTimeout(r, 1500));
  rmSync(dir, { recursive: true, force: true });
}

function sign(reason: string, maxTimeoutSeconds = 600) {
  return post("/sign", {
    agentId: "default",
    reason,
    input: { network: NETWORK, payTo: PAY_TO, asset: "lovelace", amount: AMOUNT, maxTimeoutSeconds },
  });
}

/**
 * Never rejects. A queued /sign is a request that stays open for as long as a human takes, and a
 * promise like that left floating turns any transport hiccup into an unhandled rejection that
 * takes the whole check down instead of failing a case.
 */
function post(path: string, body: unknown): Promise<{ status: number; data: Record<string, string> }> {
  return fetch(URL_ + path, { method: "POST", headers, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, data: (await r.json()) as Record<string, string> }))
    .catch(e => ({ status: 0, data: { error: "transport", detail: String(e instanceof Error ? (e.cause ?? e.message) : e) } }));
}

async function pending(): Promise<Array<{ id: string; amount: string }>> {
  return fetch(`${URL_}/pending`, { headers }).then(r => r.json()) as Promise<Array<{ id: string; amount: string }>>;
}

async function dailySpent(): Promise<string> {
  const s = (await fetch(`${URL_}/status`, { headers }).then(r => r.json())) as {
    agents: Record<string, { assets: Record<string, { dailySpent: string }> }>;
  };
  return s.agents.default.assets.lovelace.dailySpent;
}
// A declaration, not a const: this file's checks run at the top level, above where the helpers are
// written, and a const arrow would still be in its temporal dead zone when they do.
async function spentIs(expected: string) {
  return (await dailySpent()) === expected;
}

function auditEvents(): string[] {
  if (!existsSync(auditFile)) return [];
  return readFileSync(auditFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => {
      try {
        return String((JSON.parse(l) as { event?: string }).event);
      } catch {
        return "";
      }
    });
}

/** Waits for a condition, rather than guessing how long signerd takes to get there. */
async function settle(condition: () => Promise<boolean>, what: string, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitForPort() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${URL_}/status`, { headers })).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`signerd did not come up on ${URL_}`);
}
