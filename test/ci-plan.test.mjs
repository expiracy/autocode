import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPlan, assertCIResults } from "../scripts/ci-plan.mjs";

test("documentation-only changes do not schedule runtime or integration jobs", () => {
  const plan = createPlan(["README.md", "docs/configuration.md", "docs/assets/logo.svg"]);
  assert.equal(plan.checks, false);
  assert.equal(plan.full, false);
});

test("ordinary source edits keep fast checks enabled", () => {
  const plan = createPlan(["src/approval.ts", "test/approval.test.ts"]);
  assert.equal(plan.checks, true);
  assert.equal(plan.full, false);
});

test("dependency changes require the full installation and native matrix", () => {
  const plan = createPlan(["package-lock.json"]);
  assert.equal(plan.checks, true);
  assert.equal(plan.full, true);
});

test("release and explicit manual requests always get full validation even for docs", () => {
  const plan = createPlan(["README.md"], { full: true });
  assert.equal(plan.checks, true);
  assert.equal(plan.full, true);
});

test("explicit development validation keeps artifacts briefly", () => {
  const plan = createPlan([], { full: true });
  assert.equal(plan.artifactRetentionDays, 1);
  assert.equal(plan.diagnosticRetentionDays, 3);
});

test("release callers retain their tested archive and diagnostics long enough for approval", () => {
  const plan = createPlan([], { full: true, artifactRetentionDays: 30 });
  assert.equal(plan.artifactRetentionDays, 30);
  assert.equal(plan.diagnosticRetentionDays, 14);
});

function jobResults(checks = true, full = false) {
  return { plan: { result: "success", outputs: { checks: String(checks), full: String(full) } },
    "workflow-lint": { result: checks ? "success" : "skipped" }, checks: { result: checks ? "success" : "skipped" },
    package: { result: full ? "success" : "skipped" }, install: { result: full ? "success" : "skipped" }, native: { result: full ? "success" : "skipped" } };
}

test("the required merge gate rejects a cancelled integration in full validation", () => {
  const results = jobResults(true, true);
  results.native.result = "cancelled";
  assert.throws(() => assertCIResults(results));
});

async function gitFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "autocode-ci-plan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = args => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=CI Test", "-c", "user.email=test@example.invalid", ...args], { cwd: directory, encoding: "utf8" }).trim();
  git(["init", "--quiet"]);
  await mkdir(path.join(directory, "src"));
  await writeFile(path.join(directory, "src/feature.ts"), "export const feature = true;\n");
  await writeFile(path.join(directory, "README.md"), "Original docs\n");
  git(["add", "."]); git(["commit", "--quiet", "-m", "base"]);
  const before = git(["rev-parse", "HEAD"]);
  const run = async (eventName, event, extra = {}) => {
    const eventPath = path.join(directory, "event.json");
    const output = path.join(directory, "outputs");
    await writeFile(eventPath, JSON.stringify(event));
    await writeFile(output, "");
    execFileSync(process.execPath, [path.resolve(import.meta.dirname, "../scripts/ci-plan.mjs"), "plan"], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, CI_FULL: "false", CI_RETENTION_DAYS: "1", ...extra } });
    return Object.fromEntries((await readFile(output, "utf8")).trim().split("\n").map(line => line.split("=")));
  };
  return { directory, git, before, run };
}

test("planner CLI derives documentation-only scope from the actual git diff", async t => {
  const f = await gitFixture(t);
  await writeFile(path.join(f.directory, "README.md"), "Updated docs\n");
  f.git(["add", "."]); f.git(["commit", "--quiet", "-m", "docs"]);
  const result = await f.run("push", { before: f.before, after: f.git(["rev-parse", "HEAD"]) });
  assert.equal(result.checks, "false");
  assert.equal(result.full, "false");
});

