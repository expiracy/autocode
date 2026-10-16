import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plugin } from "@opencode/plugin";
import { MAX_LOG_ENTRIES, ReviewLog, type ReviewLogInput } from "../src/review-log.ts";

function storageHarness() {
  type Json = Awaited<ReturnType<Plugin.Context["storage"]["get"]>>;
  const data = new Map<string, Json>();
  const state = { fail: undefined as undefined | "get" | "set" | "remove" };
  const storage = {
    async get(key: string) {
      if (state.fail === "get") throw new Error("Storage get failed");
      return structuredClone(data.get(key));
    },
    async set(key: string, value: Exclude<Json, undefined>) {
      if (state.fail === "set") throw new Error("Storage set failed");
      data.set(key, structuredClone(value));
    },
    async remove(key: string) {
      if (state.fail === "remove") throw new Error("Storage remove failed");
      data.delete(key);
    },
    async scan() { return { entries: [] }; },
  } satisfies Plugin.Context["storage"];
  return { storage, data, state };
}

function input(reason = "The user requested this command."): ReviewLogInput {
  return {
    sessionID: "session-1", decision: "allow", reason, durationMs: 123,
    model: { providerID: "openai", id: "gpt-6-luna", variant: "low" },
  };
}

// Scenarios: persistence; retention/order; concurrent append/clear; project isolation;
// malformed records; privacy and sanitization; failures and queue recovery.
test("persists review metadata across store reloads", async () => {
  const h = storageHarness();
  const start = Date.now();
  await new ReviewLog(h.storage, "/project").append(input());
  const entries = await new ReviewLog(h.storage, "/project").read();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { ...input(), id: entries[0]!.id, timestamp: entries[0]!.timestamp });
  assert.match(entries[0]!.id, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(entries[0]!.timestamp) >= start);
  assert.ok(Date.parse(entries[0]!.timestamp) <= Date.now());
});

test("retains the newest 100 reviews in reverse append order", async () => {
  const h = storageHarness();
  const log = new ReviewLog(h.storage, "/retention");
  for (let index = 0; index < MAX_LOG_ENTRIES + 3; index++) await log.append(input(`Review ${index}`));
  const entries = await log.read();
  assert.equal(entries.length, 100);
  assert.equal(entries[0]!.reason, "Review 102");
  assert.equal(entries[99]!.reason, "Review 3");
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 100);
  assert.equal((h.data.values().next().value as unknown[]).length, 100);
});

test("serializes concurrent appends and clear across instances and module reloads", async () => {
  const h = storageHarness();
  const { ReviewLog: ReloadedLog } = await import(`../src/review-log.ts?reload=${Date.now()}`) as typeof import("../src/review-log.ts");
  const first = new ReviewLog(h.storage, "/concurrent");
  const second = new ReloadedLog(h.storage, "/concurrent");
  await Promise.all([
    first.append(input("First")),
    second.append(input("Second")),
  ]);
  assert.deepEqual((await first.read()).map((entry) => entry.reason), ["Second", "First"]);

  const beforeClear = first.append(input("Before clear"));
  const clear = second.clear();
  const afterClear = first.append(input("After clear"));
  const read = second.read();
  await Promise.all([beforeClear, clear, afterClear]);
  assert.deepEqual((await read).map((entry) => entry.reason), ["After clear"]);
});

test("isolates project histories without storing the project path in the key", async () => {
  const h = storageHarness();
  const first = new ReviewLog(h.storage, "/private/project-a");
  const second = new ReviewLog(h.storage, "/private/project-b");
  await first.append(input("Project A"));
  await second.append(input("Project B"));
  assert.deepEqual((await first.read()).map((entry) => entry.reason), ["Project A"]);
  assert.deepEqual((await second.read()).map((entry) => entry.reason), ["Project B"]);
  assert.equal(h.data.size, 2);
  for (const key of h.data.keys()) assert.match(key, /^review-log\.v1\.[0-9a-f]{64}$/);
  await first.clear();
  assert.deepEqual(await first.read(), []);
  assert.equal((await second.read())[0]!.reason, "Project B");
});

