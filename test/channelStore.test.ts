import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelStore, type ChannelEntry } from "../src/channelStore.ts";

const ID = "ab".repeat(32);
const entry: ChannelEntry = {
  agentId: "default",
  network: "cardano:preprod",
  scriptHash: "62ce4309".padEnd(56, "0"),
  asset: "lovelace",
  payTo: "addr_test1seller",
  providerKey: "cd".repeat(28),
  signedMax: "5000",
  anchor: `${"ef".repeat(32)}#0`,
  deposit: "3000000",
  reserve: "0",
  status: "open",
  openedAt: 1,
};

test("what was signed on a channel survives a restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "channels-")), "index.json");
  new ChannelStore(file).set(ID, entry);
  const again = new ChannelStore(file);
  assert.deepEqual(again.get(ID), entry);
  assert.deepEqual(again.entries().map(([id]) => id), [ID]);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a malformed entry is refused, and nothing is written", () => {
  const file = join(mkdtempSync(join(tmpdir(), "channels-")), "index.json");
  const store = new ChannelStore(file);
  store.set(ID, entry);
  const before = readFileSync(file, "utf8");
  assert.throws(() => store.set(ID, { ...entry, signedMax: "5e3" }), /signedMax is not a decimal amount/);
  assert.throws(() => store.set(ID, { ...entry, anchor: "somewhere" }), /anchor is not an out-ref/);
  assert.throws(() => store.set("not-a-tag", entry), /32-byte tag/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(store.get(ID)!.signedMax, "5000");
});

test("an unreadable index is an error, not an empty one", () => {
  // Empty would mean nothing signed on any channel: every voucher after it counted from zero, and
  // no refund allowed to pay the seller what it is owed.
  const dir = mkdtempSync(join(tmpdir(), "channels-"));
  writeFileSync(join(dir, "a.json"), JSON.stringify({ version: 2, channels: {} }));
  assert.throws(() => new ChannelStore(join(dir, "a.json")), /unrecognized/);
  writeFileSync(join(dir, "b.json"), JSON.stringify({ version: 1, channels: { [ID]: { ...entry, status: "maybe" } } }));
  assert.throws(() => new ChannelStore(join(dir, "b.json")), /status/);
});
