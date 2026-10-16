import assert from "node:assert/strict";
import { test } from "node:test";
import { setupSettings, type SettingsState } from "../src/settings-server.ts";
import type { ReviewLogEntry } from "../src/review-log.ts";

type Context = Parameters<typeof setupSettings>[0];
type HandlerContext = { error(type: string, message: string, data: unknown): unknown };
type Handler = (input: Record<string, unknown>, context: HandlerContext) => Promise<unknown>;
type Command = { name: string; execute(input: { sessionID: string; prompt: { text: string } }): Promise<void> };

function harness() {
  const state: SettingsState = {
    path: "/config/opencode.jsonc", revision: "revision-1", options: {},
    effective: { enabled: true, timeoutMs: 30_000, maxContextChars: 64_000 },
  };
  const registrations: Array<{ definition: unknown; handlers: Record<string, Handler> }> = [];
  const models = [
    { providerID: "connected", id: "reviewer", name: "Reviewer", enabled: true, variants: [{ id: "high" }] },
    { providerID: "disabled", id: "hidden", name: "Hidden", enabled: false, variants: [] },
  ];
  const saves: Array<{ revision: string; options: Record<string, unknown> }> = [];
  const commands: Command[] = [];
  const events: Array<{ name: string; payload: unknown }> = [];
  const ctx = {
    options: {} as Record<string, unknown>,
    rpc: {
      async register(definition: unknown, handlers: Record<string, Handler>) {
        registrations.push({ definition, handlers });
        return { async dispose() {}, events: { async emit(name: string, payload: unknown) { events.push({ name, payload }); } } };
      },
    },
    model: { async list() { return { data: models }; } },
    command: {
      async transform(callback: (editor: { add(command: Command): void }) => void) {
        callback({ add(command) { commands.push(command); } });
        return { async dispose() {} };
      },
    },
  };
  const store = {
    async read() { return state; },
    async save(revision: string, options: Record<string, unknown>) {
      saves.push({ revision, options });
      return { ...state, revision: "revision-2", options };
    },
  };
  const entries: ReviewLogEntry[] = [];
  const log = {
    async append() {},
    async read() { return entries; },
    async clear() { entries.splice(0); },
  };
  return {
    state, registrations, models, saves, commands, events, store, ctx, log, entries,
    async setup(withLog = true) { await setupSettings(ctx as unknown as Context, store, withLog ? log : undefined); },
    async rawCall(method: string, input: Record<string, unknown> = {}) {
      const handler = registrations[0]?.handlers[method];
      assert.ok(handler, `Settings RPC registers ${method}`);
      return handler(input, { error(type, message, data) { return { type, message, data }; } });
    },
    async call(method: string, input: Record<string, unknown> = {}) {
      const result = await this.rawCall(method, input);
      if (result && typeof result === "object" && "type" in result && result.type === "settings_error" && "message" in result) {
        throw new Error(String(result.message));
      }
      return result;
    },
    async command(text: string) {
      const command = commands.find(command => command.name === "autocode");
      assert.ok(command, "Registers native /autocode command");
      await command.execute({ sessionID: "session-1", prompt: { text } });
    },
  };
}

test("settings shows global values and the connected enabled review models", async () => {
  const h = harness();
  await h.setup();
  assert.deepEqual(await h.call("settings"), {
    ...h.state,
    models: [{ providerID: "connected", id: "reviewer", name: "Reviewer", variants: ["high"] }],
  });
});

test("saving passes the revision and review settings to the global store", async () => {
  const h = harness();
  await h.setup();
  const options = { enabled: false, model: "inherit", timeoutMs: 12_000 };
  const saved = await h.call("saveSettings", { revision: h.state.revision, options });
  assert.deepEqual(h.saves, [{ revision: "revision-1", options }]);
  assert.deepEqual(saved, {
    ...h.state, revision: "revision-2", options,
    models: [{ providerID: "connected", id: "reviewer", name: "Reviewer", variants: ["high"] }],
  });
});

