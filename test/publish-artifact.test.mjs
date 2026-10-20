import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deliverPublication, lookupPublishedVersion, assertPublicationTag, publishVerifiedCandidate, preparePublication, sanitizePublishDiagnostic } from "../scripts/publish-artifact.mjs";

const candidate = { manifest: { name: "opencode-autocode", version: "0.1.0-beta.3", sourceCommit: "a".repeat(40), channel: "next", integrity: "sha512-fixture", sha256: "b".repeat(64) }, bytes: Buffer.from("the verified artifact") };

test("rehearsal reports the verified candidate without contacting npm or requiring OIDC", async () => {
  const forbidden = () => { throw new Error("Rehearsal contacted npm"); };
  assert.deepEqual(await deliverPublication({ mode: "rehearsal", candidate, env: {}, lookup: forbidden, publish: forbidden }), {
    outcome: "rehearsal", version: candidate.manifest.version, sourceCommit: candidate.manifest.sourceCommit, channel: "next", sha256: candidate.manifest.sha256,
  });
});

const context = {
  GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "expiracy/autocode",
  GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true", RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_WORKFLOW_REF: "expiracy/autocode/.github/workflows/publish.yml@refs/heads/main", GITHUB_SHA: candidate.manifest.sourceCommit,
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.actions.githubusercontent.com/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
  AUTOCODE_PUBLISH_ENVIRONMENT: "npm-production", AUTOCODE_PUBLISH_ACTION: "publish",
};

test("publication rejects an unprotected source before any registry lookup or mutation", async () => {
  const forbidden = () => { throw new Error("Contacted npm before checking source"); };
  await assert.rejects(deliverPublication({ mode: "publish", candidate, env: { ...context, GITHUB_REF_PROTECTED: "false" }, lookup: forbidden, publish: forbidden }), /protected main/);
});

const published = { name: candidate.manifest.name, version: candidate.manifest.version, license: "MIT", channelVersion: candidate.manifest.version, dist: { integrity: candidate.manifest.integrity } };

test("explicit approved publication sends the verified candidate once and verifies registry integrity", async () => {
  const calls = [];
  let lookups = 0;
  const result = await deliverPublication({ mode: "publish", candidate, env: context, verifyTag: () => {},
    lookup: async value => { assert.equal(value, candidate); return ++lookups === 1 ? undefined : published; },
    publish: async (value, env) => { assert.equal(value, candidate); assert.equal(env, context); calls.push(value.bytes); },
  });
  assert.equal(result.outcome, "published");
  assert.equal(lookups, 2);
  assert.deepEqual(calls, [candidate.bytes]);
});

test("only npm's explicit missing-version JSON404 permits a new version", async () => {
  const calls = [];
  const missing = await lookupPublishedVersion(candidate, async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(`version not found: ${candidate.manifest.version}`), { status: 404 });
  });
  assert.equal(missing, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://registry.npmjs.org/opencode-autocode/${candidate.manifest.version}`);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.credentials, "omit");
});

async function taggedSource(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "autocode-publish-tag-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = args => execFileSync("git", ["-c", "user.name=AutoCode Test", "-c", "user.email=test@example.invalid", ...args], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init"]);
  await writeFile(path.join(directory, "source"), "tested source");
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: candidate.manifest.name, version: candidate.manifest.version }));
  git(["add", "source", "package.json"]);
  git(["commit", "-m", "source"]);
  return { directory, git, candidate: { ...candidate, manifest: { ...candidate.manifest, sourceCommit: git(["rev-parse", "HEAD"]) } } };
}

test("a new publication refuses a missing release tag before contacting npm", async t => {
  const f = await taggedSource(t);
  const forbidden = () => { throw new Error("Unexpected registry contact"); };
  await assert.rejects(deliverPublication({ mode: "publish", candidate: f.candidate, env: { ...context, GITHUB_SHA: f.candidate.manifest.sourceCommit },
    lookup: forbidden, publish: forbidden, verifyTag: value => assertPublicationTag(value, f.directory),
  }), /release tag/);
});

test("an existing version with identical bytes but another channel target is never promoted", async () => {
  await assert.rejects(deliverPublication({ mode: "publish", candidate, env: context, verifyTag: () => {},
    lookup: async () => ({ ...published, channelVersion: "0.1.0-beta.4" }),
    publish: () => { throw new Error("Unexpected mutation"); },
  }), /channel/);
});

