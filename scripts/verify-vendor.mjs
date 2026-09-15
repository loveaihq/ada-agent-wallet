#!/usr/bin/env node
/**
 * Verifies the vendored @x402 packages.
 *
 * Two levels, because they answer different questions:
 *
 *   npm run verify:vendor
 *     Are the tarballs in vendor/ the exact bytes this project was built and tested against?
 *     SHA-256 against vendor/checksums.txt. Cheap, offline, and what CI should run every time.
 *
 *   npm run verify:vendor -- --provenance <path-to-an-x402-checkout>
 *     Were those bytes built from the upstream commit vendor/PROVENANCE.md names?
 *     The published bundles carry `sourcesContent` in their .map files, so the original TypeScript
 *     can be recovered from the artifact itself and diffed against the checkout. That is a stronger
 *     claim than a checksum — it says what the code *is*, not merely that it has not changed —
 *     without needing to reproduce the build byte for byte.
 *
 * What neither level does: tell you the code is correct or safe. Provenance is not review.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor");
const CHECKSUMS = join(VENDOR, "checksums.txt");

const args = process.argv.slice(2);
const provenanceAt = args.includes("--provenance") ? args[args.indexOf("--provenance") + 1] : undefined;

let failed = false;
const fail = (msg) => {
  console.error(`  FAIL  ${msg}`);
  failed = true;
};
const ok = (msg) => console.log(`  ok    ${msg}`);

// ---------------------------------------------------------------- checksums

if (!existsSync(CHECKSUMS)) {
  console.error(`verify-vendor: ${CHECKSUMS} is missing; there is nothing to verify against.`);
  process.exit(1);
}

const expected = new Map();
for (const line of readFileSync(CHECKSUMS, "utf8").split("\n")) {
  const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/);
  if (m) expected.set(m[2], m[1]);
}

const present = readdirSync(VENDOR).filter((f) => f.endsWith(".tgz"));
console.log(`checksums (${CHECKSUMS})`);
for (const file of present) {
  const want = expected.get(file);
  const got = createHash("sha256").update(readFileSync(join(VENDOR, file))).digest("hex");
  if (!want) fail(`${file} is in vendor/ but not in checksums.txt — nothing pins it`);
  else if (want !== got) fail(`${file}\n          expected ${want}\n          actual   ${got}`);
  else ok(`${file}  ${got.slice(0, 16)}…`);
}
for (const file of expected.keys()) {
  if (!present.includes(file)) fail(`${file} is pinned in checksums.txt but missing from vendor/`);
}

// --------------------------------------------------------------- provenance

if (provenanceAt) {
  const manifest = JSON.parse(readFileSync(join(VENDOR, "provenance.json"), "utf8"));
  const checkout = resolve(provenanceAt);
  console.log(`\nprovenance against ${checkout}`);

  let head;
  try {
    head = execFileSync("git", ["-C", checkout, "rev-parse", manifest.commit + "^{commit}"], { encoding: "utf8" }).trim();
  } catch {
    fail(`commit ${manifest.commit} is not in that checkout (fetch it first)`);
    head = undefined;
  }
  if (head) {
    ok(`commit ${head}`);
    for (const pkg of manifest.packages) {
      const recovered = await recoverSources(join(VENDOR, pkg.tarball));
      const names = [...recovered.keys()].sort();
      if (names.length === 0) {
        fail(`${pkg.tarball} carries no sourcesContent; provenance cannot be checked this way`);
        continue;
      }
      let same = 0;
      const differing = [];
      for (const [rel, content] of recovered) {
        let upstream;
        try {
          upstream = execFileSync("git", ["-C", checkout, "show", `${manifest.commit}:${pkg.path}/${rel}`], {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
          });
        } catch {
          differing.push(`${rel} (absent upstream)`);
          continue;
        }
        if (normalize(upstream) === normalize(content)) same++;
        else differing.push(rel);
      }
      if (differing.length) {
        fail(`${pkg.tarball}: ${same}/${recovered.size} files match ${pkg.path} at ${manifest.commit.slice(0, 12)}`);
        for (const d of differing.slice(0, 10)) console.error(`          ${d}`);
      } else {
        ok(`${pkg.tarball}: ${same}/${recovered.size} recovered sources identical to ${pkg.path}`);
      }
    }
  }
} else {
  console.log(`\nprovenance: not checked. To verify the vendored bytes were built from the commit`);
  console.log(`vendor/PROVENANCE.md names, clone the upstream repo and re-run with:`);
  console.log(`  npm run verify:vendor -- --provenance /path/to/x402`);
}

process.exit(failed ? 1 : 0);

/** Line endings are a packaging artifact, not a source difference. */
function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

/** Pulls every `sourcesContent` entry out of the ESM source maps inside a packed tarball. */
async function recoverSources(tarball) {
  const raw = await gunzip(readFileSync(tarball));
  const out = new Map();
  for (const entry of readTar(raw)) {
    if (!entry.name.endsWith(".mjs.map")) continue;
    let map;
    try {
      map = JSON.parse(entry.data.toString("utf8"));
    } catch {
      continue;
    }
    const sources = map.sources ?? [];
    const contents = map.sourcesContent ?? [];
    // `sources` are relative to the emitted file, not to the package root: a map at
    // dist/esm/exact/facilitator/ refers to its input as ../../../../src/exact/facilitator/…
    // Resolving against the map's own directory turns those back into package-relative paths.
    const here = posix.dirname(entry.name.split("\\").join("/"));
    for (let i = 0; i < sources.length; i++) {
      const content = contents[i];
      if (content == null) continue;
      const abs = posix.normalize(posix.join(here, String(sources[i]).split("\\").join("/")));
      out.set(abs.replace(/^package\//, ""), content);
    }
  }
  return out;
}

function gunzip(buf) {
  return new Promise((res, rej) => {
    const chunks = [];
    Readable.from(buf).pipe(createGunzip()).on("data", (c) => chunks.push(c)).on("end", () => res(Buffer.concat(chunks))).on("error", rej);
  });
}

/** Minimal ustar reader: enough for an npm tarball, and one less dependency to trust. */
function* readTar(buf) {
  for (let off = 0; off + 512 <= buf.length; ) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (start, len) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/, "").trim();
    const name = str(0, 100);
    const prefix = str(345, 155);
    const size = parseInt(str(124, 12) || "0", 8);
    const type = str(156, 1) || "0";
    off += 512;
    if (type === "0" || type === "") {
      yield { name: prefix ? `${prefix}/${name}` : name, data: buf.subarray(off, off + size) };
    }
    off += Math.ceil(size / 512) * 512;
  }
}
