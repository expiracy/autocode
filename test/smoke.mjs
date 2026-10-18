import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Runs only against a local fake provider, in disposable config/data directories.
// Build first: npm run build && node test/smoke.mjs
// Add --registry-install to resolve the packed package's dependencies from npm
// in an empty cache, without peer-dependency bypasses or seeded packages.
// After publication, --published-package installs the exact manifest version
// from npm and asks OpenCode to load that registry package by name as well.
const exec = promisify(execFile);
const repository = fileURLToPath(new URL("..", import.meta.url));
const registryInstall = process.argv.includes("--registry-install");
const publishedPackage = process.argv.includes("--published-package");
assert.ok(process.argv.slice(2).every((argument) => ["--registry-install", "--published-package"].includes(argument)), "Unknown smoke-test option.");
assert.ok(!(registryInstall && publishedPackage), "Choose either a local tarball or the published package.");
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
    const hasPrompt = (marker) => body.messages?.some((message) => JSON.stringify(message.content).includes(marker));
    const hardRejectPrompt = hasPrompt("LIVE_HARD_REJECT");
    const policyRejectPrompt = hasPrompt("LIVE_POLICY_REJECT");
    const livePrompt = hasPrompt("LIVE_SMOKE") || hardRejectPrompt || policyRejectPrompt;
    const hasToolResult = body.messages?.some((message) => message.role === "tool");
    const shell = body.tools?.find((tool) => tool.function?.name === "shell");
    const toolCall = livePrompt && shell && !hasToolResult ? {
      id: hardRejectPrompt ? "call_live_hard_reject" : policyRejectPrompt ? "call_live_policy_reject" : "call_live_smoke",
      type: "function",
      function: { name: shell.function.name, arguments: JSON.stringify({
        command: hardRejectPrompt ? "printf smoke-blocked > .autocode-hard-reject-marker"
          : policyRejectPrompt ? "printf smoke-policy > .autocode-policy-reject-marker" : "printf smoke-check",
      }) },
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
  const npmConfig = path.join(temporary, "npmrc");
  const globalNpmConfig = path.join(temporary, "global-npmrc");
  await writeFile(npmConfig, "");
  await writeFile(globalNpmConfig, "");
  const npmFlags = ["--cache", path.join(temporary, "npm-cache"), "--userconfig", npmConfig, "--globalconfig", globalNpmConfig,
    "--registry", "https://registry.npmjs.org"];
  const npmEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:npm_config_|npm_token$|node_auth_token$)/i.test(name)));
  const { name, version } = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
  assert.equal(name, "opencode-autocode", "Smoke tests must use the final npm package identity.");
  const packageSpecifier = `${name}@${version}`;
  let filename;
  if (!publishedPackage) {
    await access(path.join(repository, "dist/index.js"));
    const { stdout } = await exec("npm", [
      "pack", ...npmFlags, "--ignore-scripts", "--json", "--pack-destination", temporary,
    ], { cwd: repository, env: npmEnvironment, timeout: 30_000 });
    const [packed] = JSON.parse(stdout);
    assert.equal(packed.name, name);
    assert.equal(packed.version, version);
    filename = packed.filename;
  }
  const installation = path.join(temporary, "installed");
  await mkdir(installation);
  await writeFile(path.join(installation, "package.json"), JSON.stringify({ private: true, type: "module" }));
  if (registryInstall || publishedPackage) {
    // Install only the consumer artifact: npm must obtain every dependency and
    // satisfy its peers normally. Scripts stay disabled to prove dist is shipped.
    await exec("npm", [
      "install", ...npmFlags, "--ignore-scripts", "--no-audit", "--no-fund",
      publishedPackage ? packageSpecifier : path.join(temporary, filename),
    ], { cwd: installation, env: npmEnvironment, timeout: 180_000 });
    await exec("npm", ["ls", ...npmFlags, "--omit=dev", "--all"], {
      cwd: installation, env: npmEnvironment, timeout: 30_000,
    });
    console.log(`package: fresh-cache npm installation of ${publishedPackage ? packageSpecifier : "the local tarball"} resolved dependencies and peers normally; no consumer build was required.`);
  } else {
    // Fast deterministic native checks reuse only the locally available runtime
    // dependency; the separate registry mode validates normal npm resolution.
    const { stdout: dependencyPack } = await exec("npm", [
      "pack", ...npmFlags, "--ignore-scripts", "--json", "--pack-destination", temporary,
    ], { cwd: path.join(repository, "node_modules/jsonc-parser"), env: npmEnvironment, timeout: 30_000 });
    const [{ filename: dependencyFilename }] = JSON.parse(dependencyPack);
    await exec("npm", [
      "install", ...npmFlags, "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund",
      path.join(temporary, dependencyFilename), path.join(temporary, filename),
    ], { cwd: installation, env: npmEnvironment, timeout: 30_000 });
  }
  const installed = path.join(installation, "node_modules", name);
  await access(path.join(installed, "dist/index.js"));
  await access(path.join(installed, "tui.js"));
  await access(path.join(installed, "dist/tui.js"));
  const installedPackage = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(installedPackage.name, "opencode-autocode");
  assert.equal(installedPackage.version, version);
  assert.equal(installedPackage.exports["./tui"].import, "./tui.js", "The native UI companion must be discoverable.");
  const pluginPackage = publishedPackage ? packageSpecifier : installed;

  fakeProvider.listen(0, "127.0.0.1");
  await once(fakeProvider, "listening");
  const providerPort = fakeProvider.address().port;
  const configRoot = path.join(temporary, "config");
  await mkdir(path.join(configRoot, "opencode"), { recursive: true });
  const model = { providerID: "smoke", id: "inherited" };
  const globalConfig = path.join(configRoot, "opencode/opencode.json");
  await writeFile(globalConfig, JSON.stringify({
    model: "smoke/inherited",
    plugins: [{ package: pluginPackage, options: {} }],
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
        package: pluginPackage,
        options: { model: "smoke/reviewer" },
      }] } : {}),
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    }));
    projects[mode] = directory;
  }
  projects.hardReject = path.join(temporary, "hard-reject");
  await mkdir(projects.hardReject);
  await writeFile(path.join(projects.hardReject, "opencode.json"), JSON.stringify({
    permissions: [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "printf smoke-allowed *", effect: "allow" },
      { action: "shell", resource: "printf smoke-blocked *", effect: "deny" },
    ],
    experimental: {
      policies: [{ action: "tool.use", resource: "shell:printf smoke-policy *", effect: "deny" }],
    },
  }));

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
    NPM_CONFIG_USERCONFIG: npmConfig,
    NPM_CONFIG_GLOBALCONFIG: globalNpmConfig,
    NPM_CONFIG_CACHE: path.join(temporary, "opencode-npm-cache"),
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
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
  const deadline = Date.now() + (publishedPackage ? 180_000 : 30_000);
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
    const loadedBy = Date.now() + (publishedPackage ? 180_000 : 10_000);
    do {
      plugins = await api(`/api/plugin?${locationQuery}`, undefined, publishedPackage ? 180_000 : 15_000);
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
    if (publishedPackage) {
      assert.equal(plugin.source.type, "package", "OpenCode must load from the public registry rather than a local directory.");
      assert.equal(plugin.source.version, version, "OpenCode must resolve the exact published version.");
      assert.equal(plugin.features.tui, true, "The registry package must expose its native TUI companion.");
      console.log(`${mode}: OpenCode loaded ${packageSpecifier} from its own fresh package cache.`);
    }

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
    approvalFixtures[mode] = { sessionID: session.id, permission, model: importedAssistant.model };
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

  const rpc = async (method, input, directory = projects.inherit) => {
    const locationQuery = `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
    return (await api(`/api/rpc/autocode/${method}?${locationQuery}`, { input })).output;
  };
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

  const initialLog = await rpc("log", {});
  assert.equal(initialLog.maxEntries, 100);
  assert.equal(initialLog.entries.length, 2, "The imported review and actual shell review must both be persisted.");
  assert.deepEqual(initialLog.entries.map((entry) => entry.sessionID).sort(),
    [approvalFixtures.inherit.sessionID, liveSession.id].sort());
  const reviewModels = new Map([
    [approvalFixtures.inherit.sessionID, approvalFixtures.inherit.model],
    [liveSession.id, liveMessages.find((message) => message.type === "assistant"
      && message.content.some((part) => part.type === "tool" && part.id === "call_live_smoke")).model],
  ]);
  for (const entry of initialLog.entries) {
    assert.deepEqual(Object.keys(entry).sort(),
      ["decision", "durationMs", "id", "model", "reason", "sessionID", "timestamp"],
      "Review history must contain metadata only, without raw commands, conversation, or provider errors.");
    assert.equal(entry.decision, "allow");
    assert.equal(entry.reason, "Local smoke test approval.");
    assert.deepEqual(entry.model, reviewModels.get(entry.sessionID), "History must identify the originating model and variant that actually reviewed the command.");
    assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs >= 0);
    assert.equal(new Date(entry.timestamp).toISOString(), entry.timestamp);
    assert.match(entry.id, /^[0-9a-f-]{36}$/);
  }
  assert.equal(new Set(initialLog.entries.map((entry) => entry.id)).size, 2);
  console.log("diagnostics: native review history persists actual decisions, model, timing and bounded metadata without command or conversation fields.");

  const beforeDiagnostics = requests.length;
  const aliasDirectory = path.join(temporary, "inherit-alias");
  await symlink(projects.inherit, aliasDirectory, "dir");
  const aliasQuery = `location%5Bdirectory%5D=${encodeURIComponent(aliasDirectory)}`;
  const aliasLoadedBy = Date.now() + 10_000;
  let aliasPlugin;
  do {
    aliasPlugin = (await api(`/api/plugin?${aliasQuery}`)).data.find((candidate) => candidate.id === "autocode");
    if (aliasPlugin?.state.status === "active") break;
    await delay(100);
  } while (Date.now() < aliasLoadedBy);
  assert.equal(aliasPlugin?.state.status, "active", "AutoCode must load through the project's directory alias.");
  assert.deepEqual(await rpc("log", {}, aliasDirectory), initialLog,
    "Directory aliases must expose the same persisted review history as the canonical project path.");
  assert.deepEqual(await rpc("status", {}, aliasDirectory), await rpc("status", {}));
  assert.deepEqual(await rpc("status", {}), {
    enabled: true, timeoutMs: 30_000, maxContextChars: 64_000, logLimit: 100,
  });
  assert.deepEqual(await rpc("status", {}, projects.override), {
    enabled: true, model: { providerID: "smoke", id: "reviewer" },
    timeoutMs: 30_000, maxContextChars: 64_000, logLimit: 100,
  }, "Status must report this project's effective options, including its reviewer override.");
  assert.deepEqual((await rpc("log", {}, projects.override)).entries.map((entry) => entry.sessionID),
    [approvalFixtures.override.sessionID], "Each project's history must exclude other projects' reviews.");
  assert.deepEqual(await rpc("clearLog", {}, projects.override), { cleared: true });
  assert.deepEqual((await rpc("log", {}, projects.override)).entries, []);
  assert.deepEqual((await rpc("log", {})).entries, initialLog.entries,
    "Clearing the current project's history must preserve another project's history.");
  assert.equal(requests.length, beforeDiagnostics, "Reading status/history and clearing history must not call a model.");
  console.log("diagnostics: directory aliases share history, status reflects project options, and clearing one project preserves another.");

  async function openAutoCode(text, eventName) {
    // Subscribe before invoking the command so the ephemeral UI event cannot be missed.
    const eventController = new AbortController();
    const eventResponse = await fetch(baseURL + "/api/event", {
      headers, signal: AbortSignal.any([eventController.signal, AbortSignal.timeout(15_000)]),
    });
    assert.ok(eventResponse.ok);
    const commandEvent = (async () => {
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
          if (event.type === `rpc.autocode.${eventName}` && event.data.sessionID === liveSession.id) return event;
        }
      }
      throw new Error(`The AutoCode ${text || "help"} command did not emit its UI event.`);
    })();
    const beforeCommand = requests.length;
    try {
      await api(`/api/session/${liveSession.id}/command`, { name: "autocode", text });
      const event = await commandEvent;
      assert.equal(event.data.sessionID, liveSession.id);
      assert.equal(requests.length, beforeCommand, "AutoCode commands must not prompt the coding model.");
    } finally {
      eventController.abort();
      await commandEvent.catch(() => {});
    }
  }
  async function assertAutoCodeCommands() {
    for (const [text, eventName] of [
      ["config", "openSettings"], ["log", "openLog"], ["status", "openStatus"],
      ["help", "openHelp"], ["", "openHelp"],
    ]) await openAutoCode(text, eventName);
    const beforeRemovedCommand = requests.length;
    await assert.rejects(api(`/api/session/${liveSession.id}/command`, { name: "autocode", text: "settings" }),
      /Usage: \/autocode <config\|log\|status\|help>/, "The removed settings subcommand must be rejected.");
    assert.equal(requests.length, beforeRemovedCommand, "An invalid AutoCode command must not prompt the coding model.");
  }
  await assertAutoCodeCommands();

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
  assert.deepEqual(persisted.plugins.find((entry) => entry.package === pluginPackage).options, selectedOptions);
  assert.equal(persisted.model, "smoke/inherited", "Saving plugin settings must preserve the coding model.");
  assert.ok(persisted.providers.smoke, "Saving plugin settings must preserve provider configuration.");
  await waitForApprovalMode("inherit", "ask");
  await assertAutoCodeCommands();
  assert.deepEqual(await rpc("status", {}), {
    ...selectedOptions, logLimit: 100,
  }, "Status must reflect saved disabled settings after OpenCode reloads the plugin.");
  const disabledLog = await rpc("log", {});
  for (const entry of initialLog.entries) {
    assert.deepEqual(disabledLog.entries.find((candidate) => candidate.id === entry.id), entry,
      "Existing review history must survive reload and remain readable while AutoCode is disabled.");
  }
  await waitForApprovalMode("override", "allow", "reviewer");
  const inherited = await rpc("saveSettings", {
    revision: saved.revision,
    options: { ...selectedOptions, enabled: true, model: "inherit" },
  });
  assert.equal(inherited.effective.model, undefined);
  await waitForApprovalMode("inherit", "allow", "inherited");
  console.log("commands: /autocode config, log, status, help and bare help emit UI events while enabled or disabled, without model calls; removed settings command rejected.");
  console.log("settings: models/variants listed, global choices persisted and live approvals updated; project override preserved.");
  console.log("diagnostics: saved status and existing history remain available after plugin reload while automatic review is disabled.");

  async function shellFixture(directory, command, permissions) {
    const location = { directory };
    const { data: seed } = await api("/api/session", { location, model, permissions });
    const created = Date.now();
    const assistantID = `msg_${randomUUID().replaceAll("-", "")}`;
    const toolID = `call_${randomUUID().replaceAll("-", "")}`;
    const { data: session } = await api("/api/experimental/session/import", {
      info: { ...seed, id: `ses_${randomUUID().replaceAll("-", "")}` }, location,
      messages: [
        { id: `msg_${randomUUID().replaceAll("-", "")}`, type: "user", time: { created },
          text: `Please run exactly ${command} in this temporary project.` },
        { id: assistantID, type: "assistant", agent: "build", model,
          time: { created: created + 1, streamed: created + 2, completed: created + 3 }, finish: "tool-calls",
          content: [{ type: "tool", id: toolID, name: "shell",
            time: { created: created + 1, ran: created + 2, completed: created + 3 },
            state: { status: "completed", metadata: {}, content: [{ type: "text", text: "Recorded fixture; no process was run." }],
              input: { command, workdir: directory } } }] },
      ],
    });
    const { data: messages } = await api(`/api/session/${session.id}/context`);
    const assistant = messages.find((message) => message.type === "assistant");
    const tool = assistant?.content.find((part) => part.type === "tool" && part.name === "shell");
    assert.ok(assistant && tool, "Hard-reject fixture must include the originating shell command.");
    return { sessionID: session.id, permission: {
      action: "shell", resources: [command],
      source: { type: "tool", messageID: assistant.id, id: tool.id },
    } };
  }
  const blocked = await shellFixture(projects.hardReject, "printf smoke-blocked");
  const hardRejectQuery = `location%5Bdirectory%5D=${encodeURIComponent(projects.hardReject)}`;
  const hardRejectLoadedBy = Date.now() + 10_000;
  let hardRejectPlugin;
  do {
    hardRejectPlugin = (await api(`/api/plugin?${hardRejectQuery}`)).data.find((candidate) => candidate.id === "autocode");
    if (hardRejectPlugin?.state.status === "active") break;
    await delay(100);
  } while (Date.now() < hardRejectLoadedBy);
  assert.equal(hardRejectPlugin?.state.status, "active", "AutoCode must be active before hard-rejection coverage runs.");
  const beforeBlocked = requests.length;
  assert.equal((await api(`/api/session/${blocked.sessionID}/permission`, blocked.permission)).data.effect, "deny");
  assert.equal(requests.length, beforeBlocked, "A configured deny must bypass the approval model.");
  assert.deepEqual((await api(`/api/session/${blocked.sessionID}/permission`)).data, [], "A configured deny must not create an approval prompt.");
  assert.deepEqual((await rpc("log", {}, projects.hardReject)).entries, [],
    "A configured deny must not be recorded as an AutoCode review.");
  console.log("hard reject: a configured deny blocks the command before model review or prompting.");
  const compound = await shellFixture(projects.hardReject, "printf smoke-allowed; printf smoke-blocked");
  compound.permission.resources = ["printf smoke-allowed", "printf smoke-blocked"];
  const beforeCompound = requests.length;
  assert.equal((await api(`/api/session/${compound.sessionID}/permission`, compound.permission)).data.effect, "deny");
  assert.equal(requests.length, beforeCompound, "One denied resource must block the whole compound command before model review.");
  assert.deepEqual((await api(`/api/session/${compound.sessionID}/permission`)).data, []);
  assert.deepEqual((await rpc("log", {}, projects.hardReject)).entries, []);
  console.log("hard reject: a denied resource blocks the whole compound command.");
  const disabledForSavedApproval = await rpc("saveSettings", {
    revision: inherited.revision, options: { ...inherited.options, enabled: false },
  });
  await waitForApprovalMode("inherit", "ask");
  const savedCommand = "printf smoke-saved";
  const savedFixture = await shellFixture(projects.inherit, savedCommand);
  const savedRequest = await api(`/api/session/${savedFixture.sessionID}/permission`, {
    ...savedFixture.permission, save: [savedCommand],
  });
  assert.equal(savedRequest.data.effect, "ask");
  await api(`/api/session/${savedFixture.sessionID}/permission/${savedRequest.data.id}/reply`, { decision: "always" });
  const { data: savedApprovals } = await api("/api/permission/saved");
  assert.ok(savedApprovals.some((entry) => entry.action === "shell" && entry.resource === savedCommand), "The native Allow always rule must actually be persisted.");
  const beforeSavedControl = requests.length;
  assert.equal((await api(`/api/session/${savedFixture.sessionID}/permission`, savedFixture.permission)).data.effect, "allow");
  assert.equal(requests.length, beforeSavedControl, "The saved-approval control must allow without a model review.");
  await rpc("saveSettings", {
    revision: disabledForSavedApproval.revision, options: inherited.options,
  });
  await waitForApprovalMode("inherit", "allow", "inherited");
  const deniedAfterSaved = await shellFixture(projects.inherit, savedCommand, [
    { action: "shell", resource: savedCommand, effect: "deny" },
  ]);
  const beforeSavedHistory = await rpc("log", {});
  const beforeSavedDeny = requests.length;
  assert.equal((await api(`/api/session/${deniedAfterSaved.sessionID}/permission`, deniedAfterSaved.permission)).data.effect, "deny");
  assert.equal(requests.length, beforeSavedDeny, "A configured deny must beat a persisted Allow always rule without model review.");
  assert.deepEqual((await api(`/api/session/${deniedAfterSaved.sessionID}/permission`)).data, []);
  assert.deepEqual(await rpc("log", {}), beforeSavedHistory,
    "Configured denies must leave AutoCode history unchanged, including conflicts with saved approvals.");
  console.log("hard reject: configured deny wins over a verified native Allow always approval.");
  const policyBlocked = await shellFixture(projects.hardReject, "printf smoke-policy");
  const beforePolicy = requests.length;
  assert.equal((await api(`/api/session/${policyBlocked.sessionID}/permission`, policyBlocked.permission)).data.effect, "deny");
  assert.equal(requests.length, beforePolicy + 1, "The policy must override an actual allow from the local approval reviewer.");
  assert.ok(!requests.at(-1).tools?.length);
  assert.deepEqual((await api(`/api/session/${policyBlocked.sessionID}/permission`)).data, [], "A policy deny must not create an approval prompt.");
  const policyHistory = await rpc("log", {}, projects.hardReject);
  assert.equal(policyHistory.entries.length, 1);
  assert.equal(policyHistory.entries[0].sessionID, policyBlocked.sessionID);
  assert.equal(policyHistory.entries[0].decision, "allow",
    "History records the reviewer's allow verdict, even when OpenCode's later policy denies the request.");
  assert.equal(policyHistory.entries[0].reason, "Local smoke test approval.");
  console.log("hard reject: protected tool.use policy overrides an automatic model approval.");

  async function assertRejectedShell({ marker, toolID, outputFile, reviewCount, reason }) {
    const { data: session } = await api("/api/session", { location: { directory: projects.hardReject }, model });
    const before = requests.length;
    await api(`/api/session/${session.id}/prompt`, {
      text: `${marker}: Run the shell command requested by this local test provider.`,
    });
    await api(`/api/experimental/session/${session.id}/wait`, {}, 20_000);
    const { data: messages } = await api(`/api/session/${session.id}/context`);
    const call = messages.flatMap((message) => message.type === "assistant" ? message.content : [])
      .find((part) => part.type === "tool" && part.id === toolID);
    assert.ok(call, "The coding model must actually propose the rejected shell command.");
    assert.equal(call.state.status, "error", `A hard-rejected shell command must fail: ${JSON.stringify(call)}`);
    assert.match(JSON.stringify(call.state.error), reason);
    await assert.rejects(access(path.join(projects.hardReject, outputFile)), { code: "ENOENT" }, "The rejected command must never execute its harmless printf redirection.");
    const reviews = requests.slice(before).filter((request) => request.messages?.some((message) =>
      JSON.stringify(message.content).includes("REVIEW_DATA_JSON")));
    assert.equal(reviews.length, reviewCount);
    assert.deepEqual((await api(`/api/session/${session.id}/permission`)).data, []);
    return session.id;
  }
  await assertRejectedShell({
    marker: "LIVE_HARD_REJECT", toolID: "call_live_hard_reject", outputFile: ".autocode-hard-reject-marker",
    reviewCount: 0, reason: /Permission denied/,
  });
  assert.deepEqual(await rpc("log", {}, projects.hardReject), policyHistory,
    "An actually blocked configured-deny tool call must not create a review record.");
  console.log("hard reject: configured-denied shell tool failed without review and never created its printf marker.");
  const policyExecutionSessionID = await assertRejectedShell({
    marker: "LIVE_POLICY_REJECT", toolID: "call_live_policy_reject", outputFile: ".autocode-policy-reject-marker",
    reviewCount: 1, reason: /Blocked by configuration policy/,
  });
  const finalPolicyHistory = await rpc("log", {}, projects.hardReject);
  assert.equal(finalPolicyHistory.entries.length, 2);
  assert.equal(finalPolicyHistory.entries.find((entry) => entry.sessionID === policyExecutionSessionID)?.decision, "allow",
    "A failed shell execution after a policy block must retain the actual review verdict, not pretend the reviewer denied it.");
  console.log("hard reject: policy-denied shell tool failed despite the model's approval and never created its printf marker.");
  console.log("diagnostics: configured denies create no review records; protected-policy blocks retain the model's allow verdict without claiming successful execution.");
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
