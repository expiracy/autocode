import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plugin } from "@opencode/plugin";
import plugin from "../src/index.ts";
import { ReviewLog } from "../src/review-log.ts";

type Handler = (input: Record<string, unknown>, context: { error(type: string, message: string, data: unknown): unknown }) => Promise<unknown>;

test("a directory alias reads the same review history as its canonical project path", async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "autocode-log-scope-")));
  try {
    const directory = join(temporary, "project");
    const alias = join(temporary, "alias");
    await mkdir(directory);
    await symlink(directory, alias);
    const values = new Map<string, unknown>();
    const storage = {
      async get(key: string) { return values.get(key); },
      async set(key: string, value: unknown) { values.set(key, value); },
      async remove(key: string) { values.delete(key); },
    } as Plugin.Context["storage"];
    await new ReviewLog(storage, directory).append({
      sessionID: "session-1", decision: "allow", reason: "Authorized inspection.", durationMs: 12,
    });
    let handlers: Record<string, Handler> = {};
    const ctx = {
      options: { enabled: false }, location: { directory: alias, project: { canonical: directory } }, storage,
      rpc: { async register(_definition: unknown, registered: Record<string, Handler>) {
        handlers = registered;
        return { events: { async emit() {} } };
      } },
      command: { async transform(edit: (editor: { add(command: unknown): void }) => void) { edit({ add() {} }); } },
    } as unknown as Plugin.Context;
    await plugin.setup(ctx);
    const view = await handlers.log!({}, { error(type, message, data) { return { type, message, data }; } }) as { entries: Array<{ sessionID: string }> };
    assert.deepEqual(view.entries.map(entry => entry.sessionID), ["session-1"]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
