import assert from "node:assert/strict";
import { verifyArtifact, sanitize } from "./release-artifact.mjs";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const REPOSITORY = "expiracy/autocode";
const REGISTRY = "https://registry.npmjs.org";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

export function assertPublishContext(env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, "true", "Publication requires GitHub Actions OIDC.");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "Publication requires manual dispatch.");
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, "Publication requires the upstream repository.");
  assert.ok(env.GITHUB_REF === "refs/heads/main" && env.GITHUB_REF_PROTECTED === "true", "Publication requires protected main.");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "Publication requires a GitHub-hosted runner.");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${REPOSITORY}/.github/workflows/publish.yml@refs/heads/main`, "Publication requires the trusted publish workflow.");
  assert.equal(env.AUTOCODE_PUBLISH_ACTION, "publish", "Publication must be explicitly requested.");
  assert.equal(env.AUTOCODE_PUBLISH_ENVIRONMENT, "npm-production", "Publication requires the npm-production environment.");
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && env.ACTIONS_ID_TOKEN_REQUEST_URL, "Missing GitHub OIDC credentials.");
  const endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.ok(endpoint.protocol === "https:" && endpoint.hostname.endsWith(".actions.githubusercontent.com"), "Invalid GitHub OIDC endpoint.");
  assert.ok(!Object.entries(env).some(([key, value]) => value && /^(npm_token|npm_auth_token|node_auth_token|npm_config_.*(?:auth|token))$/i.test(key)), "Legacy npm credentials must not be supplied.");
}

function assertPublished(candidate, metadata) {
  assert.ok(metadata, "The published version is not available from the public registry yet; retry this workflow safely.");
  assert.equal(metadata.name, candidate.manifest.name, "Published package name mismatch.");
  assert.equal(metadata.version, candidate.manifest.version, "Published package version mismatch.");
  assert.equal(metadata.license, "MIT", "Published package licence mismatch.");
  assert.equal(metadata.channelVersion, candidate.manifest.version, "Published channel does not target this version; refusing to change dist-tags.");
  assert.equal(metadata.dist?.integrity, candidate.manifest.integrity, "Published artifact integrity mismatch; never overwrite a version.");
}

function publicationChannel(candidate, selection = "package") {
  assert.ok(["package", "latest"].includes(selection), "Choose publication channel package or latest.");
  const channel = selection === "package" ? candidate.manifest.channel : selection;
  assert.ok(["next", "latest"].includes(channel), "Invalid packaged publication channel.");
  return channel;
}

export async function deliverPublication({ mode, candidate, channel: selection = "package", env = process.env, lookup, publish, verifyTag = assertPublicationTag }) {
  const { version, sourceCommit, sha256 } = candidate.manifest;
  const channel = publicationChannel(candidate, selection);
  if (mode !== "rehearsal") {
    assert.equal(mode, "publish", "Choose rehearsal or publish.");
    assertPublishContext(env);
    assert.equal(env.GITHUB_SHA, sourceCommit, "Publication source must match the workflow commit.");
  }
  const result = { outcome: "rehearsal", version, sourceCommit, channel, packageChannel: candidate.manifest.channel, sha256 };
  if (mode === "rehearsal") return result;
  await verifyTag(candidate);
  const existing = await lookup(candidate, channel);
  if (existing) {
    assertPublished(candidate, existing);
    return { ...result, outcome: "already-published" };
  }
  await publish(candidate, env, channel);
  assertPublished(candidate, await lookup(candidate, channel));
  return { ...result, outcome: "published" };
}

export async function lookupPublishedVersion(candidate, fetcher = fetch, publicationChannel = candidate.manifest.channel) {
  assert.ok(["next", "latest"].includes(publicationChannel), "Invalid publication channel.");
  const { name, version } = candidate.manifest;
  const response = await fetcher(`${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    redirect: "error", credentials: "omit", headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000),
  });
  const metadata = await response.json();
  if (response.status === 404) {
    assert.equal(metadata, `version not found: ${version}`, "Unexpected npm missing-version response; refusing publication.");
    return undefined;
  }
  assert.equal(response.status, 200, `Public npm lookup failed with HTTP ${response.status}; refusing publication.`);
  assert.ok(metadata && typeof metadata === "object" && !Array.isArray(metadata), "Invalid public npm metadata.");
  const channelResponse = await fetcher(`${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(publicationChannel)}`, {
    redirect: "error", credentials: "omit", headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000),
  });
  assert.equal(channelResponse.status, 200, `Public npm channel lookup failed with HTTP ${channelResponse.status}.`);
  const channel = await channelResponse.json();
  assert.equal(channel.name, name, "Invalid public npm channel metadata.");
  return { ...metadata, channelVersion: channel.version };
}

