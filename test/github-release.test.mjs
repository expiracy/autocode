import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { assertDraftContext, createGitHubTransport, deliverGitHubRelease, prepareCandidate, sanitizeDiagnostic } from "../scripts/github-release.mjs";

const execute = promisify(execFile);

const candidate = {
  repository: "expiracy/autocode", version: "0.1.0-beta.2", commit: "a".repeat(40),
  tag: "v0.1.0-beta.2", prerelease: true, title: "AutoCode v0.1.0-beta.2",
  notes: "Tested package candidate", assets: [{ name: "package.tgz", path: "/fixture/package.tgz", bytes: Buffer.from("tested archive") }],
};
const context = {
  GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "expiracy/autocode",
  GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true", GITHUB_SHA: candidate.commit,
  GITHUB_RELEASE_DELIVERY: "draft", RUNNER_ENVIRONMENT: "github-hosted",
};

test("rehearsal reports the candidate without contacting GitHub", async () => {
  const result = await deliverGitHubRelease({ mode: "rehearsal", candidate, transport: {
    request: () => assert.fail("Rehearsal must never contact GitHub"),
    upload: () => assert.fail("Rehearsal must never upload"),
  } });
  assert.equal(result.outcome, "rehearsal");
  assert.equal(result.tag, candidate.tag);
});

test("draft delivery rejects an unprotected source before any remote operation", () => {
  assert.throws(() => assertDraftContext({ ...context, GITHUB_REF_PROTECTED: "false" }), /protected main/);
});

test("a version tag at a different commit is never moved", async () => {
  const calls = [];
  await assert.rejects(deliverGitHubRelease({ mode: "draft", candidate, env: context, transport: {
    request: async (method, endpoint) => {
      calls.push({ method, endpoint });
      assert.equal(method, "GET");
      return { object: { type: "commit", sha: "b".repeat(40) } };
    },
    upload: () => assert.fail("Conflicting tags must not upload assets"),
  } }), /already points to a different commit/);
  assert.equal(calls.length, 1);
});

const missing = () => Object.assign(new Error("Not Found"), { status: 404 });
test("explicit draft creates a version tag and an unpublished prerelease with the tested assets", async () => {
  const calls = [];
  const uploads = [];
  const result = await deliverGitHubRelease({ mode: "draft", candidate, env: context, transport: {
    request: async (method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      if (endpoint.includes("/releases?")) return [];
      if (endpoint.endsWith("/releases/12")) return { id: 12, draft: true };
      if (method === "GET") throw missing();
      if (endpoint.endsWith("/releases")) return { id: 12, draft: true, html_url: "https://github.com/expiracy/autocode/releases/tag/test", assets: [] };
      return {};
    },
    upload: async (id, asset) => uploads.push({ id, asset }),
  } });
  assert.equal(result.outcome, "draft");
  const mutations = calls.filter(call => call.method !== "GET");
  assert.deepEqual(mutations[0].body, { ref: `refs/tags/${candidate.tag}`, sha: candidate.commit });
  assert.deepEqual(mutations[1].body, {
    tag_name: candidate.tag, target_commitish: candidate.commit, name: candidate.title,
    body: candidate.notes, draft: true, prerelease: true,
  });
  assert.equal(mutations.length, 2);
  assert.deepEqual(uploads, [{ id: 12, asset: candidate.assets[0] }]);
});

test("a published release is never edited or given replacement assets", async () => {
  await assert.rejects(deliverGitHubRelease({ mode: "draft", candidate, env: context, transport: {
    request: async (method, endpoint) => {
      assert.equal(method, "GET", "Published releases must remain immutable");
      return endpoint.includes("/git/ref/")
        ? { object: { type: "commit", sha: candidate.commit } }
        : [{ id: 12, tag_name: candidate.tag, draft: false, assets: [] }];
    },
    upload: () => assert.fail("Published releases must never upload"),
  } }), /already published/);
});

