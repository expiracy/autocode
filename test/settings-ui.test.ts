import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context, DialogSelectOptions, KeymapLayer } from "@opencode/plugin/tui/context";
import { editSettings, type SettingsRpc } from "../src/settings-ui.ts";
import tui from "../src/tui.ts";

function fixture(options: Record<string, unknown> = {}) {
  return {
    path: "/config/opencode/opencode.jsonc", revision: "revision-1", options,
    effective: { enabled: true, timeoutMs: 30_000, maxContextChars: 64_000 },
    models: [{ providerID: "test", id: "reviewer", name: "Reviewer", variants: ["high"] }],
  };
}

function harness(selections: Array<string | undefined>, options: Record<string, unknown> = {}) {
  const menus: DialogSelectOptions<unknown>[] = [];
  const saves: Array<{ revision: string; options: Record<string, unknown> }> = [];
  const loads: unknown[] = [];
  const confirms: unknown[] = [];
  const confirmAnswers: Array<boolean | undefined> = [];
  const alerts: Array<{ title: string; message: string }> = [];
  const toasts: unknown[] = [];
  const prompts: unknown[] = [];
  const promptAnswers: Array<string | undefined> = [];
  const location = { directory: "/project" };
  const controller = new AbortController();
  const ctx = {
    location,
    data: { location: { default() { throw new Error("Explicit location should be used"); } } },
    ui: {
      dialog: {
        async select(menu: DialogSelectOptions<unknown>) {
          menus.push({ ...menu, options: structuredClone(menu.options) });
          assert.ok(selections.length, `Unexpected dialog: ${menu.title}`);
          return selections.shift();
        },
        async confirm(input: unknown) { confirms.push(input); return confirmAnswers.length ? confirmAnswers.shift() : true; },
        async prompt(input: unknown) { prompts.push(input); assert.ok(promptAnswers.length, "Unexpected prompt"); return promptAnswers.shift(); },
        async alert(input: { title: string; message: string }) { alerts.push(input); },
      },
      toast: { show(input: unknown) { toasts.push(input); } },
    },
  } as unknown as Context;
  const rpc: SettingsRpc = {
    async settings(input, request) { loads.push({ input, request }); return fixture(options); },
    async saveSettings(input) { saves.push(structuredClone(input)); return fixture(input.options); },
  };
  return { ctx, rpc, controller, menus, saves, loads, confirms, confirmAnswers, alerts, toasts, prompts, promptAnswers, location };
}

test("opens global settings with readable current values and closes without saving", async () => {
  const h = harness([undefined]);
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.deepEqual(h.loads, [{ input: {}, request: { location: h.location, signal: h.controller.signal } }]);
  assert.equal(h.menus[0]?.title, "AutoCode settings");
  assert.match(h.menus[0]?.placeholder ?? "", /Global/);
  assert.deepEqual(h.menus[0]?.options.filter(row => ["enabled", "model", "timeoutMs", "maxContextChars"].includes(String(row.value))).map(row => [row.value, row.description]), [
    ["enabled", "Enabled"], ["model", "Inherit the coding model and variant"],
    ["timeoutMs", "30000 ms"], ["maxContextChars", "64000 characters"],
  ]);
  assert.equal(h.menus[0]?.options.find(row => row.value === "save")?.disabled, true);
  assert.deepEqual(h.saves, []);
  assert.deepEqual(h.toasts, [], "Closing without changes is not an error");
});

test("keeps an enabled toggle in a draft until Save is selected", async () => {
  const h = harness(["enabled", "save"]);
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.menus[1]?.options.find(row => row.value === "enabled")?.description, "Disabled");
  assert.equal(h.menus[1]?.options.find(row => row.value === "save")?.disabled, false);
  assert.deepEqual(h.saves, [{ revision: "revision-1", options: { enabled: false } }]);
  assert.equal(h.toasts.length, 1);
});

test("keeps the draft when discard is cancelled and never saves a discarded draft", async () => {
  const h = harness(["enabled", undefined, "close"]);
  h.confirmAnswers.push(false, true);
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.menus.length, 3);
  assert.equal(h.menus[2]?.options.find(row => row.value === "enabled")?.description, "Disabled");
  assert.equal(h.confirms.length, 2);
  assert.deepEqual(h.saves, []);
});