test("cannot save a review model that is not connected and enabled", async () => {
  const h = harness();
  await h.setup();
  await assert.rejects(
    h.call("saveSettings", { revision: h.state.revision, options: { model: "disabled/hidden" } }),
    /review model.*not available.*connected/i,
  );
  assert.deepEqual(h.saves, []);
});

test("cannot save a reasoning variant the selected model does not support", async () => {
  const h = harness();
  await h.setup();
  await assert.rejects(
    h.call("saveSettings", {
      revision: h.state.revision,
      options: { model: { providerID: "connected", id: "reviewer", variant: "missing" } },
    }),
    /variant.*not available.*review model/i,
  );
  assert.deepEqual(h.saves, []);
});

test("the native config command opens AutoCode settings for the originating session", async () => {
  const h = harness();
  await h.setup();
  await h.command("config");
  assert.deepEqual(h.events, [{ name: "openSettings", payload: { sessionID: "session-1" } }]);
  assert.deepEqual(h.saves, []);
});

test("unknown native command arguments show the supported command usage", async () => {
  const h = harness();
  await h.setup();
  await assert.rejects(h.command("enable everything"), /Usage: \/autocode (?:<)?config\|log\|status\|help/);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.saves, []);
});

test("the bare command opens help without saving", async () => {
  const h = harness();
  await h.setup();
  await h.command("");
  assert.deepEqual(h.events, [
    { name: "openHelp", payload: { sessionID: "session-1" } },
  ]);
  assert.deepEqual(h.saves, []);
});

test("the removed settings alias points to the supported commands without opening settings", async () => {
  const h = harness();
  await h.setup();
  await assert.rejects(h.command("settings"), /Usage: \/autocode <config\|log\|status\|help>/);
  assert.deepEqual(h.events, []);
});

test("the log command opens the review log for the originating session", async () => {
  const h = harness();
  await h.setup();
  await h.command(" log ");
  assert.deepEqual(h.events, [{ name: "openLog", payload: { sessionID: "session-1" } }]);
  assert.deepEqual(h.saves, []);
});

test("the status command opens effective AutoCode status for the originating session", async () => {
  const h = harness();
  await h.setup();
  await h.command("STATUS");
  assert.deepEqual(h.events, [{ name: "openStatus", payload: { sessionID: "session-1" } }]);
  assert.deepEqual(h.saves, []);
});

test("saves a connected review model with its supported reasoning variant", async () => {
  const h = harness();
  await h.setup();
  const options = { model: { providerID: "connected", id: "reviewer", variant: "high" } };
  await h.call("saveSettings", { revision: h.state.revision, options });
  assert.deepEqual(h.saves, [{ revision: "revision-1", options }]);
});

test("rejects invalid review options before writing the global config", async () => {
  const h = harness();
  await h.setup();
  await assert.rejects(h.call("saveSettings", { revision: h.state.revision, options: { timeoutMs: 0 } }), /timeoutMs must/);
  assert.deepEqual(h.saves, []);
});

test("settings read failures return a declared error with an actionable message", async () => {
  const h = harness();
  h.store.read = async () => { throw new Error("AutoCode: registration not found in /config/opencode.jsonc."); };
  await h.setup();
  assert.deepEqual(await h.rawCall("settings"), {
    type: "settings_error",
    message: "AutoCode: registration not found in /config/opencode.jsonc.",
    data: { message: "AutoCode: registration not found in /config/opencode.jsonc." },
  });
});

test("settings save failures return a declared error and preserve its actionable message", async () => {
  const h = harness();
  h.store.save = async () => { throw new Error("Settings changed on disk; reopen the editor."); };
  await h.setup();
  assert.deepEqual(await h.rawCall("saveSettings", { revision: h.state.revision, options: {} }), {
    type: "settings_error",
    message: "Settings changed on disk; reopen the editor.",
    data: { message: "Settings changed on disk; reopen the editor." },
  });
});

