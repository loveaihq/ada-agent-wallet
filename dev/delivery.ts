/**
 * The two ways a caller can leave while its own payment is still moving.
 *
 * Both are races against the agent lock, and neither could be reached from `dev/queue.ts`, where
 * nothing signs and so nothing holds the lock for long enough to leave during:
 *
 *   1. A caller that leaves while a payment *ahead of it* is signing. Its request reaches the queue
 *      afterwards, and a `close` listener attached after `close` has fired never runs — so the
 *      request sat in the queue with its budget held, for a human to approve into the void.
 *   2. A caller that leaves while *its own* approved payment is signing. The signature lands, the
 *      spend is recorded, and the one request it could have been handed to is gone. The spend
 *      stays; `signed_undelivered` is the only thing that says it will not happen.
 *
 * Signs twice and broadcasts nothing. Needs chain access and a funded wallet, because holding the
 * agent lock long enough to leave during is exactly what signing does.
 *
 * Env: SIGNERD_TOKEN, WALLET_MNEMONIC (or WALLET_MNEMONIC_FILE), SELLER_ADDRESS, CARDANO_NETWORK
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./port.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNERD = resolvePath(HERE, "../src/signerd.ts");
const NETWORK = process.env.CARDANO_NETWORK ?? "cardano:preprod";
/** Below approvalAbove, so it signs without asking, which is what holds the lock. */
const DIRECT = "900000";
/** Above it, so it queues. */
const QUEUED = "2000000";
/** Short, so the second signature is not refused for the UTXO the first one claimed. */
const NONCE_HOLD_SECONDS = "5";

const TOKEN = process.env.SIGNERD_TOKEN;
const PAY_TO = process.env.SELLER_ADDRESS;
if (!TOKEN || !PAY_TO) {
  console.error("delivery: SIGNERD_TOKEN and SELLER_ADDRESS are required (source .env.local)");
  process.exit(1);
}
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const problems: string[] = [];
const check = (condition: boolean, description: string) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) problems.push(description);
};
const note = (text: string) => console.log(`        ${text}`);

const dir = mkdtempSync(join(tmpdir(), "ada-delivery-"));
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
        approvalAbove: { lovelace: "1000000" },
      },
    },
  }),
);

const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", SIGNERD], {
  env: {
    ...process.env,
    SIGNERD_PORT: String(port),
    NONCE_HOLD_SECONDS,
    POLICY_FILE: join(dir, "policy.json"),
    AUDIT_FILE: auditFile,
    LEDGER_FILE: join(dir, "ledger.json"),
  },
  stdio: ["ignore", "ignore", "ignore"],
});

/** Never rejects: an aborted request and a queued one both come back as a shape, not a throw. */
function sign(reason: string, amount: string, signal?: AbortSignal) {
  return fetch(`${url}/sign`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      agentId: "default",
      reason,
      input: { network: NETWORK, payTo: PAY_TO, asset: "lovelace", amount, maxTimeoutSeconds: 600 },
    }),
  })
    .then(async r => ({ status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, string> }))
    .catch(e => ({ status: 0, data: { error: "aborted", detail: String(e instanceof Error ? e.message : e) } as Record<string, string> }));
}

const post = (path: string, body: unknown) =>
  fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, string> }))
    .catch(e => ({ status: 0, data: { error: "transport", detail: String(e) } as Record<string, string> }));

const pending = () => fetch(`${url}/pending`, { headers }).then(r => r.json()) as Promise<Array<{ id: string; reason: string }>>;

async function dailySpent(): Promise<string> {
  const s = (await fetch(`${url}/status`, { headers }).then(r => r.json())) as {
    agents: Record<string, { assets: Record<string, { dailySpent: string }> }>;
  };
  return s.agents.default.assets.lovelace.dailySpent;
}

const records = (): Array<Record<string, string>> =>
  existsSync(auditFile)
    ? readFileSync(auditFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => {
          try {
            return JSON.parse(l) as Record<string, string>;
          } catch {
            return { event: "?" };
          }
        })
    : [];
