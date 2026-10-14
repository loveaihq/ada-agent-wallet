import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactCardanoScheme } from "@x402/cardano";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { MCP_NO_REDIRECTS, redirectTo, withoutRedirects } from "../src/redirects.ts";

// Everything here is 127.0.0.1: two servers on two ports are two origins, and nothing leaves the
// machine. The client is the one mcp.ts builds, with a signer that only records what it was asked.

test("redirectTo reads where a 3xx points, against the URL that was asked for", () => {
  for (const status of [301, 302, 303, 307, 308]) assert.equal(redirectTo("https://a.example/x", status, "https://b.example/y"), "https://b.example/y", String(status));
  assert.equal(redirectTo("https://a.example/v1/x", 302, "/v2/y"), "https://a.example/v2/y");
  assert.equal(redirectTo("https://a.example/v1/x", 302, "z"), "https://a.example/v1/z");
  // Not a redirect, or nowhere to go.
  assert.equal(redirectTo("https://a.example/x", 200, "https://b.example/"), undefined);
  assert.equal(redirectTo("https://a.example/x", 402, "https://b.example/"), undefined);
  assert.equal(redirectTo("https://a.example/x", 304, "https://b.example/"), undefined);
  assert.equal(redirectTo("https://a.example/x", 302, null), undefined);
  assert.equal(redirectTo("https://a.example/x", 302, "http://[bad"), undefined);
});

test("withoutRedirects overrides whatever the caller asked for", async () => {
  const seen: Array<RequestInit | undefined> = [];
  const base = (async (_input: unknown, init?: RequestInit) => {
    seen.push(init);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const f = withoutRedirects(base);
  await f("http://127.0.0.1:1/", { method: "POST", redirect: "follow", headers: { a: "b" } });
  await f("http://127.0.0.1:1/");
  assert.equal(seen[0]?.redirect, "manual");
  assert.equal(seen[0]?.method, "POST", "and keeps the rest of the init");
  assert.deepEqual(seen[0]?.headers, { a: "b" });
  assert.equal(seen[1]?.redirect, "manual");
});

const listening: Server[] = [];
const listen = (s: Server) =>
  new Promise<number>(resolve => {
    listening.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
after(async () => {
  await Promise.all(listening.map(s => new Promise<void>(r => (s.closeAllConnections(), s.close(() => r())))));
});

const PAYEE = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp";
const USDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";

/** An x402 seller: 402 until a payment header arrives, then 200. Counts what reached it. */
async function seller() {
  const hits: Array<{ path: string; paid: boolean }> = [];
  const server = createServer((req, res) => {
    const paid = Boolean(req.headers["payment-signature"]);
    hits.push({ path: req.url ?? "", paid });
    if (paid) {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("delivered after payment");
    }
    const required = {
      x402Version: 2,
      resource: { url: `http://${req.headers.host}${req.url}`, description: "other origin", mimeType: "text/plain" },
      accepts: [{ scheme: "exact", network: "cardano:preprod", payTo: PAYEE, asset: USDM, amount: "1000000", maxTimeoutSeconds: 300, extra: {} }],
    };
    res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never), "content-type": "application/json" });
    res.end("{}");
  });
  return { port: await listen(server), hits };
}

/** The client mcp.ts builds, with a signer that signs nothing and says what it was asked. */
function recordingClient() {
  const asked: Array<{ payTo: string; amount: string }> = [];
  const signer = {
    getAddress: () => "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz",
    async buildAndSignPaymentTransaction(input: { payTo: string; amount: string }) {
      asked.push({ payTo: input.payTo, amount: input.amount });
      return { transaction: "AAAA", nonce: `${"11".repeat(32)}#0` };
    },
  };
  const client = x402Client.fromConfig({
    schemes: [{ network: "cardano:*", client: new ExactCardanoScheme(signer as never) }],
    spendControls: false,
  } as never);
  return { client, asked };
}

test("x402_fetch: a redirect to another origin is handed back unpaid, and the new address is never contacted", async () => {
  const other = await seller();
  const origin = createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${other.port}/paid-thing` });
    res.end();
  });
  const originPort = await listen(origin);
  const { client, asked } = recordingClient();
  const asking = `http://127.0.0.1:${originPort}/allowed/thing`;

  const r = await wrapFetchWithPayment(withoutRedirects(fetch), client)(asking, { method: "GET" });
  assert.equal(r.status, 302);
  assert.equal(redirectTo(asking, r.status, r.headers.get("location")), `http://127.0.0.1:${other.port}/paid-thing`);
  assert.deepEqual(other.hits, [], "the other origin was never asked");
  assert.deepEqual(asked, [], "so signerd would never have been asked to sign for it");
});

test("x402_fetch, for contrast: a fetch that follows redirects pays at the destination", async () => {
  // This is what mcp.ts did before, and why the test above is not passing for nothing.
  const other = await seller();
  const origin = createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${other.port}/paid-thing` });
    res.end();
  });
  const originPort = await listen(origin);
  const { client, asked } = recordingClient();

  const r = await wrapFetchWithPayment(fetch, client)(`http://127.0.0.1:${originPort}/allowed/thing`, { method: "GET" });
  assert.equal(r.status, 200);
  assert.deepEqual(other.hits.map(h => h.paid), [false, true]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].payTo, PAYEE);
});