test("a conflicting asset in an existing draft fails before any mutation", async () => {
  await assert.rejects(deliverGitHubRelease({ mode: "draft", candidate, env: context, transport: {
    request: async (method, endpoint) => {
      assert.equal(method, "GET", "Conflicting drafts must not be mutated");
      if (endpoint.includes("/git/ref/")) return { object: { type: "commit", sha: candidate.commit } };
      if (endpoint.includes("/assets/")) return Buffer.from("different archive");
      return [{ id: 12, tag_name: candidate.tag, draft: true, prerelease: true, assets: [{ id: 7, name: candidate.assets[0].name }] }];
    },
    upload: () => assert.fail("Conflicting assets must not be overwritten"),
  } }), /different bytes/);
});

test("a rerun resumes the matching draft and uploads only missing assets", async () => {
  const second = { name: "manifest.json", path: "/fixture/manifest.json", bytes: Buffer.from("manifest") };
  const uploads = [];
  const result = await deliverGitHubRelease({ mode: "draft", candidate: { ...candidate, assets: [...candidate.assets, second] }, env: context, transport: {
    request: async (method, endpoint) => {
      assert.equal(method, "GET", "A matching draft needs no tag or release mutation");
      if (endpoint.includes("/git/ref/")) return { object: { type: "commit", sha: candidate.commit } };
      if (endpoint.endsWith("/releases/12")) return { id: 12, draft: true };
      if (endpoint.includes("/assets/")) return candidate.assets[0].bytes;
      return [{ id: 12, tag_name: candidate.tag, draft: true, prerelease: true, assets: [{ id: 7, name: candidate.assets[0].name }], html_url: "https://github.com/expiracy/autocode/releases/tag/test" }];
    },
    upload: async (id, asset) => uploads.push({ id, asset }),
  } });
  assert.equal(result.outcome, "draft");
  assert.deepEqual(uploads, [{ id: 12, asset: second }]);
});

test("an annotated version tag is accepted only when its final target is the tested commit", async () => {
  const calls = [];
  await deliverGitHubRelease({ mode: "draft", candidate: { ...candidate, assets: [] }, env: context, transport: {
    request: async (method, endpoint) => {
      calls.push(endpoint);
      assert.equal(method, "GET");
      if (endpoint.includes("/git/ref/")) return { object: { type: "tag", sha: "c".repeat(40) } };
      if (endpoint.includes("/git/tags/")) return { object: { type: "commit", sha: candidate.commit } };
      return [{ id: 12, tag_name: candidate.tag, draft: true, prerelease: true, assets: [] }];
    },
    upload: () => assert.fail("No uploads expected"),
  } });
  assert.ok(calls.some(endpoint => endpoint.endsWith(`/git/tags/${"c".repeat(40)}`)));
});

