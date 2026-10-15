import type { Context } from "@opencode/plugin/tui/context";
import { parseOptions } from "./config.ts";
import type { SettingsView } from "./settings.ts";

export interface SettingsRpc {
  settings(input: Record<string, never>, options: { location: { directory: string }; signal: AbortSignal }): Promise<unknown>;
  saveSettings(input: { revision: string; options: Record<string, unknown> }, options: { location: { directory: string }; signal: AbortSignal }): Promise<unknown>;
}

export async function editSettings(ctx: Context, rpc: SettingsRpc, current: () => boolean, signal: AbortSignal): Promise<void> {
  const active = () => !signal.aborted && current();
  if (!active()) return;
  const location = ctx.location ?? ctx.data.location.default();
  let view: SettingsView;
  try {
    view = await rpc.settings({}, { location, signal }) as SettingsView;
    if (!view?.path || !view.revision || !view.options || !view.effective || !Array.isArray(view.models)) throw new Error("The server returned no editable AutoCode settings.");
    parseOptions(view.options);
  } catch (error) {
    if (active()) await ctx.ui.dialog.alert({ title: "AutoCode settings unavailable", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!active()) return;
  const draft = structuredClone(view.options);
  while (active()) {
    const effective = parseOptions(draft);
    const changed = JSON.stringify(draft) !== JSON.stringify(view.options);
    const selected = await ctx.ui.dialog.select({
      title: "AutoCode settings",
      placeholder: `${changed ? "Unsaved changes · " : ""}Global settings · all projects`,
      options: [
        { title: "Automatic approval", value: "enabled", description: effective.enabled ? "Enabled" : "Disabled" },
        { title: "Approval model", value: "model", description: effective.model ? `${effective.model.providerID}/${effective.model.id}${effective.model.variant ? ` · ${effective.model.variant}` : ""}` : "Inherit the coding model and variant" },
        { title: "Review timeout", value: "timeoutMs", description: `${effective.timeoutMs} ms` },
        { title: "Context budget", value: "maxContextChars", description: `${effective.maxContextChars} characters` },
        { title: "Save settings", value: "save", disabled: !changed },
        { title: "Reset to defaults", value: "reset", description: "Enabled · inherit model · 30000 ms · 64000 characters" },
        { title: "Close", value: "close", category: "Navigation" },
      ],
    });
    if (!active()) return;
    if (!selected || selected === "close") {
      if (changed) {
        const discard = await ctx.ui.dialog.confirm({ title: "Discard unsaved AutoCode settings?", message: `${view.path}\n\nThis draft has not been saved. Discard its changes?`, label: { confirm: "Discard changes", cancel: "Keep editing" } });
        if (!active()) return;
        if (!discard) continue;
      }
      return;
    }
    if (selected === "enabled") draft.enabled = !effective.enabled;
    else if (selected === "model") await editModel(ctx, view, draft, active);
    else if (selected === "timeoutMs" || selected === "maxContextChars") await editNumber(ctx, draft, selected, active);
    else if (selected === "reset") for (const key of Object.keys(draft)) delete draft[key];
    else if (selected === "save" && changed) {
      try {
        await rpc.saveSettings({ revision: view.revision, options: draft }, { location, signal });
        if (active()) ctx.ui.toast.show({ title: "AutoCode settings saved", message: "Global settings apply to new command reviews.", variant: "success" });
        return;
      } catch (error) {
        if (active()) await ctx.ui.dialog.alert({ title: "Unable to save AutoCode settings", message: `${error instanceof Error ? error.message : String(error)}\n\nYour draft has been kept.` });
      }
    }
  }
}

async function editNumber(ctx: Context, draft: Record<string, unknown>, field: "timeoutMs" | "maxContextChars", active: () => boolean): Promise<void> {
  const timeout = field === "timeoutMs";
  let value = String(parseOptions(draft)[field]);
  while (active()) {
    const answer = await ctx.ui.dialog.prompt({
      title: timeout ? "Review timeout" : "Context budget",
      description: timeout ? "Milliseconds per command review (1–300000)." : "Maximum review context in characters (1000–1000000).",
      value,
    });
    if (!active() || answer === undefined) return;
    value = answer;
    try {
      const candidate = { ...draft, [field]: Number(answer.trim()) };
      parseOptions(candidate);
      draft[field] = candidate[field];
      return;
    } catch (error) {
      await ctx.ui.dialog.alert({ title: "Invalid AutoCode setting", message: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function editModel(ctx: Context, view: SettingsView, draft: Record<string, unknown>, active: () => boolean): Promise<void> {
  const previous = parseOptions(draft).model;
  while (active()) {
    const selected = await ctx.ui.dialog.select({
      title: "Approval model", placeholder: "Search connected models by name or provider",
      current: previous ? `model:${previous.providerID}/${previous.id}` : "inherit",
      search(query, options) {
        const tokens = query.trim().toLowerCase().split(/\s+/);
        return options.filter(option => {
          const text = `${option.title} ${option.description ?? ""} ${option.value}`.toLowerCase();
          return tokens.every(token => text.includes(token));
        });
      },
      options: [
        { title: "Inherit coding model", value: "inherit", description: "Use the coding model and its selected variant" },
        ...view.models.map(model => ({ title: model.name, value: `model:${model.providerID}/${model.id}`, description: `${model.providerID}/${model.id}` })),
        { title: "Back to settings", value: "back", category: "Navigation" },
      ],
    });
    if (!active() || !selected || selected === "back") return;
    if (selected === "inherit") { delete draft.model; return; }
    const model = view.models.find(model => selected === `model:${model.providerID}/${model.id}`);
    if (!model) return;
    let variant: string | undefined;
    if (model.variants.length) {
      const choice = await ctx.ui.dialog.select({
        title: "Approval model variant", placeholder: `${model.providerID}/${model.id}`,
        current: previous?.providerID === model.providerID && previous.id === model.id && previous.variant ? `variant:${previous.variant}` : "default",
        options: [
          { title: "Model default", value: "default" },
          ...model.variants.map(variant => ({ title: variant, value: `variant:${variant}` })),
          { title: "Back to models", value: "back", category: "Navigation" },
        ],
      });
      if (!active()) return;
      if (!choice || choice === "back") continue;
      variant = model.variants.find(value => choice === `variant:${value}`);
      if (choice !== "default" && !variant) return;
    }
    draft.model = { providerID: model.providerID, id: model.id, ...(variant ? { variant } : {}) };
    return;
  }
}