test("selects a connected approval model and its variant before saving", async () => {
  const h = harness(["model", "model:test/reviewer", "variant:high", "save"]);
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.menus[1]?.title, "Approval model");
  assert.match(h.menus[1]?.placeholder ?? "", /Search/);
  assert.equal(h.menus[1]?.options.find(row => row.value === "model:test/reviewer")?.description, "test/reviewer");
  assert.equal(h.menus[2]?.title, "Approval model variant");
  assert.deepEqual(h.saves[0]?.options, { model: { providerID: "test", id: "reviewer", variant: "high" } });
  assert.equal(h.menus[3]?.options.find(row => row.value === "model")?.description, "test/reviewer · high");
});

test("can return an overridden model to inheriting the coding model and variant", async () => {
  const h = harness(["model", "inherit", "save"], { model: { providerID: "test", id: "reviewer", variant: "high" } });
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.deepEqual(h.saves[0]?.options, {});
  assert.equal(h.menus[2]?.options.find(row => row.value === "model")?.description, "Inherit the coding model and variant");
});

test("rejects an invalid timeout without changing other draft edits and accepts a correction", async () => {
  const h = harness(["enabled", "timeoutMs", "save"]);
  h.promptAnswers.push("0", "45000");
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0]?.message ?? "", /timeoutMs.*1.*300000/);
  assert.deepEqual(h.saves[0]?.options, { enabled: false, timeoutMs: 45000 });
  assert.equal(h.prompts.length, 2);
  assert.deepEqual(h.toasts[0], { title: "Invalid AutoCode setting", message: "Enter a whole number from 1 to 300000 milliseconds.", variant: "error", duration: 8000 });
});

test("validates and saves the context character budget", async () => {
  const h = harness(["maxContextChars", "save"]);
  h.promptAnswers.push("999", "128000");
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.match(h.alerts[0]?.message ?? "", /maxContextChars.*1000.*1000000/);
  assert.deepEqual(h.saves[0]?.options, { maxContextChars: 128000 });
});

test("resets all overrides to built-in defaults in the draft before saving", async () => {
  const h = harness(["reset", "save"], { enabled: false, model: "test/reviewer", timeoutMs: 100, maxContextChars: 2000 });
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.deepEqual(h.saves[0]?.options, {});
  assert.equal(h.menus[1]?.options.find(row => row.value === "enabled")?.description, "Enabled");
  assert.equal(h.menus[1]?.options.find(row => row.value === "model")?.description, "Inherit the coding model and variant");
  assert.equal(h.menus[1]?.options.find(row => row.value === "timeoutMs")?.description, "30000 ms");
});

test("keeps the draft visible when the server rejects a save", async () => {
  const h = harness(["enabled", "save", "save"]);
  const save = h.rpc.saveSettings;
  let attempts = 0;
  h.rpc.saveSettings = async (input, request) => {
    if (!attempts++) throw new Error("Settings changed on disk; reopen the editor.");
    return save(input, request);
  };
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.alerts[0]?.title, "Unable to save AutoCode settings");
  assert.match(h.alerts[0]?.message ?? "", /Settings changed on disk/);
  assert.equal(h.menus[2]?.options.find(row => row.value === "enabled")?.description, "Disabled");
  assert.deepEqual(h.saves[0]?.options, { enabled: false });
  assert.deepEqual(h.toasts, [
    { title: "Unable to save AutoCode settings", message: "Your draft is kept. Retry Save or reopen /autocode config if settings changed.", variant: "error", duration: 8000 },
    { title: "AutoCode settings saved", message: "Global settings apply to new command reviews.", variant: "success" },
  ]);
});

test("shows an unavailable message when global settings cannot be read", async () => {
  const h = harness([]);
  h.rpc.settings = async () => { throw new Error("Missing global plugin installation"); };
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.alerts[0]?.title, "AutoCode settings unavailable");
  assert.match(h.alerts[0]?.message ?? "", /Missing global plugin installation/);
  assert.deepEqual(h.saves, []);
});

