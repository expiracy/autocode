import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseChannel, sanitize, verifyArtifact } from "./release-artifact.mjs";

const REPOSITORY = "expiracy/autocode";
const PRODUCT = "AutoCode";
const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function sanitizeDiagnostic(value, env = process.env) {
  let text = String(value ?? "");
  if (env.GH_TOKEN) text = text.replaceAll(env.GH_TOKEN, "[redacted]");
  return sanitize(text).replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]");
}

export async function prepareCandidate({ directory, commit, diagnostics, sourceDirectory = root }) {
  const source = JSON.parse(await readFile(path.join(sourceDirectory, "package.json"), "utf8"));
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDirectory, encoding: "utf8", timeout: 30_000 }).trim(), commit, "Release source differs from the checked-out commit.");
  const checked = await verifyArtifact({ artifact: path.join(directory, "package.tgz"), manifest: path.join(directory, "manifest.json"), commit });
  assert.equal(checked.metadata.version, source.version, "Artifact does not match the checked source version.");
  assert.equal(checked.metadata.name, source.name, "Artifact does not match the checked source package.");
  const tag = `v${source.version}`;
  const changelog = await readFile(path.join(sourceDirectory, "CHANGELOG.md"), "utf8");
  const section = changelog.split(/^##\s+/m).slice(1).find(entry => entry.split(/\s/, 1)[0] === source.version);
  assert.ok(section, "The candidate version needs its own changelog entry.");
  const changes = section.split("\n").slice(1).join("\n").trim();
  assert.ok(changes, "The candidate changelog entry must describe its changes.");
  const manifestPath = path.join(directory, "manifest.json");
  const assets = [
    { name: "package.tgz", path: path.join(directory, "package.tgz"), bytes: checked.bytes },
    { name: "manifest.json", path: manifestPath, bytes: await readFile(manifestPath) },
  ];
  const sums = assets.map(asset => `${sha256(asset.bytes)}  ${asset.name}\n`).join("");
  const workflow = process.env.GITHUB_RUN_ID
    ? `https://github.com/${REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "Local rehearsal";
  const notes = `${changes}\n\n## Tested package\n\n` +
    `- Source: [${commit}](https://github.com/${REPOSITORY}/commit/${commit})\n` +
    `- CI evidence: ${workflow}\n- Package: \`${source.name}@${source.version}\` (MIT)\n` +
    `- Channel: \`${releaseChannel(source.version)}\`\n- Archive SHA-256: \`${sha256(checked.bytes)}\`\n\n` +
    "The attached npm archive is the exact artifact installed and tested by CI. Verify it with the attached SHA256SUMS and source manifest.\n\n" +
    "npm delivery is separate: this GitHub draft does not upload, approve, or publish a package at npm. A maintainer reviews and publishes this draft manually.\n";
  await mkdir(diagnostics, { recursive: true, mode: 0o700 });
  await writeFile(path.join(diagnostics, "RELEASE_NOTES.md"), notes, { mode: 0o600 });
  const checksums = path.join(diagnostics, "SHA256SUMS");
  await writeFile(checksums, sums, { mode: 0o600 });
  assets.push({ name: "SHA256SUMS", path: checksums, bytes: Buffer.from(sums) });
  return { repository: REPOSITORY, version: source.version, commit, tag, prerelease: releaseChannel(source.version) === "next", title: `${PRODUCT} ${tag}`, notes, assets };
}

export function assertDraftContext(env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, "true", "Draft delivery requires GitHub Actions.");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "Draft delivery requires a manual request.");
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, "Draft delivery requires the upstream repository.");
  assert.ok(env.GITHUB_REF === "refs/heads/main" && env.GITHUB_REF_PROTECTED === "true", "Draft delivery requires protected main.");
  assert.equal(env.GITHUB_RELEASE_DELIVERY, "draft", "Draft delivery must be explicitly requested.");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "Draft delivery requires a GitHub-hosted runner.");
}

