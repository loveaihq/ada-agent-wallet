/**
 * Every exit from the approval queue that does not sign — which is all of them but one.
 *
 * `dev/approvals.ts` covers the same state machine but signs on the way through, so it needs a
 * funded wallet and a chain. Everything here stops before the sign step, so it runs anywhere:
 * the reservation accounting, the four non-signing exits, and what a SIGKILL leaves behind.
 *
 * Env: nothing. Uses a throwaway mnemonic and temp files.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./port.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNERD = resolvePath(HERE, "../src/signerd.ts");
const MNEMONIC = Array(23).fill("abandon").join(" ") + " art";
const TOKEN = "queue-check-token-0123456789abcdef";
const NETWORK = "cardano:preprod";
const PAY_TO = "addr_test1qqqpayee";
const AMOUNT = "2000000";
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const problems: string[] = [];
const check = (condition: boolean, description: string) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) problems.push(description);
};

const dir = mkdtempSync(join(tmpdir(), "ada-queue-"));
const policyFile = join(dir, "policy.json");
const auditFile = join(dir, "audit.jsonl");
const writePolicy = (dailyMax: string) =>
  writeFileSync(
    policyFile,
    JSON.stringify({
      network: NETWORK,
      agents: {
        default: {
          perTxMax: { lovelace: "5000000" },
          dailyMax: { lovelace: dailyMax },
          allowedPayees: ["*"],
          approvalAbove: { lovelace: "1000000" }, // everything below queues
        },
      },
    }),
  );
writePolicy("10000000");

let url = "";
let child: ChildProcess | undefined;

async function start() {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", SIGNERD], {
    env: {
      ...process.env,
      WALLET_MNEMONIC: MNEMONIC,
      SIGNERD_TOKEN: TOKEN,
      SIGNERD_PORT: String(port),
      CARDANO_NETWORK: NETWORK,
      POLICY_FILE: policyFile,
      AUDIT_FILE: auditFile,
      LEDGER_FILE: join(dir, "ledger.json"),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) throw new Error(`signerd exited ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/status`, { headers })).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("signerd did not come up");
}

/** Never rejects: a queued /sign stays open for as long as a human takes. */
function sign(reason: string, maxTimeoutSeconds = 600, signal?: AbortSignal) {
  return fetch(`${url}/sign`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({ agentId: "default", reason, input: { network: NETWORK, payTo: PAY_TO, asset: "lovelace", amount: AMOUNT, maxTimeoutSeconds } }),
  })
    .then(async r => ({ status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, string> }))
    .catch(e => ({ status: 0, data: { error: "aborted", detail: String(e instanceof Error ? e.message : e) } as Record<string, string> }));
}

const post = (path: string, body: unknown) =>
  fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, string> }))
    .catch(e => ({ status: 0, data: { error: "transport", detail: String(e) } as Record<string, string> }));

const pending = () => fetch(`${url}/pending`, { headers }).then(r => r.json()) as Promise<Array<{ id: string; amount: string }>>;

async function dailySpent(): Promise<string> {
  const s = (await fetch(`${url}/status`, { headers }).then(r => r.json())) as {
    agents: Record<string, { assets: Record<string, { dailySpent: string }> }>;
  };
  return s.agents.default.assets.lovelace.dailySpent;
}