test("registers AutoCode config in the native command palette and slash completion", async () => {
  const h = harness([undefined]);
  const layers: KeymapLayer[] = [];
  const ctx = {
    ...h.ctx,
    keymap: { layer(factory: () => KeymapLayer) { layers.push(factory()); } },
    client: { rpc() { return { ...h.rpc, events: { on() { return () => {}; } } }; } },
    data: { ...h.ctx.data, on() { return () => {}; } },
  } as unknown as Context;
  const cleanup = await tui.setup(ctx);
  const command = layers[0]?.commands?.find(command => command.id === "autocode.config");
  assert.equal(command?.title, "AutoCode config");
  assert.equal(command?.palette, true);
  assert.equal(command?.slash?.name, "autocode");
  assert.equal(command?.slash?.arguments, true);
  await command?.run("config");
  assert.equal(h.menus.length, 1);
  if (cleanup) await cleanup();
});

test("handles native server commands only for the visible session and unsubscribes on disposal", async () => {
  const h = harness([undefined, "close"]);
  const requests: string[] = [];
  const listeners = new Map<string, (event: { data: { sessionID: string } }) => void | Promise<void>>();
  const unsubscribed: string[] = [];
  const ctx = {
    ...h.ctx,
    ui: { ...h.ctx.ui, router: { current() { return { type: "session", sessionID: "visible" }; } } },
    keymap: { layer() {} },
    client: { rpc() { return { ...h.rpc,
      async log() { requests.push("log"); return { entries: [], maxEntries: 100 }; },
      async status() { requests.push("status"); return { enabled: false, timeoutMs: 30000, maxContextChars: 64000, logLimit: 100 }; },
      events: { on(name: string, callback: (event: { data: { sessionID: string } }) => void | Promise<void>) { listeners.set(name, callback); return () => { unsubscribed.push(name); }; } } }; } },
    data: { ...h.ctx.data, on() { return () => {}; } },
  } as unknown as Context;
  const cleanup = await tui.setup(ctx);
  assert.deepEqual([...listeners.keys()], ["openSettings", "openLog", "openStatus", "openHelp"]);
  for (const listener of listeners.values()) await listener({ data: { sessionID: "different" } });
  assert.equal(h.menus.length, 0);
  assert.equal(h.alerts.length, 0);
  assert.deepEqual(requests, []);
  for (const listener of listeners.values()) await listener({ data: { sessionID: "visible" } });
  assert.equal(h.menus.length, 2);
  assert.equal(h.loads.length, 1);
  assert.deepEqual(requests, ["log", "status"]);
  assert.deepEqual(h.alerts.map(alert => alert.title), ["AutoCode status", "AutoCode commands"]);
  if (cleanup) await cleanup();
  assert.deepEqual(unsubscribed.sort(), [...listeners.keys()].sort());
});

test("closing the TUI companion aborts its open draft and prevents a late Save", async () => {
  const h = harness(["enabled"]);
  let layer: KeymapLayer | undefined;
  let release: ((choice: string) => void) | undefined;
  let ready: (() => void) | undefined;
  let cleared = 0;
  const opened = new Promise<void>(resolve => { ready = resolve; });
  const select = h.ctx.ui.dialog.select.bind(h.ctx.ui.dialog);
  let dialogs = 0;
  const ctx = {
    ...h.ctx,
    ui: { ...h.ctx.ui, dialog: { ...h.ctx.ui.dialog, clear() { cleared++; }, async select(menu: DialogSelectOptions<unknown>) {
      if (!dialogs++) return select(menu);
      ready?.();
      return new Promise<string>(resolve => { release = resolve; });
    } } },
    keymap: { layer(factory: () => KeymapLayer) { layer = factory(); } },
    client: { rpc() { return { ...h.rpc, events: { on() { return () => {}; } } }; } },
    data: { ...h.ctx.data, on() { return () => {}; } },
  } as unknown as Context;
  const cleanup = await tui.setup(ctx);
  const running = layer?.commands?.[0]?.run();
  await opened;
  if (cleanup) await cleanup();
  assert.equal(cleared, 1);
  release?.("save");
  await running;
  assert.deepEqual(h.saves, []);
});