test("x402_fetch: a redirect after payment is also handed back, not followed", async () => {
  const other = await seller();
  // The seller takes the payment and then sends the agent on.
  const origin = createServer((req, res) => {
    if (!req.headers["payment-signature"]) {
      const required = {
        x402Version: 2,
        resource: { url: `http://${req.headers.host}${req.url}`, description: "x", mimeType: "text/plain" },
        accepts: [{ scheme: "exact", network: "cardano:preprod", payTo: PAYEE, asset: USDM, amount: "1000000", maxTimeoutSeconds: 300, extra: {} }],
      };
      res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never) });
      return res.end("{}");
    }
    res.writeHead(307, { location: `http://127.0.0.1:${other.port}/after` });
    res.end();
  });
  const originPort = await listen(origin);
  const { client, asked } = recordingClient();
  const r = await wrapFetchWithPayment(withoutRedirects(fetch), client)(`http://127.0.0.1:${originPort}/thing`, { method: "GET" });
  assert.equal(r.status, 307);
  assert.equal(asked.length, 1, "the one payment was for the address the agent named");
  assert.deepEqual(other.hits, []);
});

// ---- the MCP transports --------------------------------------------------------------------------

async function redirecting() {
  const other = await seller();
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    // /mcp and /sse go to another origin; /moved goes to another path on this one.
    const to = req.url === "/moved" ? "/elsewhere" : req.url === "/elsewhere" ? undefined : `http://127.0.0.1:${other.port}/stolen`;
    if (!to) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(307, { location: to });
    res.end();
  });
  return { port: await listen(server), hits, other };
}

const connect = (transport: StreamableHTTPClientTransport | SSEClientTransport) =>
  new Client({ name: "test", version: "0" }).connect(transport);

test("an MCP server that redirects to another origin is not followed, over HTTP", async () => {
  const s = await redirecting();
  await assert.rejects(() => connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), MCP_NO_REDIRECTS)), /not followed|307/);
  assert.deepEqual(s.other.hits, []);
});

test("an MCP server that redirects to another path of its own origin is not followed either", async () => {
  const s = await redirecting();
  await assert.rejects(() => connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/moved`), MCP_NO_REDIRECTS)), /not followed|307/);
  assert.deepEqual(s.hits, ["/moved"], "only the URL the agent named was requested");
});

test("for contrast, the SDK's own default follows a same-origin redirect, which is a different resource", async () => {
  const s = await redirecting();
  await assert.rejects(() => connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/moved`))));
  assert.deepEqual(s.hits.slice(0, 2), ["/moved", "/elsewhere"], "it went on to /elsewhere, which allowedResources never saw");
});

test("an MCP server that redirects to another origin is not followed, over SSE", async () => {
  const s = await redirecting();
  await assert.rejects(() => connect(new SSEClientTransport(new URL(`http://127.0.0.1:${s.port}/sse`), MCP_NO_REDIRECTS)));
  assert.deepEqual(s.other.hits, []);
  assert.deepEqual(s.hits, ["/sse"]);
});
