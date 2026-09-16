/**
 * End-to-end preprod driver: a real MCP client spawns src/mcp.ts and calls its tools, so the
 * whole chain is exercised exactly as an agent would --
 *
 *   MCP x402_fetch -> @x402/fetch 402 round-trip -> ExactCardanoScheme -> gatedSigner
 *     -> signerd (policy + key) -> @x402/cardano builds and signs
 *     -> facilitator verify + settle (broadcast, await inclusion) -> resource 200
 *
 * Modes (argv[2]):
 *   auto     GET /quote    1.5 tADA  under approvalAbove -> signs unattended, expects 200 + paid
 *   approve  GET /report    4  tADA  over approvalAbove  -> parks in the queue; approve it with
 *                                    `npm run walletctl -- approve <id>` in another shell
 *   deny     GET /premium    6 tADA  over perTxMax       -> expects a policy denial, nothing signed
 *
 * Transport (argv[3]): `http` (default) buys GET <path> from dev/resource.ts through x402_fetch;
 * `mcp` buys the same-priced tool from dev/mcpresource.ts through x402_mcp_call. Same modes, same
 * checks, so the policy, the queue and the ledger are held to one standard for both ways a 402
 * can arrive.
 *
 * Env: SIGNERD_TOKEN, SIGNERD_URL, AGENT_ID, RESOURCE_URL, MCP_RESOURCE_URL
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = resolve(HERE, "../src/mcp.ts");
const RESOURCE_URL = process.env.RESOURCE_URL ?? "http://127.0.0.1:7401";
const MCP_RESOURCE_URL = process.env.MCP_RESOURCE_URL ?? "http://127.0.0.1:7404/mcp";

const MODES = {
  auto: { path: "/quote", tool: "quote", reason: "round-trip check: buy a price quote under the approval threshold" },
  approve: { path: "/report", tool: "report", reason: "round-trip check: buy the full report, over the approval threshold", queues: true },
  // `rule` matters: "denied" alone passes for any reason at all, including a daemon that is simply
  // broken, which is the opposite of what this is meant to prove.
  deny: { path: "/premium", tool: "premium", reason: "round-trip check: premium data, deliberately over perTxMax", rule: "per_tx_max" },
} as const;

const mode = (process.argv[2] ?? "auto") as keyof typeof MODES;
if (!MODES[mode]) {
  console.error(`roundtrip: mode must be one of ${Object.keys(MODES).join(" | ")}`);
  process.exit(1);
}
const via = process.argv[3] ?? "http";
if (via !== "http" && via !== "mcp") {
  console.error("roundtrip: transport must be http | mcp");
  process.exit(1);
}
if (!process.env.SIGNERD_TOKEN) {
  console.error("roundtrip: SIGNERD_TOKEN is required (source .env.local)");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.platform === "win32" ? "npx.cmd" : "npx",
  args: ["tsx", MCP_ENTRY],
  env: {
    ...(process.env as Record<string, string>),
    SIGNERD_TOKEN: process.env.SIGNERD_TOKEN,
    SIGNERD_URL: process.env.SIGNERD_URL ?? "http://127.0.0.1:7402",
    AGENT_ID: process.env.AGENT_ID ?? "default",
  },
  stderr: "inherit",
});

const client = new Client({ name: "roundtrip", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
step(`tools: ${tools.tools.map(t => t.name).join(", ")}`);

const status = await client.callTool({ name: "wallet_status", arguments: {} });
step("wallet_status:");
console.log(text(status));

const { path, tool, reason } = MODES[mode];
step(via === "mcp" ? `x402_mcp_call ${MCP_RESOURCE_URL} ${tool}   (mode: ${mode})` : `x402_fetch ${RESOURCE_URL}${path}   (mode: ${mode})`);
if (mode === "approve") {
  step("this will block until you approve it: npm run walletctl -- pending, then approve <id>");
}

// Watch the approval queue while the call is in flight. Without this, "200 and paid" is all the
// approve run ever checks — and a threshold misconfigured low enough to sign unattended looks
// exactly the same from here.
let everQueued = false;
const watching = "queues" in MODES[mode] ? setInterval(pollPending, 1000) : undefined;
async function pollPending() {
  try {
    const r = await fetch(`${process.env.SIGNERD_URL ?? "http://127.0.0.1:7402"}/pending`, {
      headers: { authorization: `Bearer ${process.env.SIGNERD_TOKEN}` },
    });
    if (r.ok && ((await r.json()) as unknown[]).length > 0) everQueued = true;
  } catch {
    // signerd will be asked again in a second
  }
}

const started = Date.now();
const call = () =>
  client.callTool(
    via === "mcp"
      ? { name: "x402_mcp_call", arguments: { server: MCP_RESOURCE_URL, tool, reason } }
      : { name: "x402_fetch", arguments: { url: `${RESOURCE_URL}${path}`, reason } },
    undefined,
    { timeout: 15 * 60 * 1000 },
  );

let out = await call();
// `utxo_busy` is signerd saying "come back", and this wallet has one UTXO, so any check that ran
// just before this one is holding it. Honouring the retryable flag is both what an agent should do
// and what keeps these suites from failing each other when run back to back.
if (/"rule":\s*"utxo_busy"/.test(text(out))) {
  const wait = Number(process.env.NONCE_HOLD_SECONDS ?? 120) + 5;
  step(`the wallet's UTXO is held by an unsettled payment; waiting ${wait}s and trying once more`);
  await new Promise(r => setTimeout(r, wait * 1000));
  out = await call();
}
clearInterval(watching);
step(`${via === "mcp" ? "x402_mcp_call" : "x402_fetch"} returned after ${((Date.now() - started) / 1000).toFixed(1)}s:`);
console.log(text(out));

await client.close();

const reply = text(out);
let result: { status?: number; paid?: boolean; denied?: boolean; rule?: string; transaction?: string } | undefined;
try {
  result = JSON.parse(reply);
} catch {
  // "error: ..." is not a verdict, and dying on the parse would hide what it said instead.
}
if (result?.transaction) step(`transaction ${result.transaction}`);
const expect = MODES[mode];
const problems: string[] = [];
if (!result) {
  problems.push(`the tool answered with no verdict at all: ${reply.slice(0, 300)}`);
} else if ("rule" in expect) {
  if (result.denied !== true) problems.push("expected the payment to be denied");
  else if (result.rule !== expect.rule) problems.push(`expected rule ${expect.rule}, got ${result.rule}`);
} else {
  if (via === "http" && result.status !== 200) problems.push(`expected HTTP 200, got ${result.status}`);
  if (via === "mcp" && out.isError) problems.push("the paid tool call came back as an error");
  if (result.paid !== true) problems.push("the response carried no payment receipt");
  // Both tools now carry the receipt. `paid` without one would be the old lie back again.
  if (result.paid === true && !result.transaction) problems.push("it says it paid, but no transaction came back to show for it");
  if ("queues" in expect && !everQueued) problems.push("the payment never appeared in the approval queue");
}
for (const p of problems) console.error(`  FAIL: ${p}`);
step(problems.length ? `FAIL (${mode} via ${via})` : `PASS (${mode} via ${via})`);
process.exit(problems.length ? 1 : 0);

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map(c => c.text ?? "").join("\n");
}
function step(msg: string) {
  console.log(`\n=== ${msg}`);
}
