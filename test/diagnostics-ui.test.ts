import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context, DialogSelectOptions } from "@opencode/plugin/tui/context";
import { showHelp, showStatus, viewReviewLog, type DiagnosticsRpc } from "../src/diagnostics-ui.ts";

const entry = { id: "review-1", timestamp: "2026-10-16T12:00:00.000Z", sessionID: "session-1", decision: "allow", reason: "Matches the user request.", durationMs: 125, model: { providerID: "openai", id: "reviewer", variant: "low" } };
function harness(selections: Array<string | undefined>, entries: unknown[] = [entry]) {
  const menus: DialogSelectOptions<string>[] = [];
  const alerts: Array<{ title: string; message: string }> = [];
  const calls: Array<{ method: string; request: unknown }> = [];
  const confirms: unknown[] = [];
  const answers: Array<boolean | undefined> = [];
  const controller = new AbortController();
  const location = { directory: "/project" };
  const state = { entries, status: { enabled: true, timeoutMs: 30000, maxContextChars: 64000, logLimit: 100 } };
  const ctx = { location, ui: { dialog: {
    async select(menu: DialogSelectOptions<string>) {
      menus.push(menu);
      assert.ok(selections.length, `Unexpected dialog: ${menu.title}`);
      return selections.shift();
    },
    async alert(input: { title: string; message: string }) { alerts.push(input); },
    async confirm(input: unknown) { confirms.push(input); return answers.shift(); },
  } } } as unknown as Context;
  const rpc: DiagnosticsRpc = {
    async log(_input, request) { calls.push({ method: "log", request }); return { entries: state.entries, maxEntries: 100 }; },
    async clearLog(_input, request) { calls.push({ method: "clearLog", request }); state.entries = []; return {}; },
    async status(_input, request) { calls.push({ method: "status", request }); return state.status; },
  };
  return { ctx, rpc, controller, location, state, menus, alerts, calls, confirms, answers };
}