const countOf = (event: string) => records().filter(r => r.event === event).length;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function settle(condition: () => Promise<boolean>, what: string, seconds = 90) {
  for (let i = 0; i < seconds * 10; i++) {
    if (await condition()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

try {
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) throw new Error(`signerd exited ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/status`, { headers })).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }

  // === 1. leaving while the payment ahead of you is signing =====================================
  console.log("\n1. a caller leaves while a payment ahead of it holds the agent lock");
  const ahead = sign("the payment that holds the lock while the next one waits", DIRECT);
  await sleep(400); // long enough for it to be inside sign(), which is seconds of chain work
  const controller = new AbortController();
  const behind = sign("queued behind it, and gone before it got there", QUEUED, controller.signal);
  await sleep(400);

  // If this is empty while `behind` is still open, it never reached the queue: it is waiting for
  // the lock, which is the case worth testing. Said out loud, because the alternative is a race
  // that passes for the wrong reason.
  const queuedEarly = (await pending()).length > 0;
  note(queuedEarly ? "it had already reached the queue — the plain close path, not the one under test" : "it is still waiting for the agent lock, which is the case under test");
  check(!queuedEarly, "the second request is still behind the lock when its caller leaves");

  controller.abort();
  const signedAhead = await ahead;
  check(signedAhead.status === 200, `the payment ahead of it signed (HTTP ${signedAhead.status})`);
  await behind;

  // Without the guard the request reaches the queue after `close` has fired, so nothing withdraws
  // it: it sits here, reserved, until the 900s approval timeout.
  await sleep(1500);
  const stillQueued = await pending();
  check(stillQueued.length === 0, `nothing is left in the queue (${stillQueued.map(p => p.id).join(", ") || "empty"})`);
  check(await dailySpent() === DIRECT, `only the signed payment is counted (dailySpent ${await dailySpent()}, expected ${DIRECT})`);
  check(countOf("pending_abandoned") === 1, `the withdrawal is recorded (${countOf("pending_abandoned")} pending_abandoned)`);

  // === 2. leaving while your own approved payment is signing ====================================
  console.log("\n2. a caller leaves while its own approved payment is signing");
  await sleep(Number(NONCE_HOLD_SECONDS) * 1000 + 1000); // let the first signature's UTXO hold lapse
  const leaving = new AbortController();
  // By id, not by count: when the guard above is missing, check 1 leaves a request in the queue,
  // and a check that cannot run is a check that reports nothing about its own subject.
  const before = (await pending()).map(p => p.id);
  const waiting = sign("approved, and abandoned while the signature was in flight", QUEUED, leaving.signal);
  await settle(async () => (await pending()).some(p => !before.includes(p.id)), "queued");
  const id = (await pending()).find(p => !before.includes(p.id))!.id;

  const approving = post("/approve", { id });
  // This entry leaves `pending` just before its signing starts, so its absence is the signal that
  // the signature is in flight — no guessing at how long the chain takes.
  await settle(async () => !(await pending()).some(p => p.id === id), "the signature to be in flight", 30);
  leaving.abort();
  const approved = await approving;
  await waiting;

  check(approved.status === 200, `the approval itself succeeded (HTTP ${approved.status})`);
  check(countOf("signed") === 2, `both payments signed (${countOf("signed")} signed)`);
  check(countOf("signed_undelivered") === 1, `the signature that reached nobody is recorded (${countOf("signed_undelivered")} signed_undelivered)`);
  const undelivered = records().find(r => r.event === "signed_undelivered");
  note(`signed_undelivered: id=${undelivered?.id} nonce=${String(undelivered?.nonce).slice(0, 24)}…`);
  check(undelivered?.id === id, "and names the approval it belongs to");
  const expected = (BigInt(DIRECT) + BigInt(QUEUED)).toString();
  check(await dailySpent() === expected, `the spend stays on the ledger rather than being refunded (dailySpent ${await dailySpent()}, expected ${expected})`);

  // === 3. the books balance ====================================================================
  console.log("\n3. every signature either reached its caller or is on the record as not having");
  const delivered = [signedAhead].filter(r => r.status === 200 && typeof r.data.transaction === "string").length;
  note(`${countOf("signed")} signed = ${delivered} delivered + ${countOf("signed_undelivered")} undelivered`);
  check(countOf("signed") === delivered + countOf("signed_undelivered"), "signed == delivered + signed_undelivered");

  console.log(problems.length ? `\nFAIL — ${problems.length} check(s) failed` : "\nPASS — a caller that leaves takes its request with it, or leaves a record behind");
  process.exitCode = problems.length ? 1 : 0;
} finally {
  child.kill("SIGTERM");
  await sleep(2000);
  child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