async function fixture(sourceVersion = "0.1.0-beta.2") {
  const directory = await mkdtemp(path.join(tmpdir(), "autocode-github-release-test-"));
  const sourceDirectory = path.join(directory, "source");
  const artifacts = path.join(directory, "artifact");
  await mkdir(sourceDirectory);
  await mkdir(path.join(artifacts, "package/dist"), { recursive: true });
  const metadata = {
    name: "opencode-autocode", version: "0.1.0-beta.2", license: "MIT",
    repository: { url: "git+https://github.com/expiracy/autocode.git" },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org", tag: "next" },
  };
  await writeFile(path.join(sourceDirectory, "package.json"), JSON.stringify({ ...metadata, version: sourceVersion }));
  await writeFile(path.join(sourceDirectory, "CHANGELOG.md"), "# Changes\n\n## 0.1.0-beta.2\n\nClear provider errors and tested release packages.\n");
  const git = args => execFileSync("git", args, { cwd: sourceDirectory, encoding: "utf8" });
  git(["init", "--quiet"]);
  git(["add", "."]);
  git(["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const commit = git(["rev-parse", "HEAD"]).trim();
  await writeFile(path.join(artifacts, "package/package.json"), JSON.stringify(metadata));
  await writeFile(path.join(artifacts, "package/LICENSE"), "MIT License\n");
  for (const name of ["index.js", "tui.js", "dist/index.js", "dist/tui.js", "dist/rpc.js"]) {
    await writeFile(path.join(artifacts, "package", name), "export default {};\n");
  }
  execFileSync("tar", ["-czf", path.join(artifacts, "package.tgz"), "-C", artifacts, "package"]);
  const bytes = await readFile(path.join(artifacts, "package.tgz"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(artifacts, "manifest.json"), JSON.stringify({
    schemaVersion: 1, sourceCommit: commit, repository: "expiracy/autocode", name: metadata.name,
    version: metadata.version, license: "MIT", channel: "next", filename: "package.tgz", sha256,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  }));
  return { options: { sourceDirectory, directory: artifacts, commit, diagnostics: path.join(directory, "diagnostics") }, sha256, clean: () => rm(directory, { recursive: true, force: true }) };
}

test("the tested archive version must exactly match the checked source package", async () => {
  const f = await fixture("0.1.0-beta.3");
  try { await assert.rejects(prepareCandidate(f.options), /checked source version/); }
  finally { await f.clean(); }
});

test("the candidate retains the exact archive and manifest and records useful notes and checksums", async () => {
  const f = await fixture();
  try {
    const result = await prepareCandidate(f.options);
    assert.equal(result.tag, "v0.1.0-beta.2");
    assert.equal(result.prerelease, true);
    assert.deepEqual(result.assets.map(asset => asset.name), ["package.tgz", "manifest.json", "SHA256SUMS"]);
    assert.deepEqual(result.assets[0].bytes, await readFile(path.join(f.options.directory, "package.tgz")));
    const sums = await readFile(path.join(f.options.diagnostics, "SHA256SUMS"), "utf8");
    assert.ok(sums.includes(`${f.sha256}  package.tgz\n`));
    assert.match(result.notes, /Clear provider errors/);
    assert.ok(result.notes.includes(f.options.commit));
    assert.match(result.notes, /npm delivery is separate/i);
  } finally { await f.clean(); }
});

test("the command rehearses locally and retains evidence without GitHub credentials", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.options.sourceDirectory, "scripts"));
    for (const name of ["github-release.mjs", "release-artifact.mjs"]) {
      await writeFile(path.join(f.options.sourceDirectory, "scripts", name), await readFile(new URL(`../scripts/${name}`, import.meta.url)));
    }
    execFileSync(process.execPath, [path.join(f.options.sourceDirectory, "scripts/github-release.mjs"),
      "rehearsal", "--directory", f.options.directory, "--commit", f.options.commit,
      "--diagnostics", f.options.diagnostics], {
      env: { PATH: process.env.PATH }, encoding: "utf8",
    });
    const result = JSON.parse(await readFile(path.join(f.options.diagnostics, "result.json"), "utf8"));
    assert.equal(result.outcome, "rehearsal");
    assert.equal(result.commit, f.options.commit);
    assert.equal(result.tag, "v0.1.0-beta.2");
  } finally { await f.clean(); }
});

test("draft reruns discover drafts through the authenticated release listing", async () => {
  const result = await deliverGitHubRelease({ mode: "draft", candidate: { ...candidate, assets: [] }, env: context, transport: {
    request: async (method, endpoint) => {
      assert.equal(method, "GET", "An existing draft must not be recreated");
      if (endpoint.includes("/git/ref/")) return { object: { type: "commit", sha: candidate.commit } };
      if (endpoint.includes("/releases?")) return [{ id: 12, tag_name: candidate.tag, draft: true, prerelease: true, assets: [] }];
      throw missing(); // GitHub's get-by-tag endpoint exposes published releases only.
    },
    upload: () => assert.fail("No upload expected"),
  } });
  assert.equal(result.outcome, "draft");
});

