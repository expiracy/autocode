import type { Plugin } from "@opencode/plugin";
import { createHash, randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

export const MAX_LOG_ENTRIES = 100;

export interface ReviewLogInput {
  sessionID: string;
  decision: "allow" | "ask" | "deny";
  reason: string;
  durationMs: number;
  model?: { providerID: string; id: string; variant?: string };
}

export interface ReviewLogEntry extends ReviewLogInput {
  id: string;
  timestamp: string;
}

export interface ReviewLogSink {
  append(input: ReviewLogInput): Promise<void>;
}

export interface ReviewLogStore extends ReviewLogSink {
  read(): Promise<ReviewLogEntry[]>;
  clear(): Promise<void>;
}

// A process-wide queue also covers OpenCode reloading this module during a write.
const queueSymbol = Symbol.for("opencode-autocode.review-log.queues.v1");
const globalQueues = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
const queues = globalQueues[queueSymbol] ??= new Map<string, Promise<void>>();

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid AutoCode review log metadata.");
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new TypeError("Invalid AutoCode review log metadata.");
  const result = stripVTControlCharacters(value.replace(/(?:\u001b[\]P^_]|[\u0090\u009d-\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, ""))
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .trim().slice(0, maximum);
  if (!result) throw new TypeError("Invalid AutoCode review log metadata.");
  return result;
}

function metadata(value: unknown): ReviewLogInput {
  const raw = record(value);
  if (raw.decision !== "allow" && raw.decision !== "ask" && raw.decision !== "deny") throw new TypeError("Invalid AutoCode review log metadata.");
  if (typeof raw.durationMs !== "number" || !Number.isFinite(raw.durationMs) || raw.durationMs < 0) throw new TypeError("Invalid AutoCode review log metadata.");
  const result: ReviewLogInput = {
    sessionID: text(raw.sessionID, 256), decision: raw.decision,
    reason: text(raw.reason, 1000), durationMs: raw.durationMs,
  };
  if (raw.model !== undefined) {
    const model = record(raw.model);
    result.model = { providerID: text(model.providerID, 256), id: text(model.id, 256) };
    if (model.variant !== undefined) result.model.variant = text(model.variant, 256);
  }
  return result;
}

export class ReviewLog implements ReviewLogStore {
  private readonly storage: Plugin.Context["storage"];
  private readonly key: string;

  constructor(storage: Plugin.Context["storage"], scope: string) {
    this.storage = storage;
    this.key = `review-log.v1.${createHash("sha256").update(scope).digest("hex")}`;
  }

  append(input: ReviewLogInput): Promise<void> {
    return this.enqueue(async () => {
      const entries = await this.load();
      const entry = { ...metadata(input), id: randomUUID(), timestamp: new Date().toISOString() };
      await this.storage.set(this.key, JSON.parse(JSON.stringify([entry, ...entries].slice(0, MAX_LOG_ENTRIES))));
    });
  }

  read(): Promise<ReviewLogEntry[]> { return this.enqueue(() => this.load()); }

  clear(): Promise<void> { return this.enqueue(() => this.storage.remove(this.key)); }

  private async load(): Promise<ReviewLogEntry[]> {
    const stored = await this.storage.get(this.key);
    if (!Array.isArray(stored)) return [];
    const entries: ReviewLogEntry[] = [];
    for (const value of stored) {
      try {
        const raw = record(value);
        const timestamp = text(raw.timestamp, 256);
        if (new Date(timestamp).toISOString() !== timestamp) continue;
        entries.push({ ...metadata(raw), id: text(raw.id, 256), timestamp });
        if (entries.length === MAX_LOG_ENTRIES) break;
      } catch {
        // Corrupt records do not hide the remaining valid history.
      }
    }
    return entries;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = (queues.get(this.key) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => {}, () => {});
    queues.set(this.key, settled);
    void settled.then(() => { if (queues.get(this.key) === settled) queues.delete(this.key); });
    return result;
  }
}
