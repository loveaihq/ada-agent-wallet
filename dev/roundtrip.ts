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
 * Env: SIGNERD_TOKEN, SIGNERD_URL, AGENT_ID, RESOURCE_URL
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = resolve(HERE, "../src/mcp.ts");
const RESOURCE_URL = process.env.RESOURCE_URL ?? "http://127.0.0.1:7401";

const MODES = {
  auto: { path: "/quote", reason: "round-trip check: buy a price quote under the approval threshold" },
  approve: { path: "/report", reason: "round-trip check: buy the full report, over the approval threshold" },
  deny: { path: "/premium", reason: "round-trip check: premium data, deliberately over perTxMax" },
} as const;

const mode = (process.argv[2] ?? "auto") as keyof typeof MODES;
if (!MODES[mode]) {
  console.error(`roundtrip: mode must be one of ${Object.keys(MODES).join(" | ")}`);
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

const { path, reason } = MODES[mode];
step(`x402_fetch ${RESOURCE_URL}${path}   (mode: ${mode})`);
if (mode === "approve") {
  step("this will block until you approve it: npm run walletctl -- pending, then approve <id>");
}

const started = Date.now();
const out = await client.callTool(
  { name: "x402_fetch", arguments: { url: `${RESOURCE_URL}${path}`, reason } },
  undefined,
  { timeout: 15 * 60 * 1000 },
);
step(`x402_fetch returned after ${((Date.now() - started) / 1000).toFixed(1)}s:`);
console.log(text(out));

await client.close();

const body = text(out);
const ok =
  mode === "deny"
    ? /"denied":\s*true/.test(body)
    : /"status":\s*200/.test(body) && /"paid":\s*true/.test(body);
step(ok ? `PASS (${mode})` : `FAIL (${mode}) — see the output above`);
process.exit(ok ? 0 : 1);

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map(c => c.text ?? "").join("\n");
}
function step(msg: string) {
  console.log(`\n=== ${msg}`);
}