test("npm receives exactly the verified archive with lifecycle scripts disabled and provenance enabled", async () => {
  const commands = [];
  await publishVerifiedCandidate(candidate, { ...context, PATH: process.env.PATH, HOME: process.env.HOME, npm_config_registry: "https://wrong.invalid", NPM_CONFIG_PROVENANCE: "false" }, async (command, args, options) => {
    commands.push(args);
    assert.equal(command, "npm");
    if (args[0] === "--version") return { stdout: "12.2.0\n", stderr: "" };
    assert.equal(args[0], "publish");
    assert.deepEqual(await readFile(args[1]), candidate.bytes);
    assert.equal(path.dirname(args[1]), options.cwd);
    assert.equal(options.env.HOME, process.env.HOME);
    assert.ok(!Object.keys(options.env).some(key => /^npm_config_/i.test(key)));
    assert.ok(args.includes("--ignore-scripts") && args.includes("--provenance"));
    assert.deepEqual(args.slice(2, 8), ["--ignore-scripts", "--provenance", "--access", "public", "--tag", "next"]);
    for (const flag of ["--userconfig", "--globalconfig"]) assert.equal(await readFile(args[args.indexOf(flag) + 1], "utf8"), "");
    assert.equal(args[args.indexOf("--registry") + 1], "https://registry.npmjs.org");
    return { stdout: "Published\n", stderr: "" };
  });
  assert.equal(commands.length, 2);
});

async function artifactFixture(t, sourceVersion = candidate.manifest.version) {
  const f = await taggedSource(t);
  const packageDirectory = path.join(f.directory, "archive", "package");
  await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
  const metadata = { name: candidate.manifest.name, version: sourceVersion, license: "MIT",
    repository: { type: "git", url: "git+https://github.com/expiracy/autocode.git" },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org", tag: "next" } };
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify(metadata));
  await writeFile(path.join(packageDirectory, "LICENSE"), "MIT License\n");
  for (const name of ["index.js", "tui.js", "dist/index.js", "dist/tui.js", "dist/rpc.js"]) await writeFile(path.join(packageDirectory, name), "export default {};\n");
  const artifact = path.join(f.directory, "package.tgz");
  execFileSync("tar", ["-czf", artifact, "-C", path.join(f.directory, "archive"), "package"]);
  const bytes = await readFile(artifact);
  const manifest = path.join(f.directory, "manifest.json");
  const record = { ...f.candidate.manifest, version: sourceVersion, schemaVersion: 1, repository: "expiracy/autocode", license: "MIT", filename: "package.tgz",
    sha256: createHash("sha256").update(bytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  await writeFile(manifest, JSON.stringify(record));
  return { ...f, artifact, manifest, record, bytes };
}

test("a checksum-valid archive cannot publish a version different from the checked source", async t => {
  const f = await artifactFixture(t);
  await writeFile(path.join(f.directory, "package.json"), JSON.stringify({ name: candidate.manifest.name, version: "0.1.0-beta.9" }));
  await assert.rejects(preparePublication({ artifact: f.artifact, manifest: f.manifest, commit: f.record.sourceCommit, sourceDirectory: f.directory }), /source version/);
});

test("the command rehearses without credentials and retains the exact candidate review record", async t => {
  const repository = path.resolve(import.meta.dirname, "..");
  const source = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const f = await artifactFixture(t, source.version);
  f.record.sourceCommit = commit;
  await writeFile(f.manifest, JSON.stringify(f.record));
  const diagnostics = path.join(f.directory, "diagnostics");
  const summary = path.join(f.directory, "summary.md");
  const output = execFileSync(process.execPath, ["scripts/publish-artifact.mjs", "rehearsal", "--artifact", f.artifact, "--manifest", f.manifest,
    "--commit", commit, "--diagnostics", diagnostics], { cwd: repository, encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary } });
  assert.match(output, /Rehearsed/);
  const result = JSON.parse(await readFile(path.join(diagnostics, "result.json"), "utf8"));
  assert.equal(result.outcome, "rehearsal");
  assert.equal(result.sha256, f.record.sha256);
  assert.match(await readFile(summary, "utf8"), new RegExp(`v${source.version.replaceAll(".", "\\.")}`));
});

test("an annotated tag is accepted only at the tested commit", async t => {
  const f = await taggedSource(t);
  f.git(["tag", "-a", `v${f.candidate.manifest.version}`, "-m", "reviewed release"]);
  assert.doesNotThrow(() => assertPublicationTag(f.candidate, f.directory));
});

test("a release tag pointing to another commit is never moved", async t => {
  const f = await taggedSource(t);
  const tag = `v${f.candidate.manifest.version}`;
  f.git(["tag", tag]);
  await writeFile(path.join(f.directory, "source"), "new source");
  f.git(["add", "source"]);
  f.git(["commit", "-m", "new source"]);
  const changed = { ...f.candidate, manifest: { ...f.candidate.manifest, sourceCommit: f.git(["rev-parse", "HEAD"]) } };
  assert.throws(() => assertPublicationTag(changed, f.directory), /release tag.*tested source commit/);
  assert.equal(f.git(["rev-parse", `refs/tags/${tag}`]), f.candidate.manifest.sourceCommit);
});

test("an exact already-published version and channel make a rerun read-only", async () => {
  const result = await deliverPublication({ mode: "publish", candidate, env: context, verifyTag: () => {}, lookup: async () => published,
    publish: () => { throw new Error("Unexpected mutation"); },
  });
  assert.equal(result.outcome, "already-published");
});

test("an existing version with conflicting bytes is never overwritten", async () => {
  await assert.rejects(deliverPublication({ mode: "publish", candidate, env: context, verifyTag: () => {},
    lookup: async () => ({ ...published, dist: { integrity: "sha512-other" } }),
    publish: () => { throw new Error("Unexpected mutation"); },
  }), /integrity mismatch/);
});

test("registry network failure cannot be mistaken for an unpublished version", async () => {
  await assert.rejects(deliverPublication({ mode: "publish", candidate, env: context, verifyTag: () => {},
    lookup: value => lookupPublishedVersion(value, async () => { throw new Error("network failure"); }),
    publish: () => { throw new Error("Unexpected mutation"); },
  }), /network failure/);
});

test("authentication, server, malformed, and unrelated404 responses all fail closed", async () => {
  for (const [status, body] of [[401, { error: "Unauthorized" }], [503, { error: "Unavailable" }], [404, "Not found"], [200, null]]) {
    await assert.rejects(lookupPublishedVersion(candidate, async () => new Response(JSON.stringify(body), { status })));
  }
  await assert.rejects(lookupPublishedVersion(candidate, async () => new Response("gateway error", { status: 404 })));
});

test("public metadata lookup resolves the expected channel independently", async () => {
  const calls = [];
  const actual = await lookupPublishedVersion(candidate, async url => {
    calls.push(String(url));
    return new Response(JSON.stringify(published), { status: 200 });
  });
  assert.equal(actual.channelVersion, candidate.manifest.version);
  assert.deepEqual(calls, [`https://registry.npmjs.org/opencode-autocode/${candidate.manifest.version}`, "https://registry.npmjs.org/opencode-autocode/next"]);
});

test("publication requires the trusted manual environment, workflow, hosted source, and token-free OIDC", async () => {
  const forbidden = () => { throw new Error("Unexpected registry contact"); };
  for (const patch of [
    { GITHUB_EVENT_NAME: "push" }, { GITHUB_REPOSITORY: "fork/autocode" }, { GITHUB_REF: "refs/heads/other" },
    { RUNNER_ENVIRONMENT: "self-hosted" }, { GITHUB_WORKFLOW_REF: "expiracy/autocode/.github/workflows/release.yml@refs/heads/main" },
    { AUTOCODE_PUBLISH_ACTION: "rehearsal" }, { AUTOCODE_PUBLISH_ENVIRONMENT: "npm-staging" },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }, { ACTIONS_ID_TOKEN_REQUEST_URL: "https://invalid.example/token" },
    { NPM_TOKEN: "legacy" }, { NODE_AUTH_TOKEN: "legacy" }, { npm_config__authToken: "legacy" }, { GITHUB_SHA: "b".repeat(40) },
  ]) {
    await assert.rejects(deliverPublication({ mode: "publish", candidate, env: { ...context, ...patch }, lookup: forbidden, publish: forbidden }), error => {
      assert.doesNotMatch(error.message, /Unexpected registry contact/);
      return true;
    });
  }
});