test("can disable AutoCode while retaining an unavailable stored review model", async () => {
  const h = harness();
  const model = { providerID: "disconnected", id: "previous-reviewer", variant: "high" };
  h.state.options = { model };
  h.state.effective.model = model;
  await h.setup();
  const options = { enabled: false, model };
  await h.call("saveSettings", { revision: h.state.revision, options });
  assert.deepEqual(h.saves, [{ revision: "revision-1", options }]);
});

test("status reports the current project options even when disabled without reading global settings or providers", async () => {
  const h = harness();
  h.ctx.options = {
    enabled: false, model: { providerID: "project", id: "reviewer", variant: "low" },
    timeoutMs: 12_000, maxContextChars: 42_000,
  };
  h.store.read = async () => { throw new Error("Must not read the global settings."); };
  h.ctx.model.list = async () => { throw new Error("Must not query model providers."); };
  await h.setup();
  assert.deepEqual(await h.call("status"), { ...h.ctx.options, logLimit: 100 });
});

test("the log RPC returns recorded decisions with the history limit without querying settings or providers", async () => {
  const h = harness();
  h.entries.push({
    id: "review-1", timestamp: "2026-10-16T12:00:00.000Z", sessionID: "session-1",
    decision: "allow", reason: "Requested project test.", durationMs: 251,
    model: { providerID: "connected", id: "reviewer", variant: "high" },
  });
  h.store.read = async () => { throw new Error("Must not read the global settings."); };
  h.ctx.model.list = async () => { throw new Error("Must not query model providers."); };
  await h.setup();
  assert.deepEqual(await h.call("log"), { entries: h.entries, maxEntries: 100 });
});

test("clearLog removes the recent decisions without changing approval settings", async () => {
  const h = harness();
  h.entries.push({
    id: "review-1", timestamp: "2026-10-16T12:00:00.000Z", sessionID: "session-1",
    decision: "ask", reason: "Needs manual review.", durationMs: 100,
  });
  await h.setup();
  assert.deepEqual(await h.call("clearLog"), { cleared: true });
  assert.deepEqual(h.entries, []);
  assert.deepEqual(h.saves, []);
});

test("log read failures return a declared diagnostic error without exposing storage details", async () => {
  const h = harness();
  h.log.read = async () => { throw new Error("storage failed: secret-token-123 /private/config"); };
  await h.setup();
  const message = "AutoCode review log is unavailable. Try reopening /autocode log or restart OpenCode.";
  assert.deepEqual(await h.rawCall("log"), { type: "diagnostics_error", message, data: { message } });
});

test("log clear failures return a declared diagnostic error without exposing storage details", async () => {
  const h = harness();
  h.log.clear = async () => { throw new Error("storage failed: secret-token-123 /private/config"); };
  await h.setup();
  const message = "AutoCode could not clear the review log. Try again or restart OpenCode.";
  assert.deepEqual(await h.rawCall("clearLog"), { type: "diagnostics_error", message, data: { message } });
});

test("log reads report an unavailable store through the declared diagnostic error", async () => {
  const h = harness();
  await h.setup(false);
  const message = "AutoCode review log is unavailable. Try reopening /autocode log or restart OpenCode.";
  assert.deepEqual(await h.rawCall("log"), { type: "diagnostics_error", message, data: { message } });
});

test("log clearing reports an unavailable store through the declared diagnostic error", async () => {
  const h = harness();
  await h.setup(false);
  const message = "AutoCode could not clear the review log. Try again or restart OpenCode.";
  assert.deepEqual(await h.rawCall("clearLog"), { type: "diagnostics_error", message, data: { message } });
});

test("status defaults to inheritance when no reviewer override is configured", async () => {
  const h = harness();
  await h.setup();
  assert.deepEqual(await h.call("status"), {
    enabled: true, timeoutMs: 30_000, maxContextChars: 64_000, logLimit: 100,
  });
});