test("GitHub transport sends draft JSON as stdin and never requests asset clobbering", async () => {
  const calls = [];
  const transport = createGitHubTransport(candidate.repository, async (args, input) => {
    calls.push({ args, input });
    return Buffer.from("{}");
  });
  await transport.request("POST", `repos/${candidate.repository}/releases`, { draft: true, body: "Release notes with $HOME and `literal backticks`" });
  await transport.upload(12, candidate.assets[0]);
  assert.ok(calls[0].args.includes("--input"));
  assert.deepEqual(JSON.parse(calls[0].input), { draft: true, body: "Release notes with $HOME and `literal backticks`" });
  assert.deepEqual(calls[1].args, ["api", "--hostname", "github.com", "--method", "POST",
    `https://uploads.github.com/repos/${candidate.repository}/releases/12/assets?name=package.tgz`,
    "--header", "Content-Type: application/octet-stream",
    "--header", `Content-Length: ${candidate.assets[0].bytes.byteLength}`, "--input", "-"]);
  assert.deepEqual(calls[1].input, candidate.assets[0].bytes);
  assert.ok(calls.every(call => !call.args.includes("--clobber")));
});

test("an existing draft with the wrong prerelease flag cannot be reused", async () => {
  await assert.rejects(deliverGitHubRelease({ mode: "draft", candidate: { ...candidate, assets: [] }, env: context, transport: {
    request: async (method, endpoint) => {
      assert.equal(method, "GET");
      return endpoint.includes("/git/ref/") ? { object: { type: "commit", sha: candidate.commit } }
        : [{ id: 12, tag_name: candidate.tag, draft: true, prerelease: false, assets: [] }];
    },
    upload: () => assert.fail("Conflicting drafts must never upload"),
  } }), /prerelease flag/);
});

test("retained failures remove the GitHub credential even when it is opaque", () => {
  assert.doesNotMatch(sanitizeDiagnostic("GitHub failed: opaque-job-credential", { GH_TOKEN: "opaque-job-credential" }), /opaque-job-credential/);
});

test("publication between asset uploads stops the remaining draft delivery", async () => {
  const uploads = [];
  let refreshed = 0;
  await assert.rejects(deliverGitHubRelease({ mode: "draft", candidate: { ...candidate, assets: [candidate.assets[0], { name: "manifest.json", bytes: Buffer.from("manifest") }] }, env: context, transport: {
    request: async (method, endpoint) => {
      assert.equal(method, "GET");
      if (endpoint.includes("/git/ref/")) return { object: { type: "commit", sha: candidate.commit } };
      if (endpoint.endsWith("/releases/12")) return { id: 12, draft: ++refreshed === 1 };
      return [{ id: 12, tag_name: candidate.tag, draft: true, prerelease: true, assets: [] }];
    },
    upload: async (id, asset) => uploads.push({ id, asset }),
  } }), /published during delivery/);
  assert.deepEqual(uploads, [{ id: 12, asset: candidate.assets[0] }]);
});

