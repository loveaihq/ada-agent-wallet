/**
 * The checks that only run on POSIX: real mode bits, and a signal a process can survive long
 * enough to drain. On Windows checkFileMode declines to check and child.kill() is a hard kill, so
 * neither the permission gate nor the shutdown path had ever actually been executed.
 *
 * Signs nothing and needs no chain: everything here happens before the sign step, or instead of it.
 *
 * Env: nothing. Uses a throwaway mnemonic and temp files.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./port.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNERD = resolvePath(HERE, "../src/signerd.ts");
const MNEMONIC = Array(23).fill("abandon").join(" ") + " art";
const TOKEN = "posix-check-token-0123456789abcdef";
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const NL = "\n";

if (process.platform === "win32") {
  console.error("posix: this check is about POSIX mode bits and signals; run it on Linux");
  process.exit(1);
}

const problems: string[] = [];
const check = (condition: boolean, description: string) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) problems.push(description);
};
const note = (text: string) => console.log(`        ${text}`);

const POLICY = (network: string) => ({
  network,
  agents: {
    default: {
      perTxMax: { lovelace: "5000000" },
      dailyMax: { lovelace: "10000000" },
      allowedPayees: ["*"],
      approvalAbove: { lovelace: "1000000" },
    },
  },
});

interface Started {
  child: ChildProcess;
  url: string;
  stderr: () => string;
  exited: Promise<number | null>;
}

async function start(dir: string, opts: { network?: string; env?: Record<string, string>; wait?: boolean } = {}): Promise<Started> {
  const network = opts.network ?? "cardano:preprod";
  const port = await freePort();
  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", SIGNERD], {
    env: {
      ...process.env,
      WALLET_MNEMONIC: MNEMONIC,
      SIGNERD_TOKEN: TOKEN,
      SIGNERD_PORT: String(port),
      CARDANO_NETWORK: network,
      POLICY_FILE: join(dir, "policy.json"),
      AUDIT_FILE: join(dir, "audit.jsonl"),
      LEDGER_FILE: join(dir, "ledger.json"),
      ...opts.env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", c => (stderr += c));
  const exited = new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));
  const started: Started = { child, url: `http://127.0.0.1:${port}`, stderr: () => stderr, exited };
  if (opts.wait !== false) await waitFor(started);
  return started;
}

async function waitFor(s: Started, seconds = 180) {
  for (let i = 0; i < seconds; i++) {
    if (s.child.exitCode !== null) throw new Error(`signerd exited ${s.child.exitCode}: ${s.stderr()}`);
    try {
      if ((await fetch(`${s.url}/status`, { headers })).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`signerd did not come up: ${s.stderr()}`);
}

const firstLines = (text: string, n: number) =>
  text.trim().split(NL).slice(0, n).join(" | ");

const post = (url: string, path: string, body: unknown) =>
  fetch(url + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) })
    .then(async r => ({ status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, string> }))
    .catch(e => ({ status: 0, data: { error: "transport", detail: String(e) } as Record<string, string> }));

const preflight = (url: string) =>
  fetch(`${url}/preflight`, { headers }).then(r => r.json()) as Promise<{
    checks: Array<{ level: string; check: string; detail: string }>;
  }>;

const auditEvents = (file: string): string[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split(NL)
        .filter(Boolean)
        .map(l => {
          try {
            return String((JSON.parse(l) as { event?: string }).event);
          } catch {
            return "?";
          }
        })
    : [];

const mode = (f: string) => (statSync(f).mode & 0o777).toString(8);
const dirs: string[] = [];
const workdir = () => {
  const d = mkdtempSync(join(tmpdir(), "ada-posix-"));
  dirs.push(d);
  return d;
};
const permissionChecks = async (url: string) => (await preflight(url)).checks.filter(c => c.check === "file permissions");
/** `ok` reads "<label>: mode 600"; `warn` reads "<label> <path> is writable by ...". */
const noteFor = (checks: Array<{ level: string; detail: string }>, label: string) =>
  checks.find(c => c.detail.startsWith(`${label}:`) || c.detail.startsWith(`${label} `));