test("shows searchable review verdicts and their details without implying execution permission", async () => {
  const h = harness(["entry:review-1", "close"]);
  await viewReviewLog(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.deepEqual(h.calls, [{ method: "log", request: { location: h.location, signal: h.controller.signal } }]);
  const menu = h.menus[0];
  assert.equal(menu?.title, "AutoCode review log");
  assert.match(menu?.placeholder ?? "", /Search/);
  assert.match(menu?.options.find(option => option.value === "entry:review-1")?.title ?? "", /^ALLOW · 10-16 12:00Z$/);
  assert.match(menu?.options.find(option => option.value === "entry:review-1")?.description ?? "", /^openai\/reviewer · low · 125 ms · Matches the user request/);
  assert.deepEqual(menu?.search?.("ALLOW openai/reviewer", menu.options).map(option => option.value), ["entry:review-1"]);
  assert.equal(menu?.options.find(option => option.value === "entry:review-1")?.footer, undefined, "Session IDs must not consume the native row width");
  assert.deepEqual(menu?.search?.("session-1", menu.options).map(option => option.value), ["entry:review-1"]);
  assert.match(h.alerts[0]?.message ?? "", /Reviewer verdict: ALLOW/);
  assert.match(h.alerts[0]?.message ?? "", /session-1/);
  assert.match(h.alerts[0]?.message ?? "", /2026-10-16T12:00:00.000Z/);
  assert.match(h.alerts[0]?.message ?? "", /native.*polic/i);
});

test("refreshes the log and clears it only after explicit confirmation", async () => {
  const h = harness(["clear", "refresh", "clear", "close"]);
  h.answers.push(false, true);
  await viewReviewLog(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.confirms.length, 2);
  assert.deepEqual(h.calls.map(call => call.method), ["log", "log", "clearLog", "log"]);
  assert.equal(h.menus[2]?.options.some(option => option.value === "entry:review-1"), true);
  assert.equal(h.menus[3]?.options.some(option => option.value === "entry:review-1"), false);
  assert.match(h.menus[3]?.options.find(option => option.value === "empty")?.description ?? "", /only AutoCode reviews/i);
  assert.match(h.menus[3]?.options.find(option => option.value === "empty")?.description ?? "", /commands.*conversations/i);
});

test("explains a log read failure and how to retry", async () => {
  const h = harness([]);
  h.rpc.log = async () => { throw new Error("Storage unavailable"); };
  await viewReviewLog(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.menus.length, 0);
  assert.match(h.alerts[0]?.title ?? "", /unavailable/);
  assert.match(h.alerts[0]?.message ?? "", /Storage unavailable/);
  assert.match(h.alerts[0]?.message ?? "", /\/autocode log/);
});

test("keeps the last visible log when refresh or clear fails", async () => {
  const h = harness(["refresh", "clear", "close"]);
  const log = h.rpc.log;
  let loads = 0;
  h.rpc.log = async (input, request) => { if (loads++) throw new Error("Refresh failed"); return log(input, request); };
  h.rpc.clearLog = async () => { throw new Error("Clear failed"); };
  h.answers.push(true);
  await viewReviewLog(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.alerts.length, 2);
  assert.match(h.alerts[0]?.message ?? "", /Refresh failed/);
  assert.match(h.alerts[1]?.message ?? "", /Clear failed/);
  assert.equal(h.menus[2]?.options.some(option => option.value === "entry:review-1"), true);
});

test("shows effective project status even when automatic approval is disabled", async () => {
  const h = harness([]);
  h.state.status = { enabled: false, timeoutMs: 45000, maxContextChars: 128000, logLimit: 100 };
  await showStatus(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.deepEqual(h.calls, [{ method: "status", request: { location: h.location, signal: h.controller.signal } }]);
  assert.equal(h.alerts[0]?.title, "AutoCode status");
  assert.match(h.alerts[0]?.message ?? "", /Disabled/);
  assert.match(h.alerts[0]?.message ?? "", /Inherit.*coding model/);
  assert.match(h.alerts[0]?.message ?? "", /45000 ms/);
  assert.match(h.alerts[0]?.message ?? "", /128000 characters/);
  assert.match(h.alerts[0]?.message ?? "", /100 reviews/);
  assert.match(h.alerts[0]?.message ?? "", /\/project/);
});

test("treats malformed log responses as unavailable instead of crashing the dialog", async () => {
  const h = harness([]);
  h.rpc.log = async () => ({ entries: [null], maxEntries: 100 });
  await viewReviewLog(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.menus.length, 0);
  assert.match(h.alerts[0]?.message ?? "", /invalid.*review log/i);
});

test("lists the config, log, status, and help commands without requesting a model or settings", async () => {
  const h = harness([]);
  await showHelp(h.ctx, () => true, h.controller.signal);
  assert.equal(h.alerts[0]?.title, "AutoCode commands");
  for (const command of ["config", "log", "status", "help"]) assert.ok(h.alerts[0]?.message.includes(`/autocode ${command}`));
  assert.deepEqual(h.calls, []);
});

test("ignores a cancelled log load and skips subsequent diagnostics", async () => {
  const h = harness([]);
  let release: ((value: unknown) => void) | undefined;
  h.rpc.log = async () => new Promise(resolve => { release = resolve; });
  const pending = viewReviewLog(h.ctx, h.rpc, () => true, h.controller.signal);
  h.controller.abort();
  release?.({ entries: [entry], maxEntries: 100 });
  await pending;
  await showStatus(h.ctx, h.rpc, () => true, h.controller.signal);
  await showHelp(h.ctx, () => true, h.controller.signal);
  assert.equal(h.menus.length, 0);
  assert.equal(h.alerts.length, 0);
  assert.deepEqual(h.calls, []);
});

test("does not reload after a pending clear completes in a closed viewer", async () => {
  const h = harness(["clear"]);
  h.answers.push(true);
  let release: (() => void) | undefined;
  let clearing: (() => void) | undefined;
  const started = new Promise<void>(resolve => { clearing = resolve; });
  h.rpc.clearLog = async () => { clearing?.(); return new Promise<void>(resolve => { release = resolve; }); };
  const pending = viewReviewLog(h.ctx, h.rpc, () => true, h.controller.signal);
  await started;
  h.controller.abort();
  release?.();
  await pending;
  assert.equal(h.calls.filter(call => call.method === "log").length, 1);
});

test("renders an explicit reviewer model and reports status errors with retry guidance", async () => {
  const h = harness([]);
  h.rpc.status = async () => ({ ...h.state.status, model: { providerID: "openai", id: "reviewer", variant: "low" } });
  await showStatus(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.match(h.alerts[0]?.message ?? "", /openai\/reviewer · low/);
  h.rpc.status = async () => { throw new Error("Server disconnected"); };
  await showStatus(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.alerts[1]?.title, "AutoCode status unavailable");
  assert.match(h.alerts[1]?.message ?? "", /Server disconnected/);
  assert.match(h.alerts[1]?.message ?? "", /\/autocode status/);
});

test("removes terminal escape and bidi control characters from review text", async () => {
  const h = harness(["entry:review-1", "close"], [{ ...entry, reason: "\u001b[31mAllowed\u001b[0m\u202e\nfor the request" }]);
  await viewReviewLog(h.ctx, h.rpc, () => true, h.controller.signal);
  const description = h.menus[0]?.options.find(option => option.value === "entry:review-1")?.description;
  assert.match(description ?? "", /Allowed  for the request/);
  assert.doesNotMatch(description ?? "", /[\p{C}]/u);
  assert.doesNotMatch(h.alerts[0]?.message ?? "", /\u001b|\u202e/);
});

test("keeps the empty-log explanation visible as a selectable information row", async () => {
  const h = harness(["empty", "close"], []);
  await viewReviewLog(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.menus[0]?.options.find(option => option.value === "empty")?.disabled, undefined);
  assert.equal(h.alerts[0]?.title, "No AutoCode reviews yet");
  assert.match(h.alerts[0]?.message ?? "", /Only AutoCode reviews/);
  assert.match(h.alerts[0]?.message ?? "", /commands.*conversations/);
});

test("rejects status responses missing the effective settings or log limit", async () => {
  const h = harness([]);
  h.rpc.status = async () => ({});
  await showStatus(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.alerts[0]?.title, "AutoCode status unavailable");
  assert.match(h.alerts[0]?.message ?? "", /invalid.*status/i);
});
