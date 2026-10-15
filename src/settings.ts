import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, unlink, realpath } from "node:fs/promises";
import { lstatSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse, visit, type ParseError } from "jsonc-parser";
import { isDeepStrictEqual } from "node:util";
import { parseOptions, type ResolvedOptions } from "./config.ts";

export interface SettingsModel {
  providerID: string;
  id: string;
  name: string;
  variants: string[];
}

export interface SettingsSnapshot {
  path: string;
  revision: string;
  options: Record<string, unknown>;
  effective: ResolvedOptions;
  backup?: string;
}

export interface SettingsView extends SettingsSnapshot {
  models: SettingsModel[];
}

type SettingsTarget = { directory?: string; configFile?: string; packagePath?: string };

async function matchesPackage(name: string, packagePath: string, directory: string): Promise<boolean> {
  if (/^(?:autocode|open-auto-code)(?:@[^/]+)?$/.test(name)) return true;
  const path = name.startsWith("file://") ? fileURLToPath(name)
    : isAbsolute(name) || name.startsWith(".") ? resolve(directory, name) : undefined;
  if (path === undefined) return false;
  const canonical = (value: string) => realpath(value).catch(() => resolve(value));
  const actual = await canonical(path);
  const candidates = await Promise.all([packagePath, join(packagePath, "index.js"), join(packagePath, "index.ts")].map(canonical));
  return candidates.includes(actual);
}

function revision(path: string, source: string): string {
  return createHash("sha256").update(path).update("\0").update(source).digest("hex");
}

const queueKey = Symbol.for("autocode.settings-writes");
const writes: Map<string, Promise<void>> = Reflect.get(globalThis, queueKey) ?? new Map();
Reflect.set(globalThis, queueKey, writes);

export class GlobalSettings {
  private readonly target: SettingsTarget;
  constructor(target: SettingsTarget = {}) { this.target = target; }

  private async document() {
    const directory = this.target.directory ?? process.env.OPENCODE_CONFIG_DIR
      ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
    const explicit = this.target.configFile ?? process.env.OPENCODE_CONFIG;
    const paths = explicit ? [resolve(explicit)] : [join(directory, "opencode.json"), join(directory, "opencode.jsonc")];
    const packagePath = resolve(this.target.packagePath ?? fileURLToPath(new URL("../", import.meta.url)));
    const matches = [];
    for (const path of paths) {
      let source: string;
      try { source = await readFile(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const errors: ParseError[] = [];
      const native = parse(source, errors, { allowTrailingComma: true }) as Record<string, unknown>;
      if (errors.length || !native || typeof native !== "object" || Array.isArray(native)) {
        throw new Error("Correct the invalid global OpenCode configuration before editing AutoCode settings.");
      }
      const keys: Set<string>[] = [];
      visit(source, {
        onObjectBegin() { keys.push(new Set()); },
        onObjectProperty(key) {
          if (keys.at(-1)!.has(key)) throw new Error("Remove duplicate global configuration properties before editing AutoCode settings.");
          keys.at(-1)!.add(key);
        },
        onObjectEnd() { keys.pop(); },
      }, { allowTrailingComma: true });
      if (!Array.isArray(native.plugins)) continue;
      for (const [index, entry] of native.plugins.entries()) {
        const name = typeof entry === "string" ? entry : entry?.package;
        if (typeof name !== "string" || !await matchesPackage(name, packagePath, dirname(path))) continue;
        const options = (typeof entry === "string" || entry.options === undefined ? {} : entry.options) as Record<string, unknown>;
        matches.push({ path, source, native, index, options, effective: parseOptions(options), revision: revision(path, source) });
      }
    }
    if (matches.length !== 1) throw new Error(matches.length
      ? "Multiple AutoCode registrations exist. Keep one global registration before editing settings."
      : "Install AutoCode in your global OpenCode configuration before editing settings.");
    return matches[0]!;
  }

  async read(): Promise<SettingsSnapshot> {
    const { path, revision, options, effective } = await this.document();
    return { path, revision, options, effective };
  }

  async save(expectedRevision: string, options: Record<string, unknown>): Promise<SettingsSnapshot> {
    const { path } = await this.document();
    const operation = (writes.get(path) ?? Promise.resolve()).then(() => this.saveCurrent(expectedRevision, options));
    const settled = operation.then(() => {}, () => {});
    writes.set(path, settled);
    void settled.then(() => { if (writes.get(path) === settled) writes.delete(path); });
    return operation;
  }

  private async saveCurrent(expectedRevision: string, options: Record<string, unknown>): Promise<SettingsSnapshot> {
    const effective = parseOptions(options);
    const before = await this.document();
    if (before.revision !== expectedRevision) throw new Error("AutoCode settings changed. Reopen settings before saving.");
    if (isDeepStrictEqual(before.options, options)) return this.read();
    if (lstatSync(before.path).isSymbolicLink()) throw new Error("Edit the original global configuration instead of a symlinked profile.");
    const plugins = before.native.plugins as Array<string | { package: string; options?: Record<string, unknown> }>;
    const entry = plugins[before.index]!;
    let source = before.source;
    const formattingOptions = { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" };
    const set = (path: (string | number)[], value: unknown) => {
      source = applyEdits(source, modify(source, path, value, { formattingOptions }));
    };
    if (typeof entry === "string") set(["plugins", before.index], { package: entry, options });
    else if (entry.options === undefined) set(["plugins", before.index, "options"], options);
    else for (const key of ["enabled", "model", "timeoutMs", "maxContextChars"]) {
      if (!isDeepStrictEqual(before.options[key], options[key])) set(["plugins", before.index, "options", key], options[key]);
    }
    const backupDirectory = join(dirname(before.path), ".autocode", "settings-backups");
    await mkdir(backupDirectory, { recursive: true });
    const backup = join(backupDirectory, `${Date.now()}-${crypto.randomUUID()}.jsonc`);
    await writeFile(backup, before.source, { flag: "wx", mode: 0o600 });
    const temporary = join(dirname(before.path), `.autocode-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
      if (lstatSync(before.path).isSymbolicLink()) throw new Error("The global configuration became a symlink. Reopen settings before saving.");
      if (readFileSync(before.path, "utf8") !== before.source) throw new Error("AutoCode settings changed. Reopen settings before saving.");
      renameSync(temporary, before.path);
    } finally { await unlink(temporary).catch(() => {}); }
    return { path: before.path, revision: revision(before.path, source), options: structuredClone(options), effective, backup };
  }
}
