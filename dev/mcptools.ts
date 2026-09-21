/**
 * The MCP-side x402 tools: that they register, and that the payment client survives the hand-off.
 *
 * The tools are registered by `src/mcp.ts` and the payment client it builds is handed to
 * `@x402/mcp`'s `wrapMCPClientWithPayment`. Types agree now that both come from one `@x402/core`,
 * but agreeing at compile time is not the same as the hand-off working, which is what this runs.
 *
 * Not covered: an actual paid MCP tool call. That needs a seller-side MCP server and a chain;
 * everything here stops before a payment, so it runs anywhere.
 *
 * Env: nothing. Uses a throwaway mnemonic and temp files.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "..");
const MNEMONIC = Array(23).fill("abandon").join(" ") + " art";
const TOKEN = "mcptools-check-token-0123456789ab";
const PORT = "7412";
const EXPECTED = ["wallet_status", "x402_fetch", "x402_mcp_tools", "x402_mcp_call"];
// Chosen to be closed. The point is the error, not the connection.
const DEAD_SERVER = "http://127.0.0.1:59999/mcp";

const dir = mkdtempSync(join(tmpdir(), "mcptools-"));
const POLICY_FILE = join(dir, "policy.json");
writeFileSync(POLICY_FILE, readFileSync(join(ROOT, "policy.example.json"), "utf8"));

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  WALLET_MNEMONIC: MNEMONIC,
  SIGNERD_TOKEN: TOKEN,
  SIGNERD_PORT: PORT,
  SIGNERD_URL: `http://127.0.0.1:${PORT}`,
  CARDANO_NETWORK: "cardano:preprod",
  AGENT_ID: "default",
  POLICY_FILE,
  AUDIT_FILE: join(dir, "audit.jsonl"),
  LEDGER_FILE: join(dir, "ledger.json"),
};

let failures = 0;
const check = (ok: boolean, what: string, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const step = (msg: string) => console.log(`\n=== ${msg}`);
const text = (r: unknown) => ((r as { content?: Array<{ text?: string }> }).content ?? []).map(c => c.text ?? "").join("\n");

let signerd: ChildProcess | undefined;
let client: Client | undefined;
try {
  step("signerd");
  signerd = spawn("node", ["--import", "tsx", "src/signerd.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  signerd.stdout?.on("data", d => (log += d));
  signerd.stderr?.on("data", d => (log += d));

  // tsx takes its time on a cold start; the deadline is for a daemon that is not coming up at all.
  const deadline = Date.now() + 120_000;
  let address: string | undefined;
  while (Date.now() < deadline && address === undefined) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (r.ok) address = ((await r.json()) as { address?: string }).address;
    } catch {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  if (address === undefined) {
    console.error(`signerd never answered /status:\n${log.slice(-2000)}`);
    process.exit(1);
  }
  check(true, `up at 127.0.0.1:${PORT}`, address);

  step("mcp server over stdio");
  client = new Client({ name: "mcptools-check", version: "0.1.0" });
  await client.connect(new StdioClientTransport({ command: process.platform === "win32" ? "npx.cmd" : "npx", args: ["tsx", "src/mcp.ts"], cwd: ROOT, env, stderr: "inherit" }));
  // Reaching here is itself the first result: mcp.ts asserts the two methods `@x402/mcp` needs on
  // the payment client at load, so a broken hand-off would have died before the transport opened.
  const names = (await client.listTools()).tools.map(t => t.name);
  console.log(`  tools: ${names.join(", ")}`);
  for (const want of EXPECTED) check(names.includes(want), `${want} registered`);

  step("the payment client is really handed over");
  const dead = await client.callTool({ name: "x402_mcp_tools", arguments: { server: DEAD_SERVER } });
  const said = text(dead);
  // `wrapMCPClientWithPayment` runs before `connect`, so a connect error — rather than a TypeError
  // out of the wrapper — is what says the client was accepted.
  check(Boolean(dead.isError), "a dead server is an error, not a result");
  check(/could not connect to the MCP server/.test(said), "and a connect error the agent can act on", said.slice(0, 160));
  check(!/is not a function|undefined is not|TypeError/.test(said), "not a TypeError from inside the wrapper", said.slice(0, 160));

  step("the policy gate still covers the HTTP path");
  const status = text(await client.callTool({ name: "wallet_status", arguments: {} }));
  check(status.includes(address), "wallet_status still answers with the wallet address");
} finally {
  await client?.close().catch(() => {});
  signerd?.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nmcptools: ok" : `\nmcptools: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
