import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GlobalSettings } from "../src/settings.ts";

async function fixture(source = JSON.stringify({ plugins: [{ package: "/plugin/autocode", options: {} }] }, null, 2)) {
  const directory = await mkdtemp(join(tmpdir(), "autocode-settings-"));
  const path = join(directory, "opencode.jsonc");
  await writeFile(path, source);
  return { directory, path, source, store: new GlobalSettings({ directory, packagePath: "/plugin/autocode" }), clean: () => rm(directory, { recursive: true, force: true }) };
}

test("reads installed global options with inherited defaults and a revision", async () => {
  const f = await fixture();
  try {
    const view = await f.store.read();
    assert.equal(view.path, f.path);
    assert.deepEqual(view.options, {});
    assert.deepEqual(view.effective, { enabled: true, timeoutMs: 30_000, maxContextChars: 64_000 });
    assert.match(view.revision, /^[a-f0-9]{64}$/);
  } finally { await f.clean(); }
});

test("saves only AutoCode options while preserving JSONC comments and other settings", async () => {
  const source = `{
  // Keep this profile comment.
  "model": "coding/model",
  "plugins": [
    { "package": "another-plugin", "options": { "secret": "unchanged" } },
    { "package": "/plugin/autocode", "options": { "timeoutMs": 30000 } },
  ],
  "permissions": [{ "action": "shell", "resource": "sudo *", "effect": "deny" }],
}`;
  const f = await fixture(source);
  try {
    const before = await f.store.read();
    const after = await f.store.save(before.revision, { model: "provider/reviewer", timeoutMs: 60_000 });
    assert.equal(after.effective.model?.id, "reviewer");
    assert.equal(after.effective.timeoutMs, 60_000);
    assert.notEqual(after.revision, before.revision);
    assert.equal(await readFile(after.backup!, "utf8"), source);
    const saved = await readFile(f.path, "utf8");
    assert.match(saved, /Keep this profile comment/);
    assert.match(saved, /"model": "coding\/model"/);
    assert.match(saved, /"secret": "unchanged"/);
    assert.match(saved, /"resource": "sudo \*", "effect": "deny"/);
  } finally { await f.clean(); }
});

test("rejects a stale draft without overwriting a concurrent configuration edit", async () => {
  const f = await fixture();
  try {
    const before = await f.store.read();
    const changed = f.source + "\n// Edited in another client.\n";
    await writeFile(f.path, changed);
    await assert.rejects(f.store.save(before.revision, { enabled: false }), /changed|reopen/i);
    assert.equal(await readFile(f.path, "utf8"), changed);
  } finally { await f.clean(); }
});

test("serializes two saves of the same revision so one draft cannot overwrite the other", async () => {
  const f = await fixture();
  try {
    const before = await f.store.read();
    const other = new GlobalSettings({ directory: f.directory, packagePath: "/plugin/autocode" });
    const results = await Promise.allSettled([
      f.store.save(before.revision, { timeoutMs: 20_000 }),
      other.save(before.revision, { timeoutMs: 40_000 }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.ok([20_000, 40_000].includes((await f.store.read()).effective.timeoutMs));
  } finally { await f.clean(); }
});

test("avoids rewriting the profile or creating a backup when settings are unchanged", async () => {
  const f = await fixture();
  try {
    const before = await f.store.read();
    const after = await f.store.save(before.revision, {});
    assert.equal(after.backup, undefined);
    assert.equal(after.revision, before.revision);
    assert.equal(await readFile(f.path, "utf8"), f.source);
  } finally { await f.clean(); }
});

test("rejects duplicate JSONC properties before any settings are edited", async () => {
  const f = await fixture('{"plugins":[{"package":"/plugin/autocode","options":{"enabled":true,"enabled":false}}]}');
  try {
    await assert.rejects(f.store.read(), /duplicate/i);
    assert.equal(await readFile(f.path, "utf8"), f.source);
  } finally { await f.clean(); }
});

test("does not replace a symlinked global configuration file", async () => {
  const f = await fixture();
  try {
    const target = join(f.directory, "profile.jsonc");
    await writeFile(target, f.source);
    await rm(f.path);
    await symlink(target, f.path);
    const before = await f.store.read();
    await assert.rejects(f.store.save(before.revision, { enabled: false }), /symlink/i);
    assert.equal(await readFile(target, "utf8"), f.source);
  } finally { await f.clean(); }
});

test("recognizes a local plugin registered through a symlinked package path", async () => {
  const f = await fixture();
  try {
    const packagePath = join(f.directory, "autocode-package");
    const alias = join(f.directory, "package-alias");
    await mkdir(packagePath);
    await symlink(packagePath, alias);
    await writeFile(f.path, JSON.stringify({ plugins: [{ package: alias, options: { timeoutMs: 40_000 } }] }));
    const store = new GlobalSettings({ directory: f.directory, packagePath });
    assert.equal((await store.read()).effective.timeoutMs, 40_000);
  } finally { await f.clean(); }
});
