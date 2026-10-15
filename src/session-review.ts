import type { Plugin } from "@opencode/plugin";
import { randomUUID } from "node:crypto";
import { REVIEW_POLICY } from "./policy.ts";

type ReviewInput = { sessionID: string; data: string; signal: AbortSignal };
type ReviewFrame = { sessionID: string; prompt: string; data: string; wasIsolated: boolean };

export async function createSessionReviewer(ctx: Plugin.Context): Promise<(input: ReviewInput) => Promise<{ text: string }>> {
  const frames = new Map<string, ReviewFrame>();
  await ctx.session.hook("generate", (event) => {
    for (const message of event.messages) {
      if (message.role !== "user") continue;
      for (const part of message.content) {
        if (part.type !== "text") continue;
        const marker = part.text.split("\n", 1)[0]!;
        const frame = frames.get(marker);
        if (!frame || frame.sessionID !== event.sessionID || frame.prompt !== part.text) continue;
        event.system = [{ type: "text", text: REVIEW_POLICY }];
        event.messages = [{ role: "user", content: [{ type: "text", text: `REVIEW_DATA_JSON\n${frame.data}` }] }];
        event.tools = {};
        frame.wasIsolated = true;
        return;
      }
    }
  });
  return async ({ sessionID, data, signal }) => {
    signal.throwIfAborted();
    const marker = `AUTOCODE_REVIEW_${randomUUID()}`;
    const prompt = `${marker}\n${data}`;
    const frame = { sessionID, prompt, data, wasIsolated: false };
    frames.set(marker, frame);
    const forget = () => { frames.delete(marker); };
    signal.addEventListener("abort", forget, { once: true });
    try {
      const result = await ctx.session.generate({ sessionID, prompt }, { signal });
      signal.throwIfAborted();
      if (!frame.wasIsolated) throw new Error("AutoCode review context could not be isolated.");
      return result;
    } finally {
      forget();
      signal.removeEventListener("abort", forget);
    }
  };
}
