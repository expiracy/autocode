import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const NAME = "opencode-autocode";
const REPOSITORY = "expiracy/autocode";
const REGISTRY = "https://registry.npmjs.org";
const digest = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

export function assertStageContext(env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, "true", "Staging requires GitHub Actions OIDC.");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "Staging requires manual dispatch.");
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, "Staging requires the upstream repository.");
  assert.ok(env.GITHUB_REF === "refs/heads/main" && env.GITHUB_REF_PROTECTED === "true", "Staging requires protected main.");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "Staging requires a GitHub-hosted runner.");
  assert.equal(env.AUTOCODE_DELIVERY_ACTION, "stage", "Staging must be explicitly requested.");
  assert.equal(env.AUTOCODE_DELIVERY_ENVIRONMENT, "npm-staging", "Staging requires the npm-staging environment.");
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && env.ACTIONS_ID_TOKEN_REQUEST_URL, "Missing GitHub OIDC credentials.");
  const endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.ok(endpoint.protocol === "https:" && endpoint.hostname.endsWith(".actions.githubusercontent.com"), "Invalid GitHub OIDC endpoint.");
  assert.ok(!env.NPM_TOKEN && !env.NODE_AUTH_TOKEN && !env.NPM_AUTH_TOKEN, "Legacy npm tokens must not be supplied.");
}

export function releaseChannel(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  assert.ok(match && !(match[4]?.split(".").some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))), "Invalid package version.");
  return match[4] ? "next" : "latest";
}

function archiveText(artifact, name) {
  return execFileSync("tar", ["-xOf", artifact, `package/${name}`], { encoding: "utf8", maxBuffer: 2_000_000 });
}

export async function verifyArtifact({ artifact, manifest, commit }) {
  assert.match(commit ?? "", /^[a-f0-9]{40}$/, "Expected a full source commit SHA.");
  assert.ok((await lstat(artifact)).isFile(), "Artifact must be a regular file.");
  const record = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(record.schemaVersion, 1, "Unsupported artifact manifest.");
  assert.equal(record.sourceCommit, commit, "Artifact source commit mismatch.");
  assert.equal(record.repository, REPOSITORY, "Artifact repository mismatch.");
  assert.equal(record.name, NAME, "Artifact package name mismatch.");
  assert.equal(record.license, "MIT", "Artifact must use the MIT licence.");
  assert.equal(record.filename, "package.tgz", "Unexpected artifact filename.");
  assert.equal(path.basename(artifact), record.filename, "Artifact filename mismatch.");
  assert.equal(record.channel, releaseChannel(record.version), "Release channel does not match the version.");
  const bytes = await readFile(artifact);
  assert.equal(digest(bytes, "sha256", "hex"), record.sha256, "Artifact SHA-256 mismatch.");
  assert.equal(`sha512-${digest(bytes, "sha512", "base64")}`, record.integrity, "Artifact integrity mismatch.");
  const names = execFileSync("tar", ["-tzf", artifact], { encoding: "utf8", maxBuffer: 2_000_000 }).trim().split("\n");
  assert.ok(names.every(name => name.startsWith("package/") && !name.includes("\\") && !name.split("/").includes("..")), "Unsafe archive paths.");
  assert.ok(!names.some(name => name.split("/").some(part => [".npmrc", ".git", "node_modules", ".gigacode", ".live-validation", "test"].includes(part))), "Unexpected private or development files in artifact.");
  for (const name of ["package.json", "LICENSE", "index.js", "tui.js", "dist/index.js", "dist/tui.js", "dist/rpc.js"]) {
    assert.ok(names.includes(`package/${name}`), `Missing package entrypoint: ${name}`);
  }
  const metadata = JSON.parse(archiveText(artifact, "package.json"));
  assert.equal(metadata.name, record.name, "Archived name mismatch.");
  assert.equal(metadata.version, record.version, "Archived version mismatch.");
  assert.equal(metadata.license, record.license, "Archived licence mismatch.");
  assert.equal(metadata.repository?.url, `git+https://github.com/${REPOSITORY}.git`, "Archived repository mismatch.");
  assert.deepEqual(metadata.publishConfig, { access: "public", registry: REGISTRY, tag: record.channel }, "Archived npm delivery settings mismatch.");
  assert.ok(archiveText(artifact, "LICENSE").startsWith("MIT License"), "Missing MIT licence text.");
  return { manifest: record, metadata, bytes };
}