test("reconnecting aborts an in-flight settings load before it can open a stale editor", async () => {
  const h = harness([]);
  let layer: KeymapLayer | undefined;
  let reconnect: (() => void) | undefined;
  let release: ((value: unknown) => void) | undefined;
  let requestSignal: AbortSignal | undefined;
  h.rpc.settings = async (_input, request) => {
    requestSignal = request.signal;
    return new Promise(resolve => { release = resolve; });
  };
  const ctx = {
    ...h.ctx,
    ui: { ...h.ctx.ui, dialog: { ...h.ctx.ui.dialog, clear() {} } },
    keymap: { layer(factory: () => KeymapLayer) { layer = factory(); } },
    client: { rpc() { return { ...h.rpc, events: { on() { return () => {}; } } }; } },
    data: { ...h.ctx.data, on(name: string, callback: () => void) { assert.equal(name, "server.connected"); reconnect = callback; return () => {}; } },
  } as unknown as Context;
  const cleanup = await tui.setup(ctx);
  const running = layer?.commands?.[0]?.run();
  assert.ok(reconnect);
  reconnect();
  assert.equal(requestSignal?.aborted, true);
  release?.(fixture());
  await running;
  assert.equal(h.menus.length, 0);
  if (cleanup) await cleanup();
});

test("an already cancelled editor does not issue a settings request", async () => {
  const h = harness([]);
  h.controller.abort();
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.deepEqual(h.loads, []);
  assert.deepEqual(h.saves, []);
  assert.deepEqual(h.toasts, []);
});

test("settings remains discoverable while the command palette owns modal input", async () => {
  const h = harness([undefined]);
  const layers: KeymapLayer[] = [];
  const ctx = {
    ...h.ctx,
    keymap: { layer(factory: () => KeymapLayer) { layers.push(factory()); } },
    client: { rpc() { return { ...h.rpc, events: { on() { return () => {}; } } }; } },
    data: { ...h.ctx.data, on() { return () => {}; } },
  } as unknown as Context;
  const cleanup = await tui.setup(ctx);
  // OpenCode's dialog host pushes modal input; omitted layer modes require base input.
  const modalCommands = layers.filter(layer => layer.mode === "global" || layer.mode === "modal")
    .flatMap(layer => layer.commands ?? []).filter(command => command.palette);
  const settings = modalCommands.find(command => command.title === "AutoCode config");
  assert.ok(settings, "AutoCode config is reachable from the open palette");
  await settings.run();
  assert.equal(h.menus.length, 1);
  if (cleanup) await cleanup();
});

test("approval model search matches raw provider/model IDs and case-insensitive query tokens", async () => {
  const h = harness(["model", "back", undefined]);
  h.rpc.settings = async () => ({ ...fixture(), models: [
    { providerID: "openai", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", variants: [] },
    { providerID: "other", id: "reviewer", name: "Reviewer", variants: [] },
  ] });
  const select = h.ctx.ui.dialog.select.bind(h.ctx.ui.dialog);
  const ctx = { ...h.ctx, ui: { ...h.ctx.ui, dialog: { ...h.ctx.ui.dialog, async select(menu: DialogSelectOptions<string>) {
    if (menu.title === "Approval model") {
      const search = menu.search ?? ((query: string, options: typeof menu.options) => options.filter(option => option.title.toLowerCase().includes(query.toLowerCase())));
      assert.deepEqual(search("OPENAI/GPT-6.1-SOL", menu.options).map(option => option.value), ["model:openai/gpt-6.1-sol"]);
      assert.deepEqual(search("openai GPT-6.1-SOL", menu.options).map(option => option.value), ["model:openai/gpt-6.1-sol"]);
    }
    return select(menu);
  } } } } as unknown as Context;
  await editSettings(ctx, h.rpc, () => true, h.controller.signal);
  assert.deepEqual(h.saves, []);
});

test("opens the review log from config and returns to the unsaved draft without saving", async () => {
  const h = harness(["enabled", "log", "save"]);
  let visits = 0;
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal, async () => {
    visits++;
    assert.deepEqual(h.saves, []);
  });
  assert.ok(h.menus[0]?.options.some(option => option.value === "log" && option.title === "View review log"));
  assert.equal(visits, 1);
  assert.equal(h.menus[2]?.options.find(option => option.value === "enabled")?.description, "Disabled");
  assert.deepEqual(h.saves, [{ revision: "revision-1", options: { enabled: false } }]);
  assert.equal(h.loads.length, 1);
});

