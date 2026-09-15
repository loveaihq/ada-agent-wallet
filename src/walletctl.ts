#!/usr/bin/env node
/** Operator CLI: walletctl status | pending | approve <id> | deny <id> | audit [n] */
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const URL_ = process.env.SIGNERD_URL ?? "http://127.0.0.1:7402";
const headers = { authorization: `Bearer ${process.env.SIGNERD_TOKEN ?? ""}`, "content-type": "application/json" };
const [cmd, arg] = process.argv.slice(2);

interface PendingEntry {
  id: string;
  createdAt: number;
  agentId: string;
  reason: string;
  payTo: string;
  asset: string;
  amount: string;
}

function die(msg: string): never {
  console.error(`walletctl: ${msg}`);
  process.exit(1);
}

async function call(path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  let res: Response;
  try {
    res = await fetch(URL_ + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    die(`cannot reach signerd at ${URL_} (${e instanceof Error ? e.message : String(e)}) — is it running?`);
  }
  if (res.status === 401) die(`signerd rejected the token; SIGNERD_TOKEN does not match the one it was started with`);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

switch (cmd) {
  case "status":
    console.log(JSON.stringify((await call("/status")).data, null, 2));
    break;
  case "pending":
    console.log(JSON.stringify((await call("/pending")).data, null, 2));
    break;
  case "approve":
  case "deny": {
    if (!arg) die(`${cmd} needs a pending id — run: walletctl pending`);
    // Show the request before releasing it. Approving by id alone is approving an amount and a
    // payee you cannot see, which is most of what the approval gate exists to put in front of you.
    const queue = (await call("/pending")).data as PendingEntry[];
    const entry = Array.isArray(queue) ? queue.find(p => p.id === arg) : undefined;
    if (!entry) die(`no pending request "${arg}" — it may have been resolved or timed out`);
    console.log(`${cmd === "approve" ? "approving" : "denying"} ${entry.id}`);
    console.log(`  agent   ${entry.agentId}`);
    console.log(`  amount  ${entry.amount} ${entry.asset}`);
    console.log(`  payTo   ${entry.payTo}`);
    console.log(`  reason  ${entry.reason}`);
    const { status, data } = await call(`/${cmd}`, { id: arg });
    console.log(JSON.stringify(data));
    // exitCode rather than exit(): a hard exit here aborts inside libuv on Windows while the
    // fetch handles are still closing.
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "audit": {
    const f = process.env.AUDIT_FILE ?? "./audit.jsonl";
    if (!existsSync(f)) die(`no audit file at ${resolvePath(f)} — set AUDIT_FILE, or run from signerd's working directory`);
    const lines = readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
    console.log(lines.slice(-Number(arg ?? 20)).join("\n"));
    break;
  }
  default:
    console.log("walletctl status | pending | approve <id> | deny <id> | audit [n]");
}