export function sanitize(value) {
  return String(value ?? "")
    .replace(/npm_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/(?:authorization\s*[=:]\s*(?:Bearer\s+)?|Bearer\s+)[^\s,]+/gi, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/([?&](?:token|sessionId|auth|key)=)[^&\s]+/gi, "$1[redacted]")
    .slice(-64_000);
}

async function report(directory, result, output = "") {
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "result.json"), JSON.stringify(result, null, 2) + "\n");
  await writeFile(path.join(directory, "command.log"), sanitize(output));
}

export async function buildArtifact({ output, commit }) {
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(actual, commit, "Build commit differs from checked-out source.");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(), "", "Build requires a clean source checkout.");
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(lock.name, metadata.name, "Lockfile package name mismatch.");
  assert.equal(lock.version, metadata.version, "Lockfile package version mismatch.");
  await mkdir(output, { recursive: true });
  assert.ok(!await lstat(path.join(output, "package.tgz")).then(() => true, () => false), "Refusing to overwrite an existing release artifact.");
  const temporary = await mkdtemp(path.join(tmpdir(), "autocode-pack-"));
  let stdout;
  try {
    const npm = await isolatedNpm(temporary);
    ({ stdout } = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", path.resolve(output), ...npm.flags], { cwd: root, env: npm.env, maxBuffer: 2_000_000 }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
  const [packed] = JSON.parse(stdout);
  await rename(path.join(output, packed.filename), path.join(output, "package.tgz"));
  const bytes = await readFile(path.join(output, "package.tgz"));
  const manifest = {
    schemaVersion: 1, sourceCommit: commit, repository: REPOSITORY,
    name: packed.name, version: packed.version, license: "MIT", channel: releaseChannel(packed.version), filename: "package.tgz",
    sha256: digest(bytes, "sha256", "hex"), integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
    nodeVersion: process.version, npmVersion: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
  };
  await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await verifyArtifact({ artifact: path.join(output, "package.tgz"), manifest: path.join(output, "manifest.json"), commit });
  console.log(JSON.stringify(manifest, null, 2));
}

async function isolatedNpm(directory, inherit = false) {
  const userconfig = path.join(directory, "user.npmrc");
  const globalconfig = path.join(directory, "global.npmrc");
  await writeFile(userconfig, "", { mode: 0o600 });
  await writeFile(globalconfig, "", { mode: 0o600 });
  const env = inherit ? Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(npm_config_|npm_token$|npm_auth_token$|node_auth_token$)/i.test(key)))
    : { PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C.UTF-8" };
  return { env, flags: ["--userconfig", userconfig, "--globalconfig", globalconfig, "--cache", path.join(directory, "cache"), "--registry", REGISTRY] };
}