test("routes canonical subcommands and palette diagnostics through one slash command", async () => {
  const h = harness(["close", "close"]);
  const calls: string[] = [];
  let layer: KeymapLayer | undefined;
  const ctx = {
    ...h.ctx,
    keymap: { layer(factory: () => KeymapLayer) { layer = factory(); } },
    client: { rpc() { return { ...h.rpc,
      async log() { calls.push("log"); return { entries: [], maxEntries: 100 }; },
      async status() { calls.push("status"); return { enabled: true, timeoutMs: 30000, maxContextChars: 64000, logLimit: 100 }; },
      events: { on() { return () => {}; } },
    }; } },
    data: { ...h.ctx.data, on() { return () => {}; } },
  } as unknown as Context;
  const cleanup = await tui.setup(ctx);
  const command = layer?.commands?.find(command => command.id === "autocode.config");
  assert.ok(command);
  await command.run("/autocode");
  assert.equal(h.alerts[0]?.title, "AutoCode commands");
  assert.equal(h.loads.length, 0);
  await command.run("settings");
  assert.match(h.alerts[1]?.message ?? "", /Unknown AutoCode command/);
  assert.equal(h.loads.length, 0);
  await command.run("log");
  await command.run("status");
  await command.run("config");
  assert.deepEqual(calls, ["log", "status"]);
  assert.equal(h.menus[0]?.title, "AutoCode review log");
  assert.equal(h.menus[1]?.title, "AutoCode settings");
  assert.equal(h.loads.length, 1);
  assert.deepEqual(layer?.commands?.filter(command => command.palette).map(command => command.id), ["autocode.config", "autocode.log", "autocode.status", "autocode.help"]);
  assert.equal(layer?.commands?.filter(command => command.slash).length, 1);
  if (cleanup) await cleanup();
});

test("shares the dialog lifecycle guard across config and log loads", async () => {
  const h = harness(["close"]);
  let layer: KeymapLayer | undefined;
  let reconnect: (() => void) | undefined;
  let release: ((value: unknown) => void) | undefined;
  let logSignal: AbortSignal | undefined;
  let cleared = 0;
  const ctx = {
    ...h.ctx,
    ui: { ...h.ctx.ui, dialog: { ...h.ctx.ui.dialog, clear() { cleared++; } } },
    keymap: { layer(factory: () => KeymapLayer) { layer = factory(); } },
    client: { rpc() { return { ...h.rpc,
      async log(_input: unknown, request: { signal: AbortSignal }) { logSignal = request.signal; return new Promise(resolve => { release = resolve; }); },
      events: { on() { return () => {}; } },
    }; } },
    data: { ...h.ctx.data, on(_name: string, callback: () => void) { reconnect = callback; return () => {}; } },
  } as unknown as Context;
  const cleanup = await tui.setup(ctx);
  const log = layer?.commands?.find(command => command.id === "autocode.log");
  const config = layer?.commands?.find(command => command.id === "autocode.config");
  const pending = log?.run();
  await config?.run();
  assert.equal(h.loads.length, 0, "A second dialog cannot replace an in-flight log");
  reconnect?.();
  assert.equal(logSignal?.aborted, true);
  assert.equal(cleared, 1);
  release?.({ entries: [], maxEntries: 100 });
  await pending;
  assert.equal(h.menus.length, 0);
  await config?.run();
  assert.equal(h.menus.length, 1, "A new dialog can open after reconnection");
  if (cleanup) await cleanup();
});


