#!/usr/bin/env node
/**
 * Operator CLI: walletctl status | preflight | pending | approve <id> | deny <id> | audit [n]
 *   batch-settlement: channels | refund <channelId> <url> | close <channelId> | end <channelId>
 *                     | elapse <channelId> | recover <agentId>
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";

const URL_ = process.env.SIGNERD_URL ?? "http://127.0.0.1:7402";
const headers = { authorization: `Bearer ${process.env.SIGNERD_TOKEN ?? ""}`, "content-type": "application/json" };
const [cmd, arg, arg2] = process.argv.slice(2);
const USAGE = [
  "walletctl status | preflight | pending | approve <id> | deny <id> | audit [n]",
  "          channels | refund <channelId> <url> | close <channelId> | end <channelId> | elapse <channelId> | recover <agentId>",
].join("\n");

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

const request = (path: string, body?: unknown) =>
  fetch(URL_ + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });

/**
 * `anyStatus` is for the callers that inspect the status themselves. Everyone else gets a message:
 * printing a 503 body as though it were a result is how you read "no pending approvals" off an
 * error.
 */
async function call(path: string, body?: unknown, anyStatus = false): Promise<{ status: number; data: unknown }> {
  let res: Response;
  try {
    res = await request(path, body);
  } catch (e) {
    die(`cannot reach signerd at ${URL_} (${e instanceof Error ? e.message : String(e)}) — is it running?`);
  }
  if (res.status === 401) die(`signerd rejected the token; SIGNERD_TOKEN does not match the one it was started with`);
  const data = await res.json().catch(() => ({}));
  if (!anyStatus && !res.ok) die(`signerd returned ${res.status} for ${path}: ${JSON.stringify(data)}`);
  return { status: res.status, data };
}

/** Best effort, for the one question worth asking a signerd that may not be running. */
async function ask(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await request(path);
    return res.ok ? ((await res.json()) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

switch (cmd) {
  case "status":
    console.log(JSON.stringify((await call("/status")).data, null, 2));
    break;
  case "pending":
    console.log(JSON.stringify((await call("/pending")).data, null, 2));
    break;
  case "preflight": {
    const { data } = await call("/preflight");
    const r = data as {
      network: string;
      address: string;
      policyFile: string;
      auditFile: string;
      ledgerEntries: number;
      pending: number;
      checks: Array<{ level: "ok" | "warn" | "fail"; check: string; detail: string }>;
      summary: { fail: number; warn: number; ok: number };
    };
    console.log(`network   ${r.network}`);
    console.log(`address   ${r.address}`);
    console.log(`policy    ${r.policyFile}`);
    console.log(`audit     ${r.auditFile}  (${r.ledgerEntries} spends in the last 24h)`);
    console.log("");
    const mark = { ok: "  ok  ", warn: " WARN ", fail: " FAIL " };
    for (const c of r.checks) console.log(`[${mark[c.level]}] ${c.check}
           ${c.detail}`);
    console.log("");
    console.log(`${r.summary.ok} ok, ${r.summary.warn} warning(s), ${r.summary.fail} failure(s)`);
    if (r.summary.fail) {
      console.log("Not ready: resolve the failures above.");
      process.exitCode = 1;
    } else if (r.summary.warn) {
      console.log("Each warning is a decision, not a bug — make it deliberately before real money is involved.");
    }
    break;
  }
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
    const { status, data } = await call(`/${cmd}`, { id: arg }, true);
    console.log(JSON.stringify(data));
    // exitCode rather than exit(): a hard exit here aborts inside libuv on Windows while the
    // fetch handles are still closing.
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "audit": {
    // Ask signerd where it writes rather than guessing from the working directory, where a
    // different audit.jsonl reads as "nothing ever happened".
    const f = process.env.AUDIT_FILE ?? ((await ask("/preflight"))?.auditFile as string | undefined) ?? "./audit.jsonl";
    if (!existsSync(f)) die(`no audit file at ${resolvePath(f)} — set AUDIT_FILE, or start signerd so it can say where it writes`);
    const n = Number(arg ?? 20);
    if (!Number.isInteger(n) || n <= 0) die(`audit takes a positive number of records, got "${arg}"`);
    const lines = readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
    console.log(lines.slice(-n).join("\n"));
    break;
  }
  case "channels":
    console.log(JSON.stringify((await call("/channels")).data, null, 2));
    break;
  case "refund": {
    // signerd builds and signs the refund but talks to no seller: the 402 and the answer travel
    // through here, as a payment's travel through the agent's process.
    if (!arg || !arg2) die("refund needs a channel id and the seller's URL — run: walletctl channels");
    let probe: Response;
    try {
      probe = await fetch(arg2);
    } catch (e) {
      die(`cannot reach ${arg2}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const required = probe.headers.get("PAYMENT-REQUIRED");
    if (probe.status !== 402 || !required) die(`${arg2} answered ${probe.status} without a 402 to refund against`);
    const { data } = await call("/channels/refund", { channelId: arg, paymentRequired: decodePaymentRequiredHeader(required) });
    const paymentPayload = (data as { paymentPayload: Parameters<typeof encodePaymentSignatureHeader>[0] }).paymentPayload;
    const res = await fetch(arg2, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) } });
    const header = res.headers.get("PAYMENT-RESPONSE");
    if (!header) die(`the seller answered ${res.status} with no settlement: ${(await res.text()).slice(0, 300)}`);
    const settleResponse = decodePaymentResponseHeader(header);
    console.log(JSON.stringify((await call("/channels/refund/result", { channelId: arg, paymentPayload, settleResponse })).data));
    if (!settleResponse.success) process.exitCode = 1;
    break;
  }
  case "close":
  case "end":
  case "elapse": {
    if (!arg) die(`${cmd} needs a channel id — run: walletctl channels`);
    const { status, data } = await call(`/channels/${cmd}`, { channelId: arg }, true);
    console.log(JSON.stringify(data));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "recover":
    if (!arg) die("recover needs the agent id whose channels to look for");
    console.log(JSON.stringify((await call("/channels/recover", { agentId: arg })).data, null, 2));
    break;
  default:
    console.log(USAGE);
}