test("an unexpected npm CLI version is rejected before publication", async () => {
  let commands = 0;
  await assert.rejects(publishVerifiedCandidate(candidate, context, async (command, args) => {
    commands++;
    assert.deepEqual(args, ["--version"]);
    return { stdout: "12.1.0\n", stderr: "" };
  }), /pinned npm/);
  assert.equal(commands, 1);
});

test("retained publication diagnostics redact opaque OIDC credentials and bearer tokens", () => {
  const redacted = sanitizePublishDiagnostic("opaque-request-secret Authorization: Bearer npm_secret123 eyJabc.def.ghi", { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "opaque-request-secret" });
  assert.doesNotMatch(redacted, /opaque-request-secret|npm_secret123|eyJabc/);
});

test("a refused local publication retains its failure without reading an archive or running npm", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "autocode-publish-rejected-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const diagnostics = path.join(directory, "diagnostics");
  assert.throws(() => execFileSync(process.execPath, ["scripts/publish-artifact.mjs", "publish", "--artifact", path.join(directory, "absent.tgz"),
    "--manifest", path.join(directory, "absent.json"), "--commit", candidate.manifest.sourceCommit, "--diagnostics", diagnostics],
    { cwd: path.resolve(import.meta.dirname, ".."), env: {}, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /GitHub Actions OIDC/);
    return true;
  });
  const result = JSON.parse(await readFile(path.join(diagnostics, "result.json"), "utf8"));
  assert.equal(result.outcome, "failure");
  assert.match(result.failure, /GitHub Actions OIDC/);
  assert.doesNotMatch(result.failure, /ENOENT/);
});
