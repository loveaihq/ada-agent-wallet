/**
 * The startup rules that decide whether signerd may run on a given network, and what to say when it
 * may not. Pure logic: no chain, no keys, no I/O — the file's mode, the token and the count of
 * agent tokens are handed in, so each rule can be tested without a filesystem or a process.
 *
 * Every rule here is "fatal on mainnet, a warning elsewhere". signerd owns the two outcomes; this
 * owns the question and the sentence.
 */

/** Hex of 16 random bytes is 32 characters; `openssl rand -hex 16`, as the README suggests, passes. */
export const MIN_OPERATOR_TOKEN_LENGTH = 32;

/** Why this operator token is too weak for real money, or undefined. */
export function operatorTokenProblem(token: string): string | undefined {
  if (token.length >= MIN_OPERATOR_TOKEN_LENGTH) return undefined;
  return `SIGNERD_TOKEN is ${token.length} characters; at least ${MIN_OPERATOR_TOKEN_LENGTH} are required (openssl rand -hex 16 makes one)`;
}

/**
 * Without per-agent tokens the operator's token is the only one there is, so it is also the one the
 * agent's MCP server is configured with — and the operator's token reads the approval queue and
 * approves from it. An agent that can queue a payment over its threshold can then approve it itself.
 */
export function agentIdentityProblem(agentTokenCount: number): string | undefined {
  if (agentTokenCount > 0) return undefined;
  return (
    "AGENT_TOKENS_FILE is unset, so the only token is the operator's: the agent has to be given it, and with it " +
    "the agent can list its own queued payments and approve them. Set AGENT_TOKENS_FILE to a JSON map of " +
    '{"<token>": "<agentId>"} and give the agent one of those instead'
  );
}

/** What a file holds, which sets how much of its mode matters. */
export type FileKind =
  /** A mnemonic, an agent token, a keystore or its passphrase: reading it is the harm. */
  | "secret"
  /** Policy, audit, ledger, channel records: writing it is the harm; others may read. */
  | "shared";

/**
 * Why a file with this mode (`st_mode & 0o777`) is unsafe, or undefined.
 *
 * A secret must have no group or other bits at all: a file others can read is a secret others have.
 * The rest only need to be unwritable by them, because an agent that can write the policy raises
 * its own limits, and one that can only read them has learned nothing it was not told.
 */
export function modeProblem(kind: FileKind, mode: number): string | undefined {
  if (kind === "secret") {
    if (!(mode & 0o077)) return undefined;
    return `is accessible to group or other (mode ${mode.toString(8)}); a secret must be 0600, with no group or other bits`;
  }
  if (!(mode & 0o022)) return undefined;
  return `is writable by group or other (mode ${mode.toString(8)})`;
}
