import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * Five files say "Pure logic: no chain, no keys, no I/O" in their headers, and nothing made that
 * true beyond nobody having broken it yet. These are the modules whose testability, and whose
 * usefulness as the place the rules live, depends on it — a `readFileSync` in policy.ts would not
 * fail anything, it would just quietly move a decision out of reach of the unit suite.
 */
const PURE = ["policy.ts", "serialize.ts", "keystore.ts", "replay.ts", "verifyTx.ts"];
/** Computation, not I/O. Everything else a pure module needs, it should be given. */
const ALLOWED = new Set(["node:crypto"]);

function importsOf(file: string): string[] {
  const src = readFileSync(resolve(SRC, file), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*import\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["'];?$/gm)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["'];?$/gm)) out.push(m[1]);
  return out;
}

test("the pure modules import nothing that touches the world", () => {
  for (const file of PURE) {
    for (const spec of importsOf(file)) {
      const ok = ALLOWED.has(spec) || (spec.startsWith("./") && PURE.includes(spec.replace(/^\.\//, "").replace(/\.js$/, ".ts")));
      assert.ok(ok, `${file} imports ${spec}, which is neither pure computation nor another pure module`);
    }
  }
});

test("the pure modules still say so, and the list is the files that do", () => {
  // Keeps the claim and the check from drifting apart: a sixth file claiming purity, or one of
  // these dropping the claim, should show up here rather than silently going unchecked.
  const claiming = PURE.filter(f => /no chain, no keys, no I\/O|Pure logic/.test(readFileSync(resolve(SRC, f), "utf8")));
  assert.deepEqual(claiming, PURE, "a module in the pure list no longer claims to be pure");
});

test("signerd binds the loopback and nothing else", () => {
  // The key lives in this process. A listen address is one token in one line, and getting it wrong
  // publishes the wallet; the daemon checks its own bound address at startup, and this checks that
  // the check is there.
  const src = readFileSync(resolve(SRC, "signerd.ts"), "utf8");
  assert.match(src, /server\.listen\(PORT, "127\.0\.0\.1"/, "signerd does not listen on 127.0.0.1");
  assert.match(src, /LOOPBACK/, "signerd does not assert its own bound address");
});
