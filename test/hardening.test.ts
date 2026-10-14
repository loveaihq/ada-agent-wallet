import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_OPERATOR_TOKEN_LENGTH, agentIdentityProblem, modeProblem, operatorTokenProblem } from "../src/hardening.ts";

test("an operator token needs at least 32 characters, and openssl rand -hex 16 makes exactly that", () => {
  assert.equal(MIN_OPERATOR_TOKEN_LENGTH, 32);
  assert.equal(operatorTokenProblem("ab".repeat(16)), undefined);
  assert.equal(operatorTokenProblem("x".repeat(64)), undefined);
  assert.match(operatorTokenProblem("x".repeat(31))!, /SIGNERD_TOKEN is 31 characters; at least 32 are required/);
  assert.match(operatorTokenProblem("")!, /is 0 characters/);
  assert.match(operatorTokenProblem("hunter2")!, /openssl rand -hex 16/);
});

test("without agent tokens the only token is the operator's, and the sentence says what that costs", () => {
  assert.equal(agentIdentityProblem(1), undefined);
  assert.equal(agentIdentityProblem(5), undefined);
  const why = agentIdentityProblem(0)!;
  assert.match(why, /AGENT_TOKENS_FILE is unset/);
  assert.match(why, /approve them/);
});

test("a secret file must have no group or other bits at all", () => {
  for (const ok of [0o600, 0o400, 0o700, 0o500]) assert.equal(modeProblem("secret", ok), undefined, ok.toString(8));
  for (const bad of [0o640, 0o604, 0o644, 0o660, 0o666, 0o601, 0o610, 0o777]) {
    assert.match(modeProblem("secret", bad)!, /is accessible to group or other \(mode [0-7]+\); a secret must be 0600/, bad.toString(8));
  }
  assert.match(modeProblem("secret", 0o644)!, /mode 644/);
});

test("a shared file (policy, audit, ledger) keeps the write-bit check: others may read it, not write it", () => {
  for (const ok of [0o600, 0o644, 0o640, 0o604, 0o444, 0o755]) assert.equal(modeProblem("shared", ok), undefined, ok.toString(8));
  for (const bad of [0o664, 0o666, 0o620, 0o602, 0o622, 0o777]) {
    assert.match(modeProblem("shared", bad)!, /is writable by group or other \(mode [0-7]+\)/, bad.toString(8));
  }
});

test("the same mode is fine for the policy and not for the mnemonic", () => {
  assert.equal(modeProblem("shared", 0o644), undefined);
  assert.ok(modeProblem("secret", 0o644));
});
