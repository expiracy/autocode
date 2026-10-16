import type { Plugin } from "@opencode/plugin";
import { resolve } from "node:path";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import { parseOptions, type ApprovalModel, type ResolvedOptions } from "./config.ts";
import { REVIEW_POLICY } from "./policy.ts";
import { createSessionReviewer } from "./session-review.ts";
import type { ReviewLogSink } from "./review-log.ts";

type Decision = { decision: "allow" | "ask" | "deny"; reason: string };
class ReviewTimeoutError extends Error {}

// Accept exactly two fields, in either order. This also rejects duplicate JSON keys.
const reasonField = String.raw`"reason"\s*:\s*"(?:[^"\\]|\\.)*"`;
const decisionField = String.raw`"decision"\s*:\s*"(?:allow|ask|deny)"`;
const verdictShape = new RegExp(
  String.raw`^\s*\{\s*(?:${decisionField}\s*,\s*${reasonField}|${reasonField}\s*,\s*${decisionField})\s*\}\s*$`,
);

function parseDecision(text: string): Decision | undefined {
  if (text.length > 4_096 || !verdictShape.test(text)) return;
  try {
    const value = JSON.parse(text) as Decision;
    if (!value.reason.trim() || value.reason.length > 2_000) return;
    return value;
  } catch {
    return;
  }
}

async function review(
  ctx: Plugin.Context, event: PermissionEvaluation, options: ResolvedOptions, signal: AbortSignal,
  sessionReviewer: Awaited<ReturnType<typeof createSessionReviewer>>,
  selectedModel: (model: ApprovalModel) => void,
): Promise<Decision | undefined> {
  const messages = await ctx.session.context({ sessionID: event.sessionID }, { signal });
  signal.throwIfAborted();
  if (!messages.some((message) => message.type === "user" && message.text.trim())) {
    return { decision: "ask", reason: "User intent is unavailable in the review context." };
  }
  const origin = messages.find((message) => message.id === event.source?.messageID);
  const session = await ctx.session.get({ sessionID: event.sessionID }, { signal });
  signal.throwIfAborted();
  let model = options.model ?? (origin?.type === "assistant" ? origin.model : undefined) ?? session.model;
  if (!model) {
    const fallback = await ctx.model.default({ location: session.location }, { signal });
    signal.throwIfAborted();
    if (fallback.data) model = { providerID: fallback.data.providerID, id: fallback.data.id };
  }
  if (!model) return { decision: "ask", reason: "The approval model could not be resolved." };
  selectedModel(model);
  const tool = origin?.type === "assistant"
    ? origin.content.find((part) => part.type === "tool" && part.id === event.source?.id)
    : undefined;
  const toolInput = tool?.type === "tool" && tool.state.status !== "streaming" ? tool.state.input : undefined;
  if (tool?.type !== "tool" || tool.name !== "shell" || typeof toolInput?.command !== "string" || !toolInput.command.trim()) {
    return { decision: "ask", reason: "The full originating shell command is unavailable; parsed permission resources alone are insufficient." };
  }
  const directory = session.location.directory;
  if (!directory) return { decision: "ask", reason: "The session working directory is unavailable." };
  const workingDirectory = resolve(directory, session.subpath ?? "", typeof toolInput.workdir === "string" ? toolInput.workdir : ".");
  const request = {
    action: event.action, resources: event.resources, workingDirectory, toolInput,
    metadata: event.metadata, source: event.source, previousMessage: event.message,
  };
  const data = JSON.stringify({ request, messages });
  if (data.length > options.maxContextChars) {
    return { decision: "ask", reason: "The review context exceeds maxContextChars; the command was not sent for partial review." };
  }
  const current = session.model;
  const matchesCurrent = current && model.providerID === current.providerID && model.id === current.id
    && (model.variant ?? "default") === (current.variant ?? "default");
  const result = matchesCurrent
    ? await sessionReviewer({ sessionID: event.sessionID, data, signal })
    : await ctx.generate.text({ model, prompt: `${REVIEW_POLICY}\nREVIEW_DATA_JSON\n${data}` }, { signal });
  return parseDecision(result.text);
}

async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new ReviewTimeoutError("Automatic review timed out");
      reject(error);
      controller.abort(error);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function setupApproval(ctx: Plugin.Context, log?: ReviewLogSink): Promise<void> {
  const options = parseOptions(ctx.options);
  if (!options.enabled) return;
  const sessionReviewer = await createSessionReviewer(ctx);
  await ctx.permission.hook("evaluate", async (event) => {
    if (event.effect !== "ask" || event.action !== "shell") return;
    const started = performance.now();
    let model: ApprovalModel | undefined;
    try {
      const decision = await withDeadline(options.timeoutMs, (signal) => review(ctx, event, options, signal, sessionReviewer, (selected) => {
        model = { providerID: selected.providerID, id: selected.id, ...(selected.variant ? { variant: selected.variant } : {}) };
      }));
      if (decision) {
        event.effect = decision.decision;
        event.message = `autocode: ${decision.reason}`;
      } else {
        event.message = "autocode: Invalid reviewer response; please review this command.";
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("OpenCode's free tier can only be used from within OpenCode")) {
        event.message = "autocode: The OpenCode free model rejected this review request. Choose a separate approval model in /autocode config, or review this command manually.";
      } else if (error instanceof ReviewTimeoutError) {
        event.message = `autocode: Automatic review timed out after ${options.timeoutMs} ms; please review this command.`;
      } else {
        event.message = "autocode: Automatic review failed; please review this command.";
      }
    } finally {
      if (log) {
        // Diagnostics must never delay or change a permission decision.
        try {
          void log.append({
            sessionID: event.sessionID, decision: event.effect,
            reason: event.message?.replace(/^autocode:\s*/, "") ?? "Manual review required.",
            durationMs: Math.max(0, Math.round(performance.now() - started)),
            ...(model ? { model } : {}),
          }).catch(() => {});
        } catch {}
      }
    }
  });
}