test("reports an unavailable settings load with a brief error notification that excludes server payloads", async () => {
  const h = harness([]);
  h.rpc.settings = async () => { throw new Error("Private server response: Bearer fixture-secret " + "x".repeat(2000)); };
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.deepEqual(h.toasts, [{
    title: "AutoCode settings unavailable", message: "Check your global plugin registration, then run /autocode config again.", variant: "error", duration: 8000,
  }]);
  assert.equal(h.alerts.length, 1, "The existing detailed explanation remains available");
  assert.deepEqual(h.saves, []);
});


test("reports an unexpected command failure once without its payload and permits the next command", async () => {
  const h = harness(["close"]);
  let layer: KeymapLayer | undefined;
  const select = h.ctx.ui.dialog.select.bind(h.ctx.ui.dialog);
  let attempts = 0;
  const ctx = {
    ...h.ctx,
    ui: { ...h.ctx.ui, dialog: { ...h.ctx.ui.dialog, async select(menu: DialogSelectOptions<unknown>) {
      const attempt = attempts++;
      if (attempt === 0) throw new Error("Private server response: Bearer fixture-secret " + "x".repeat(2000));
      if (attempt === 2) throw new DOMException("Dialog cancelled", "AbortError");
      return select(menu);
    } } },
    keymap: { layer(factory: () => KeymapLayer) { layer = factory(); } },
    client: { rpc() { return { ...h.rpc, events: { on() { return () => {}; } } }; } },
    data: { ...h.ctx.data, on() { return () => {}; } },
  } as unknown as Context;
  const cleanup = await tui.setup(ctx);
  try {
    const command = layer?.commands?.find(command => command.id === "autocode.config");
    assert.ok(command);
    await assert.doesNotReject(async () => { await command.run("config"); });
    assert.deepEqual(h.toasts, [{ title: "AutoCode command failed", message: "Try the command again. If it keeps failing, restart OpenCode.", variant: "error", duration: 8000 }]);
    await command.run("config");
    assert.equal(h.menus.length, 1, "The failed command releases its lifecycle guard");
    assert.equal(h.toasts.length, 1);
    await command.run("config");
    assert.equal(h.toasts.length, 1, "Expected dialog cancellation is not an error");
    assert.deepEqual(h.saves, []);
  } finally { if (cleanup) await cleanup(); }
});


test("does not report an explicitly cancelled settings request as an error", async () => {
  const h = harness([]);
  h.rpc.settings = async () => { throw new DOMException("Request cancelled", "AbortError"); };
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.alerts, []);
  assert.deepEqual(h.saves, []);
});


test("does not report or retry a committed save when the success notification fails", async () => {
  const h = harness(["enabled", "save"]);
  h.ctx.ui.toast.show = () => { throw new Error("Host notifications unavailable"); };
  await assert.doesNotReject(async () => { await editSettings(h.ctx, h.rpc, () => true, h.controller.signal); });
  assert.deepEqual(h.saves, [{ revision: "revision-1", options: { enabled: false } }]);
  assert.deepEqual(h.alerts, [], "A notification failure must not claim the save failed");
  assert.equal(h.menus.length, 2, "A successful save must not offer another Save attempt");
});


test("does not report an explicitly cancelled settings save as a failed mutation", async () => {
  const h = harness(["enabled", "save", "close"]);
  let attempts = 0;
  h.rpc.saveSettings = async () => { attempts++; throw new DOMException("Request cancelled", "AbortError"); };
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(attempts, 1);
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.alerts, []);
});


test("retains the settings error explanation when native toast delivery is unavailable", async () => {
  const h = harness([]);
  h.ctx.ui.toast.show = () => { throw new Error("Host notifications unavailable"); };
  h.rpc.settings = async () => { throw new Error("Missing global plugin registration"); };
  await editSettings(h.ctx, h.rpc, () => true, h.controller.signal);
  assert.equal(h.alerts[0]?.title, "AutoCode settings unavailable");
  assert.match(h.alerts[0]?.message ?? "", /Missing global plugin registration/);
  assert.deepEqual(h.saves, []);
});

test("does not notify a settings failure after the originating editor becomes stale", async () => {
  const h = harness([]);
  let current = true;
  h.rpc.settings = async () => { current = false; throw new Error("Late settings failure"); };
  await editSettings(h.ctx, h.rpc, () => current, h.controller.signal);
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.alerts, []);
});
