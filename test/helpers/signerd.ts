/**
 * Starts the real signerd for a test, against the fake provider in ./fakeKoios.ts, with every file in
 * a directory of its own and an environment that holds nothing of the developer's: no mnemonic, no
 * API key, none of the real wallet's variables, whatever the shell running the tests has set.
 *
 * Nothing leaves 127.0.0.1. localOnly.mjs is loaded into the child to send its provider URLs to the
 * fake and to refuse any other connection, so a test that goes wrong fails rather than reaching a
 * real provider. Nothing is submitted: there is no submit path in what signerd does for `/sign`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { toClientCardanoSigner } from "@x402/cardano";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../..");
const SIGNERD = resolve(REPO, "src/signerd.ts");
const LOCAL_ONLY = pathToFileURL(resolve(HERE, "localOnly.mjs")).href;

/** The standard BIP-39 test vector for all-zero entropy: public, and worth nothing. */
export const MNEMONIC = Array(23).fill("abandon").join(" ") + " art";
/** The all-ones vector: a second wallet, for the payee. */
export const PAYEE_MNEMONIC = Array(23).fill("zoo").join(" ") + " vote";

/** Long enough for mainnet (32), and not a secret. */
export const OPERATOR_TOKEN = "operator-" + "0123456789abcdef".repeat(3);
export const AGENT_TOKEN = "agent-token-" + "fedcba9876543210".repeat(3);

const ENV_ALLOWED = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "LANG"];

/** An address of the wallet `mnemonic` on `network`, derived offline: nothing is asked of any provider. */
export function addressOn(network: string, mnemonic: string): string {
  return toClientCardanoSigner({ mnemonic, network, provider: { koios: { baseUrl: "http://127.0.0.1:9" } } }).getAddress();
}

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const bound = probe.address();
      const port = typeof bound === "object" && bound ? bound.port : 0;
      probe.close(() => (port ? resolvePort(port) : reject(new Error("could not get a free port"))));
    });
  });
}

export interface StartOptions {
  network: string;
  policy: object;
  /** Written as AGENT_TOKENS_FILE. Omit for single-token mode. */
  agentTokens?: Record<string, string>;
  /** Default `OPERATOR_TOKEN`. */
  operatorToken?: string;
  /** The fake provider's URL. */
  koios: string;
  /** Mode of the agent-tokens file; 0600 unless a test is about it. */
  tokensMode?: number;
  /** Put the mnemonic in a file of this mode, and point WALLET_MNEMONIC_FILE at it, instead of the environment. */
  mnemonicFileMode?: number;
  /** Mode of the policy file; 0600, since a mode that mainnet refuses is not what most tests are about. */
  policyMode?: number;
  /** More files for the environment to point at: written into the run's directory, with the mode given. */
  files?: Array<{ env: string; name: string; content: string; mode: number }>;
  /** Start on the files of an earlier run (its `dir`), which must have been stopped. */
  reuse?: string;
  env?: Record<string, string>;
  /** Do not wait for it to answer: for starts that are meant to be refused. */
  wait?: boolean;
}

export interface Running {
  url: string;
  dir: string;
  child: ChildProcess;
  stderr(): string;
  exited: Promise<number | null>;
  stop(): Promise<void>;
  /** Every audit record written so far. */
  audit(): Array<Record<string, unknown>>;
  /** GET/POST with a bearer token. */
  call(path: string, o?: { token?: string; method?: string; body?: unknown }): Promise<{ status: number; data: Record<string, unknown> & { [k: string]: any } }>;
}

const running: Running[] = [];
const dirs: string[] = [];