export async function installArtifact(options) {
  const checked = await verifyArtifact(options);
  const directory = await mkdtemp(path.join(tmpdir(), "autocode-install-"));
  const result = { outcome: "failure", sourceCommit: checked.manifest.sourceCommit, version: checked.manifest.version, sha256: checked.manifest.sha256, nodeVersion: process.version };
  let output = "";
  try {
    const artifact = path.join(directory, "package.tgz");
    await writeFile(artifact, checked.bytes, { mode: 0o400 });
    await writeFile(path.join(directory, "package.json"), '{"private":true,"type":"module"}\n');
    const npm = await isolatedNpm(directory);
    const installed = await exec("npm", ["install", artifact, "--ignore-scripts", "--no-audit", "--no-fund", "--strict-peer-deps", ...npm.flags], { cwd: directory, env: npm.env, timeout: 300_000, maxBuffer: 2_000_000 });
    output += installed.stdout + installed.stderr;
    const dependencies = await exec("npm", ["ls", "--omit=dev", "--all", ...npm.flags], { cwd: directory, env: npm.env, timeout: 30_000, maxBuffer: 2_000_000 });
    output += dependencies.stdout + dependencies.stderr;
    const actual = JSON.parse(await readFile(path.join(directory, "node_modules", NAME, "package.json"), "utf8"));
    assert.equal(actual.version, checked.manifest.version);
    const imports = await exec(process.execPath, ["--input-type=module", "-e", 'import assert from "node:assert/strict"; const main = await import("opencode-autocode"); const tui = await import("opencode-autocode/tui"); const rpc = await import("opencode-autocode/rpc"); assert.equal(main.default.id,"autocode"); assert.equal(tui.default.id,"autocode"); assert.ok(rpc.AutoCodeRpc);'], { cwd: directory, env: npm.env, timeout: 30_000 });
    output += imports.stdout + imports.stderr;
    result.outcome = "success";
    console.log(`Exact artifact installed and all three entrypoints imported on ${process.version}.`);
  } catch (error) {
    output += (error.stdout ?? "") + (error.stderr ?? "") + error.message;
    result.failure = sanitize(error.message);
    throw error;
  } finally {
    await report(options.diagnostics, result, output);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function stageArtifact(options) {
  assertStageContext();
  const checked = await verifyArtifact(options);
  assert.equal(process.env.GITHUB_SHA, checked.manifest.sourceCommit, "Stage source must match this workflow commit.");
  const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim().split(".").map(Number);
  assert.ok(npmVersion[0] > 11 || (npmVersion[0] === 11 && npmVersion[1] >= 15), "npm staging requires npm 11.15 or newer.");
  const directory = await mkdtemp(path.join(tmpdir(), "autocode-stage-"));
  const result = { outcome: "failure", sourceCommit: checked.manifest.sourceCommit, version: checked.manifest.version, sha256: checked.manifest.sha256, channel: checked.manifest.channel };
  let output = "";
  try {
    const artifact = path.join(directory, "package.tgz");
    await writeFile(artifact, checked.bytes, { mode: 0o400 });
    const npm = await isolatedNpm(directory, true);
    const staged = await exec("npm", ["stage", "publish", artifact, "--ignore-scripts", "--access", "public", "--tag", checked.manifest.channel, ...npm.flags], { cwd: directory, env: npm.env, timeout: 300_000, maxBuffer: 2_000_000 });
    output += staged.stdout + staged.stderr;
    result.outcome = "success";
    console.log(`Staged ${NAME}@${checked.manifest.version} under ${checked.manifest.channel}. Human npm approval is still required.`);
  } catch (error) {
    output += (error.stdout ?? "") + (error.stderr ?? "") + error.message;
    result.failure = sanitize(error.message);
    throw error;
  } finally {
    await report(options.diagnostics, result, output);
    await rm(directory, { recursive: true, force: true });
  }
}

function argumentsFor(argv) {
  const [command, ...flags] = argv;
  assert.ok(["build", "verify", "install", "stage"].includes(command), "Use build, verify, install, or stage.");
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index]?.replace(/^--/, "");
    assert.ok(flags[index]?.startsWith("--") && ["output", "artifact", "manifest", "commit", "diagnostics"].includes(key) && flags[index + 1] && !flags[index + 1].startsWith("--") && !Object.hasOwn(options, key), "Invalid artifact command arguments.");
    options[key] = flags[index + 1];
  }
  assert.ok(options.commit, "A source --commit is required.");
  if (command === "build") assert.ok(options.output, "An --output directory is required.");
  else assert.ok(options.artifact && options.manifest, "An --artifact and --manifest are required.");
  return { command, options };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { command, options } = argumentsFor(process.argv.slice(2));
    if (command === "build") await buildArtifact(options);
    else if (command === "install") await installArtifact(options);
    else if (command === "stage") await stageArtifact(options);
    else { const checked = await verifyArtifact(options); console.log(`Verified ${checked.manifest.name}@${checked.manifest.version} from ${checked.manifest.sourceCommit} (${checked.manifest.sha256}).`); }
  } catch (error) {
    console.error(sanitize(error.message));
    process.exitCode = 1;
  }
}
