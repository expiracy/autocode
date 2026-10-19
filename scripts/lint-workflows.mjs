import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = "1.7.12";
// Official release checksums, reviewed with the version bump:
// https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_checksums.txt
const checksums = {
  "darwin-x64": "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
  "darwin-arm64": "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
  "linux-x64": "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
  "linux-arm64": "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = `${process.platform}-${process.arch}`;
const expected = checksums[platform];
let runtime;

try {
  if (!expected) throw new Error(`Workflow linting supports Linux and macOS on x64/arm64; received ${platform}.`);
  const filenames = process.argv.slice(2);
  if (filenames.length === 0) {
    const directory = path.join(root, ".github/workflows");
    for (const filename of (await readdir(directory)).sort()) {
      if (/\.ya?ml$/.test(filename)) filenames.push(path.join(directory, filename));
    }
  }
  if (filenames.length === 0) throw new Error("No GitHub Actions workflow files found.");

  const architecture = process.arch === "x64" ? "amd64" : "arm64";
  const archiveName = `actionlint_${version}_${process.platform}_${architecture}.tar.gz`;
  const cached = path.join(tmpdir(), `opencode-autocode-${archiveName}`);
  let archive;
  try {
    archive = await readFile(cached);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const url = `https://github.com/rhysd/actionlint/releases/download/v${version}/${archiveName}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Could not download pinned actionlint: HTTP ${response.status}.`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha256").update(archive).digest("hex") !== expected) {
    throw new Error(`Pinned actionlint checksum mismatch. Remove ${cached} before retrying.`);
  }
  // Exclusive creation never overwrites another file or follows a cache symlink.
  await writeFile(cached, archive, { mode: 0o600, flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  runtime = await mkdtemp(path.join(tmpdir(), "autocode-actionlint-"));
  // Extract the verified bytes into a private directory on every invocation;
  // a stale cached executable is never trusted.
  const verified = path.join(runtime, archiveName);
  await writeFile(verified, archive, { mode: 0o600, flag: "wx" });
  execFileSync("tar", ["-xzf", verified, "-C", runtime, "actionlint"], { timeout: 30_000 });
  const binary = path.join(runtime, "actionlint");
  await chmod(binary, 0o700);
  const result = spawnSync(binary, ["-color", ...filenames], {
    cwd: root,
    stdio: "inherit",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Workflow lint failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (runtime) await rm(runtime, { recursive: true, force: true });
}