export async function deliverGitHubRelease({ mode, candidate, transport, env = process.env }) {
  if (mode === "rehearsal") return { outcome: "rehearsal", tag: candidate.tag };
  assert.equal(mode, "draft", "Choose rehearsal or draft delivery.");
  assertDraftContext(env);
  assert.equal(env.GITHUB_SHA, candidate.commit, "Draft source must match the workflow commit.");
  const prefix = `repos/${candidate.repository}`;
  const lookup = async endpoint => transport.request("GET", `${prefix}/${endpoint}`).catch(error => {
    if (error.status === 404) return undefined;
    throw error;
  });
  const tag = await lookup(`git/ref/tags/${candidate.tag}`);
  if (tag) {
    let target = tag.object;
    for (let depth = 0; target.type === "tag" && depth < 5; depth++) {
      target = (await transport.request("GET", `${prefix}/git/tags/${target.sha}`)).object;
    }
    assert.ok(target.type === "commit" && target.sha === candidate.commit, `Tag ${candidate.tag} already points to a different commit; refusing to move it.`);
  }
  // GitHub's get-by-tag endpoint excludes drafts; the authenticated list does not.
  let release;
  for (let page = 1; ; page++) {
    const entries = await transport.request("GET", `${prefix}/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(entries), "GitHub returned an invalid release listing.");
    release = entries.find(entry => entry.tag_name === candidate.tag);
    if (release || entries.length < 100) break;
  }
  assert.ok(!release || release.draft === true, `Release ${candidate.tag} is already published; prepare a new version instead.`);
  assert.ok(!release || release.prerelease === candidate.prerelease, "The existing draft has a different prerelease flag; review it manually.");
  const missingAssets = [];
  for (const asset of candidate.assets) {
    const existing = release?.assets?.find(item => item.name === asset.name);
    if (existing) {
      const bytes = await transport.request("GET", `${prefix}/releases/assets/${existing.id}`, undefined, { binary: true });
      assert.ok(asset.bytes.equals(bytes), `Asset ${asset.name} already contains different bytes; refusing to overwrite it.`);
    } else missingAssets.push(asset);
  }
  if (!tag) await transport.request("POST", `${prefix}/git/refs`, { ref: `refs/tags/${candidate.tag}`, sha: candidate.commit });
  if (!release) release = await transport.request("POST", `${prefix}/releases`, {
    tag_name: candidate.tag, target_commitish: candidate.commit, name: candidate.title,
    body: candidate.notes, draft: true, prerelease: candidate.prerelease,
  });
  for (const asset of missingAssets) {
    const current = await transport.request("GET", `${prefix}/releases/${release.id}`);
    assert.equal(current.draft, true, "The draft was published during delivery; remaining asset uploads were stopped.");
    await transport.upload(release.id, asset);
  }
  return { outcome: "draft", tag: candidate.tag, url: release.html_url };
}

function runGh(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile("gh", args, { encoding: "buffer", timeout: 60_000, maxBuffer: 20_000_000 }, (error, stdout, stderr) => {
      if (error) {
        const status = /\(HTTP (\d+)\)/.exec(stderr.toString())?.[1];
        reject(Object.assign(new Error(sanitizeDiagnostic(stderr.toString() || error.message)), { status: Number(status) || undefined }));
      } else resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function createGitHubTransport(repository, run = runGh) {
  return {
    async request(method, endpoint, body, { binary = false } = {}) {
      const args = ["api", "--hostname", "github.com", "--method", method, endpoint];
      if (binary) args.push("--header", "Accept: application/octet-stream");
      if (body) args.push("--input", "-");
      const output = await run(args, body ? JSON.stringify(body) : undefined);
      return binary ? output : JSON.parse(output.toString());
    },
    async upload(releaseId, asset) {
      // Send the verified bytes to this fixed release ID; never replace assets.
      await run(["api", "--hostname", "github.com", "--method", "POST",
        `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
        "--header", "Content-Type: application/octet-stream", "--input", "-"], asset.bytes);
    },
  };
}

function argumentsFor(argv) {
  const [mode, ...flags] = argv;
  assert.ok(["rehearsal", "draft"].includes(mode), "Choose rehearsal or draft delivery.");
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index]?.replace(/^--/, "");
    assert.ok(flags[index]?.startsWith("--") && ["directory", "commit", "diagnostics"].includes(key) && flags[index + 1] && !flags[index + 1].startsWith("--") && !Object.hasOwn(options, key), "Invalid GitHub release arguments.");
    options[key] = flags[index + 1];
  }
  assert.ok(options.directory && options.commit && options.diagnostics, "Supply --directory, --commit and --diagnostics.");
  return { mode, options };
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  let options;
  let result = { outcome: "failure" };
  try {
    const parsed = argumentsFor(process.argv.slice(2));
    options = parsed.options;
    if (parsed.mode === "draft") assertDraftContext();
    const candidate = await prepareCandidate(options);
    const delivered = await deliverGitHubRelease({ mode: parsed.mode, candidate, transport: createGitHubTransport(REPOSITORY) });
    result = { ...delivered, version: candidate.version, commit: candidate.commit, assets: candidate.assets.map(asset => ({ name: asset.name, sha256: sha256(asset.bytes) })) };
    const message = parsed.mode === "rehearsal"
      ? `Rehearsed ${candidate.tag}; no GitHub or npm mutation was requested.`
      : `Prepared draft ${candidate.tag}: ${delivered.url}. A maintainer must publish the draft manually.`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, message + "\n\n" + candidate.notes, { flag: "a" });
  } catch (error) {
    result.failure = sanitizeDiagnostic(error.message);
    console.error(result.failure);
    process.exitCode = 1;
  } finally {
    if (options?.diagnostics) {
      await mkdir(options.diagnostics, { recursive: true, mode: 0o700 });
      await writeFile(path.join(options.diagnostics, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    }
  }
}