try {
  // === 1. SIGTERM drains the approval queue =====================================================
  console.log(`${NL}1. SIGTERM: the queue is drained, the caller is told, the record is written`);
  {
    const dir = workdir();
    writeFileSync(join(dir, "policy.json"), JSON.stringify(POLICY("cardano:preprod")));
    const s = await start(dir);
    // Above approvalAbove, so it queues and waits on a human. Nothing is signed.
    const queued = post(s.url, "/sign", {
      agentId: "default",
      reason: "queued so that shutdown has something to drain",
      input: { network: "cardano:preprod", payTo: "addr_test1payee", asset: "lovelace", amount: "2000000", maxTimeoutSeconds: 600 },
    });
    for (let i = 0; i < 60; i++) {
      const p = (await fetch(`${s.url}/pending`, { headers }).then(r => r.json())) as unknown[];
      if (p.length === 1) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const waiting = (await fetch(`${s.url}/pending`, { headers }).then(r => r.json())) as unknown[];
    check(waiting.length === 1, "a payment is waiting on a human");

    s.child.kill("SIGTERM");
    const answer = await queued;
    const code = await s.exited;
    check(answer.status === 403 && answer.data.error === "approval_denied", `the waiting caller was answered, not dropped (HTTP ${answer.status} ${answer.data.error})`);
    check(/shut down/.test(String(answer.data.detail)), `and told it was the shutdown (${answer.data.detail})`);
    check(code === 0, `signerd exited cleanly (code ${code})`);
    const events = auditEvents(join(dir, "audit.jsonl"));
    check(events.includes("shutdown_denied"), `the audit records shutdown_denied (${events.join(", ")})`);
    check(/SIGTERM received/.test(s.stderr()), "and said so on stderr");
  }

  // === 2. the permission gate actually runs =====================================================
  console.log(`${NL}2. file permissions are checked, not waived`);
  {
    const dir = workdir();
    const policyFile = join(dir, "policy.json");
    writeFileSync(policyFile, JSON.stringify(POLICY("cardano:preprod")));
    chmodSync(policyFile, 0o664); // group-writable: an agent in the group rewrites its own limits
    const s = await start(dir);
    const checks = await permissionChecks(s.url);
    for (const c of checks) note(`${c.level}: ${c.detail}`);
    check(noteFor(checks, "policy")?.level === "warn", "a group-writable policy file is reported as a warning on preprod");
    check(!checks.some(c => /not checked/.test(c.detail)), "no check was skipped the way Windows skips them");
    s.child.kill("SIGTERM");
    await s.exited;
  }

  // === 3. mainnet refuses to start on it ========================================================
  console.log(`${NL}3. the same file on mainnet refuses to start`);
  {
    const dir = workdir();
    const policyFile = join(dir, "policy.json");
    writeFileSync(policyFile, JSON.stringify(POLICY("cardano:mainnet")));
    chmodSync(policyFile, 0o664);
    // Nothing here reaches the chain: checkFileMode runs before the signer is built.
    const s = await start(dir, { network: "cardano:mainnet", wait: false });
    const code = await s.exited;
    check(code === 1, `signerd refused to start (exit ${code})`);
    check(/refusing to run on cardano:mainnet/.test(s.stderr()), `and said why: ${firstLines(s.stderr(), 1)}`);
  }

  // === 4. the ledger check, added because the cap is computed from it ============================
  console.log(`${NL}4. a world-writable ledger checkpoint`);
  {
    const dir = workdir();
    writeFileSync(join(dir, "policy.json"), JSON.stringify(POLICY("cardano:preprod")));
    const ledgerFile = join(dir, "ledger.json");
    const first = await start(dir);
    first.child.kill("SIGTERM");
    await first.exited;
    check(existsSync(ledgerFile), "the first start wrote a checkpoint");
    chmodSync(ledgerFile, 0o666); // anyone can rewrite the spend the cap is computed from
    note(`before the restart: ledger.json is mode ${mode(ledgerFile)}`);
    const s = await start(dir);
    const ledgerNote = noteFor(await permissionChecks(s.url), "ledger");
    note(`after the restart:  ledger.json is mode ${mode(ledgerFile)}, reported as "${ledgerNote?.level}: ${ledgerNote?.detail}"`);
    check(ledgerNote?.level === "warn", "a world-writable ledger checkpoint is reported, rather than rewritten to 600 and reported ok");
    s.child.kill("SIGTERM");
    await s.exited;
  }

  // === 5. the audit file signerd creates itself =================================================
  console.log(`${NL}5. the permissions signerd gives its own audit log (umask ${process.umask().toString(8).padStart(4, "0")})`);
  {
    const dir = workdir();
    writeFileSync(join(dir, "policy.json"), JSON.stringify(POLICY("cardano:preprod")));
    const auditFile = join(dir, "audit.jsonl");
    const first = await start(dir);
    first.child.kill("SIGTERM");
    await first.exited;
    note(`signerd created audit.jsonl as mode ${mode(auditFile)}, ledger.json as mode ${mode(join(dir, "ledger.json"))}`);
    const s = await start(dir);
    const auditNote = noteFor(await permissionChecks(s.url), "audit");
    note(`the next start reports it as "${auditNote?.level}: ${auditNote?.detail}"`);
    check(auditNote?.level === "ok", "signerd does not create an audit log that its own next start would flag");
    s.child.kill("SIGTERM");
    await s.exited;
  }

  // === 6. numeric environment variables =========================================================
  console.log(`${NL}6. environment variables that are not numbers`);
  {
    const dir = workdir();
    writeFileSync(join(dir, "policy.json"), JSON.stringify(POLICY("cardano:preprod")));

    const port = await start(dir, { env: { SIGNERD_PORT: "not-a-port" }, wait: false });
    check((await port.exited) === 1 && /SIGNERD_PORT must be a port number/.test(port.stderr()), "SIGNERD_PORT is validated");

    const hot = await start(dir, { env: { MAX_HOT_BALANCE_LOVELACE: "10 ADA" }, wait: false });
    const hotCode = await hot.exited;
    note(firstLines(hot.stderr(), 2));
    check(hotCode === 1 && /^signerd: /m.test(hot.stderr()), `MAX_HOT_BALANCE_LOVELACE is refused with a message, not a stack trace (exit ${hotCode})`);

    const masumi = await start(dir, { env: { MASUMI_MAX_COLLATERAL_LOVELACE: "15 ADA" }, wait: false });
    const masumiCode = await Promise.race([masumi.exited, new Promise<null>(r => setTimeout(() => r(null), 120_000))]);
    note(firstLines(masumi.stderr(), 2));
    check(masumiCode === 1 && /^signerd: /m.test(masumi.stderr()), `MASUMI_MAX_COLLATERAL_LOVELACE is refused with a message (exit ${masumiCode})`);
    masumi.child.kill("SIGKILL");

    const nonce = await start(dir, { env: { NONCE_HOLD_SECONDS: "two minutes" }, wait: false });
    const nonceCode = await Promise.race([nonce.exited, new Promise<null>(r => setTimeout(() => r(null), 120_000))]);
    note(nonceCode === null ? 'NONCE_HOLD_SECONDS="two minutes" was accepted; it reaches claimNonce as NaN' : `exited ${nonceCode}`);
    check(nonceCode === 1, "NONCE_HOLD_SECONDS is validated (a NaN expiry never prunes, so a held UTXO is held forever)");
    nonce.child.kill("SIGKILL");
  }

  // === 7. malformed and oversize requests =======================================================
  console.log(`${NL}7. requests that should never reach a decision`);
  {
    const dir = workdir();
    writeFileSync(join(dir, "policy.json"), JSON.stringify(POLICY("cardano:preprod")));
    const s = await start(dir);
    const before = auditEvents(join(dir, "audit.jsonl")).length;

    check((await post(s.url, "/sign", "{not json")).status === 400, "a body that is not JSON is a 400");
    check((await post(s.url, "/sign", "[1,2,3]")).status === 400, "a JSON array is a 400");
    const big = await post(s.url, "/sign", "x".repeat(2 << 20));
    check(big.status === 413, `a 2 MiB body is a 413 (got ${big.status})`);
    // The builder reads the TTL off this, and BigInt(undefined) there is a 500 for an omission.
    const noTtl = await post(s.url, "/sign", {
      agentId: "default",
      reason: "a payment that never says how long it may live",
      input: { network: "cardano:preprod", payTo: "addr_test1payee", asset: "lovelace", amount: "1000" },
    });
    check(noTtl.status === 400, `a missing maxTimeoutSeconds is a 400, not a 500 from the builder (got ${noTtl.status})`);
    const wrongNet = await post(s.url, "/sign", {
      agentId: "default",
      reason: "paying an endpoint that quoted another chain",
      input: { network: "cardano:mainnet", payTo: "addr1payee", asset: "lovelace", amount: "1000", maxTimeoutSeconds: 300 },
    });
    check(wrongNet.status === 400 && wrongNet.data.error === "network_mismatch", `a 402 for another chain is a 400 (${wrongNet.status} ${wrongNet.data.error})`);
    const longReason = await post(s.url, "/sign", {
      agentId: "default",
      reason: "x".repeat(1001),
      input: { network: "cardano:preprod", payTo: "addr_test1payee", asset: "lovelace", amount: "1000", maxTimeoutSeconds: 300 },
    });
    check(longReason.status === 400 && longReason.data.error === "too_long", `an oversize reason is refused before it is logged (${longReason.data.error})`);
    const badToken = await fetch(`${s.url}/status`, { headers: { authorization: "Bearer wrong" } });
    check(badToken.status === 401, "a wrong token is a 401");

    const after = auditEvents(join(dir, "audit.jsonl"));
    check(after.length === before, `none of them wrote an audit record (${after.length - before} written)`);
    const m = await fetch(`${s.url}/metrics`, { headers }).then(r => r.text());
    note(m.split(NL).filter(l => /bad_requests|unauthorized/.test(l) && !l.startsWith("#")).join(" | "));
    s.child.kill("SIGTERM");
    await s.exited;
  }

  // === 8. a torn append, and a rewritten log ====================================================
  console.log(`${NL}8. an audit log that a crash or an edit got to`);
  {
    const dir = workdir();
    writeFileSync(join(dir, "policy.json"), JSON.stringify(POLICY("cardano:preprod")));
    const auditFile = join(dir, "audit.jsonl");
    const first = await start(dir);
    // Two denials, so the log has a record whose successor can disagree with it.
    for (const reason of ["a denial, so the log has a record in it", "a second denial, so the chain has a link"])
      await post(first.url, "/sign", {
        agentId: "default",
        reason,
        input: { network: "cardano:preprod", payTo: "addr_test1payee", asset: "lovelace", amount: "9999999999", maxTimeoutSeconds: 300 },
      });
    first.child.kill("SIGTERM");
    await first.exited;
    const lines = readFileSync(auditFile, "utf8").split(NL).filter(Boolean).length;
    note(`${lines} records in the log`);

    appendFileSync(auditFile, '{"ts":1,"seq":99,"prev":"x","event":"sig'); // a crash mid-append
    const torn = await start(dir);
    check(/dropped [0-9]+ unterminated byte/.test(torn.stderr()), `the partial record was cut off: ${(torn.stderr().match(/audit ended[^\n]*/) ?? ["(not reported)"])[0]}`);
    check(readFileSync(auditFile, "utf8").split(NL).filter(Boolean).length === lines, "and nothing that was written was lost");
    torn.child.kill("SIGTERM");
    await torn.exited;

    const body = readFileSync(auditFile, "utf8").split(NL).filter(Boolean);
    body[0] = body[0].replace(/"reason":"[^"]*"/, '"reason":"a reason nobody gave"');
    writeFileSync(auditFile, body.join(NL) + NL);
    const broken = await start(dir, { wait: false });
    const code = await broken.exited;
    note(firstLines(broken.stderr(), 2));
    check(
      code === 1 && /does not follow the record before it|no longer contains record/.test(broken.stderr()),
      `an edited record refuses to start (exit ${code})`,
    );
  }

  console.log(problems.length ? `${NL}FAIL - ${problems.length} check(s) failed` : `${NL}PASS`);
  process.exitCode = problems.length ? 1 : 0;
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