test("the draft command sends the verified bytes through a local gh fixture and leaves publication pending", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.options.sourceDirectory, "scripts"));
    for (const name of ["github-release.mjs", "release-artifact.mjs"]) {
      await writeFile(path.join(f.options.sourceDirectory, "scripts", name), await readFile(new URL(`../scripts/${name}`, import.meta.url)));
    }
    const bin = path.join(f.options.sourceDirectory, "bin");
    await mkdir(bin);
    const gh = path.join(bin, "gh");
    const trace = path.join(bin, "trace.jsonl");
    await writeFile(gh, `#!${process.execPath}\n` + String.raw`
const { appendFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
(async () => {
  const args = process.argv.slice(2);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const uploading = args.some(arg => arg.startsWith("https://uploads.github.com/"));
  appendFileSync(process.env.GH_FIXTURE_TRACE, JSON.stringify({ args,
    json: !uploading && bytes.length ? JSON.parse(bytes.toString()) : undefined,
    sha256: uploading ? createHash("sha256").update(bytes).digest("hex") : undefined }) + "\n");
  if (args.includes("GET") && args.some(arg => arg.includes("/git/ref/"))) {
    process.stderr.write("gh: Not Found (HTTP 404)\n"); process.exitCode = 1; return;
  }
  if (args.some(arg => arg.includes("/releases?"))) { process.stdout.write("[]"); return; }
  process.stdout.write(JSON.stringify({ id: 12, draft: true, prerelease: true,
    html_url: "https://github.com/fixture/releases/12", assets: [] }));
})();
`, { mode: 0o700 });
    await chmod(gh, 0o700);
    execFileSync(process.execPath, [path.join(f.options.sourceDirectory, "scripts/github-release.mjs"),
      "draft", "--directory", f.options.directory, "--commit", f.options.commit,
      "--diagnostics", f.options.diagnostics], { encoding: "utf8", env: {
      ...context, GITHUB_SHA: f.options.commit, GH_TOKEN: "local-fixture-credential",
      PATH: bin + path.delimiter + process.env.PATH, GH_FIXTURE_TRACE: trace,
    } });
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const release = calls.find(call => call.json?.tag_name);
    assert.equal(release.json.draft, true);
    assert.equal(release.json.prerelease, true);
    assert.equal(release.json.target_commitish, f.options.commit);
    const uploads = calls.filter(call => call.sha256);
    assert.equal(uploads.length, 3);
    assert.equal(uploads[0].sha256, f.sha256);
    assert.ok(calls.every(call => !call.args.includes("PATCH") && !call.args.includes("DELETE")));
    const result = JSON.parse(await readFile(path.join(f.options.diagnostics, "result.json"), "utf8"));
    assert.equal(result.outcome, "draft");
  } finally { await f.clean(); }
});

test("real gh sends a fixed byte length and the exact binary asset to the HTTP upload endpoint", async () => {
  const configuration = await mkdtemp(path.join(tmpdir(), "github-upload-http-"));
  const bytes = Buffer.concat([Buffer.from("Binary asset: é 😀\n"), Buffer.from([0, 128, 255]), Buffer.alloc(65536, 90)]);
  let observed;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = { method: request.method, url: request.url, headers: request.headers, bytes: Buffer.concat(chunks) };
    const valid = request.headers["content-length"] === String(bytes.length) && request.headers["transfer-encoding"] === undefined;
    response.writeHead(valid ? 201 : 400, { "content-type": "application/json" });
    response.end(JSON.stringify(valid ? { id: 123 } : { message: "Bad Content-Length" }));
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const transport = createGitHubTransport(candidate.repository, async (args, input) => {
      const localArgs = args.map(argument => argument.startsWith("https://uploads.github.com/")
        ? `http://127.0.0.1:${server.address().port}${new URL(argument).pathname}${new URL(argument).search}` : argument);
      const running = execute("gh", localArgs, { cwd: configuration, timeout: 10_000, encoding: "buffer", env: {
        PATH: process.env.PATH, GH_TOKEN: "local-contract-fixture", GH_CONFIG_DIR: configuration, XDG_STATE_HOME: path.join(configuration, "state"),
        GH_PROMPT_DISABLED: "1", NO_PROXY: "127.0.0.1",
      } });
      running.child.stdin.on("error", () => {});
      running.child.stdin.end(input);
      return (await running).stdout;
    });
    await transport.upload(12, { name: "package.tgz", bytes });
    assert.equal(observed.method, "POST");
    assert.equal(observed.url, `/repos/${candidate.repository}/releases/12/assets?name=package.tgz`);
    assert.equal(observed.headers["content-length"], String(bytes.length));
    assert.equal(observed.headers["transfer-encoding"], undefined);
    assert.equal(observed.headers["content-type"], "application/octet-stream");
    assert.deepEqual(observed.bytes, bytes);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(configuration, { recursive: true, force: true });
  }
});