async function settle(condition: () => Promise<boolean>, what: string, seconds = 90) {
  for (let i = 0; i < seconds; i++) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const auditEvents = (): string[] =>
  existsSync(auditFile)
    ? readFileSync(auditFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => {
          try {
            return String((JSON.parse(l) as { event?: string }).event);
          } catch {
            return "?";
          }
        })
    : [];

try {
  await start();

  // === 1. two at once: both hold budget ==========================================================
  console.log("\n1. two payments queue at the same time");
  const first = sign("the first, waiting on a human");
  const second = sign("the second, waiting on a human");
  await settle(async () => (await pending()).length === 2, "two queued");
  check(await dailySpent() === "4000000", `both reservations are held (dailySpent ${await dailySpent()}, expected 4000000)`);

  // === 2. denied ================================================================================
  console.log("\n2. deny one");
  const denied = (await pending())[0];
  check((await post("/deny", { id: denied.id })).status === 200, "deny accepted");
  const deniedAnswer = await first;
  check(deniedAnswer.status === 403 && deniedAnswer.data.error === "approval_denied", `the waiting caller was told (${deniedAnswer.status} ${deniedAnswer.data.error})`);
  check(await dailySpent() === "2000000", `the reservation went back (dailySpent ${await dailySpent()}, expected 2000000)`);
  check((await post("/deny", { id: denied.id })).status === 404, "denying it twice finds nothing");

  // === 3. the caller stops waiting ==============================================================
  console.log("\n3. the caller stops waiting (undici gives up on headers at 300s; this is the same exit)");
  const controller = new AbortController();
  const abandoned = sign("nobody will be here when this is answered", 600, controller.signal);
  await settle(async () => (await pending()).length === 2, "queued");
  const idsBefore = (await pending()).map(p => p.id);
  controller.abort();
  await abandoned;
  await settle(async () => (await pending()).length === 1, "withdrawn from the queue");
  const idsAfter = (await pending()).map(p => p.id);
  const gone = idsBefore.filter(id => !idsAfter.includes(id));
  check(gone.length === 1, `the request was withdrawn when the connection closed (${gone.join(", ") || "none"})`);
  check(await dailySpent() === "2000000", `and its budget came back (dailySpent ${await dailySpent()}, expected 2000000)`);
  check(auditEvents().includes("pending_abandoned"), "the audit records pending_abandoned");
  check((await post("/approve", { id: gone[0] ?? "none" })).status === 404, "approving it afterwards signs nothing");

  // === 4. the policy in force at approval time is the one that governs ===========================
  console.log("\n4. tighten the policy while it waits");
  writePolicy("1000000"); // 2000000 no longer fits
  const staleId = (await pending())[0].id;
  const refused = await post("/approve", { id: staleId });
  check(refused.status === 409 && refused.data.error === "policy_changed", `approving is refused (${refused.status} ${refused.data.error})`);
  check(refused.data.rule === "daily_max", `and names the limit that now blocks it (${refused.data.rule})`);
  const staleAnswer = await second;
  check(staleAnswer.status === 403, `the waiting caller is answered rather than left hanging (${staleAnswer.status})`);
  check((await pending()).length === 0, "the queue is empty");
  check(await dailySpent() === "0", `every reservation is back (dailySpent ${await dailySpent()}, expected 0)`);
  writePolicy("10000000");

  // === 5. the approval window's floor ===========================================================
  console.log("\n5. a one-second approval window still gets the 30s floor, then times out");
  const startedAt = Date.now();
  const timedOut = await sign("nobody is going to answer this either", 1);
  const waited = Math.round((Date.now() - startedAt) / 1000);
  check(timedOut.status === 403 && /timed out/.test(String(timedOut.data.detail)), `the caller was told it timed out (${timedOut.data.detail})`);
  check(waited >= 29, `and it waited the 30s floor rather than firing at once (${waited}s)`);
  check(await dailySpent() === "0", `the reservation went back (dailySpent ${await dailySpent()})`);

  // === 6. what a SIGKILL leaves behind ==========================================================
  console.log("\n6. SIGKILL with something queued, then a restart");
  const orphaned = sign("queued when the process was killed");
  await settle(async () => (await pending()).length === 1, "queued");
  const before = auditEvents().filter(e => e === "pending_abandoned").length;
  child!.kill("SIGKILL");
  await orphaned;
  await new Promise(r => setTimeout(r, 1000));
  await start();
  const after = auditEvents().filter(e => e === "pending_abandoned").length;
  check(after === before + 1, `the restart closed the approval the kill left open (${before} -> ${after})`);
  check((await pending()).length === 0, "and did not carry it into the new run's queue");
  check(await dailySpent() === "0", `nothing is reserved against a request nobody can answer (dailySpent ${await dailySpent()})`);

  const events = auditEvents();
  for (const e of ["pending", "approval_denied", "pending_abandoned", "approval_stale", "approval_timeout"])
    check(events.includes(e), `the audit records ${e}`);

  console.log(problems.length ? `\nFAIL — ${problems.length} check(s) failed` : "\nPASS — every exit that does not sign gives the budget back");
  process.exitCode = problems.length ? 1 : 0;
} finally {
  child?.kill("SIGKILL");
  await new Promise(r => setTimeout(r, 500));
  rmSync(dir, { recursive: true, force: true });
}