test("renaming executable source into docs cannot hide the removed runtime file", async t => {
  const f = await gitFixture(t);
  await mkdir(path.join(f.directory, "docs"));
  f.git(["mv", "src/feature.ts", "docs/feature.md"]);
  f.git(["commit", "--quiet", "-m", "rename"]);
  const result = await f.run("pull_request", { pull_request: { base: { sha: f.before }, head: { sha: f.git(["rev-parse", "HEAD"]) } } });
  assert.equal(result.checks, "true");
  assert.equal(result.full, "false");
});

test("merge queue events detect delivery changes and require the full matrix", async t => {
  const f = await gitFixture(t);
  await writeFile(path.join(f.directory, "package.json"), '{"private":true}\n');
  f.git(["add", "package.json"]); f.git(["commit", "--quiet", "-m", "dependency metadata"]);
  const result = await f.run("merge_group", { merge_group: { base_sha: f.before, head_sha: f.git(["rev-parse", "HEAD"]) } });
  assert.equal(result.checks, "true");
  assert.equal(result.full, "true");
});

test("manual and reusable full input produces retained release outputs without a diff", async t => {
  const f = await gitFixture(t);
  for (const event of ["workflow_dispatch", "pull_request", "push"]) {
    const result = await f.run(event, {}, { CI_FULL: "true", CI_RETENTION_DAYS: "30" });
    assert.equal(result.full, "true");
    assert.equal(result["artifact-retention-days"], "30");
    assert.equal(result["diagnostic-retention-days"], "14");
  }
});

test("invalid diff references and unsupported events cannot emit successful skip outputs", async t => {
  const f = await gitFixture(t);
  await assert.rejects(f.run("pull_request", {}), /Expected full CI diff commit IDs/);
  await assert.rejects(f.run("pull_request_target", {}), /Unsupported automatic CI event/);
});

test("required gate accepts only the precise planned success and intentional skip sets", () => {
  for (const [checks, full] of [[false, false], [true, false], [true, true]]) assert.doesNotThrow(() => assertCIResults(jobResults(checks, full)));
  for (const job of ["plan", "workflow-lint", "checks", "package", "install", "native"]) {
    for (const result of ["failure", "cancelled", "skipped", ""]) {
      const results = jobResults(true, true);
      results[job].result = result;
      assert.throws(() => assertCIResults(results));
    }
  }
  const unexpected = jobResults(false, false);
  unexpected.checks.result = "success";
  assert.throws(() => assertCIResults(unexpected));
});

test("missing or inconsistent planner outputs always block the required check", () => {
  for (const outputs of [{}, { checks: "false", full: "true" }, { checks: true, full: "false" }, { checks: "true", full: "" }]) {
    const results = jobResults(); results.plan.outputs = outputs;
    assert.throws(() => assertCIResults(results));
  }
  const unknown = jobResults(); unknown.untested = { result: "success" };
  assert.throws(() => assertCIResults(unknown));
});

test("unknown code paths and nested executable docs remain eligible for fast checks", () => {
  for (const filename of ["src/prompt.md", "docs/example.ts", "future.config", "AGENTS.md"]) assert.equal(createPlan([filename]).checks, true);
  for (const filename of [".github/workflows/ci.yml", "tsconfig.build.json", "scripts/ci-plan.mjs", ".npmrc", "index.js"]) assert.equal(createPlan([filename]).full, true);
});

test("invalid scope inputs and excessive retention are rejected", () => {
  assert.throws(() => createPlan(null));
  assert.throws(() => createPlan([null]));
  assert.throws(() => createPlan([], { full: "false" }));
  for (const artifactRetentionDays of [0, 31, -1, 1.5]) assert.throws(() => createPlan([], { artifactRetentionDays }));
});

test("native harness and host-facing entrypoint edits receive compatibility validation", () => {
  for (const filename of ["test/smoke.mjs", "src/index.ts", "src/tui.ts", "src/rpc.ts"]) assert.equal(createPlan([filename]).full, true);
});
