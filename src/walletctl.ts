#!/usr/bin/env node
/** Operator CLI: walletctl status | pending | approve <id> | deny <id> | audit [n] */
import { readFileSync, existsSync } from "node:fs";
const URL_ = process.env.SIGNERD_URL ?? "http://127.0.0.1:7402";
const headers = { authorization: `Bearer ${process.env.SIGNERD_TOKEN ?? ""}`, "content-type": "application/json" };
const [cmd, arg] = process.argv.slice(2);
const call = (path: string, body?: unknown) =>
  fetch(URL_ + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
switch (cmd) {
  case "status": console.log(JSON.stringify(await call("/status"), null, 2)); break;
  case "pending": console.log(JSON.stringify(await call("/pending"), null, 2)); break;
  case "approve": console.log(JSON.stringify(await call("/approve", { id: arg }))); break;
  case "deny": console.log(JSON.stringify(await call("/deny", { id: arg }))); break;
  case "audit": {
    const f = process.env.AUDIT_FILE ?? "./audit.jsonl";
    const lines = existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : [];
    console.log(lines.slice(-Number(arg ?? 20)).join("\n")); break;
  }
  default: console.log("walletctl status | pending | approve <id> | deny <id> | audit [n]");
}
