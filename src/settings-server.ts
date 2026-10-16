import type { Plugin } from "@opencode/plugin";
import { parseOptions } from "./config.ts";
import { parseAutoCodeCommand } from "./commands.ts";
import { AutoCodeRpc } from "./rpc.ts";
import type { SettingsSnapshot } from "./settings.ts";
import { MAX_LOG_ENTRIES, type ReviewLogStore } from "./review-log.ts";

export type SettingsState = SettingsSnapshot;

export interface SettingsStore {
  read(): Promise<SettingsState>;
  save(revision: string, options: Record<string, unknown>): Promise<SettingsState>;
}

export async function setupSettings(ctx: Plugin.Context, store: SettingsStore, log?: ReviewLogStore): Promise<void> {
  const models = async () => (await ctx.model.list()).data
    .filter(model => model.enabled)
    .map(model => ({
      providerID: model.providerID,
      id: model.id,
      name: model.name,
      variants: model.variants.map(variant => variant.id),
    }));
  const rpc = await ctx.rpc.register(AutoCodeRpc, {
    async settings(_input, context) {
      try { return { ...await store.read(), models: await models() }; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return context.error("settings_error", message, { message });
      }
    },
    async saveSettings(input, context) {
      try {
        const { revision, options } = input as { revision: string; options: Record<string, unknown> };
        const effective = parseOptions(options);
        const available = await models();
        if (effective.enabled && effective.model) {
          const selected = available.find(model => model.providerID === effective.model?.providerID && model.id === effective.model.id);
          if (!selected) {
            throw new Error("AutoCode: the review model is not available. Choose a connected, enabled model or inherit the session model.");
          }
          if (effective.model.variant && !selected.variants.includes(effective.model.variant)) {
            throw new Error("AutoCode: that variant is not available for the review model. Choose a listed variant or the default.");
          }
        }
        const saved = await store.save(revision, options);
        return { ...saved, models: available };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return context.error("settings_error", message, { message });
      }
    },
    async status(_input, context) {
      try { return { ...parseOptions(ctx.options), logLimit: MAX_LOG_ENTRIES }; }
      catch {
        const message = "AutoCode status is unavailable. Check the plugin configuration and reopen /autocode status.";
        return context.error("diagnostics_error", message, { message });
      }
    },
    async log(_input, context) {
      try {
        if (!log) throw new Error("Review log is unavailable.");
        return { entries: await log.read(), maxEntries: MAX_LOG_ENTRIES };
      } catch {
        const message = "AutoCode review log is unavailable. Try reopening /autocode log or restart OpenCode.";
        return context.error("diagnostics_error", message, { message });
      }
    },
    async clearLog(_input, context) {
      try {
        if (!log) throw new Error("Review log is unavailable.");
        await log.clear();
        return { cleared: true };
      } catch {
        const message = "AutoCode could not clear the review log. Try again or restart OpenCode.";
        return context.error("diagnostics_error", message, { message });
      }
    },
  });
  await ctx.command.transform(editor => editor.add({
    name: "autocode",
    description: "Configure AutoCode or inspect approval logs and status",
    async execute(input) {
      const command = parseAutoCodeCommand(input.prompt.text);
      if (!command) {
        throw new Error("Usage: /autocode <config|log|status|help>");
      }
      const event = { config: "openSettings", log: "openLog", status: "openStatus", help: "openHelp" } as const;
      await rpc.events.emit(event[command], { sessionID: input.sessionID });
    },
  }));
}