/** Stops every signerd a test started and removes the directories it made. Call from `after`. */
export async function cleanUp() {
  await Promise.all(running.splice(0).map(r => r.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export async function startSignerd(o: StartOptions): Promise<Running> {
  const dir = o.reuse ?? mkdtempSync(join(tmpdir(), "ada-signerd-test-"));
  if (!o.reuse) dirs.push(dir);
  // On Windows chmod means nothing, and signerd would report that it could not check. localOnly.mjs
  // can stand in for POSIX there (FAKE_MODES): this is the mode each file is meant to have, so that
  // the same cases run on every platform. Where modes are real, they are what is used.
  const modes: Record<string, number> = {};
  const policyFile = join(dir, "policy.json");
  writeFileSync(policyFile, JSON.stringify(o.policy));
  chmodSync(policyFile, o.policyMode ?? 0o600);
  modes[policyFile] = o.policyMode ?? 0o600;
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWED) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  if (o.agentTokens) {
    const f = join(dir, "agent-tokens.json");
    writeFileSync(f, JSON.stringify(o.agentTokens), { mode: o.tokensMode ?? 0o600 });
    if (o.tokensMode !== undefined) chmodSync(f, o.tokensMode);
    modes[f] = o.tokensMode ?? 0o600;
    env.AGENT_TOKENS_FILE = f;
  }
  if (o.mnemonicFileMode !== undefined) {
    const f = join(dir, "mnemonic");
    writeFileSync(f, MNEMONIC);
    chmodSync(f, o.mnemonicFileMode);
    modes[f] = o.mnemonicFileMode;
    env.WALLET_MNEMONIC_FILE = f;
  } else {
    env.WALLET_MNEMONIC = MNEMONIC;
  }
  for (const f of o.files ?? []) {
    const path = join(dir, f.name);
    writeFileSync(path, f.content);
    chmodSync(path, f.mode);
    modes[path] = f.mode;
    env[f.env] = path;
  }
  if (process.platform === "win32") env.FAKE_MODES = JSON.stringify(modes);
  const port = await freePort();
  const token = o.operatorToken ?? OPERATOR_TOKEN;
  Object.assign(env, {
    SIGNERD_TOKEN: token,
    SIGNERD_PORT: String(port),
    CARDANO_NETWORK: o.network,
    POLICY_FILE: policyFile,
    AUDIT_FILE: join(dir, "audit.jsonl"),
    LEDGER_FILE: join(dir, "ledger.json"),
    CHANNELS_DIR: join(dir, "channels"),
    FAKE_KOIOS_URL: o.koios,
    // No release pass: it would ask the fake for a chain tip it does not serve.
    RELEASE_EXPIRED_SPENDS: "0",
    NONCE_HOLD_SECONDS: "1",
    ...o.env,
  });
  mkdirSync(join(dir, "channels"), { recursive: true });

  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", "--import", LOCAL_ONLY, SIGNERD], { cwd: REPO, env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", c => (stderr += c));
  const exited = new Promise<number | null>(r => child.on("exit", code => r(code)));
  const url = `http://127.0.0.1:${port}`;

  const call: Running["call"] = async (path, c = {}) => {
    const r = await fetch(url + path, {
      method: c.method ?? (c.body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${c.token ?? token}`, "content-type": "application/json" },
      body: c.body === undefined ? undefined : JSON.stringify(c.body),
    });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as never };
  };
  const auditFile = join(dir, "audit.jsonl");
  const r: Running = {
    url,
    dir,
    child,
    stderr: () => stderr,
    exited,
    stop: async () => {
      if (child.exitCode === null) child.kill();
      await exited;
    },
    audit: () =>
      existsSync(auditFile)
        ? readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
        : [],
    call,
  };
  running.push(r);

  if (o.wait !== false) {
    for (let i = 0; i < 240; i++) {
      if (child.exitCode !== null) throw new Error(`signerd exited ${child.exitCode}:\n${stderr}`);
      try {
        if ((await call("/status")).status === 200) return r;
      } catch {
        /* not up yet */
      }
      await new Promise(done => setTimeout(done, 500));
    }
    throw new Error(`signerd did not come up in 120s:\n${stderr}`);
  }
  return r;
}

/**
 * The exit code of a signerd that is expected to refuse to start. A daemon that starts when it should
 * not is a failure of the test, not a reason for it to wait for ever.
 */
export async function exitCode(s: Running, ms = 30_000): Promise<number | null> {
  const timer = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error(`signerd was meant to refuse to start and is still running after ${ms}ms:
${s.stderr()}`)), ms);
    t.unref();
  });
  return Promise.race([s.exited, timer]);
}

/** A payment request as mcp.ts would send it, for `network`. */
export function signRequest(o: { network: string; payTo: string; asset: string; amount: string; reason?: string; agentId?: string; resource?: string }) {
  return {
    ...(o.agentId ? { agentId: o.agentId } : {}),
    reason: o.reason ?? "test payment for a data api",
    ...(o.resource ? { resource: o.resource } : {}),
    input: { network: o.network, payTo: o.payTo, asset: o.asset, amount: o.amount, maxTimeoutSeconds: 300, extra: {} },
  };
}
