import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const documentNames = new Set(["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "RELEASING.md", "TEST-SCENARIOS.md", ".github/FUNDING.yml"]);
const documentation = filename => documentNames.has(filename) || /^docs\/.+\.(?:md|png|jpe?g|gif|webp|svg)$/.test(filename);

const fullValidation = filename => ["package.json", "package-lock.json", "npm-shrinkwrap.json", "index.js", "tui.js", "src/index.ts", "src/tui.ts", "src/rpc.ts", "test/smoke.mjs", ".node-version", ".nvmrc", ".npmrc"].includes(filename)
  || filename.startsWith(".github/workflows/")
  || /^scripts\/(?:ci-plan|release-artifact|publish-artifact|github-release)\.mjs$/.test(filename)
  || /^tsconfig(?:\..+)?\.json$/.test(filename);

export function createPlan(files, { full: requestedFull = false, forceChecks = false, artifactRetentionDays = 1 } = {}) {
  assert.ok(Array.isArray(files) && files.every(filename => typeof filename === "string" && filename.length > 0), "Expected changed file paths.");
  assert.ok(typeof requestedFull === "boolean" && typeof forceChecks === "boolean", "CI selection flags must be booleans.");
  assert.ok(Number.isInteger(artifactRetentionDays) && artifactRetentionDays >= 1 && artifactRetentionDays <= 30, "Artifact retention must be 1 to 30 days.");
  const full = requestedFull || files.some(fullValidation);
  return { checks: full || forceChecks || files.some(filename => !documentation(filename)), full, artifactRetentionDays, diagnosticRetentionDays: Math.min(14, Math.max(3, artifactRetentionDays)) };
}

export function assertCIResults(results) {
  const fastJobs = ["workflow-lint", "checks"];
  const fullJobs = ["package", "install", "native"];
  assert.deepEqual(Object.keys(results).sort(), ["plan", ...fastJobs, ...fullJobs].sort(), "Unexpected CI dependencies.");
  assert.equal(results.plan?.result, "success", "CI planning must succeed.");
  const flag = name => {
    const value = results.plan.outputs?.[name];
    assert.ok(["true", "false"].includes(value), `Missing or invalid CI plan: ${name}.`);
    return value === "true";
  };
  const checks = flag("checks");
  const full = flag("full");
  assert.ok(!full || checks, "Full validation must include fast checks.");
  for (const [jobs, expected] of [[fastJobs, checks], [fullJobs, full]]) {
    for (const job of jobs) assert.equal(results[job]?.result, expected ? "success" : "skipped", `${job} did not match the required CI plan.`);
  }
}

function changedFiles(eventName, event) {
  const sha = value => { assert.match(value ?? "", /^[a-f0-9]{40}$/, "Expected full CI diff commit IDs."); return value; };
  const git = args => execFileSync("git", args, { encoding: "utf8", timeout: 30000, maxBuffer: 2000000 }).split("\0").filter(Boolean);
  let base;
  let head;
  let mergeBase = false;
  if (eventName === "pull_request") {
    base = sha(event.pull_request?.base?.sha); head = sha(event.pull_request?.head?.sha); mergeBase = true;
  } else if (eventName === "push") {
    base = sha(event.before); head = sha(event.after);
    if (/^0{40}$/.test(base)) return git(["ls-tree", "-r", "--name-only", "-z", head]);
  } else if (eventName === "merge_group") {
    base = sha(event.merge_group?.base_sha); head = sha(event.merge_group?.head_sha);
  } else throw new Error("Unsupported automatic CI event; refusing to skip validation.");
  return git(["diff", "--name-only", "--no-renames", "-z", ...(mergeBase ? [`${base}...${head}`] : [base, head]), "--"]);
}

async function main(command) {
  if (command === "gate") {
    assertCIResults(JSON.parse(process.env.CI_RESULTS ?? "null"));
    console.log("All checks required by the CI plan passed.");
    return;
  }
  assert.equal(command, "plan", "Use plan or gate.");
  const requestedFull = process.env.CI_FULL ?? "false";
  assert.ok(["true", "false", ""].includes(requestedFull), "Invalid full-CI input.");
  const full = requestedFull === "true";
  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const files = full || manual ? [] : changedFiles(process.env.GITHUB_EVENT_NAME, JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")));
  const plan = createPlan(files, { full, forceChecks: manual, artifactRetentionDays: Number(process.env.CI_RETENTION_DAYS ?? 1) });
  const output = `checks=${plan.checks}\nfull=${plan.full}\nartifact-retention-days=${plan.artifactRetentionDays}\ndiagnostic-retention-days=${plan.diagnosticRetentionDays}\n`;
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, output, { flag: "a" });
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `### CI scope\n\n${plan.full ? "Full compatibility validation" : plan.checks ? "Fast source checks" : "Documentation-only merge gate"}.\n`, { flag: "a" });
  console.log(JSON.stringify(plan));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
