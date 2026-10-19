import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertStageContext, releaseChannel, sanitize, verifyArtifact } from "../scripts/release-artifact.mjs";

const commit = "a".repeat(40);
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "autocode-artifact-test-"));
  const packageDirectory = path.join(directory, "package");
  await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
  const metadata = {
    name: "opencode-autocode", version: "0.1.0-beta.1", license: "MIT",
    publishConfig: { access: "public", registry: "https://registry.npmjs.org", tag: "next" },
    repository: { type: "git", url: "git+https://github.com/expiracy/autocode.git" },
  };
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify(metadata));
  await writeFile(path.join(packageDirectory, "LICENSE"), "MIT License\n");
  for (const name of ["index.js", "tui.js", "dist/index.js", "dist/tui.js", "dist/rpc.js"]) {
    await writeFile(path.join(packageDirectory, name), "export default {};\n");
  }
  const artifact = path.join(directory, "package.tgz");
  execFileSync("tar", ["-czf", artifact, "-C", directory, "package"]);
  const bytes = await readFile(artifact);
  const manifest = path.join(directory, "manifest.json");
  const record = {
    schemaVersion: 1, sourceCommit: commit, repository: "expiracy/autocode",
    name: metadata.name, version: metadata.version, license: "MIT", channel: "next", filename: "package.tgz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    nodeVersion: process.version, npmVersion: "12.2.0",
  };
  await writeFile(manifest, JSON.stringify(record));
  return { directory, artifact, manifest, record, metadata, clean: () => rm(directory, { recursive: true, force: true }) };
}

test("accepts the traced tarball and checks its archived package identity", async () => {
  const f = await fixture();
  try {
    const verified = await verifyArtifact({ artifact: f.artifact, manifest: f.manifest, commit });
    assert.equal(verified.metadata.name, "opencode-autocode");
    assert.equal(verified.manifest.sourceCommit, commit);
    assert.equal(verified.manifest.channel, "next");
  } finally { await f.clean(); }
});

test("staging refuses a non-main ref even when OIDC credentials are present", () => {
  assert.throws(() => assertStageContext({
    GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "expiracy/autocode",
    GITHUB_REF: "refs/heads/feature", GITHUB_REF_PROTECTED: "true", RUNNER_ENVIRONMENT: "github-hosted",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.actions.githubusercontent.com/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    AUTOCODE_DELIVERY_ENVIRONMENT: "npm-staging", AUTOCODE_DELIVERY_ACTION: "stage",
  }), /protected main/);
});

test("rejects modified bytes instead of installing a different artifact", async () => {
  const f = await fixture();
  try {
    await writeFile(f.artifact, Buffer.concat([await readFile(f.artifact), Buffer.from("changed")]));
    await assert.rejects(verifyArtifact({ ...f, commit }), /SHA-256 mismatch/);
  } finally { await f.clean(); }
});

test("rejects mismatched source commits and forged archived versions", async () => {
  const f = await fixture();
  try {
    await assert.rejects(verifyArtifact({ ...f, commit: "b".repeat(40) }), /source commit mismatch/);
    await writeFile(f.manifest, JSON.stringify({ ...f.record, version: "0.1.0-beta.2" }));
    await assert.rejects(verifyArtifact({ ...f, commit }), /Archived version mismatch/);
  } finally { await f.clean(); }
});

test("prereleases use next, stable releases use latest, malformed versions are refused", () => {
  assert.equal(releaseChannel("0.1.0-beta.1"), "next");
  assert.equal(releaseChannel("1.0.0"), "latest");
  assert.throws(() => releaseChannel("1.0.0-beta.01"), /Invalid package version/);
  assert.throws(() => releaseChannel("01.0.0"), /Invalid package version/);
});

test("staging requires explicit protected upstream dispatch, a hosted runner and OIDC without npm tokens", () => {
  const valid = {
    GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "expiracy/autocode",
    GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true", RUNNER_ENVIRONMENT: "github-hosted",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.actions.githubusercontent.com/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    AUTOCODE_DELIVERY_ENVIRONMENT: "npm-staging", AUTOCODE_DELIVERY_ACTION: "stage",
  };
  assert.doesNotThrow(() => assertStageContext(valid));
  for (const change of [
    { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REPOSITORY: "fork/autocode" },
    { GITHUB_REF_PROTECTED: "false" }, { RUNNER_ENVIRONMENT: "self-hosted" },
    { AUTOCODE_DELIVERY_ACTION: "rehearsal" }, { AUTOCODE_DELIVERY_ENVIRONMENT: "other" },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }, { ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.com/token" },
    { NPM_TOKEN: "legacy-token" }, { NODE_AUTH_TOKEN: "legacy-token" },
  ]) assert.throws(() => assertStageContext({ ...valid, ...change }));
});

test("retained delivery diagnostics redact bearer credentials", () => {
  assert.doesNotMatch(sanitize("Authorization: Bearer opaque-credential"), /opaque-credential/);
});