test("stores only bounded sanitized review metadata", async () => {
  const h = storageHarness();
  const log = new ReviewLog(h.storage, "/privacy");
  await log.append({
    ...input(),
    sessionID: `\u001b[31m${"s".repeat(300)}\u001b[0m`,
    reason: `\u001b]0;unsafe title\u0007${"r".repeat(1100)}\n\u0000\u202e`,
    model: {
      providerID: `\u001b[32m${"p".repeat(300)}\u001b[0m`,
      id: `\u009b31m${"m".repeat(300)}`,
      variant: `\u0000${"v".repeat(300)}`,
      token: "private token",
    },
    command: "printf private-command",
    context: "private conversation",
    error: "private raw provider failure",
  } as ReviewLogInput);
  const entries = await log.read();
  assert.deepEqual(entries[0], {
    sessionID: "s".repeat(256), reason: "r".repeat(1000), decision: "allow", durationMs: 123,
    model: { providerID: "p".repeat(256), id: "m".repeat(256), variant: "v".repeat(256) },
    id: entries[0]!.id, timestamp: entries[0]!.timestamp,
  });
  const serialized = JSON.stringify([...h.data.values()]);
  for (const privateText of ["private token", "private-command", "private conversation", "raw provider failure", "unsafe title"])
    assert.equal(serialized.includes(privateText), false);
});

test("ignores malformed stored entries and returns only sanitized metadata", async () => {
  const h = storageHarness();
  const log = new ReviewLog(h.storage, "/malformed");
  await log.append(input());
  const valid = (await log.read())[0]!;
  const key = h.data.keys().next().value!;
  h.data.set(key, [
    null, "invalid", {}, { ...valid, decision: "execute" }, { ...valid, durationMs: -1 },
    { ...valid, id: null }, { ...valid, timestamp: "yesterday" },
    { ...valid, model: { providerID: "missing-model" } },
    { ...valid, reason: "\u001b[31mReviewed\u001b[0m", command: "private command", context: "private conversation" },
  ]);
  assert.deepEqual(await log.read(), [{ ...valid, reason: "Reviewed" }]);
  for (const malformedRoot of [null, "invalid", {}, 42]) {
    h.data.set(key, malformedRoot);
    assert.deepEqual(await log.read(), []);
  }
});

test("rejects malformed append metadata without changing durable history", async () => {
  const h = storageHarness();
  const log = new ReviewLog(h.storage, "/invalid-input");
  await log.append(input("Existing"));
  const invalid = [
    null, {}, { ...input(), decision: "approve" }, { ...input(), durationMs: Number.NaN },
    { ...input(), durationMs: Number.POSITIVE_INFINITY }, { ...input(), durationMs: -1 },
    { ...input(), sessionID: "\u0000" }, { ...input(), reason: "\n" },
    { ...input(), model: { providerID: "provider" } },
  ];
  for (const value of invalid) await assert.rejects(log.append(value as ReviewLogInput), /Invalid AutoCode review log metadata/);
  assert.deepEqual((await log.read()).map((entry) => entry.reason), ["Existing"]);
});

test("reports storage failures and keeps subsequent operations usable", async () => {
  const h = storageHarness();
  const log = new ReviewLog(h.storage, "/failure");
  await log.append(input("Existing"));
  h.state.fail = "set";
  await assert.rejects(log.append(input("Not saved")), /Storage set failed/);
  h.state.fail = "get";
  await assert.rejects(log.read(), /Storage get failed/);
  await assert.rejects(log.append(input("Not read")), /Storage get failed/);
  h.state.fail = "remove";
  await assert.rejects(log.clear(), /Storage remove failed/);
  h.state.fail = undefined;
  await log.append(input("Recovered"));
  assert.deepEqual((await log.read()).map((entry) => entry.reason), ["Recovered", "Existing"]);
  await log.clear();
  assert.equal(h.data.size, 0);
  assert.deepEqual(await log.read(), []);
});
