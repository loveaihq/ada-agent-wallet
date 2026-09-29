import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyedLock, createLock } from "../src/serialize.ts";

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

test("keyed lock runs one task at a time per key", async () => {
  const lock = createKeyedLock();
  const events: string[] = [];
  const task = (name: string) => async () => {
    events.push(`${name}:start`);
    await tick();
    events.push(`${name}:end`);
  };
  await Promise.all([lock("a", task("1")), lock("a", task("2")), lock("a", task("3"))]);
  assert.deepEqual(events, ["1:start", "1:end", "2:start", "2:end", "3:start", "3:end"]);
});

test("different keys are not serialized against each other", async () => {
  const lock = createKeyedLock();
  const events: string[] = [];
  const task = (name: string) => async () => {
    events.push(`${name}:start`);
    await tick();
    events.push(`${name}:end`);
  };
  await Promise.all([lock("a", task("a")), lock("b", task("b"))]);
  assert.deepEqual(events, ["a:start", "b:start", "a:end", "b:end"]);
});

test("a rejecting task does not wedge the ones behind it", async () => {
  const lock = createKeyedLock();
  const boom = lock("a", async () => {
    await tick();
    throw new Error("boom");
  });
  const after = lock("a", async () => "ran anyway");
  await assert.rejects(boom, /boom/); // the failure still reaches its own caller
  assert.equal(await after, "ran anyway");
});

test("the read-then-write a keyed lock exists to protect is atomic under it", async () => {
  // Models signerd's critical section: read a budget, do slow work, then record the spend.
  // Without the lock both tasks read 10 and both commit, spending 12 against a cap of 10.
  const lock = createKeyedLock();
  let spent = 0;
  const cap = 10;
  const pay = (amount: number) =>
    lock("agent", async () => {
      const allowed = spent + amount <= cap;
      await tick(); // the window: building a transaction queries the chain
      if (!allowed) return "denied";
      spent += amount;
      return "signed";
    });
  const verdicts = await Promise.all([pay(6), pay(6)]);
  assert.deepEqual(verdicts.sort(), ["denied", "signed"]);
  assert.equal(spent, 6);
});

test("plain lock serializes everything", async () => {
  const lock = createLock();
  let concurrent = 0;
  let peak = 0;
  const task = async () => {
    peak = Math.max(peak, ++concurrent);
    await tick();
    concurrent--;
  };
  await Promise.all([lock(task), lock(task), lock(task)]);
  assert.equal(peak, 1);
});

test("a task started from inside the lock and not awaited runs after the current one, and does not wedge it", async () => {
  // signerd starts an automatic tidy from code that can be inside a locked section, and the tidy
  // takes the wallet lock itself. Awaiting it there would wait for a lock only the caller can free;
  // scheduling it and moving on queues it behind the caller instead.
  const lock = createLock();
  const events: string[] = [];
  let inner: Promise<string> | undefined;
  await lock(async () => {
    events.push("outer:start");
    setImmediate(() => {
      inner = lock(async () => {
        events.push("inner");
        return "inner done";
      });
    });
    await tick(20); // still holding the lock when the immediate fires
    events.push("outer:end");
  });
  assert.equal(await (inner as Promise<string> | undefined), "inner done");
  assert.deepEqual(events, ["outer:start", "outer:end", "inner"]);
});
