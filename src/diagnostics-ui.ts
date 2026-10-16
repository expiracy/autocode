import type { Context } from "@opencode/plugin/tui/context";
import type { ReviewLogEntry } from "./review-log.ts";
import { parseOptions } from "./config.ts";
import { AUTOCODE_HELP } from "./commands.ts";

interface RequestOptions { location: { directory: string }; signal: AbortSignal }
export interface DiagnosticsRpc {
  log(input: Record<string, never>, options: RequestOptions): Promise<unknown>;
  clearLog(input: Record<string, never>, options: RequestOptions): Promise<unknown>;
  status(input: Record<string, never>, options: RequestOptions): Promise<unknown>;
}

export async function viewReviewLog(ctx: Context, rpc: DiagnosticsRpc, current: () => boolean, signal: AbortSignal): Promise<void> {
  const active = () => !signal.aborted && current();
  if (!active()) return;
  const location = ctx.location ?? ctx.data.location.default();
  const load = async () => {
    if (!active()) return undefined;
    try { return readLog(await rpc.log({}, { location, signal })); }
    catch (error) {
      if (active()) await ctx.ui.dialog.alert({ title: "AutoCode review log unavailable", message: `${errorMessage(error)}\n\nRun /autocode log to retry.` });
      return undefined;
    }
  };
  let view = await load();
  if (!view) return;
  while (active()) {
    const byValue = new Map(view.entries.map(entry => [`entry:${entry.id}`, entry]));
    const selected = await ctx.ui.dialog.select({
      title: "AutoCode review log", placeholder: "Search reviewer verdicts, reasons, models, or sessions",
      search(query, options) {
        const tokens = query.trim().toLowerCase().split(/\s+/);
        return options.filter(option => {
          const text = `${option.title} ${option.description ?? ""} ${byValue.get(option.value)?.sessionID ?? ""}`.toLowerCase();
          return tokens.every(token => text.includes(token));
        });
      },
      options: [
        ...view.entries.map(entry => ({
          title: `${entry.decision.toUpperCase()} · ${new Date(entry.timestamp).toISOString().slice(5, 16).replace("T", " ")}Z`,
          value: `entry:${entry.id}`,
          description: `${modelLabel(entry.model)} · ${entry.durationMs} ms · ${entry.reason}`,
        })),
        ...(!view.entries.length ? [{ title: "No reviews yet", value: "empty", description: "Only AutoCode reviews appear here. Commands and conversations have no separate log fields." }] : []),
        { title: "Refresh", value: "refresh", category: "Actions" },
        { title: "Clear review log", value: "clear", category: "Actions", disabled: view.entries.length === 0 },
        { title: "Close", value: "close", category: "Navigation" },
      ],
    });
    if (!active() || !selected || selected === "close") return;
    if (selected === "empty") {
      await ctx.ui.dialog.alert({ title: "No AutoCode reviews yet", message: "Only AutoCode reviews appear here. Configured hard denies and already allowed commands skip automatic review. The log has no separate fields for raw commands or conversations, but a reviewer reason may quote supplied context." });
      continue;
    }
    if (selected === "refresh") { view = await load() ?? view; continue; }
    if (selected === "clear") {
      const confirmed = await ctx.ui.dialog.confirm({ title: "Clear AutoCode review log?", message: "Remove the recent AutoCode review history for this project? This cannot be undone.", label: { confirm: "Clear log", cancel: "Keep log" } });
      if (!active()) return;
      if (confirmed) {
        try { await rpc.clearLog({}, { location, signal }); view = await load() ?? view; }
        catch (error) {
          if (active()) await ctx.ui.dialog.alert({ title: "Unable to clear AutoCode review log", message: `${errorMessage(error)}\n\nSelect Clear review log to retry.` });
        }
      }
      continue;
    }
    const entry = byValue.get(selected);
    if (!entry) continue;
    await ctx.ui.dialog.alert({
      title: "AutoCode review details",
      message: `Reviewer verdict: ${entry.decision.toUpperCase()}\nTime: ${entry.timestamp}\nReason: ${entry.reason}\nModel: ${modelLabel(entry.model)}\nDuration: ${entry.durationMs} ms\nSession: ${entry.sessionID}\n\nOpenCode native policies may still block execution after an ALLOW verdict.`,
    });
  }
}

function modelLabel(model: ReviewLogEntry["model"]): string {
  return model ? `${model.providerID}/${model.id}${model.variant ? ` · ${model.variant}` : ""}` : "Model unavailable";
}

function errorMessage(error: unknown): string { return safeText(error instanceof Error ? error.message : String(error)); }

export async function showStatus(ctx: Context, rpc: DiagnosticsRpc, current: () => boolean, signal: AbortSignal): Promise<void> {
  const active = () => !signal.aborted && current();
  if (!active()) return;
  const location = ctx.location ?? ctx.data.location.default();
  try {
    const result = await rpc.status({}, { location, signal }) as Record<string, unknown>;
    if (!result || result.logLimit !== 100 || typeof result.enabled !== "boolean" || !Object.hasOwn(result, "timeoutMs") || !Object.hasOwn(result, "maxContextChars")) {
      throw new Error("The server returned an invalid AutoCode status.");
    }
    const { logLimit, ...input } = result;
    const status = parseOptions(input);
    if (!active()) return;
    await ctx.ui.dialog.alert({
      title: "AutoCode status",
      message: `Effective project settings: ${location.directory}\nAutomatic approval: ${status.enabled ? "Enabled" : "Disabled"}\nReviewer: ${status.model ? modelLabel(status.model) : "Inherit the coding model and variant"}\nReview timeout: ${status.timeoutMs} ms\nContext budget: ${status.maxContextChars} characters\nReview log: latest ${logLimit} reviews\n\nUse /autocode config to edit global settings. Project overrides may take precedence.`,
    });
  } catch (error) {
    if (active()) await ctx.ui.dialog.alert({ title: "AutoCode status unavailable", message: `${errorMessage(error)}\n\nRun /autocode status to retry.` });
  }
}

function readLog(value: unknown): { entries: ReviewLogEntry[]; maxEntries: number } {
  const invalid = () => new Error("The server returned an invalid AutoCode review log.");
  if (typeof value !== "object" || value === null) throw invalid();
  const view = value as Record<string, unknown>;
  if (!Array.isArray(view.entries) || view.maxEntries !== 100 || view.entries.length > view.maxEntries) throw invalid();
  const entries = view.entries.map((item: unknown) => {
    if (typeof item !== "object" || item === null) throw invalid();
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.id !== "string" || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp)) ||
      typeof entry.sessionID !== "string" || typeof entry.reason !== "string" || !["allow", "ask", "deny"].includes(entry.decision as string) ||
      typeof entry.durationMs !== "number" || !Number.isFinite(entry.durationMs) || entry.durationMs < 0
    ) throw invalid();
    const model = entry.model === undefined ? undefined : parseOptions({ model: entry.model }).model;
    return {
      id: entry.id, timestamp: entry.timestamp, sessionID: safeText(entry.sessionID),
      decision: entry.decision as ReviewLogEntry["decision"], reason: safeText(entry.reason),
      durationMs: entry.durationMs, ...(model ? { model } : {}),
    };
  });
  return { entries, maxEntries: view.maxEntries as number };
}
function safeText(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\p{C}]/gu, " ");
}

export async function showHelp(ctx: Context, current: () => boolean, signal: AbortSignal): Promise<void> {
  if (signal.aborted || !current()) return;
  await ctx.ui.dialog.alert({ title: "AutoCode commands", message: AUTOCODE_HELP });
}