export function assertPublicationTag(candidate, sourceDirectory = root) {
  const tag = `v${candidate.manifest.version}`;
  let target;
  try {
    target = execFileSync("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], { cwd: sourceDirectory, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch { throw new Error(`Missing release tag ${tag}; prepare its GitHub release draft first.`); }
  assert.equal(target, candidate.manifest.sourceCommit, `The release tag ${tag} does not point to the tested source commit; refusing publication.`);
}

export async function publishVerifiedCandidate(candidate, env = process.env, run = exec, channel = candidate.manifest.channel) {
  assert.ok(["next", "latest"].includes(channel), "Invalid publication channel.");
  assertPublishContext(env);
  const directory = await mkdtemp(path.join(tmpdir(), "autocode-publish-"));
  try {
    const artifact = path.join(directory, "package.tgz");
    await writeFile(artifact, candidate.bytes, { mode: 0o400, flag: "wx" });
    const userconfig = path.join(directory, "user.npmrc");
    const globalconfig = path.join(directory, "global.npmrc");
    await writeFile(userconfig, "", { mode: 0o600, flag: "wx" });
    await writeFile(globalconfig, "", { mode: 0o600, flag: "wx" });
    const isolated = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(npm_config_|npm_token$|npm_auth_token$|node_auth_token$)/i.test(key)));
    const options = { cwd: directory, env: isolated, timeout: 300_000, maxBuffer: 2_000_000 };
    const version = await run("npm", ["--version"], options);
    assert.equal(version.stdout.trim(), "12.2.0", "Publication requires the pinned npm 12.2.0 CLI.");
    return await run("npm", ["publish", artifact, "--ignore-scripts", "--provenance", "--access", "public", "--tag", channel,
      "--userconfig", userconfig, "--globalconfig", globalconfig, "--cache", path.join(directory, "cache"), "--registry", REGISTRY], options);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function preparePublication({ sourceDirectory = root, ...options }) {
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDirectory, encoding: "utf8", timeout: 30_000 }).trim();
  assert.equal(sourceCommit, options.commit, "Publication source differs from the checked-out commit.");
  const checked = await verifyArtifact(options);
  const source = JSON.parse(await readFile(path.join(sourceDirectory, "package.json"), "utf8"));
  assert.equal(checked.metadata.name, source.name, "Artifact does not match the checked source package.");
  assert.equal(checked.metadata.version, source.version, "Artifact does not match the checked source version.");
  return checked;
}

export function sanitizePublishDiagnostic(value, env = process.env) {
  let message = String(value ?? "");
  for (const key of ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "NPM_TOKEN", "NPM_AUTH_TOKEN", "NODE_AUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    if (env[key]) message = message.replaceAll(env[key], "[redacted]");
  }
  return sanitize(message);
}

function argumentsFor(argv) {
  const [mode, ...flags] = argv;
  assert.ok(["rehearsal", "publish"].includes(mode), "Choose rehearsal or publish.");
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index]?.replace(/^--/, "");
    assert.ok(flags[index]?.startsWith("--") && ["artifact", "manifest", "commit", "diagnostics", "channel"].includes(key) && flags[index + 1] && !flags[index + 1].startsWith("--") && !Object.hasOwn(options, key), "Invalid npm publication arguments.");
    options[key] = flags[index + 1];
  }
  assert.ok(options.artifact && options.manifest && options.commit && options.diagnostics, "Supply --artifact, --manifest, --commit and --diagnostics.");
  assert.ok(["package", "latest"].includes(options.channel ?? "package"), "Choose publication channel package or latest.");
  return { mode, options };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  let result = { outcome: "failure" };
  let output = "";
  try {
    const parsed = argumentsFor(process.argv.slice(2));
    options = parsed.options;
    if (parsed.mode === "publish") assertPublishContext();
    const candidate = await preparePublication(options);
    result = await deliverPublication({ mode: parsed.mode, candidate, channel: options.channel,
      lookup: (value, channel) => lookupPublishedVersion(value, fetch, channel),
      publish: async (value, env, channel) => {
        const command = await publishVerifiedCandidate(value, env, exec, channel);
        output += command.stdout + command.stderr;
      },
    });
    const message = result.outcome === "rehearsal"
      ? `Rehearsed ${candidate.manifest.name}@${result.version}; no npm write or OIDC request was made.`
      : `Verified ${candidate.manifest.name}@${result.version}: ${result.outcome}.`;
    const review = `${message}\n\n- Source: \`${result.sourceCommit}\`\n- Expected immutable tag: \`v${result.version}\`\n- Channel: \`${result.channel}\`\n- Packaged default channel: \`${result.packageChannel}\`\n- Licence: MIT\n- Archive SHA-256: \`${result.sha256}\`\n- Integrity: \`${candidate.manifest.integrity}\`\n`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, review, { flag: "a" });
  } catch (error) {
    output += (error.stdout ?? "") + (error.stderr ?? "") + error.message;
    result.failure = sanitizePublishDiagnostic(error.message);
    console.error(result.failure);
    process.exitCode = 1;
  } finally {
    if (options?.diagnostics) {
      await mkdir(options.diagnostics, { recursive: true, mode: 0o700 });
      await writeFile(path.join(options.diagnostics, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
      await writeFile(path.join(options.diagnostics, "command.log"), sanitizePublishDiagnostic(output), { mode: 0o600 });
    }
  }
}
