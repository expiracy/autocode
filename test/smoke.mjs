import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Runs only against a local fake provider, in disposable config/data directories.
// Build first: npm run build && node test/smoke.mjs
const exec = promisify(execFile);
const repository = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "autocode-smoke-"));
const serverPassword = randomUUID();
const requests = [];
let child;
let logs = "";
const fakeProvider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    const livePrompt = body.messages?.some((message) => JSON.stringify(message.content).includes("LIVE_SMOKE"));
    const hasToolResult = body.messages?.some((message) => message.role === "tool");
    const shell = body.tools?.find((tool) => tool.function?.name === "shell");
    const toolCall = livePrompt && shell && !hasToolResult ? {
      id: "call_live_smoke", type: "function",
      function: { name: shell.function.name, arguments: JSON.stringify({ command: "printf smoke-check" }) },
    } : undefined;
    const content = livePrompt && body.tools?.length ? "Smoke command completed." :
      JSON.stringify({ decision: "allow", reason: "Local smoke test approval." });
    const base = { id: "chatcmpl-smoke", created: Math.floor(Date.now() / 1_000), model: body.model };
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        ...base, object: "chat.completion.chunk",
        choices: [{ index: 0,
          delta: toolCall ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] } : { role: "assistant", content },
          finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        ...base, object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`);
      response.end();
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ...base, object: "chat.completion",
        choices: [{ index: 0,
          message: toolCall ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content },
          finish_reason: toolCall ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    }
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: String(error), type: "smoke_failure" } }));
  }
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function stopChild() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

try {
  await access(path.join(repository, "dist/index.js"));
  const npmConfig = path.join(temporary, "npmrc");
  const globalNpmConfig = path.join(temporary, "global-npmrc");
  await writeFile(npmConfig, "");
  await writeFile(globalNpmConfig, "");
  const npmFlags = ["--cache", path.join(temporary, "npm-cache"), "--userconfig", npmConfig, "--globalconfig", globalNpmConfig];
  const { stdout } = await exec("npm", [
    "pack", ...npmFlags, "--ignore-scripts", "--json", "--pack-destination", temporary,
  ], { cwd: repository, timeout: 30_000 });
  const [{ filename }] = JSON.parse(stdout);
  const { stdout: dependencyPack } = await exec("npm", [
    "pack", ...npmFlags, "--ignore-scripts", "--json", "--pack-destination", temporary,
  ], { cwd: path.join(repository, "node_modules/jsonc-parser"), timeout: 30_000 });
  const [{ filename: dependencyFilename }] = JSON.parse(dependencyPack);
  const installation = path.join(temporary, "installed");
  await mkdir(installation);
  await writeFile(path.join(installation, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await exec("npm", [
    "install", ...npmFlags, "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund",
    path.join(temporary, dependencyFilename), path.join(temporary, filename),
  ], { cwd: installation, timeout: 30_000 });
  const installed = path.join(installation, "node_modules/autocode");
  await access(path.join(installed, "dist/index.js"));
  await access(path.join(installed, "tui.js"));
  await access(path.join(installed, "dist/tui.js"));
  const installedPackage = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(installedPackage.name, "autocode");
  assert.equal(installedPackage.exports["./tui"].import, "./tui.js", "The native UI companion must be discoverable.");

  fakeProvider.listen(0, "127.0.0.1");
  await once(fakeProvider, "listening");
  const providerPort = fakeProvider.address().port;
  const configRoot = path.join(temporary, "config");
  await mkdir(path.join(configRoot, "opencode"), { recursive: true });
  const model = { providerID: "smoke", id: "inherited" };
  const globalConfig = path.join(configRoot, "opencode/opencode.json");
  await writeFile(globalConfig, JSON.stringify({
    model: "smoke/inherited",
    plugins: [{ package: installed, options: {} }],
    providers: {
      smoke: {
        name: "Local smoke fixture",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          inherited: { name: "Inherited fixture", capabilities: { tools: true, input: ["text"], output: ["text"] } },
          reviewer: {
            name: "Separate reviewer fixture", variants: [{ id: "high" }],
            capabilities: { tools: true, input: ["text"], output: ["text"] },
          },
        },
      },
    },
  }));

  const projects = {};
  const approvalFixtures = {};
  for (const mode of ["inherit", "override"]) {
    const directory = path.join(temporary, mode);
    await mkdir(directory);
    await writeFile(path.join(directory, "opencode.json"), JSON.stringify({
      ...(mode === "override" ? { plugins: [{
        package: installed,
        options: { model: "smoke/reviewer" },
      }] } : {}),
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    }));
    projects[mode] = directory;
  }

  // Reserve a free port; the server receives no connection to an existing service.
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const installedBinary = path.join(homedir(), ".opencode/bin/opencode");
  const binary = process.env.OPENCODE_BIN ?? await access(installedBinary).then(() => installedBinary, () => "opencode");
  // Deliberately omit inherited API keys, auth variables, service addresses and config overrides.
  const environment = {
    PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8",
    TMPDIR: temporary,
    XDG_CONFIG_HOME: configRoot,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_CACHE_HOME: path.join(temporary, "cache"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    OPENCODE_PASSWORD: serverPassword,
  };
  child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", "warn"], {
    cwd: projects.inherit, env: environment, stdio: ["ignore", "pipe", "pipe"],
  });
  let startupError;
  child.on("error", (error) => { startupError = error; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      logs = (logs + chunk).replaceAll(serverPassword, "[redacted]")
        .replace(/server password [^\r\n]+/g, "server password [redacted]").slice(-32_000);
    });
  }
  const baseURL = `http://127.0.0.1:${port}`;
  const headers = {
    "content-type": "application/json",
    authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}`,
  };
  async function api(route, body, timeout = 15_000) {
    const response = await fetch(baseURL + route, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const result = response.status === 204 ? undefined : await response.json();
    assert.ok(response.ok, `${route}: HTTP ${response.status} ${JSON.stringify(result)}`);
    return result;
  }
  const deadline = Date.now() + 30_000;
  while (true) {
    if (startupError) throw startupError;
    assert.equal(child.exitCode, null, `OpenCode exited before startup:\n${logs}`);
    try {
      const info = await api("/api/info", undefined, 500);
      assert.match(info.version, /^2\./, "Smoke test requires OpenCode 2.");
      console.log(`OpenCode ${info.version}: isolated server started.`);
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`OpenCode startup timed out: ${error}\n${logs}`);
      await delay(100);
    }
  }

  for (const mode of ["inherit", "override"]) {
    const locationQuery = `location%5Bdirectory%5D=${encodeURIComponent(projects[mode])}`;
    let plugins;
    let plugin;
    const loadedBy = Date.now() + 10_000;
    do {
      plugins = await api(`/api/plugin?${locationQuery}`);
      plugin = plugins.data.find((candidate) => candidate.id === "autocode");
      if (plugin) break;
      await delay(100);
    } while (Date.now() < loadedBy);
    if (!plugin) {
      const config = await api(`/api/config?${locationQuery}`);
      const entries = Array.isArray(config) ? config : config.data ?? [];
      const summary = entries.map((entry) => ({
        type: entry.type, path: entry.path,
        plugins: entry.info?.plugins, providers: Object.keys(entry.info?.providers ?? {}),
      }));
      throw new Error(`Packaged plugin was not discovered: ${JSON.stringify({ plugins, config: summary })}`);
    }
    assert.equal(plugin.state.status, "active", JSON.stringify(plugin));

    const location = { directory: projects[mode] };
    const { data: seed } = await api("/api/session", { location, model });
    const assistantID = `msg_${randomUUID().replaceAll("-", "")}`;
    const toolID = `call_${mode}`;
    const created = Date.now();
    // Import a tool transcript so scanner resources are not mistaken for the
    // complete command. Importing a transcript does not execute its tools.
    const { data: session } = await api("/api/experimental/session/import", {
      info: { ...seed, id: `ses_${randomUUID().replaceAll("-", "")}` },
      location,
      messages: [
        { id: `msg_${randomUUID().replaceAll("-", "")}`, type: "user", time: { created },
          text: "Please run printf smoke-check to validate this temporary project." },
        { id: assistantID, type: "assistant", agent: "build", model,
          time: { created: created + 1, streamed: created + 2, completed: created + 3 }, finish: "tool-calls",
          content: [{ type: "tool", id: toolID, name: "shell", time: { created: created + 1, ran: created + 2, completed: created + 3 },
            state: { status: "completed", metadata: {}, content: [{ type: "text", text: "Recorded fixture; no process was run." }],
              input: { command: "printf smoke-check", workdir: projects[mode] } } }] },
      ],
    });
    const { data: importedMessages } = await api(`/api/session/${session.id}/context`);
    const importedAssistant = importedMessages.find((message) => message.type === "assistant");
    const importedCall = importedAssistant?.content.find((part) => part.type === "tool" && part.name === "shell");
    assert.ok(importedAssistant && importedCall, `Imported shell fixture is missing: ${JSON.stringify(importedMessages)}`);
    const permission = {
      action: "shell", resources: ["printf smoke-check"],
      source: { type: "tool", messageID: importedAssistant.id, id: importedCall.id },
    };
    approvalFixtures[mode] = { sessionID: session.id, permission };
    const requestCount = requests.length;
    const { data: decision } = await api(`/api/session/${session.id}/permission`, permission);
    if (decision.effect !== "allow") {
      const pending = await api(`/api/session/${session.id}/permission/${decision.id}`);
      throw new Error(`Expected automatic approval: ${JSON.stringify({ decision, pending, importedCall, modelRequests: requests.length - requestCount })}`);
    }
    assert.equal(decision.effect, "allow", `Expected automatic approval: ${JSON.stringify(decision)}`);
    assert.equal(requests.length, requestCount + 1, "Permission must invoke exactly one tool-free model review.");
    assert.equal(requests.at(-1).model, mode === "inherit" ? "inherited" : "reviewer");
    assert.ok(!requests.at(-1).tools?.length, "Reviewer must not receive tools.");
    console.log(`${mode}: installed plugin active, automatic approval used ${requests.at(-1).model}.`);
  }
  const { data: liveSession } = await api("/api/session", { location: { directory: projects.inherit }, model });
  await api(`/api/session/${liveSession.id}/prompt`, {
    text: "LIVE_SMOKE: Please run exactly printf smoke-check in this temporary directory, then report the output.",
  });
  try {
    await api(`/api/experimental/session/${liveSession.id}/wait`, {}, 20_000);
  } catch (error) {
    const pending = await api(`/api/session/${liveSession.id}/permission`);
    throw new Error(`Live shell turn did not settle: ${error}; pending permissions: ${JSON.stringify(pending)}`);
  }
  const { data: liveMessages } = await api(`/api/session/${liveSession.id}/context`);
  const liveCall = liveMessages.flatMap((message) => message.type === "assistant" ? message.content : [])
    .find((part) => part.type === "tool" && part.id === "call_live_smoke");
  assert.ok(liveCall, `Fake provider's shell call was not executed: ${JSON.stringify(liveMessages)}`);
  assert.equal(liveCall.state.status, "completed", `Live shell approval failed: ${JSON.stringify(liveCall)}`);
  assert.ok(liveCall.state.content.some((part) => part.type === "text" && part.text.includes("smoke-check")));
  assert.deepEqual((await api(`/api/session/${liveSession.id}/permission`)).data, []);
  console.log("live call: real shell permission auto-approved and printf completed in the temporary directory.");

  const settingsQuery = `location%5Bdirectory%5D=${encodeURIComponent(projects.inherit)}`;
  const rpc = async (method, input) => (await api(`/api/rpc/autocode/${method}?${settingsQuery}`, { input })).output;
  const settings = await rpc("settings", {});
  assert.equal(settings.path, globalConfig);
  assert.deepEqual(settings.options, {});
  assert.equal(settings.effective.enabled, true);
  assert.equal(settings.effective.model, undefined);
  assert.equal(settings.effective.timeoutMs, 30_000);
  assert.equal(settings.effective.maxContextChars, 64_000);
  assert.ok(settings.models.some((candidate) => candidate.providerID === "smoke" && candidate.id === "inherited"));
  const reviewer = settings.models.find((candidate) => candidate.providerID === "smoke" && candidate.id === "reviewer");
  assert.ok(reviewer?.variants.includes("high"), "Settings must offer connected models and their variants.");

  async function openSettings() {
    // Subscribe before invoking the command so the ephemeral UI event cannot be missed.
    const eventController = new AbortController();
    const eventResponse = await fetch(baseURL + "/api/event", {
      headers, signal: AbortSignal.any([eventController.signal, AbortSignal.timeout(15_000)]),
    });
    assert.ok(eventResponse.ok);
    const settingsEvent = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of eventResponse.body) {
        buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          if (event.type === "rpc.autocode.openSettings") return event;
        }
      }
      throw new Error("The AutoCode settings command did not emit its UI event.");
    })();
    const beforeSettings = requests.length;
    try {
      await api(`/api/session/${liveSession.id}/command`, { name: "autocode", text: "settings" });
      const event = await settingsEvent;
      assert.equal(event.data.sessionID, liveSession.id);
      assert.equal(requests.length, beforeSettings, "Opening settings must not prompt the coding model.");
    } finally {
      eventController.abort();
      await settingsEvent.catch(() => {});
    }
  }
  await openSettings();

  async function waitForApprovalMode(mode, effect, selectedModel) {
    const fixture = approvalFixtures[mode];
    const settledBy = Date.now() + 10_000;
    let last;
    do {
      const before = requests.length;
      const { data: decision } = await api(`/api/session/${fixture.sessionID}/permission`, fixture.permission);
      const modelRequests = requests.length - before;
      last = { ...decision, modelRequests, model: modelRequests ? requests.at(-1).model : undefined };
      if (decision.effect === "ask") {
        await api(`/api/session/${fixture.sessionID}/permission/${decision.id}/reply`, { decision: "reject" });
      }
      if (decision.effect === effect && modelRequests === (effect === "allow" ? 1 : 0)
        && (!selectedModel || requests.at(-1).model === selectedModel)) return;
      await delay(100);
    } while (Date.now() < settledBy);
    throw new Error(`Saved settings did not reach ${mode} approvals: expected ${effect}, last ${JSON.stringify(last)}`);
  }

  const selectedOptions = {
    enabled: false,
    model: { providerID: "smoke", id: "reviewer", variant: "high" },
    timeoutMs: 45_000,
    maxContextChars: 128_000,
  };
  const saved = await rpc("saveSettings", { revision: settings.revision, options: selectedOptions });
  assert.deepEqual(saved.options, selectedOptions);
  const persisted = JSON.parse(await readFile(globalConfig, "utf8"));
  assert.deepEqual(persisted.plugins.find((entry) => entry.package === installed).options, selectedOptions);
  assert.equal(persisted.model, "smoke/inherited", "Saving plugin settings must preserve the coding model.");
  assert.ok(persisted.providers.smoke, "Saving plugin settings must preserve provider configuration.");
  await waitForApprovalMode("inherit", "ask");
  await openSettings();
  await waitForApprovalMode("override", "allow", "reviewer");
  const inherited = await rpc("saveSettings", {
    revision: saved.revision,
    options: { ...selectedOptions, enabled: true, model: "inherit" },
  });
  assert.equal(inherited.effective.model, undefined);
  await waitForApprovalMode("inherit", "allow", "inherited");
  console.log("settings: models/variants listed, /autocode opens while disabled, global choices persisted and live approvals updated; project override preserved.");
  console.log("Smoke test passed; all model traffic stayed on the local fake provider.");
} catch (error) {
  const logFiles = (await readdir(temporary, { recursive: true })).filter((name) =>
    name.endsWith(".log") && ["data", "state"].some((directory) => name.startsWith(directory + path.sep)));
  for (const name of logFiles) {
    const logFile = await readFile(path.join(temporary, name), "utf8").catch(() => "");
    if (logFile) console.error(logFile.replaceAll(serverPassword, "[redacted]").slice(-32_000));
  }
  if (logs) console.error(logs);
  throw error;
} finally {
  await stopChild();
  fakeProvider.closeAllConnections();
  await new Promise((resolve) => fakeProvider.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
