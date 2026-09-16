/**
 * Whose reason is whose, when two tool calls are in flight at once.
 *
 * `src/mcp.ts` reaches the signer through `@x402/fetch`, which takes no argument of ours to thread
 * state through, so the reason a payment is audited under is fetched from a callback with nothing
 * but ambient context to go on. That is what the `AsyncLocalStorage` in mcp.ts is for, and its
 * comment says so: module-level slots "would let one concurrent tool call's reason land in
 * another's audit record". Nothing had ever made two calls at once, so the claim was untested.
 *
 * Two `x402_fetch` calls, fired together on one MCP client, at two prices that take two different
 * paths through the policy — one signs, one is refused. Then the audit is read back and each
 * decision has to carry the reason of the call that caused it. Crossed reasons are the failure.
 *
 * Signs and settles one payment (1.5 tADA). Needs the dev stack and a funded wallet; see README,
 * "Dev stack". With Koios the settle step cannot complete — set BLOCKFROST_PROJECT_ID.
 *
 * Env: SIGNERD_TOKEN, SIGNERD_URL, RESOURCE_URL, AGENT_ID
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = resolve(HERE, "../src/mcp.ts");
const RESOURCE_URL = process.env.RESOURCE_URL ?? "http://127.0.0.1:7401";
const SIGNERD_URL = process.env.SIGNERD_URL ?? "http://127.0.0.1:7402";
const TOKEN = process.env.SIGNERD_TOKEN;
if (!TOKEN) {
  console.error("context: SIGNERD_TOKEN is required (source .env.local)");
  process.exit(1);
}

/**
 * The markers are the whole point: each has to come back attached to its own decision, so they are
 * written to be impossible to confuse and impossible to produce by accident.
 */
const ALPHA = { path: "/quote", marker: "ALPHA", amount: "1500000", verdict: "signed" } as const;
const BETA = { path: "/premium", marker: "BETA", amount: "6000000", verdict: "denied" } as const;
const reasonFor = (c: typeof ALPHA | typeof BETA) =>
  `${c.marker}: this reason belongs to the ${c.marker} call for ${c.path}, and to no other`;

const problems: string[] = [];
const check = (condition: boolean, description: string) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) problems.push(description);
};
const step = (msg: string) => console.log(`\n=== ${msg}`);
const text = (result: unknown): string =>
  ((result as { content?: Array<{ text?: string }> }).content ?? []).map(c => c.text ?? "").join("\n");

/** Ask signerd where it writes rather than guessing from the working directory. */
const preflight = (await fetch(`${SIGNERD_URL}/preflight`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(r =>
  r.json(),
)) as { auditFile: string };
const AUDIT = preflight.auditFile;
const records = (): Array<Record<string, string>> =>
  existsSync(AUDIT)
    ? readFileSync(AUDIT, "utf8")
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
const before = records().length;

const transport = new StdioClientTransport({
  command: process.platform === "win32" ? "npx.cmd" : "npx",
  args: ["tsx", MCP_ENTRY],
  env: {
    ...(process.env as Record<string, string>),
    SIGNERD_TOKEN: TOKEN,
    SIGNERD_URL,
    AGENT_ID: process.env.AGENT_ID ?? "default",
  },
  stderr: "inherit",
});
const client = new Client({ name: "context", version: "0.1.0" });
await client.connect(transport);

const call = (c: typeof ALPHA | typeof BETA) =>
  client.callTool(
    { name: "x402_fetch", arguments: { url: `${RESOURCE_URL}${c.path}`, reason: reasonFor(c) } },
    undefined,
    { timeout: 15 * 60 * 1000 },
  );

step("two x402_fetch calls, fired together");
console.log(`  ${ALPHA.marker} -> ${ALPHA.path}  (${ALPHA.amount} lovelace, under the caps: signs)`);
console.log(`  ${BETA.marker} -> ${BETA.path}   (${BETA.amount} lovelace, over perTxMax: refused)`);
const started = Date.now();
const [alphaOut, betaOut] = await Promise.all([call(ALPHA), call(BETA)]);
step(`both returned after ${((Date.now() - started) / 1000).toFixed(1)}s`);
await client.close();

const alpha = JSON.parse(text(alphaOut)) as { status?: number; paid?: boolean; rule?: string };
const beta = JSON.parse(text(betaOut)) as { denied?: boolean; rule?: string };
console.log(`  ${ALPHA.marker}: ${JSON.stringify(alpha).slice(0, 120)}`);
console.log(`  ${BETA.marker}: ${JSON.stringify(beta).slice(0, 120)}`);

// The pairing is only worth reading if both calls took the path they were meant to.
check(alpha.status === 200 && alpha.paid === true, `${ALPHA.marker} was paid and served (status ${alpha.status}, paid ${alpha.paid})`);
check(beta.denied === true && beta.rule === "per_tx_max", `${BETA.marker} was refused on per_tx_max (${beta.rule})`);

step("the audit records each call wrote");
const written = records().slice(before);
for (const r of written) console.log(`  ${r.event}  ${r.amount ?? ""}  reason=${String(r.reason).slice(0, 44)}…`);

const signed = written.find(r => r.event === ALPHA.verdict && r.amount === ALPHA.amount);
const denied = written.find(r => r.event === BETA.verdict && r.amount === BETA.amount);
check(signed !== undefined, `the ${ALPHA.amount} payment was audited as ${ALPHA.verdict}`);
check(denied !== undefined, `the ${BETA.amount} payment was audited as ${BETA.verdict}`);

// The claim under test. A module-level slot would put whichever call set it last on both records.
check(
  String(signed?.reason).startsWith(`${ALPHA.marker}:`),
  `the signed payment carries ${ALPHA.marker}'s reason, not the other call's (${String(signed?.reason).slice(0, 24)}…)`,
);
check(
  String(denied?.reason).startsWith(`${BETA.marker}:`),
  `the refused payment carries ${BETA.marker}'s reason (${String(denied?.reason).slice(0, 24)}…)`,
);

console.log(
  problems.length
    ? `\nFAIL — ${problems.length} check(s) failed`
    : "\nPASS — concurrent tool calls keep their own reasons all the way into the log",
);
process.exit(problems.length ? 1 : 0);
